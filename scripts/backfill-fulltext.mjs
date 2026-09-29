#!/usr/bin/env node
/**
 * 一次性/按需：把库内**历史遗留**的被截断推文补全（KI-009 的补齐入口）。
 *
 * 为什么需要它（自动那条通道覆盖不到的部分）：
 * 采集时会顺带为「本轮收下的长推文」取全文，但**它只看得见本轮收下的**。
 * 库里早先入库的那些推文一旦采过，就再也不会重新进采集窗口 —— 增量采集翻到
 * 已入库的推文即停，连全量回补也只回溯到「上一次重置 - 缓冲」，而 09-12 那次
 * 重置公告比那个下界早得多。于是：
 *   · 修好采集端之后，**新**推文会被补全；
 *   · 修好之前就已经在库里的**旧**推文，永远停在半句上 —— 除非有人来补一次。
 *
 * 所以这条通道是**手工触发**而不是每轮跑：它必然会为库里那些「本来就完整、
 * 只是恰好超过门槛」的长推文白开一次详情页（详情页给出的并不更长 → 不该打
 * `text_full` → 下一轮还会被选中）。挂在自动链路上就是每轮固定的无效请求；
 * 放在这里，跑一次、收敛，代价只付一次。
 *
 * 幂等：已标 `text_full` 的不进候选；正文只在**更长**时替换（复用
 * `patchTruncatedTexts`）。重复跑不会改动任何数据。
 *
 * 用法:
 *   node scripts/backfill-fulltext.mjs            # 补齐库内所有疑似截断的推文
 *   node scripts/backfill-fulltext.mjs --dry-run  # 只看候选，不请求、不落盘
 *   node scripts/backfill-fulltext.mjs --max=30   # 单次最多补多少条（默认 20）
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readJson,
  saveJson,
  patchTruncatedTexts,
  classify,
  runCollection,
  SOURCE_ACCOUNT,
} from '../src/lib/collect.mjs';
import { fetchTweetFullTexts, TRUNCATED_MIN_LENGTH } from '../src/lib/browser.mjs';
import { resolveProxy } from '../src/lib/proxy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const maxArg = Number((argv.find((a) => a.startsWith('--max=')) ?? '').slice(6));
const max = Number.isFinite(maxArg) && maxArg > 0 ? maxArg : 20;

const live = await readJson(resolve(DATA, 'tweets.json'), { tweets: [] });
const tweets = live.tweets ?? [];

// 候选 = 疑似被截断、且还没补过。
// ⚠ 库里的记录**没有** `truncated` 标记（那是采集期的 DOM 判据，归一化时就被丢掉了，
// 见 browser.mjs 的 harvestStream），所以这里只能用长度判据 —— 门槛的实际含义
// 与采集侧一致：比它长就有可能是被切在半句。偏保守的代价只是多开一次详情页。
const candidates = tweets
  .filter((t) => t?.id && t.text_full !== true && String(t.text ?? '').length >= TRUNCATED_MIN_LENGTH)
  .sort((a, b) => new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0));

console.log(`库内 ${tweets.length} 条推文，疑似被截断且未补全 ${candidates.length} 条`);
for (const t of candidates.slice(0, max)) {
  console.log(
    `  ${t.id}  ${String(t.text).length} 字符  ${String(t.created_at).slice(0, 10)}  kind=${t.kind}`
  );
}
if (candidates.length > max) console.log(`  …另有 ${candidates.length - max} 条超出本次上限（--max 可调）`);

if (!candidates.length) {
  console.log('\n没有需要补全的推文，未改动任何文件。');
} else if (dryRun) {
  console.log('\n--dry-run：不发起请求，未改动任何文件。');
} else {
  await backfill(candidates.slice(0, max));
}

async function backfill(picked) {
  const proxy = await resolveProxy();
  console.log(`\n逐条打开详情页取全文（代理：${proxy || '直连'}）…`);

  const { fullTexts, scanned } = await fetchTweetFullTexts(
    picked.map((t) => t.id),
    {
      handle: SOURCE_ACCOUNT,
      proxy,
      gapMs: 900,
      onProgress: (r) =>
        console.log(`  · ${r.id} → ${r.length} 字符${r.error ? `（失败：${r.error}）` : ''}`),
    }
  );

  const { tweets: patched, patched: count } = patchTruncatedTexts(tweets, fullTexts);

  // 补全后**重算 kind**：它是从正文里读出来的，用半句判、用全文入库会留下
  // 「库里写着 banked reset、kind 却是 other」这种自相矛盾的记录（与采集出口同一口径）。
  const next = patched.map((t) => {
    const full = fullTexts.get(t.id);
    if (!full) return t;
    const text = String(full).replace(/\s+/g, ' ').trim();
    if (text.length <= String(t.text ?? '').length) return t;
    return { ...t, kind: classify(text) };
  });

  const failed = scanned.filter((s) => s.error);
  console.log(
    `\n取回 ${fullTexts.size} 条正文，实际替换 ${count} 条${failed.length ? `，失败 ${failed.length} 条` : ''}`
  );
  for (const f of failed) console.log(`  ⚠ ${f.id}：${f.error}`);
  // 取了但没变长的，是「本来就完整」那一类 —— 如实报出，免得被当成失败。
  // 这个数字持续不为 0 说明长度门槛偏松、白花请求，是调门槛的依据。
  const noGain = Math.max(0, scanned.filter((s) => !s.error).length - count);
  if (noGain > 0) console.log(`  （其中 ${noGain} 条详情页给出的正文并不更长 —— 它本来就是完整的）`);

  if (!count) {
    console.log('\n库里没有可补的正文，未改动任何文件。');
    return;
  }

  await saveJson(resolve(DATA, 'tweets.json'), {
    ...live,
    tweets: next,
    updated_at: new Date().toISOString(),
  });
  console.log('✓ 已写回 data/tweets.json');

  // 信号与统计是从推文库算出来的，正文（以及跟着重算的 kind）变了就得跟着重算 ——
  // 否则会留下「库里有全文、页面上的信号还是按半句算的」这种跨文件不一致，
  // 而那正是这一整类 bug 的形态。走离线重算：不联网，只把下游产物重建一遍。
  const r = await runCollection({ dataDir: DATA, skipLive: true });
  console.log(`✓ 已重算 signal.json / stats.json（${r.tweetCount} 条推文）`);
}
