/**
 * 采集与统计 —— 供 CLI 脚本与后端服务共用。
 *
 * 采集链路有三条，优先级从高到低：
 *   1) 登录态采集（主链路，见 ./browser.mjs）：驱动本机已登录的 Chrome 滚动收割
 *      完整时间线。未登录的 x.com 只给 profile 首屏 **7 条**原创，覆盖不到
 *      「上一次重置」—— 2026-09-12 那次重置的 5 条全在 7 条窗口之外，
 *      观测台一次都没看见它本该盯住的那件事。
 *   2) 免登录 HTML（降级）：抓 x.com/<account> 首屏，内嵌 React Server Components
 *      载荷键名不带引号，只能用正则而非 JSON.parse。只覆盖最近 7 条，
 *      浏览器路径不可用时（如 CI 无 Chrome）才走这条。
 *   3) 历史回填：公开 API，仅用于冷启动，记录里标注 attribution。
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectSignals, classifyEvent } from './signals.mjs';
import { collectTimeline } from './browser.mjs';
import { resolveProxy } from './proxy.mjs';

const execFileP = promisify(execFile);

export const SOURCE_ACCOUNT = process.env.SOURCE_ACCOUNT || 'thsottiaux';

/**
 * 回复雷达的监控对象池。
 *
 * 为什么需要它：Tibo 的重置预告**经常出现在「他回复别人的推文」里**，而不在他的原创流。
 * 实测（2026-09-22）：未登录 x.com 的 profile 首屏只返回最近 7 条**原创**推文，
 * 回复不进这个流；`/with_replies` 与 `/search` 在未登录态都只返回「JavaScript is not
 * available」空壳页。唯一能拿到回复的地方是**别人推文的详情页**（已验证可读、且能
 * 提取每条回复的作者）。所以要盯住「他会去回复的人」。
 *
 * 池子怎么扩：每轮把雷达命中的「被回复者」记录下来（radar.json），
 * 这些是经证实会引来他回复的账号，值得在下一轮加进池子。
 */
export const RADAR_ACCOUNTS = (process.env.RADAR_ACCOUNTS || 'udiWertheimer')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const HISTORY_API = 'https://codex-resets.com/api/v1/resets?limit=100';

/**
 * 隔多久强制走一次**全量回溯**（小时）。
 *
 * 增量采集靠「翻到已入库的推文就停」省时间，代价是它假设时间线连续且单调向下：
 *   · X 的虚拟列表在两次收割之间会把渲染过的条目卸载，偶尔丢一屏；
 *   · 他会删推、也会发完再改（引用/重发）；
 * 这些洞增量**永远补不回来**（它看到已知的就停了）。所以必须周期性从头翻一次。
 *
 * 72 小时是个保守值：按每周 2–3 次的重置频率，三天内至少覆盖一次完整重置周期。
 */
export const DEFAULT_FULL_SCAN_HOURS = 72;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/* ------------------------------- 基础工具 ------------------------------- */

/**
 * 出口代理。
 *
 * x.com 在境内被 DNS 污染（实测解析到 Fastly 的 151.101.66.146，curl 直连 http=000），
 * 必须走代理才连得上。而 **Node 内置 fetch 不读 HTTPS_PROXY / https_proxy**
 * —— 对照实验：设与不设都是 `fetch failed`（Node 24 需额外开 NODE_USE_ENV_PROXY=1）。
 *
 * 代理地址**不直接取环境变量**，而是交给 `resolveProxy()` 实测探测 —— 本机的
 * `HTTPS_PROXY` 指的是沙箱自己的出口端口，连不通 x.com。原因与代价写在
 * ./proxy.mjs 顶部，这里只调用。
 *
 * 探测到代理时改走 curl 子进程：curl 的代理支持跨平台且成熟，macOS / Linux /
 * GitHub runner / 本项目的 Docker 运行镜像都自带，不引入任何 npm 依赖。
 * 没有可用代理时走原生 fetch —— runner（境外机房）直连即可，那一侧无需代理。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let curlProbe = null;
async function hasCurl() {
  if (curlProbe !== null) return curlProbe;
  try {
    await execFileP('curl', ['--version'], { timeout: 5_000 });
    curlProbe = true;
  } catch {
    curlProbe = false;
  }
  return curlProbe;
}

async function getViaCurl(url, timeout, proxyUrl) {
  const { stdout } = await execFileP(
    'curl',
    [
      '-s',
      '-f', // 4xx/5xx 直接非零退出，交给上层的重试处理，而不是把错误页当正文
      '-L',
      '-x',
      proxyUrl,
      '-A',
      UA,
      '-H',
      'accept: text/html,application/json,*/*',
      '--max-time',
      String(Math.max(1, Math.round(timeout / 1000))),
      url,
    ],
    { maxBuffer: 48 * 1024 * 1024, encoding: 'utf8' }
  );
  return stdout;
}

