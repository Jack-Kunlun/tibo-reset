#!/usr/bin/env node
/**
 * CLI 采集入口：采集 + 合并 + 落盘。
 *
 * 实际逻辑在 src/lib/collect.mjs —— 后端服务复用同一份代码，
 * 避免「脚本能跑、服务跑不了」这类双实现漂移。
 *
 * 用法:
 *   node scripts/collect.mjs             # 增量采集
 *   node scripts/collect.mjs --bootstrap # 额外执行历史回填（冷启动）
 *   node scripts/collect.mjs --offline   # 跳过网络，只重算统计（自检用）
 *   node scripts/collect.mjs --max-age=120
 *                                        # 数据比 120 分钟还新就不采（CI 兜底用，见
 *                                        # src/lib/collect.mjs 里「新鲜度短路」的说明）
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCollection } from '../src/lib/collect.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

const maxAgeArg = argv.find((a) => a.startsWith('--max-age='));
const maxAgeMinutes = maxAgeArg ? Number(maxAgeArg.split('=')[1]) : 0;

const result = await runCollection({
  dataDir: resolve(ROOT, 'data'),
  bootstrap: argv.includes('--bootstrap'),
  skipLive: argv.includes('--offline'),
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
