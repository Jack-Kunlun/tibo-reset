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
  const ids = new Set();
  for (const b of html.match(/client:([A-Za-z0-9+/=]+):/g) ?? []) {
    try {
      const decoded = Buffer.from(b.slice(7, -1), 'base64').toString('utf8');
      if (decoded.startsWith('Tweet:')) ids.add(decoded.slice(6));
    } catch {
      /* 忽略非 base64 片段 */
    }
  }

  const texts = [...html.matchAll(/full_text:"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    unescapeJs(m[1])
  );
  const times = [...html.matchAll(/created_at_ms:(\d{13})/g)].map((m) => Number(m[1]));

  const sortedIds = [...ids].sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1));

  return texts.map((text, i) => ({
    id: sortedIds[i] ?? null,
    text,
    created_at: times[i] ? new Date(times[i]).toISOString() : null,
  }));
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
 * @param {string} opts.dataDir        数据目录
 * @param {boolean} opts.bootstrap     是否执行历史回填（冷启动用）
 * @param {boolean} opts.skipLive      跳过实时采集（离线自检用）
 * @returns {Promise<{ok:boolean, stats:object, errors:string[]}>}
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
  let live = await readJson(resolve(dataDir, 'tweets.json'), { tweets: [] });
  if (!opts.skipLive) {
    try {
      const fresh = await fetchLiveTweets(opts.account);
      const merged = new Map(live.tweets.map((t) => [t.id ?? t.text.slice(0, 40), t]));
      for (const t of fresh) {
        const key = t.id ?? t.text.slice(0, 40);
        if (!merged.has(key)) merged.set(key, { ...t, first_seen: new Date().toISOString() });
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
    collectedAt: new Date().toISOString(),
  };
}