export async function get(url, tries = 3, timeout = 25_000) {
  const proxyUrl = await resolveProxy();
  const useCurl = Boolean(proxyUrl) && (await hasCurl());
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      if (useCurl) return await getViaCurl(url, timeout, proxyUrl);
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/json,*/*' },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (i < tries) await sleep(1200 * i);
    }
  }
  throw lastErr;
}

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写：先写临时文件再 rename，避免读取方看到半截 JSON */
export async function saveJson(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await rename(tmp, path);
}

function unescapeJs(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/* --------------------------- 自建采集：X 页面 --------------------------- */

export function parseTweets(html) {
  const tweets = [];

  // 逐条推文**就近配对**，而不是「全部 full_text 抓成一个数组、全部 created_at_ms 抓成另一个数组，
  // 再按索引硬配」。后者有个必然的错位：payload 里除了推文，用户对象也带 created_at_ms
  // （UserCore 的账号注册时间），多出来的那一个会把整条链推歪一位 ——
  // 实测 7 条推文配到 8 个时间戳，第一条推文的时间被写成账号注册时间 2025-08-07，
  // 而它实际是 2026-09-19 发的。这个错误会一路传到「距上次重置多少天」这个核心数字上。
  //
  // RSC payload 里同一条推文的字段是聚在一起的，所以就近取就够：
  //   client:<base64 "Tweet:id">:legacy  = { … }                                  ← id 在这
  //   client:<base64 "Tweet:id">:details = { full_text:"…", …, created_at_ms:… }  ← 正文与时间在这
  // 实测 id 在正文前 < 1000 字符，时间在正文后 < 500 字符，下面的窗口都留了数倍余量。
  for (const m of html.matchAll(/full_text:"((?:[^"\\]|\\.)*)"/g)) {
    const at = m.index;

    // id：向前找最近的 Tweet 类型 key
    let id = null;
    const before = html.slice(Math.max(0, at - 4000), at);
    const keys = [...before.matchAll(/client:([A-Za-z0-9+/=]+):/g)];
    for (let i = keys.length - 1; i >= 0; i--) {
      let decoded;
      try {
        decoded = Buffer.from(keys[i][1], 'base64').toString('utf8');
      } catch {
        continue; // 不是 base64 的片段，跳过
      }
      if (decoded.startsWith('Tweet:')) {
        id = decoded.slice(6);
        break;
      }
    }

    // created_at_ms：向后找最近的一个；窗口上限取下一条推文正文之前，避免越界借用别人的时间
    const after = html.slice(at, at + 2500);
    const t = after.match(/created_at_ms:(\d{13})/);

    tweets.push({
      id,
      text: unescapeJs(m[1]),
      created_at: t ? new Date(Number(t[1])).toISOString() : null,
    });
  }

  return tweets;
}

/* --------------------------- 详情页解析（雷达用） --------------------------- */

/** 作者标识与正文之间的最大距离。实测 1.9k–3.7k 字符，这里留到 12k 余量。 */
const AUTHOR_WINDOW = 12_000;

/**
 * 解析推文详情页：主推文 + 回复列表，每条都带作者。
 *
 * 配对依据是 payload 里的**物理顺序**：一条推文的作者 `screen_name` 出现在它的
 * `full_text` 之前（实测每条都在 3.7k 字符内，见 docs/data-source.md）。
 * 所以「前向最近的 screen_name」就是该条正文的作者 —— 与 parseTweets 同一种
 * 就近配对思路，而不是先各自抓成数组再按索引硬配（那样一有错位就整条链歪掉）。
 *
 * 主推文在页面上出现的次数不固定（实测 2 次），按 id 去重。
 */
