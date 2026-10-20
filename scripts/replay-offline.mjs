#!/usr/bin/env node
/**
 * 离线重放：把**已核验的作者原帖**按当前识别逻辑重新合并进历史库，并重算信号与统计。
 *
 * 为什么需要它（2026-10-20 D-068 踩出来的坑）：
 *   识别逻辑改了以后，历史库里已有的记录可能需要重判 —— 比如某条推文被核实是
 *   「随帖落地」而不是「预告」，那它就该进历史库、推进「距上次重置」。
 *   但 `runCollection` 跑的是真采集（要浏览器、要网络），不适合这种「只重判不改数据源」的场景。
 *
 * ⛔ **本脚本必须推进 `stats.json` 的 `generated_at`**：
 *   `generated_at` 是 `/api/ingest` 的**幂等键**（服务端只在载荷更新时才落盘）。
 *   D-068 手工改了 `resets.json` / `stats.json` / `signal.json` 三个文件却没动
 *   `generated_at`，结果推送被服务端判成 stale 丢弃 —— **数据改了但线上永远看不到**。
 *   所以「重算数据」和「推得上去」必须绑在同一个动作里，不能靠手工对齐时间戳。
 *
 * 用法：
 *   node scripts/replay-offline.mjs              # 预览（只打印，不落盘）
 *   node scripts/replay-offline.mjs --write      # 落盘
 *   node scripts/replay-offline.mjs --write --push   # 落盘并推送（需要 INGEST_URL / INGEST_TOKEN）
 *
 * ⚠ **不做采集**：不碰 `tweets.json` 的采集来源，只用库里已有的推文重判。
 *   「权威时刻」取原帖的 `created_at`，不是本脚本运行的时刻。
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeConfirmedResets, buildStats, saveJson } from '../src/lib/collect.mjs';
import { detectSignals, latestEventMs } from '../src/lib/signals.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');

const write = process.argv.includes('--write');
const push = process.argv.includes('--push');
const account = 'thsottiaux';

const readJson = async (p, fallback) => {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
};

const history = await readJson(resolve(DATA, 'resets.json'), { records: [] });
const live = await readJson(resolve(DATA, 'tweets.json'), { tweets: [] });
const prevStats = await readJson(resolve(DATA, 'stats.json'), {});

const tweets = live.tweets ?? [];
const now = Date.now();

// 1) 用当前识别逻辑重合并历史库 —— 这是「重放」的核心。
const merged = mergeConfirmedResets(history.records, tweets, { now, account });
const records = merged.records;

// 2) 重算信号：与 runCollection 同口径（lastResetAt 取合并后的最新事件）。
const signals = detectSignals(tweets, {
  now,
  account,
  lastResetAt: latestEventMs(records),
});

// 3) 重算统计。
const stats = buildStats(records);

// 4) ⭐ 推进 `generated_at` —— ingest 的幂等键。不推进的话推送会被判 stale 丢弃。
const generatedAt = new Date().toISOString();

const statsPayload = {
  stats,
  generated_at: generatedAt,
  // 留档形态沿用上一轮，但标出这是离线重放而不是采集轮 ——
  // 免得以后看到「source: browser」误以为真跑了一次浏览器采集。
  collect: {
    ...(prevStats.collect ?? {}),
    carriedOver: true,
    offlineReplay: true,
    replayedAt: generatedAt,
  },
  history: {
    ...(prevStats.history ?? {}),
    changed: merged.added > 0 || merged.updated > 0,
    confirmedAdded: merged.added,
    confirmedUpdated: merged.updated,
    upstreamCount: records.length,
    refreshedAt: generatedAt,
  },
  last_full_at: prevStats.last_full_at ?? null,
  errors: prevStats.errors ?? [],
};

console.log('· 离线重放预览');
console.log(`  推文 ${tweets.length} 条 · 历史记录 ${history.records.length} → ${records.length}`);
console.log(`  新增 ${merged.added} · 更新 ${merged.updated}`);
console.log(`  最近重置 ${stats.last_at}`);
console.log(`  预告 ${signals.forecasts.length} · 已发生 ${signals.occurred.length}`);
console.log(`  generated_at ${generatedAt}`);

if (!write) {
  console.log('· 未加 --write，只预览不落盘');
  process.exit(0);
}

await saveJson(resolve(DATA, 'resets.json'), { records });
await saveJson(resolve(DATA, 'signal.json'), signals);
await saveJson(resolve(DATA, 'stats.json'), statsPayload);
console.log('· 已落盘：resets.json / signal.json / stats.json');

if (push) {
  const url = process.env.INGEST_URL ?? '';
  const token = process.env.INGEST_TOKEN ?? '';
  if (!url || !token) {
    console.error('✗ 推送需要 INGEST_URL 与 INGEST_TOKEN');
    process.exit(1);
  }
  const payload = {
    generatedAt,
    resets: { records },
    tweets: live,
    stats: statsPayload,
    signals,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  console.log('· 推送结果', res.status, JSON.stringify(body).slice(0, 200));
  if (!res.ok) process.exit(1);
}
