/**
 * 页面组装：数据 → 完整 HTML。
 *
 * 为什么单独一个模块：同一份页面现在有**两个消费者** ——
 *   1. `scripts/build.mjs`（构建期出 dist/index.html，供 GitHub Pages 与镜像兜底）
 *   2. `server/index.mjs`（请求时实时渲染，数据一变刷新即新，不经构建）
 * 两边必须渲染出**同一份**页面（同一份数据 + 同一时刻），所以组装逻辑只能有一份。
 * 放在这里，两边都调它 —— 否则「页面数字 = API 数字」（验收 A3）就从架构保证
 * 退化成人工比对。
 *
 * 三个导出是**有顺序**的：derive（算） → renderPage（渲染）。
 * 之所以不合成一个函数，是因为构建期还要拿 derive 的中间值去出 OG 分享图
 * （og-image.mjs 需要 model 与 prediction），合成之后那份中间值就取不到了。
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChartData } from './chart-data.js';
import { predictAll } from './predict.mjs';
import { detectSignals, latestEventMs } from './signals.mjs';
import { renderAll } from './render.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ------------------------------- 派生值 ------------------------------- */

/**
 * 从三份数据文件算出页面需要的全部派生值。
 *
 * `now` 必须由调用方钉死，不能用模块内的 Date.now()：一次渲染里所有时间派生量
 * （倒计时锚点、`sinceDays`、图表里的「当前位置」）都要共用它，否则
 * 「同一份数据 + 同一时刻 → 同一份产物」这条可复现构建的前提就不成立了。
 * 构建期由 BUILD_NOW 钉（验收 A8），后端由请求时刻钉。
 *
 * @param {{resets:object, tweets:object, statsFile:object, now:number, account:string}} input
 * @returns {{chart:object, prediction:object, signals:object, model:object}}
 */
export function derive({ resets, tweets, statsFile, now, account }) {
  const chart = buildChartData(resets.records, now);
  if (!chart) throw new Error('记录不足（至少需要 2 条带时间的记录），无法渲染页面');

  const prediction = predictAll(resets.records, { now });
  // lastResetAt 让「已经兑现的预告」不再展示（见 signals.mjs 里 isExpiredForecast 的注释）。
  // 口径是「最近一次额度事件」，**含发券型 credit** —— 预告兑现与否与那次发放叫什么名字无关。
  const signals = detectSignals(tweets.tweets, {
    now,
    account,
    lastResetAt: latestEventMs(resets.records),
  });
  const model = {
    ...chart,
    generatedAt: statsFile.generated_at ?? new Date(now).toISOString(),
  };
  return { chart, prediction, signals, model };
}

/* ------------------------------- 组装 ------------------------------- */

const tokenOf = (key) => `<!--__${key.toUpperCase()}__-->`;

/**
 * 模板 + 片段 → 完整 HTML。
 *
 * 两道检查都是**抛错**而不是警告：缺占位符说明模板与渲染层脱节，
 * 有占位符没被替换说明渲染层少给了一个键 —— 两种情况都会静默产出半张空白页，
 * 那比构建失败糟糕得多（失败看得见，空白页要等读者来发现）。
 */
export function injectTokens(template, parts) {
  let html = template;
  for (const [key, value] of Object.entries(parts)) {
    const token = tokenOf(key);
    if (!html.includes(token)) throw new Error(`模板缺少占位符 ${token}`);
    // 函数式替换：字符串形式会把内容里的 $& / $1 当特殊序列处理
    html = html.replace(token, () => value);
  }
  const leftover = html.match(/<!--__[A-Z_]+__-->/g);
  if (leftover) throw new Error(`存在未替换的占位符：${leftover.join(', ')}`);
  return html;
}

/**
 * 派生值 + 模板 → 完整 HTML。
 *
 * @param {{template:string, model:object, prediction:object, signals:object,
 *          og:object|null, collect:object, logoUri:string}} input
 */
export function renderPage({ template, model, prediction, signals, og, collect, logoUri }) {
  const parts = renderAll(model, prediction, signals, { og, collect });
  parts.LOGO_URI = logoUri;
  return injectTokens(template, parts);
}

/* ------------------------------ 品牌标 ------------------------------ */

/**
 * 品牌标内联成 data URI。
 *
 * 为什么要内联：产物要能**单独拿走就成立**（本项目页面只有一个 HTML）。
 * 图标则相反 —— 浏览器是独立地、自主地发请求去取 favicon 的，内联不可靠
 * （Safari 尤其），所以那两个 png 走独立文件。两者取舍不同，不是不一致。
 *
 * 两个消费者都要它（构建期写进 dist、后端每次渲染写进响应），所以放在这里
 * 只读一次盘上的同一个文件。
 */
export async function logoDataUri() {
  const buf = await readFile(resolve(ROOT, 'src/assets/logo-96.png'));
  return `data:image/png;base64,${buf.toString('base64')}`;
}
