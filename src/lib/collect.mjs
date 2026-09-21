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
import { detectSignals } from './signals.mjs';

export const SOURCE_ACCOUNT = process.env.SOURCE_ACCOUNT || 'thsottiaux';
export const HISTORY_API = 'https://codex-resets.com/api/v1/resets?limit=100';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/* ------------------------------- 基础工具 ------------------------------- */

export async function get(url, tries = 3, timeout = 25_000) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/json,*/*' },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (i < tries) await new Promise((r) => setTimeout(r, 1200 * i));
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
    .map((t) => ({ ...t, kind: classify(t.text), account }));
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

  if (opts.skipLive) {
    // 离线自检：不碰网络，只重算统计
  } else if (freshEnough) {
    skippedFresh = true;
  } else {
    try {
      const fresh = await fetchLiveTweets(opts.account);
      const merged = new Map(live.tweets.map((t) => [t.id ?? t.text.slice(0, 40), t]));
      const now = new Date().toISOString();
      for (const t of fresh) {
        const key = t.id ?? t.text.slice(0, 40);
        const prev = merged.get(key);
        // 已存在时**用本轮采集覆盖**，而不是跳过。
        // 只有「只增不改」时，解析器修好了、旧数据里的错值也回不来 ——
        // 例如 2026-09-21 修掉的时间戳错位，就是靠这一步把已有推文的时间纠正过来的。
        // 唯一保留的是 first_seen：它是本地记账（我们最早看到这条的时刻），
        // 不是推文自身的属性，不该被覆盖。
        merged.set(key, prev ? { ...prev, ...t, first_seen: prev.first_seen ?? now } : { ...t, first_seen: now });
      }
      live = {
        tweets: [...merged.values()].sort(
          (a, b) => new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0)
        ),
        updated_at: new Date().toISOString(),
      };
    } catch (err) {
      errors.push(`实时采集失败：${err.message}`);
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
    skippedFresh,
    liveAgeMs,
    collectedAt: new Date().toISOString(),
  };
}
