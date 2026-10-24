#!/usr/bin/env node
/**
 * 列出「待翻译」的推文 —— **agent 翻译工作流的入口**。
 *
 * ⭐ 为什么要分两步（列清单 → 回填译文）：
 *
 * 翻译这件事只有 agent 能做（要读懂英文推文、懂 Tibo 的语境、知道
 * 「Day N / Reset」是什么意思）。而采集是死脚本，它不知道哪条推文值得译。
 * 所以分工是：
 *
 *   ① 本脚本（死代码）**列出待译清单**：哪些推文要译、原文是什么、
 *      它的 sha256 是多少 —— agent 照着清单产出译文；
 *   ② agent 把译文写进 `data/translations.json`（人工可读、可 diff、可复核）；
 *   ③ `scripts/apply-translations.mjs` 把译文**挂到推文对象上**，
 *      挂的时候校验 sha256，对不上就拒绝。
 *
 * ⭐ 为什么译文不直接由脚本生成：机器翻译接口在生产环境空转
 * （D-080 实测：容器内访问境外 12 秒超时、本机匿名额度耗尽），
 * 而整条链路的目的是**不依赖任何外部接口**。
 * agent 在本机做翻译 —— 本机走住宅出口，采集本来就跑在这儿。
 *
 * 用法：
 *   node scripts/translation-todo.mjs                # 列出待译清单（人读）
 *   node scripts/translation-todo.mjs --json         # 机器读（给 agent 用）
 *   node scripts/translation-todo.mjs --limit 20      # 只列最近 20 条
 *   node scripts/translation-todo.mjs --all           # 连不在页面上的也列
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sourceHash, translationFor } from '../src/lib/tweet-translations.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 页面**实际展示**的推文集合 —— 只译这些。
 *
 * 库里躺着 400+ 条推文，但页面真正露出来的只有几十条（信号证据 + 预告 +
 * 计划条目）。全译一遍是浪费，而且大部分是无关闲聊。
 *
 * 这里用数据层自己算一遍「哪些推文进了展示位」，而不是靠猜：
 * 判据 = 出现在信号的证据/预告里，或出现在 28 天计划的条目里。
 */
async function displayedTweetIds(tweets) {
  const { detectSignals } = await import('../src/lib/signals.mjs');
  const { buildResetCalendar } = await import('../src/lib/reset-calendar.mjs');
  const { latestEventMs } = await import('../src/lib/signals.mjs');

  const now = Date.now();
  const resets = JSON.parse(await readFile(resolve(ROOT, 'data/resets.json'), 'utf8'));
  const signals = detectSignals(tweets, { now, account: 'thsottiaux', lastResetAt: latestEventMs(resets.records ?? []) });
  signals.calendar = buildResetCalendar({
    records: resets.records ?? [], tweets, signals, now, account: 'thsottiaux',
  });

  const ids = new Set();
  const collect = (list) => {
    for (const item of list ?? []) {
      if (item?.id != null) ids.add(String(item.id));
    }
  };
  for (const f of signals.forecasts ?? []) {
    collect(f.evidence);
    if (f.text != null && f.id != null) ids.add(String(f.id));
  }
  for (const top of signals.hints ?? []) {
    if (top?.id != null) ids.add(String(top.id));
  }
  for (const row of signals.calendar?.plan?.rows ?? []) {
    for (const entry of row.entries ?? []) {
      if (entry?.id != null) ids.add(String(entry.id));
    }
  }
  return ids;
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const all = argv.includes('--all');
  const limitArg = argv.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(argv[limitArg + 1]) : 0;

  let file;
  try {
    file = JSON.parse(await readFile(resolve(ROOT, 'data/tweets.json'), 'utf8'));
  } catch (err) {
    console.error(`读不到 data/tweets.json：${err.message}`);
    process.exitCode = 1;
    return;
  }
  const tweets = file.tweets ?? [];
  const displayed = all ? null : await displayedTweetIds(tweets);

  const pending = tweets
    .filter((tweet) => {
      // 已经有**有效**译文的跳过（原文被编辑过 → 译文已失效 → 重新排队）
      if (translationFor(tweet)) return false;
      if (!sourceHash(tweet.text)) return false;
      if (displayed && !displayed.has(String(tweet.id))) return false;
      return true;
    })
    .sort((a, b) => new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0));

  const list = (limit > 0 ? pending.slice(0, limit) : pending).map((tweet) => ({
    id: String(tweet.id),
    createdAt: tweet.created_at,
    url: tweet.url,
    sourceHash: sourceHash(tweet.text),
    text: tweet.text,
  }));

  if (asJson) {
    console.log(JSON.stringify({
      count: list.length,
      total: pending.length,
      scope: all ? 'all' : 'displayed',
      tweets: list,
    }, null, 2));
    return;
  }

  console.log(`待译推文：${list.length} 条（库内共 ${tweets.length} 条，范围：${all ? '全部' : '仅页面展示位'}）`);
  console.log('');
  for (const item of list) {
    console.log('─'.repeat(72));
    console.log(`id:         ${item.id}`);
    console.log(`时间:       ${item.createdAt}`);
    console.log(`链接:       ${item.url}`);
    console.log(`sourceHash: ${item.sourceHash}`);
    console.log(`原文:       ${item.text}`);
    console.log('');
  }
  if (list.length) {
    console.log('─'.repeat(72));
    console.log('把译文写进 data/translations.json，格式：');
    console.log(JSON.stringify({
      [list[0].id]: { sourceHash: list[0].sourceHash, text: '中文译文', language: 'zh-CN', provider: 'agent' },
    }, null, 2));
  }
}

main();
