/**
 * 运行期的 OG 分享图与它的描述 —— 由本机构建后经 `POST /api/ingest` 送达。
 *
 * 为什么不让容器从 dist/ 出这张图：
 *   `dist/` 是**镜像构建期**的产物，而线上换容器走的是「diff + docker commit」——
 *   那条路不重新执行构建，于是 `dist/` 被一路原样继承。实测 2026-10-09：容器里那张图
 *   停在 10-02（**7 天前**），卡片上印着三个错数字（距上次重置 / 历史记录次数 / 最近采集时刻），
 *   而页面上的数字早就翻新了。
 *   D-025 / D-026 把「卡片停在最后一次构建的数值」记为**已知且接受的代价**，
 *   前提是「部署 = 一次构建」；diff 部署把这个前提悄悄弄没了，
 *   代价于是从「差一次构建」变成「无限期」。
 *
 * 为什么不让容器自己渲染：
 *   要引 `@resvg/resvg-js`（devDependency、原生二进制）进运行镜像，
 *   与 D-002「运行镜像零依赖」冲突 —— D-026 已明确否掉这条路。
 *
 * 所以走第三条：**图在别处构建，走已有的数据通道送进来**。
 *   本机的采集自动化每小时跑一次 `node scripts/build.mjs`（那里有 resvg 与中文字体），
 *   产出与本轮 `data/` **同一次构建**的 PNG + 描述，由 `scripts/push-ingest.mjs`
 *   随数据一并 POST。好处不只是「图会新」——卡片与页面来自同一份数据、同一个 now，
 *   数字不可能对不上，这正是 `scripts/og-image.mjs` 里「图与文字不能各算各的」那条要求。
 *
 * 落点必须在数据卷里（`DATA_DIR/og/`）：容器里除挂载卷之外都是镜像层，换容器即丢。
 *   ⚠ `data/og/` 必须留在 `.gitignore` 里 —— 本机自动化每轮 `git add data`，
 *     不排除就会每小时把一个 ~100KB 的二进制提交进公开仓库（且永久留在历史里）。
 *     `test-secrets.mjs` 有断言守着这条。
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** 数据卷里的子目录 */
export const OG_SUBDIR = 'og';
/** 对外服务的文件名（URL 是 `/og-image.png`） */
export const OG_PNG_NAME = 'og-image.png';
const OG_META_NAME = 'meta.json';

/**
 * 卡片尺寸。与 `scripts/og-image.mjs` 的 `OG_W` / `OG_H`、
 * `src/lib/render.mjs` 里 `og:image:width/height` 是同一个数，**三处必须一致**。
 *
 * 这里不能 import 那两个模块：`scripts/og-image.mjs` 顶层 import 了
 * `@resvg/resvg-js`，而运行镜像里没有它（D-002）—— 正是这个约束逼出了本文件的设计。
 * 于是服务端改成「用判据把它钉住」：`decodeOgPng` 会校验 IHDR 声明的尺寸。
 */
export const OG_EXPECT = { width: 1200, height: 630 };

/** 描述是一句话。超过这个长度说明送来的不是我们构建的卡片 */
export const MAX_OG_DESC = 300;

/** PNG 上限 2 MB。实测 1200×630 的卡片约 105 KB —— 留足余量，但别让一个请求吃光内存 */
export const MAX_OG_BYTES = 2 * 1024 * 1024;

/** PNG 的 8 字节签名 */
const PNG_MAGIC = '\x89PNG\r\n\x1a\n';

export const ogPaths = (dataDir) => {
  const dir = resolve(dataDir, OG_SUBDIR);
  return { dir, png: resolve(dir, OG_PNG_NAME), meta: resolve(dir, OG_META_NAME) };
};

/**
 * 校验并解出 PNG。合法返回 Buffer，不合法返回 null。
 *
 * 判据三样：base64 解得开且带 PNG 签名、体积在上限内、IHDR 声明的尺寸是 1200×630。
 * 刻意**不做完整解码** —— 这里只需要挡住「送来的不是卡片」和「体积失控」，
 * 真正的解码由浏览器与各平台做。
 *
 * 尺寸那一条是有用的：平台按 `og:image:width/height` 决定裁切方式，
 * 图与声明不一致会被裁错，而那种错在服务端完全看不出来。
 */
export function decodeOgPng(value) {
  if (typeof value !== 'string' || !value) return null;
  // 注意：Buffer.from 对非法字符**不抛错**，它会静默丢弃 —— 所以签名与尺寸这两道
  // 判据才是真正的门，不能只靠「解得开」。
  const buf = Buffer.from(value, 'base64');
  if (buf.length < 24 || buf.length > MAX_OG_BYTES) return null;
  if (buf.subarray(0, 8).toString('latin1') !== PNG_MAGIC) return null;
  // IHDR 紧跟在「8 字节签名 + 4 字节长度 + 4 字节类型」之后：偏移 16 是宽、20 是高
  if (buf.readUInt32BE(16) !== OG_EXPECT.width || buf.readUInt32BE(20) !== OG_EXPECT.height) {
    return null;
  }
  return buf;
}

