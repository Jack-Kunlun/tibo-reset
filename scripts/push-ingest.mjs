#!/usr/bin/env node
/**
 * 把采集产物推给境内服务（本机采集自动化的一步；D-025 之后数据不再经过 CI）。
 *
 * 推的是三样：`data/` 的三个数据文件、可选的信号结果、以及可选的 F8 分享卡片。
 * 卡片之所以也走这里，是因为容器零运行时依赖（D-002）渲染不了那张图 —— 见 server/og.mjs。
 *
 * 为什么单独一个脚本而不是在调用方拼 curl：
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

// F8 分享卡片：与 data/ **同一次构建**的产物，一并送过去。
// 容器里没有 resvg（D-002「运行镜像零依赖」），渲染不了这张图 —— 它只能由本机
// 构建后经这条通道送达。落点与解析见 server/og.mjs。
// 没有就只送数据：`og` 是可选字段，缺它不会让整份载荷被拒。
let ogNote = 'absent';
try {
  const [png, meta] = await Promise.all([
    readFile(resolve(ROOT, 'dist/og-image.png')),
    readJson('dist/og-meta.json'),
  ]);
  payload.og = { png: png.toString('base64'), description: meta.description, builtAt: meta.builtAt };
  ogNote = 'written';
} catch {
  console.log('· 没有 dist/og-image.png + dist/og-meta.json（先跑 npm run build），本次不带分享卡片');
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
  // 服务端是老版本时不认识 og 字段（不会回它）—— 那种情况下也一样打印「已推送」，
  // 只是在末尾如实说明卡片没被更新。
  const og = body.og ?? ogNote;
  console.log(
    `✓ 已推送：${body.records} 条记录 / ${body.tweets} 条推文 · ${body.generatedAt}` +
      ` · 分享卡片${og === 'written' ? '已更新' : '未更新（本次没带 og）'}`
  );
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