export function parseTweetDetail(html, focalId = null) {
  const marks = [...html.matchAll(/screen_name:"([^"]+)"/g)].map((m) => ({ name: m[1], at: m.index }));
  const items = [];

  for (const m of html.matchAll(/full_text:"((?:[^"\\]|\\.)*)"/g)) {
    const at = m.index;

    let id = null;
    const before = html.slice(Math.max(0, at - 6000), at);
    const keys = [...before.matchAll(/client:([A-Za-z0-9+/=]+):/g)];
    for (let i = keys.length - 1; i >= 0; i--) {
      let decoded;
      try {
        decoded = Buffer.from(keys[i][1], 'base64').toString('utf8');
      } catch {
        continue;
      }
      if (decoded.startsWith('Tweet:')) {
        id = decoded.slice(6);
        break;
      }
    }

    const prev = marks.filter((x) => x.at < at).pop();
    const account = prev && at - prev.at <= AUTHOR_WINDOW ? prev.name : null;

    const t = html.slice(at, at + 2500).match(/created_at_ms:(\d{13})/);

    items.push({
      id,
      account,
      text: unescapeJs(m[1]),
      created_at: t ? new Date(Number(t[1])).toISOString() : null,
    });
  }

  const seen = new Set();
  const uniq = items.filter((x) => {
    const key = x.id ?? x.text.slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const idx = focalId ? uniq.findIndex((x) => x.id === focalId) : -1;
  const focal = idx >= 0 ? uniq[idx] : uniq[0] ?? null;

  return { focal, replies: uniq.filter((x) => x !== focal) };
}

/* ----------------------------- 事件分类 ----------------------------- */

/**
 * 归类一条推文是否属于「额度事件」，并给出类型（`kind` 字段）。
 *
 * ⚠ 这里**只是转发** signals.mjs 的判定，不再自带一份词表。
 *
 * 它曾经是自带的一份，于是同一份数据被两套词表判出两个结论：
 *   · 识别侧（signals.mjs）把「Reset all propagated」当「已完成的过去事件」丢掉；
 *   · 采集侧这份靠词表里的 `all` 把它蒙成 reset —— 可那个 all 是
 *     「全部传播完毕」，跟额度毫无关系，纯属巧合。
 * 同一天的「Hi Astra users. A reset and a quick update…」没有 all，
 * 就被这份词表判成 other。两条最该被记录的数据，一条靠巧合、一条判错。
 */
export const classify = classifyEvent;

/* ------------------------------- 采集入口 ------------------------------- */

export async function fetchLiveTweets(account = SOURCE_ACCOUNT) {
  const html = await get(`https://x.com/${account}`);
  return parseTweets(html)
    .filter((t) => t.text)
    .map((t) => ({
      ...t,
      kind: classify(t.text),
      account,
      // profile 首屏流里出现的都是原创推文（回复不进这个流），据此标注来源。
      // 雷达捞回来的回复标 role:'reply' 并带 inReplyTo 上下文。
      role: 'post',
      foundVia: 'timeline',
      inReplyTo: null,
    }));
}

/**
 * 登录态采集：驱动本机已登录的 Chrome，滚动收割时间线。
 *
 * 失败一律抛错，把「要不要降级」留给调用方决定。这里的失败都是**静默丢数据**
 * 型的（profile 过期退回未登录、页面结构变了、收割到 0 条）—— 吞掉它，
 * 表面上一切正常，实际覆盖范围已经悄悄缩回 7 条。
 *
 * @param {string} account
 * @param {{sinceMs?:number, knownIds?:Iterable<string>|null, maxSteps?:number,
 *          onProgress?:Function}} opts
 *        `knownIds` 里的视为已入库，采集器翻到「连续整屏都是已知」即停 ——
 *        这是增量的实现方式（X 没有按时间范围查询的入口，只能从最新往下翻）。
 *        传 null / 空集合 = 全量回溯到 `sinceMs` 下界。
 */
export async function fetchLiveTweetsViaBrowser(account = SOURCE_ACCOUNT, opts = {}) {
  const result = await collectTimeline({
    handle: account,
    sinceMs: opts.sinceMs ?? 0,
    knownIds: opts.knownIds ?? null,
    maxSteps: opts.maxSteps,
    // Chrome 也必须走同一个（实测出来的）代理。
    // 早先这里没传，Chrome 便一路用系统/环境代理 —— 而沙箱注入的那个连不通 x.com。
    proxy: opts.proxy,
    onProgress: opts.onProgress,
  });
  if (!result.loggedIn) throw new Error('Chrome profile 未登录 x.com');
  if (!result.tweets.length) throw new Error('浏览器收割到 0 条推文');
  return {
    tweets: result.tweets.map((t) => ({
      ...t,
      kind: classify(t.text),
      account,
      role: 'post',
      foundVia: 'timeline-browser',
      inReplyTo: null,
    })),
    mode: result.mode,
    stoppedBy: result.stoppedBy,
    steps: result.steps,
  };
}

/**
 * 本轮采集的时间下界：上一次**明确重置**再往前留一段缓冲。
 *
 * 为什么不硬切在重置那一刻：重置当天的前序预告常早于最终确认推文。
 * 2026-09-12 那组正是如此 —— 03:20「Hi Astra users. A reset and a quick update…」
 * 在前，08:09「Reset all propagated」在后，相隔 5 小时。硬切在 08:09 会把
 * 03:20 那条切掉，而它恰恰是本轮最该被看见的一条。
 *
 * 返回 0 表示没有可用锚点（尚无历史记录），此时不做下界裁剪。
 */
export function resetFloorMs(records, bufferHours = 24) {
  const latest = (records ?? [])
    .filter((r) => r?.type === 'reset' && r.announced_at)
    .sort((a, b) => new Date(b.announced_at) - new Date(a.announced_at))[0];
  if (!latest) return 0;
  return new Date(latest.announced_at).getTime() - bufferHours * 3_600_000;
}

export async function fetchHistory() {
  const raw = JSON.parse(await get(HISTORY_API));
  return (raw?.data ?? []).map((r) => ({
    id: r.id,
    announced_at: r.announced_at,
    type: r.reset_type === 'banked' ? 'credit' : 'reset',
    text: r.text ?? '',
    url: r.source?.url ?? null,
    attribution: 'codex-resets.com',
  }));
}

/* ------------------------------- 回复雷达 ------------------------------- */

/**
 * 值得开详情页去看一眼的推文。
 *
 * 抓详情页比抓首屏贵得多（一条一次请求），所以先筛：只有「跟他／Codex 有关」的推文
 * 才可能引来他的回复。这是**代价换覆盖率**的取舍 —— 筛掉的一律不进雷达，
 * 所以宁可放宽（多花几次请求），不要过窄。
 */
const RE_RADAR_HINT =
  /\b(reset|resetting|resets|limits?|usage|allowance|quota|credits?|banked|codex|rate limit)\b|@thsottiaux\b/i;

export function pickRadarCandidates(tweets) {
  return (tweets ?? []).filter((t) => t?.id && RE_RADAR_HINT.test(t.text ?? ''));
}

/**
 * 雷达实际用的排序：命中的排前面，其余按时间从新到旧跟在后面。
 *
 * 为什么不直接**过滤**掉未命中的：这条闸门本身就会漏掉真正重要的那种推文。
 * 2026-09-21 那次，Tibo 回复的原推文是「你们这周没发布什么有意思的东西」——
 * 额度词出现在同一串推文的下一段里纯属运气；如果他只写那一句，过滤式闸门
 * 会把它整条丢掉，而回复里的承诺（"still coming in Tuesday"）也就跟着丢了。
 *
 * 所以筛选只用来**排序**，不用来排除。名额（radarLimit）用完为止，
 * 高价值目标优先，剩下的名额仍然抽样 —— 宁可多花几次请求，不要静默漏掉。
 */
export function rankRadarCandidates(tweets) {
  const hit = (t) => (RE_RADAR_HINT.test(t.text ?? '') ? 1 : 0);
  return (tweets ?? [])
    .filter((t) => t?.id)
    .sort((a, b) => hit(b) - hit(a) || new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0));
}

