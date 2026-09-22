#!/usr/bin/env node
/**
 * CLI 采集入口：采集 + 合并 + 落盘。
 *
 * 实际逻辑在 src/lib/collect.mjs —— 后端服务复用同一份代码，
 * 避免「脚本能跑、服务跑不了」这类双实现漂移。
 *
 * 用法:
 *   node scripts/collect.mjs             # 增量采集（原创 + 回复两条流）
 *   node scripts/collect.mjs --full      # 强制全量回溯（忽略已入库边界）
 *   node scripts/collect.mjs --no-replies # 只收原创流，跳过 /with_replies
 *   node scripts/collect.mjs --radar     # 额外跑回复雷达（默认关，见下方说明）
 *   node scripts/collect.mjs --bootstrap # 额外执行历史回填（冷启动）
 *   node scripts/collect.mjs --offline   # 跳过网络，只重算统计（自检用）
 *   node scripts/collect.mjs --max-age=180
 *                                        # 数据比 180 分钟还新就不采，连请求都不发。
 *                                        # ⚠ 现在没有自动调用方（CI 兜底采集 2026-09-22
 *                                        # 已移除，见 docs/decisions.md D-023），留给手动
 *                                        # 重跑用；若将来重新用于自动化，阈值必须 ≥ 采集周期
 *   node scripts/collect.mjs --radar-accounts=udiWertheimer,someone
 *                                        # 覆盖回复雷达的监控对象池
 *   node scripts/collect.mjs --no-browser
 *                                        # 强制走免登录首屏（只 7 条，调试用）
 *   node scripts/collect.mjs --since-buffer-hours=48
 *                                        # 采集下界 = 上一次重置往前推 48 小时（默认 24）
 *   node scripts/collect.mjs --full-scan-hours=24
 *                                        # 隔多久强制全量回补一次（默认 72）
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
const fullScanHours = Number(argVal('full-scan-hours') ?? 0);
const maxSteps = Number(argVal('max-steps') ?? 0);

const result = await runCollection({
  dataDir: resolve(ROOT, 'data'),
  bootstrap: argv.includes('--bootstrap'),
  skipLive: argv.includes('--offline'),
  // 登录态浏览器采集是主链路（覆盖「上一次重置以来」的全部帖子）。
  // 要临时降级成免登录首屏（只 7 条）用 --no-browser。
  browser: argv.includes('--no-browser') ? false : undefined,
  resetBufferHours: Number.isFinite(sinceBufferHours) ? sinceBufferHours : 24,
  // 增量是默认。--full 强制从头回溯一遍（对齐 GraphQL/页面结构变化后的数据）。
  full: argv.includes('--full') ? true : undefined,
  fullScanHours: Number.isFinite(fullScanHours) && fullScanHours > 0 ? fullScanHours : undefined,
  maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? maxSteps : undefined,
  // 雷达默认**关**。
  //
  // 它当初存在的理由是「回复不进 profile 流，只能从别人推文的详情页里反着找」。
  // 这条前提已经没了：并上 `/with_replies` 之后，他的回复是**直接**收的
  // （实测一轮 52 条，覆盖 30+ 个被回复者），而雷达要间接地猜「他可能回了谁」，
  // 既天生抽样（详情页只渲染部分回复），又依赖人工维护的对象池 ——
  // 实测池里只有 1 个账号、扫 6 条详情页命中 0。
  //
  // 留着默认开会白花请求，更麻烦的是日志里会多一行「命中 0」的噪音，
  // 让人误以为回复采集没工作，而真正在工作的那条通道反而被盖过去。
  // 要用（排查、或 with_replies 连续失败时兜底）加 --radar。
  radar: argv.includes('--radar'),
  // 回复流默认开 —— 它是「很多消息在回复里」的直接答案。要退回只收原创用 --no-replies。
  withReplies: !argv.includes('--no-replies'),
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
  const mode =
    result.mode === 'incremental'
      ? `增量（翻到已入库的推文即停：${result.stoppedBy}）`
      : result.mode === 'full'
        ? `全量回溯（${result.stoppedBy}）`
        : result.mode === 'degraded'
          ? '降级路径'
          : '(未采集)';
  console.log('\n--- 覆盖范围 ---');
  console.log('  来源      ' + src);
  console.log('  采集模式  ' + mode);
  if (result.newCount != null) {
    console.log(
      '  本轮新增  ' +
        result.newCount +
        ' 条' +
        (result.newCount === 0 ? '（已是最新，库内数据原样保留）' : '')
    );
  }
  if (result.coverageSince) console.log('  采集下界  ' + result.coverageSince + '（上一次重置 - 缓冲）');
  if (result.tweetCount != null) {
    console.log(
      '  库内推文  ' +
        result.tweetCount +
        ' 条' +
        (result.replyTweetCount
          ? `（其中 ${result.replyTweetCount} 条来自回复 —— 别人的帖子底下）`
          : '')
    );
  }
  // 回复流单独报：它是「很多消息在回复里」这件事的答案，采到什么程度必须看得见。
  if (result.reply) {
    const r = result.reply;
    const rm = r.mode === 'incremental' ? `增量（${r.stoppedBy}）` : `全量回溯（${r.stoppedBy}）`;
    console.log(
      `  回复流    ${rm} · 收下 ${r.harvested} 条，其中带被回复内容 ${r.withContext} 条`
    );
    if (r.authorsMissing) {
      console.log(
        `            ⚠ 有 ${r.authorsMissing} 个条目的作者没解析出来（配对依赖它，数字偏大就该查选择器）`
      );
    }
  } else if (result.replyError) {
    console.log('  回复流    ⚠ 本轮失败：' + result.replyError);
  }
  const sig = result.signals;
  if (sig?.counts) {
    console.log(
      `  信号识别  已发生 ${sig.counts.occurred} · 预告 ${sig.counts.explicit} · 线索 ${sig.counts.hint} · 其余 ${sig.counts.none}` +
        `  （共 ${sig.counts.scanned} 条，时间窗自 ${String(sig.windowFrom).slice(0, 10)}）`
    );
  }
  // 综合假设要单独打一行。它回答的是「凭什么说这个时间」——
  // 单看「预告 1 条」看不出那天被几条推文从不同角度指到过，
  // 也看不出哪些钟点线索**被看到但没采信**（两者是完全不同的结论）。
  const hy = sig?.hypothesis;
  if (hy?.evidence?.length) {
    const unadopted = (hy.clockHints ?? []).filter((c) => !c.adopted);
    console.log(
      `  综合假设  ${hy.day} · 精度 ${hy.precision} · ${hy.counts.hard} 条承诺 + ${hy.counts.soft} 条同日提及` +
        (unadopted.length
          ? `\n            钟点线索 ${unadopted.map((c) => c.word).join(' / ')} 未采用（语境与额度无关，仅作旁证）`
          : '')
    );
  }
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
