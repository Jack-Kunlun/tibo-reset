/**
 * 小程序首屏数据快照（`miniprogram/data/snapshot.js`）的组装与落盘。
 *
 * 为什么它单独成一个模块 —— 这份产物必须能**脱离 `dist/` 的构建单独重生成**。
 * 两条理由都不是洁癖：
 *
 *   1. **它不入库**（见 `.gitignore` 与 D-027），而 `miniprogram/utils/api.js` 在
 *      **模块顶层** `import` 它。所以任何要加载小程序代码的东西 —— `npm test` 里的
 *      test-miniprogram、`npm run preview:mp`、微信开发者工具 —— 都得先在磁盘上有
 *      它。前置步骤因此越轻越好，不能要求「先跑一次完整构建」。
 *   2. **不能把完整构建塞进测试前置**：CI 的 `npm run test` 必须跑在
 *      `node scripts/build.mjs` **之前** —— test-shared 要比对
 *      `miniprogram/utils/scene.js` 与 `src/lib/scene.js`，放到构建之后副本刚被
 *      覆盖，那条检查恒真、等于没有（`collect.yml` 的「校验」一步有注释）。
 *      所以「给 test 补一个完整构建」是错的解法，只能补这一份快照。
 *
 * `resolveBuildNow` 也放在这里，因为「所有派生值共用同一个 now」这条约束的起点
 * 就是它：快照、页面、OG 卡片必须同一个时刻，否则同一份数据会产出三个世界。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { derive } from './page.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 快照相对仓库根的路径。路径只在这一处出现，调用方拿它打日志。 */
export const SNAPSHOT_REL = 'miniprogram/data/snapshot.js';

const HEADER =
  '/** ⚠ 本文件由 scripts/build.mjs 或 scripts/build-snapshot.mjs 生成，请勿直接修改。 */\n' +
  '// 离线首屏数据快照：采集脚本 → 构建 → 小程序内置。\n';

/**
 * 固定一个 now，让同一轮构建里所有派生结果共用同一时刻。
 * BUILD_NOW 可以把它钉死（ISO 串或毫秒数）—— 「同一份数据 + 同一个时刻 → 同一份产物」，
 * 这是可复现构建的前提，也是验收 A8（时间显示不随机器时区变化）能精确判等的基础。
 */
export function resolveBuildNow(raw) {
  if (!raw) return Date.now();
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return asDate;
  throw new Error(`BUILD_NOW 无法解析：${raw}（应为 ISO 时间串或毫秒时间戳）`);
}

/**
 * 组装快照文件内容。
 *
 * `chart` / `prediction` / `signals` 来自 `derive()` —— **调用方负责共用同一份派生值**
 * （同一份数据 + 同一个 now），不要在这里再 derive 一次，否则页面与快照会各自算一遍。
 */
export function snapshotFrom({ chart, prediction, signals, statsFile, account, now }) {
  const snapshot = {
    schema: 1,
    generatedAt: new Date(now).toISOString(),
    dataUpdatedAt: statsFile.generated_at ?? null,
    account,
    chart,
    prediction,
    // rejected 不随快照下发：它是「未命中但值得留档」的排查材料，服务端 API 里照旧有，
    // 小程序端一处都不读。但它**很占体积** —— 并上回复流之后被排除的推文从个位数涨到
    // 50+ 条，实测这一项就占快照的一半（47KB / 92KB）。而快照是要跟着小程序包下发的
    // （它的存在就是为了「域名没备案时也能出首屏」），不该被排查材料撑大。
    // 计数照旧保留在 counts 里，「扫了多少、排除多少」仍然说得清。
    //
    // rejected 被清空，所以 truncated 必须**重算**：沿用原值会让快照自相矛盾 ——
    // 保留数是 0 条、却标着「触顶」，将来谁去读就会渲染出「排除项保留了最近的
    // 0 / 共 62 条」这种句子。快照里确实只带 hints，故截断状态只由 hints 决定。
    // （小程序端目前两个字段都不读，这一行只是不让错值留在产物里。）
    signals: {
      ...signals,
      rejected: [],
      truncated: (signals.hints?.length ?? 0) < (signals.counts?.hint ?? 0),
    },
    stats: statsFile.stats ?? null,
    collectErrors: statsFile.errors ?? [],
  };

  return HEADER + `export default ${JSON.stringify(snapshot, null, 2)};\n`;
}

/**
 * 读 `data/` 自行派生并组装 —— 给「只需要这一份快照」的入口用
 * （`scripts/build-snapshot.mjs`）。`build.mjs` 自己已经读过数据、derive 过，
 * 所以那边直接用 `snapshotFrom`，省掉一遍重复计算。
 */
export async function buildSnapshot({ account, now }) {
  const read = async (p) => JSON.parse(await readFile(resolve(ROOT, p), 'utf8'));
  const [resets, tweets, statsFile] = await Promise.all([
    read('data/resets.json'),
    read('data/tweets.json'),
    read('data/stats.json'),
  ]);
  const { chart, prediction, signals } = derive({ resets, tweets, statsFile, now, account });
  return snapshotFrom({ chart, prediction, signals, statsFile, account, now });
}

/** 落盘。返回字节数，调用方打日志用。 */
export async function writeSnapshot(js) {
  const abs = resolve(ROOT, SNAPSHOT_REL);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, js, 'utf8');
  return Buffer.byteLength(js);
}