/**
 * 在候选推文的详情页里找 targetAccount 的回复。
 *
 * 已知边界（必须说清楚，不能把「没找到」当成「不存在」）：
 *   详情页只渲染**部分**回复 —— 实测一条有 50 条回复的推文，页面上只给了 3 条。
 *   所以雷达是**抽样**不是**穷举**：命中说明那条回复确实存在；没命中**不能**推断
 *   他没回复过。X 会把高影响力账号的回复往上顶，这是它能工作的前提，但不是保证。
 */
export async function scanReplies(targetAccount, candidates, opts = {}) {
  const limit = opts.limit ?? 6;
  const gapMs = opts.gapMs ?? 900; // 限流礼貌间隔
  const hits = [];
  const scanned = [];

  for (const c of candidates.slice(0, limit)) {
    const rec = { account: c.account, tweetId: c.id };
    try {
      const html = await get(`https://x.com/${c.account}/status/${c.id}`, 2, opts.timeout ?? 25_000);
      const { focal, replies } = parseTweetDetail(html, c.id);
      const mine = replies.filter(
        (r) => (r.account ?? '').toLowerCase() === targetAccount.toLowerCase()
      );
      rec.repliesOnPage = replies.length;
      rec.hits = mine.length;
      for (const r of mine) {
        hits.push({
          id: r.id,
          account: targetAccount,
          text: r.text,
          created_at: r.created_at,
          role: 'reply',
          foundVia: 'radar',
          // 上下文 = 他回应的那条推文。识别算法要靠它 —— 他的回复本身常常一个额度词
          // 都没有（「OK fine. But it's also still coming in Tuesday」），
          // 只有连着被回复的内容，才读得出「这是在说重置」。
          inReplyTo: {
            account: c.account,
            id: c.id,
            text: focal?.text ?? c.text,
            created_at: focal?.created_at ?? c.created_at,
          },
        });
      }
    } catch (err) {
      rec.error = err.message;
    }
    scanned.push(rec);
    if (gapMs) await sleep(gapMs);
  }

  return { hits, scanned };
}

