#!/usr/bin/env node
/**
 * 把采集产物推给境内服务（GitHub Actions 里的最后一个步骤）。
 *
 * 为什么单独一个脚本而不是写在 workflow 里用 curl：
 *   载荷要从四个文件拼出来、要带超时、要把「服务端拒收」和「网络不通」分开报，
 *   写成 curl 就是一大串 shell，还不好在本地复现。脚本本地能跑，CI 只是调用它。
 *
 * 退出码的约定（决定了 Actions 会不会发失败邮件）：
 *   INGEST_URL 未配置            → 0，跳过。本地开发、后端尚未部署时属正常
 *   服务端 stale（数据不比现有新）→ 0。CI 重跑就会走到这里，不是错误
 *   服务端 401 / 422             → 1。这是配置错或数据坏，必须让人看到
 *   网络不通 / 超时              → 1。境内服务挂了，页面还是新的，属于要处理的情况
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const URL_ = process.env.INGEST_URL ?? '';
const TOKEN = process.env.INGEST_TOKEN ?? '';

/** 一次 POST 不该挂太久 —— Actions 有整轮时长上限，卡住比失败更糟 */
const TIMEOUT_MS = 30_000;

if (!URL_) {
  console.log('· 未配置 INGEST_URL，跳过境内推送（后端尚未部署时属正常）');
  process.exit(0);
}

if (!TOKEN) {
  console.error('✗ 配了 INGEST_URL 却没有 INGEST_TOKEN —— 无法通过鉴权，直接失败');
  process.exit(1);
}

const readJson = async (p) => JSON.parse(await readFile(resolve(ROOT, p), 'utf8'));

const stats = await readJson('data/stats.json');
if (!Number.isFinite(Date.parse(stats?.generated_at))) {
  console.error('✗ data/stats.json 里没有合法的 generated_at，无法作为幂等依据');
  process.exit(1);
}

const payload = {
  generatedAt: stats.generated_at,
  resets: await readJson('data/resets.json'),
  tweets: await readJson('data/tweets.json'),
  stats,
};

// 采集降级时 signal.json 可能不存在，有就带上
try {
  payload.signals = await readJson('data/signal.json');
} catch {
  console.log('· 没有 data/signal.json，本次不带信号结果');
}

let res;
try {
  res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
} catch (err) {
  console.error(`✗ 推送失败：${err.message}`);
  console.error('  这通常意味着境内服务不可达 —— 页面数据是新的，但 API 会停在旧数据上。');
  process.exit(1);
}

const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = { raw: text.slice(0, 300) };
}

if (res.status === 200 && body.status === 'accepted') {
  console.log(`✓ 已推送：${body.records} 条记录 / ${body.tweets} 条推文 · ${body.generatedAt}`);
  process.exit(0);
}

if (res.status === 200 && body.status === 'stale') {
  console.log(`· 服务端已有更新数据（${body.current}），本次载荷 ${body.incoming} 已丢弃`);
  process.exit(0);
}

console.error(`✗ 服务端拒绝（HTTP ${res.status}）：${JSON.stringify(body)}`);
if (res.status === 401) console.error('  两侧的 INGEST_TOKEN 不一致。');
if (res.status === 422) console.error('  载荷形状不合法，见 detail 字段 —— 这属于采集侧的问题。');
if (res.status === 503) console.error('  服务端没有配置 INGEST_TOKEN，写入入口是关闭的。');
process.exit(1);
