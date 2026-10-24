#!/usr/bin/env node
/**
 * 把 agent 产出的译文**挂到推文对象上**，写回 `data/tweets.json`。
 *
 * ⭐ 为什么译文最终落在推文对象里（而不是独立文件）：
 *
 * 线上数据是通过 `POST /api/ingest` 推过去的，而那个接口的载荷契约只认
 * `resets / tweets / stats / signals / og` 五个字段。D-080 把译文放在
 * `data/translation-cache.json`，结果这个文件**不在契约里** ⇒ 本机译出来了，
 * 线上永远收不到 ⇒ 断链，且是**静默**断链（推送返回 200，页面没变）。
 *
 * 译文挂成 `tweet.translation` 就跟着 `tweets.tweets[]` 一起进载荷 ——
 * **不动 ingest 契约**，也就不存在新的断点。
 *
 * 用法：
 *   node scripts/apply-translations.mjs                  # 应用 data/translations.json
 *   node scripts/apply-translations.mjs --dry-run        # 只校验，不写盘
 *   node scripts/apply-translations.mjs --file <路径>     # 指定译文文件
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sourceHash, translationFor } from '../src/lib/tweet-translations.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 校验一条译文能不能挂到这条推文上。
 *
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function validateEntry(tweet, entry) {
  if (!entry || typeof entry !== 'object') return { ok: false, reason: '译文条目不是对象' };
  if (typeof entry.text !== 'string' || !entry.text.trim()) return { ok: false, reason: '译文为空' };
  if (entry.text.length > 20_000) return { ok: false, reason: '译文超长' };

  const expected = sourceHash(tweet.text);
  if (!expected) return { ok: false, reason: '推文没有原文，无法绑定' };
  if (entry.sourceHash && entry.sourceHash !== expected) {
    return { ok: false, reason: 'sha256 与当前原文对不上（原文被编辑过，或译文张冠李戴）' };
  }
  return { ok: true };
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const fileArg = argv.indexOf('--file');
  const translationsPath = resolve(ROOT, fileArg >= 0 ? argv[fileArg + 1] : 'data/translations.json');
  const tweetsPath = resolve(ROOT, 'data/tweets.json');

  let entries;
  try {
    entries = JSON.parse(await readFile(translationsPath, 'utf8'));
  } catch (err) {
    console.error(`读不到译文文件 ${translationsPath}：${err.message}`);
    process.exitCode = 1;
    return;
  }

  const file = JSON.parse(await readFile(tweetsPath, 'utf8'));
  const tweets = file.tweets ?? [];
  const byId = new Map(tweets.map((tweet) => [String(tweet.id), tweet]));

  const applied = [];
  const rejected = [];
  const orphan = [];

  for (const [id, entry] of Object.entries(entries ?? {})) {
    const tweet = byId.get(String(id));
    if (!tweet) {
      orphan.push({ id, reason: '库内找不到这条推文（可能已被清理）' });
      continue;
    }
    const check = validateEntry(tweet, entry);
    if (!check.ok) {
      rejected.push({ id, reason: check.reason });
      continue;
    }
    const translation = {
      text: entry.text.trim(),
      sourceHash: sourceHash(tweet.text),
      language: entry.language ?? 'zh-CN',
      provider: entry.provider ?? 'agent',
    };
    applied.push({ id, tweet, translation });
  }

  // 应用：只改**有译文**的推文，其余原样保留。
  const nextTweets = tweets.map((tweet) => {
    const hit = applied.find((a) => a.tweet === tweet);
    if (!hit) return tweet;
    return { ...tweet, translation: hit.translation };
  });

  console.log(`译文文件：${translationsPath}`);
  console.log(`应用：${applied.length} 条｜拒绝：${rejected.length} 条｜孤儿：${orphan.length} 条`);
  for (const item of rejected) console.log(`  ✗ ${item.id}：${item.reason}`);
  for (const item of orphan) console.log(`  ? ${item.id}：${item.reason}`);

  if (dryRun) {
    console.log('（--dry-run，未写盘）');
    return;
  }
  if (!applied.length) {
    console.log('没有可应用的译文，未写盘');
    return;
  }

  // ⚠ 落盘必须推进 updated_at —— 它的变化是**服务端信号缓存失效**的依据
  // （server/index.mjs 的 getSignals 缓存 key 里含 file.updated_at）。
  // 不推进的话，线上页面会一直显示旧的信号缓存 ⇒ 译文「推了但看不到」。
  const next = { ...file, tweets: nextTweets, updated_at: new Date().toISOString() };
  await writeFile(tweetsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`已写盘 ${tweetsPath}（updated_at → ${next.updated_at}）`);

  // 自检：写完再读一遍，确认译文确实挂上且仍有效
  const reread = JSON.parse(await readFile(tweetsPath, 'utf8'));
  const rereadById = new Map((reread.tweets ?? []).map((t) => [String(t.id), t]));
  let ok = 0;
  for (const item of applied) {
    if (translationFor(rereadById.get(item.id))) ok += 1;
  }
  console.log(`自检：${ok}/${applied.length} 条译文写盘后仍然有效`);
  if (ok !== applied.length) {
    console.error('⛔ 自检未通过：译文写进去但读不出来');
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