/* ------------------------------- 统计 ------------------------------- */

export function buildStats(records) {
  const asc = [...records]
    .filter((r) => r.announced_at)
    .sort((a, b) => new Date(a.announced_at) - new Date(b.announced_at));

  const values = [];
  for (let i = 1; i < asc.length; i++) {
    values.push((new Date(asc[i].announced_at) - new Date(asc[i - 1].announced_at)) / 86_400_000);
  }

  const sum = values.reduce((a, b) => a + b, 0);
  const avg = values.length ? sum / values.length : 0;
  const sorted = [...values].sort((a, b) => a - b);
  const variance = values.length
    ? values.reduce((a, b) => a + (b - avg) ** 2, 0) / values.length
    : 0;

  const last = asc[asc.length - 1];
  return {
    total: asc.length,
    first_at: asc[0]?.announced_at ?? null,
    last_at: last?.announced_at ?? null,
    last_text: last?.text ?? null,
    days_since_last: last ? (Date.now() - new Date(last.announced_at)) / 86_400_000 : null,
    avg_interval_days: avg,
    median_interval_days: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    sd_interval_days: Math.sqrt(variance),
    longest_wait_days: values.length ? Math.max(...values) : 0,
    shortest_wait_days: values.length ? Math.min(...values) : 0,
    credit_count: asc.filter((r) => r.type === 'credit').length,
    reset_count: asc.filter((r) => r.type === 'reset').length,
    hit_within_avg: values.length ? values.filter((v) => v <= avg).length / values.length : 0,
  };
}

/* ------------------------------- 主流程 ------------------------------- */

/**
 * 采集 + 合并 + 落盘。
 *
 * @param {object} opts
 * @param {string} opts.dataDir               数据目录
 * @param {boolean} opts.bootstrap            是否执行历史回填（冷启动用）
 * @param {boolean} opts.skipLive             跳过实时采集（离线自检用）
 * @param {number} opts.skipIfFresherThanMs   数据比这个时限还新时，直接跳过实时采集
 * @returns {Promise<{ok:boolean, stats:object, errors:string[], skippedFresh:boolean}>}
 */