/* --------------------------------- 读 --------------------------------- */

// 描述每小时才变一次，而页面**每次请求**都会问一次 —— 按 mtime 缓存。
// 缓存 key 里带上路径，否则同一进程里换 dataDir（测试）会读到上一个目录的值。
let metaCache = { path: null, key: null, value: null };

/**
 * 读运行期推送的卡片描述。
 *
 * @returns {Promise<null|{description: string, builtAt: string|null, bytes: number|null, mtimeMs: number}>}
 *   从未推送过、或文件坏了，一律返回 null —— 调用方回落 `dist/` 那份。
 */
export async function readOgMeta(dataDir) {
  const { meta } = ogPaths(dataDir);

  let info;
  try {
    info = await stat(meta);
    if (!info.isFile()) return null;
  } catch {
    return null;
  }

  const key = `${info.mtimeMs}|${info.size}`;
  if (metaCache.path === meta && metaCache.key === key) return metaCache.value;

  let value = null;
  try {
    const parsed = JSON.parse(await readFile(meta, 'utf8'));
    const description = typeof parsed?.description === 'string' ? parsed.description.trim() : '';
    if (description) {
      value = {
        description,
        builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : null,
        bytes: Number.isFinite(parsed.bytes) ? parsed.bytes : null,
        mtimeMs: info.mtimeMs,
      };
    }
  } catch {
    value = null; // 半截 JSON / 坏 JSON：当作没推送过，回落 dist/
  }

  metaCache = { path: meta, key, value };
  return value;
}

/* --------------------------------- 写 --------------------------------- */

/**
 * 落盘。先写临时文件再 `rename` —— 与 `saveJson` 同一个理由：读方不会读到半截文件。
 * PNG 先写、meta 后写，于是「meta 在」蕴含「PNG 在」。
 */
export async function writeOgAsset(dataDir, { png, description, builtAt }) {
  const p = ogPaths(dataDir);
  await mkdir(p.dir, { recursive: true });
  const suffix = `.tmp-${process.pid}`;

  const tmpPng = `${p.png}${suffix}`;
  await writeFile(tmpPng, png);
  await rename(tmpPng, p.png);

  const tmpMeta = `${p.meta}${suffix}`;
  const body = { description, builtAt, bytes: png.length };
  await writeFile(tmpMeta, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  await rename(tmpMeta, p.meta);

  return { bytes: png.length };
}

/* ------------------------------ 页面 meta ------------------------------ */

/**
 * 页面 meta 该用的那份 OG 信息。没有可用的卡片时返回 null。
 *
 * 优先运行期推送的那份（`data/og/`），没有才回落到镜像里的 `dist/og-image.png`。
 * 回落不是「等价选择」而是**兼容窗口**：新容器刚起来、自动化还没推第一轮时，
 * 不能因为缺图就把 `og:image` 整条撤掉 —— 平台抓不到那个地址会展开成**空白卡**，
 * 而空白卡比一张旧图更糟。
 *
 * 刻意**不缓存**返回结果：它必须反映最新一次推送，否则就等于把
 * 「卡片永远是旧的」这个 bug 原样搬进新实现。两次 `stat` 相对整页渲染可以忽略
 * （描述本身在 `readOgMeta` 里按 mtime 缓存）。
 *
 * @param {{ dataDir: string, siteUrl: string, distPng: string }} ctx
 *        `distPng` 由调用方传入而不是在这里拼路径 —— 本模块不假设仓库布局。
 */
export async function resolveOgMeta({ dataDir, siteUrl, distPng }) {
  if (!siteUrl) return null;
  const imageUrl = `${siteUrl}/og-image.png`;

  const pushed = await readOgMeta(dataDir);
  if (pushed) {
    // 写入顺序保证「meta 在则 PNG 在」，但仍确认一次：宁可退回 dist/，
    // 也不给平台一个 404 的地址。
    try {
      if ((await stat(ogPaths(dataDir).png)).isFile()) {
        return { pageUrl: siteUrl, imageUrl, description: pushed.description };
      }
    } catch {
      /* 落到下面的兜底 */
    }
  }

  try {
    if ((await stat(distPng)).isFile()) return { pageUrl: siteUrl, imageUrl };
  } catch {
    /* 镜像里也没有 —— 整体不输出 og:image */
  }

  return null;
}
