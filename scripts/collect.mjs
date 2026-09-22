#!/usr/bin/env node
/**
 * CLI 采集入口：采集 + 合并 + 落盘。
 *
 * 实际逻辑在 src/lib/collect.mjs —— 后端服务复用同一份代码，
 * 避免「脚本能跑、服务跑不了」这类双实现漂移。
 *
 * 用法:
 *   node scripts/collect.mjs             # 增量采集（含回复雷达）
 *   node scripts/collect.mjs --no-radar  # 跳过回复雷达
 *   node scripts/collect.mjs --bootstrap # 额外执行历史回填（冷启动）
 *   node scripts/collect.mjs --offline   # 跳过网络，只重算统计（自检用）
 *   node scripts/collect.mjs --max-age=120
 *                                        # 数据比 120 分钟还新就不采（CI 兜底用，见
 *                                        # src/lib/collect.mjs 里「新鲜度短路」的说明）
 *   node scripts/collect.mjs --radar-accounts=udiWertheimer,someone
 *                                        # 覆盖回复雷达的监控对象池
 *   node scripts/collect.mjs --no-browser
 *                                        # 强制走免登录首屏（只 7 条，调试用）
 *   node scripts/collect.mjs --since-buffer-hours=48
 *                                        # 采集下界 = 上一次重置往前推 48 小时（默认 24）
 *   node scripts/collect.mjs --max-steps=40
 *                                        # 时间线最多小步滚动多少下（默认 60）
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCollection } from '../src/lib/collect.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

const argVal = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const maxAgeMinutes = Number(argVal('max-age') ?? 0);
const radarAccountsArg = argVal('radar-accounts');
const radarLimit = Number(argVal('radar-limit') ?? 0);
const sinceBufferHours = Number(argVal('since-buffer-hours') ?? 24);
const maxSteps = Number(argVal('max-steps') ?? 0);

const result = await runCollection({
  dataDir: resolve(ROOT, 'data'),
  bootstrap: argv.includes('--bootstrap'),
  skipLive: argv.includes('--offline'),
  // 登录态浏览器采集是主链路（覆盖「上一次重置以来」的全部帖子）。
  // 要临时降级成免登录首屏（只 7 条）用 --no-browser。
  browser: argv.includes('--no-browser') ? false : undefined,
  resetBufferHours: Number.isFinite(sinceBufferHours) ? sinceBufferHours : 24,
  maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? maxSteps : undefined,
  // 雷达默认开：发现「他在回复里做的预告」正是这套采集存在的理由之一。
  // 要临时关掉用 --no-radar。
  radar: !argv.includes('--no-radar'),
  radarAccounts: radarAccountsArg
    ? radarAccountsArg.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined,
  radarLimit: Number.isFinite(radarLimit) && radarLimit > 0 ? radarLimit : undefined,
  skipIfFresherThanMs: Number.isFinite(maxAgeMinutes) ? maxAgeMinutes * 60_000 : 0,
});

const s = result.stats;
console.log('\n--- 统计 ---');
console.table({
  记录总数: s.total,
  平均间隔: s.avg_interval_days.toFixed(2) + ' 天',
  中位间隔: s.median_interval_days.toFixed(2) + ' 天',
  最长等待: s.longest_wait_days.toFixed(1) + ' 天',
  距上次重置: s.days_since_last?.toFixed(2) + ' 天',
  普通重置: s.reset_count,
  发券型: s.credit_count,
});

// 覆盖范围必须看得见。降级成免登录首屏时只有 7 条，覆盖不到上一次重置 ——
// 观测台漏掉 2026-09-12 那次重置，就是因为这件事没有任何提示。
if (!result.skippedFresh) {
  const src =
    result.source === 'browser'
      ? '✓ 登录态浏览器（完整时间线）'
      : result.source === 'html'
        ? '⚠ 免登录首屏（降级，只有最近 7 条）'
        : '(未采集)';
  console.log('\n--- 覆盖范围 ---');
  console.log('  来源      ' + src);
  if (result.coverageSince) console.log('  采集下界  ' + result.coverageSince + '（上一次重置 - 缓冲）');
  if (result.tweetCount != null) console.log('  库内推文  ' + result.tweetCount + ' 条');
}

if (result.skippedFresh) {
  console.log(
    `\n⏭ 数据足够新（${(result.liveAgeMs / 60_000).toFixed(1)} 分钟前采过），本轮跳过采集，未改动任何文件。`
  );
} else if (result.errors.length) {
  console.warn('\n⚠ 部分步骤失败（已保留本地数据）：');
  for (const e of result.errors) console.warn('  · ' + e);
  process.exitCode = 1;
} else {
  console.log('\n✓ 已写入 data/');
}

// 雷达的执行情况要看得见：它是一条抽样通道（详情页只渲染部分回复），
// 「这轮扫了什么、命中几条」直接决定该怎么调对象池。
if (result.radar) {
  const r = result.radar.lastRun;
  console.log('\n--- 回复雷达 ---');
  console.log('  监控对象池: ' + result.radar.pool.join(', '));
  console.log(`  扫了 ${r.scanned.length} 条候选推文的详情页，命中 ${r.hits} 条回复`);
  for (const sc of r.scanned) {
    const d = sc.error
      ? '失败：' + sc.error
      : `详情页 ${sc.repliesOnPage} 条回复，命中 ${sc.hits}`;
    console.log(`    · @${sc.monitor}/status/${sc.tweetId} → ${d}`);
  }
  for (const e of r.errors) console.warn('    ⚠ ' + e);
  const targets = Object.keys(result.radar.targets ?? {});
  if (targets.length) console.log('  历次命中过的被回复者: ' + targets.join(', '));
}