export async function runCollection(opts = {}) {
  const dataDir = opts.dataDir ?? resolve(process.cwd(), 'data');
  const errors = [];
  let radarReport = null;
  await mkdir(dataDir, { recursive: true });

  // 1) 历史记录
  let history = await readJson(resolve(dataDir, 'resets.json'), { records: [] });
  if ((opts.bootstrap || history.records.length === 0) && !opts.skipLive) {
    try {
      history = {
        records: await fetchHistory(),
        bootstrapped_at: new Date().toISOString(),
      };
    } catch (err) {
      errors.push(`历史回填失败：${err.message}`);
    }
  }
  history.records = history.records
    .filter((r) => r.announced_at)
    .sort((a, b) => new Date(b.announced_at) - new Date(a.announced_at));

  // 2) 实时推文
  //
  // 新鲜度短路（opts.skipIfFresherThanMs）：数据已经足够新时，本轮连请求都不发。
  //
  // 为什么需要它：采集有两处发起方 —— 本机（住宅出口，能过 Cloudflare）与 CI（机房 IP，
  // 被 Cloudflare 挑战）。本机是主链路，CI 只是兜底。若 CI 不看数据新鲜度照样去采，
  // 它那次注定失败，会把 stats.json 的 errors 写成非空，于是本机刚清掉的
  // 「数据采集异常」横幅又被贴回页面上 —— 明明数据是新鲜的，却告警说采不到。
  // 有了短路，CI 只在数据确实陈旧时才尝试，那种失败才是真该告警的情况。
  let live = await readJson(resolve(dataDir, 'tweets.json'), { tweets: [] });
  const prevStats = await readJson(resolve(dataDir, 'stats.json'), {});
  const lastLiveAt = live.updated_at ? new Date(live.updated_at).getTime() : 0;
  const liveAgeMs = Date.now() - lastLiveAt;
  const freshEnough =
    opts.skipIfFresherThanMs > 0 && lastLiveAt > 0 && liveAgeMs < opts.skipIfFresherThanMs;
  let skippedFresh = false;
  /** 本轮实时数据来自哪条链路：'browser'（登录态，完整）| 'html'（降级，仅 7 条）。 */
  let liveSource = null;
  /** 登录态采集的时间下界（ISO），即「上一次重置 - 缓冲」。 */
  let coverageSince = null;
  /** 本轮走的是增量还是全量回溯（供落盘与 CLI 展示）。 */
  let collectMode = null;
  /** 采集器是「怎么停下来的」：known / floor / no-more / exhausted。 */
  let stoppedBy = null;
  /** 本轮真正新增（库里此前没有）的推文条数。 */
  let newCount = 0;
  /** 本轮是否真的完成了全量回溯（用于推进 stats.json 的 last_full_at）。 */
  let didFullScan = false;

  // 把一批推文并进 live。已存在的**用新版本覆盖**，而不是跳过 ——
  // 只有「只增不改」时，解析器修好了、旧数据里的错值也回不来（2026-09-21 修掉的
  // 时间戳错位，就是靠这一步把已有推文的时间纠正过来的）。
  // 唯一保留的是 first_seen：它是本地记账（我们最早看到这条的时刻），
  // 不是推文自身的属性，不该被覆盖。
  const mergeInto = (base, incoming) => {
    const merged = new Map(base.map((t) => [t.id ?? t.text.slice(0, 40), t]));
    const now = new Date().toISOString();
    for (const t of incoming) {
      const key = t.id ?? t.text.slice(0, 40);
      const prev = merged.get(key);
      merged.set(
        key,
        prev ? { ...prev, ...t, first_seen: prev.first_seen ?? now } : { ...t, first_seen: now }
      );
    }
    return [...merged.values()].sort(
      (a, b) => new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0)
    );
  };

  if (opts.skipLive) {
    // 离线自检：不碰网络，只重算统计
  } else if (freshEnough) {
    skippedFresh = true;
  } else {
    // 主链路是登录态浏览器采集。CI 上没有 Chrome、也没有登录 profile，
    // 所以默认只在非 CI 环境尝试；显式传 opts.browser 可覆盖。
    const useBrowser = opts.browser ?? (process.env.X_BROWSER !== '0' && !process.env.CI);
    const floor = opts.sinceMs ?? resetFloorMs(history.records, opts.resetBufferHours);

    // 增量 / 全量。默认增量（快），周期性强制全量回补。
    //
    // 增量怎么省时间：X 的时间线只能从最新往下翻，没有「给我 09-20 到 09-22」这种
    // 查询入口（GraphQL 的时间线接口在未登录/受控路由下一律 404，已实测）。所以
    // 「只取未读部分」＝ 翻到「连续整屏都是已入库的推文」就停。滚动深度于是从
    // 「翻到上一次重置那天」缩到「翻到上次见到的最新一条」，通常 2–5 步。
    //
    // 为什么还必须周期性全量：增量只在「时间线连续且单调向下」时成立。虚拟列表
    // 抖动会丢整屏、他也会删推 —— 这些洞增量永远补不回来（它看到已知的就停了）。
    const fullScanMs = (opts.fullScanHours ?? DEFAULT_FULL_SCAN_HOURS) * 3_600_000;
    const lastFullAt = prevStats.last_full_at ? new Date(prevStats.last_full_at).getTime() : 0;
    const knownIds = live.tweets.map((t) => t.id).filter(Boolean);
    const wantFull =
      opts.full === true ||
      knownIds.length === 0 || // 库里什么都没有，增量无从谈起
      !lastFullAt ||
      Date.now() - lastFullAt > fullScanMs;

    let fresh = null;
    let browserError = null;
    if (useBrowser) {
      try {
        const r = await fetchLiveTweetsViaBrowser(opts.account, {
          sinceMs: floor,
          knownIds: wantFull ? null : knownIds,
          maxSteps: opts.maxSteps,
          proxy: await resolveProxy(),
          onProgress: opts.onProgress,
        });
        fresh = r.tweets;
        liveSource = 'browser';
        collectMode = r.mode;
        stoppedBy = r.stoppedBy;
        didFullScan = r.mode === 'full';
        if (floor > 0) coverageSince = new Date(floor).toISOString();
      } catch (err) {
        browserError = err.message;
      }
    }

    // 降级：免登录首屏。
    //
    // 这条路径只覆盖最近 7 条 —— 它「聊胜于无」，不是「够用」。2026-09-12 那次
    // 重置的 5 条全在 7 条之外，正是覆盖不足导致观测台漏掉了自己该盯的事。
    // 所以降级这件事必须**写进数据里**（tweets.json 的 source / degraded），
    // 不能被当成正常情况。
    if (!fresh) {
      try {
        fresh = await fetchLiveTweets(opts.account);
        liveSource = 'html';
        collectMode = 'degraded';
        didFullScan = false;
      } catch (err) {
        errors.push(
          `实时采集失败：${err.message}${browserError ? `（浏览器路径：${browserError}）` : ''}`
        );
      }
    }

    if (fresh) {
      const known = new Set(knownIds);
      newCount = fresh.filter((t) => t.id && !known.has(t.id)).length;

      // ⚠ 用展开旧对象的方式更新，而不是**重建**对象。
      //
      // 重建会丢掉本轮没有重新赋值的字段 —— `coverage_since` 就踩过这个坑：
      // 降级走 html 路径时它不被赋值，于是「覆盖范围从上次重置算起」这条关键
      // 元信息在降级一轮后凭空消失，页面对覆盖范围的声明也就没了依据。
      const next = {
        ...live,
        tweets: mergeInto(live.tweets, fresh),
        updated_at: new Date().toISOString(),
        source: liveSource,
      };
      delete next.degraded;
      if (coverageSince) next.coverage_since = coverageSince;
      if (liveSource === 'html' && browserError) next.degraded = browserError;
      live = next;
    }

    // 2b) 回复雷达：他的预告常出现在「他回复别人的推文」里，而回复不进 profile 首屏。
    //     这里盯住一批「他会去回复的人」，抓他们推文的详情页，从他的回复中捞。
    //
    //     雷达失败**不进 errors**：它是一条增强通道，挂了不该让整轮采集判失败、
    //     更不该把一个「数据采集异常」横幅贴到页面上（数据本身是好的）。
    //     但也不能静默 —— 失败与命中都写进 radar.json，CLI 会打印出来。
    if (opts.radar) {
      const target = opts.account ?? SOURCE_ACCOUNT;
      const pool = (opts.radarAccounts ?? RADAR_ACCOUNTS).filter(
        (a) => a.toLowerCase() !== target.toLowerCase()
      );
      const scanned = [];
      const hits = [];
      const radarErrors = [];

      for (const acct of pool) {
        try {
          const list = await fetchLiveTweets(acct);
          const cands = rankRadarCandidates(list);
          const r = await scanReplies(target, cands, {
            limit: opts.radarLimit ?? 6,
            gapMs: opts.radarGapMs ?? 900,
          });
          hits.push(...r.hits);
          scanned.push(...r.scanned.map((s) => ({ ...s, monitor: acct })));
        } catch (err) {
          radarErrors.push(`${acct}：${err.message}`);
        }
      }

      if (hits.length) {
        live = {
          ...live,
          tweets: mergeInto(live.tweets, hits),
          updated_at: new Date().toISOString(),
        };
      }

      // 历次命中过的「被回复者」值得在下一轮继续盯（经证实他会去回复这些人）
      const prevRadar = await readJson(resolve(dataDir, 'radar.json'), {});
      const targets = { ...(prevRadar.targets ?? {}) };
      const stamp = new Date().toISOString();
      for (const h of hits) {
        const name = h.inReplyTo?.account;
        if (!name) continue;
        targets[name] = {
          hits: (targets[name]?.hits ?? 0) + 1,
          lastHitAt: stamp,
        };
      }

      radarReport = {
        updated_at: stamp,
        pool,
        targets,
        lastRun: { scanned, hits: hits.length, errors: radarErrors },
      };
      await saveJson(resolve(dataDir, 'radar.json'), radarReport);
    }
  }

  // 短路时到此为止：本轮什么都没做，就不该写任何文件。
  //
  // 写了会让「有无变化」的判断失去意义 —— stats.json 的 generated_at 是采集运行时刻，
  // 每轮都会变，CI 就会为它单独提交一次，于是每 30 分钟污染一条提交历史，
  // 而数据其实一个字都没动（这正是此前 48 条提交/天的来源）。
  // 不写文件，「没变化」就真的意味着没变化。
  if (skippedFresh) {
    return {
      ok: errors.length === 0,
      stats: buildStats(history.records),
      signals: await readJson(resolve(dataDir, 'signal.json'), {}),
      errors,
      skippedFresh: true,
      liveAgeMs,
      collectedAt: new Date().toISOString(),
    };
  }

  const stats = buildStats(history.records);

  // 3) 信号识别：跟着采集一起算，避免「接口读到的信号」与「页面上的信号」来自不同时刻。
  //
  //    分析按**时间窗**读推文，不是「取最近 N 条」：
  //      · 下界取「最近 lookbackDays 天」与「上次重置 - 缓冲」里更早的那个，
  //        这样既覆盖他近期的公开发言，又保证「上一次重置以来」的全部都在窗内
  //        （两者取更早者，谁更长听谁的）；
  //      · 上界就是 now。
  //    窗口本身写进 signal.json（windowFrom / windowTo），可复核，不是隐含假设。
  const signals = detectSignals(live.tweets, {
    now: Date.now(),
    account: opts.account,
    sinceMs: opts.sinceMs ?? resetFloorMs(history.records, opts.resetBufferHours),
  });

  await saveJson(resolve(dataDir, 'resets.json'), history);
  await saveJson(resolve(dataDir, 'tweets.json'), live);
  await saveJson(resolve(dataDir, 'signal.json'), signals);
  await saveJson(resolve(dataDir, 'stats.json'), {
    stats,
    generated_at: new Date().toISOString(),
    // 本轮采集的形态。留档是为了让「上次是全量还是增量」可复核 ——
    // 连续多轮增量之后，漏检风险是靠一次全量回补清掉的，这件事得看得见。
    collect: {
      mode: collectMode,
      source: liveSource,
      stoppedBy,
      newTweets: newCount,
      knownCount: live.tweets.length - newCount,
    },
    last_full_at: didFullScan ? new Date().toISOString() : (prevStats.last_full_at ?? null),
    errors,
  });

  return {
    ok: errors.length === 0,
    stats,
    signals,
    errors,
    radar: radarReport,
    skippedFresh,
    liveAgeMs,
    source: liveSource,
    coverageSince,
    mode: collectMode,
    stoppedBy,
    newCount,
    tweetCount: live.tweets.length,
    collectedAt: new Date().toISOString(),
  };
}
