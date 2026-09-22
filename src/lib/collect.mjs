/**
 * 采集与统计 —— 供 CLI 脚本与后端服务共用。
 *
 * 采集链路有两条：
 *   1) 自建采集：抓 x.com/<account> 的未登录 HTML。页面内嵌 React Server Components
 *      载荷，键名不带引号，因此只能用正则而非 JSON.parse。
 *      免登录、免 API Key（X 官方 Basic 档 $200/月）、零成本 —— 这是长期主链路。
 *   2) 历史回填：公开 API，仅用于冷启动，记录里标注 attribution。
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectSignals } from './signals.mjs';

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
 * 所以有代理时改走 curl 子进程：curl 的代理支持跨平台且成熟，macOS / Linux /
 * GitHub runner / 本项目的 Docker 运行镜像都自带，不引入任何 npm 依赖。
 * 没有代理时仍走原生 fetch —— runner（境外机房）直连即可，那一侧无需代理。
 */
const PROXY_URL =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  null;

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

async function getViaCurl(url, timeout) {
  const { stdout } = await execFileP(
    'curl',
    [
      '-s',
      '-f', // 4xx/5xx 直接非零退出，交给上层的重试处理，而不是把错误页当正文
      '-L',
      '-x',
      PROXY_URL,
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
  const useCurl = Boolean(PROXY_URL) && (await hasCurl());
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      if (useCurl) return await getViaCurl(url, timeout);
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

const RE_CREDIT = /\b(banked|credit|credits)\b/i;
const RE_RESET = /\breset\b/i;
const RE_SCOPE = /\b(limit|limits|usage|allowance|allowances|everyone|all|rate)\b/i;

/** 判定一条推文是否属于「额度事件」，并给出类型 */
export function classify(text) {
  const t = text ?? '';
  const hasReset = RE_RESET.test(t);
  const hasCredit = RE_CREDIT.test(t);
  if (hasCredit && !hasReset) return 'credit';
  if (hasReset && hasCredit) return 'credit'; // 发券型重置
  if (hasReset && RE_SCOPE.test(t)) return 'reset';
  return 'other';
}

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
  const lastLiveAt = live.updated_at ? new Date(live.updated_at).getTime() : 0;
  const liveAgeMs = Date.now() - lastLiveAt;
  const freshEnough =
    opts.skipIfFresherThanMs > 0 && lastLiveAt > 0 && liveAgeMs < opts.skipIfFresherThanMs;
  let skippedFresh = false;

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
    try {
      const fresh = await fetchLiveTweets(opts.account);
      live = { tweets: mergeInto(live.tweets, fresh), updated_at: new Date().toISOString() };
    } catch (err) {
      errors.push(`实时采集失败：${err.message}`);
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
        live = { tweets: mergeInto(live.tweets, hits), updated_at: new Date().toISOString() };
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

  // 3) 信号识别：跟着采集一起算，避免「接口读到的信号」与「页面上的信号」来自不同时刻
  const signals = detectSignals(live.tweets, {
    now: Date.now(),
    account: opts.account,
  });

  await saveJson(resolve(dataDir, 'resets.json'), history);
  await saveJson(resolve(dataDir, 'tweets.json'), live);
  await saveJson(resolve(dataDir, 'signal.json'), signals);
  await saveJson(resolve(dataDir, 'stats.json'), {
    stats,
    generated_at: new Date().toISOString(),
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
    collectedAt: new Date().toISOString(),
  };
}
