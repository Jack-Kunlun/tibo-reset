#!/usr/bin/env node
/**
 * 探针：推文详情页能不能拿到长推文的**完整正文**。
 *
 * 要回答的问题（KI-009 的修法前提）：
 *   1. 详情页的 RSC payload 里 `full_text` 是完整正文，还是同样被截断？
 *   2. DOM 侧的 `[data-testid="tweetText"]` 在详情页是全文吗？
 *   3. 两者谁更长（取更长者是不是必要的）？
 *
 * 用法:
 *   node scripts/probe-fulltext.mjs                    # 自动挑库里「疑似截断」的
 *   node scripts/probe-fulltext.mjs 2104823812042940713
 *
 * 只读：不写 data/，不改任何东西。
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTweetFullTexts } from '../src/lib/browser.mjs';
import { resolveProxy } from '../src/lib/proxy.mjs';
import { readJson, SOURCE_ACCOUNT } from '../src/lib/collect.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hr = (t) => console.log(`\n${'='.repeat(76)}\n${t}\n${'='.repeat(76)}`);

const argvIds = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
const lib = await readJson(resolve(ROOT, 'data', 'tweets.json'), { tweets: [] });

const targets = argvIds.length
  ? argvIds.map((id) => lib.tweets.find((t) => t.id === id) ?? { id, text: '' })
  : lib.tweets.filter((t) => !t.text_full && String(t.text ?? '').length >= 240);

hr(`目标 ${targets.length} 条`);
for (const t of targets) console.log(`  ${t.id}  库内 ${String(t.text ?? '').length} 字符`);

const proxy = await resolveProxy();
console.log(`\n代理：${proxy || '(直连)'}`);

const started = Date.now();
const { fullTexts, scanned } = await fetchTweetFullTexts(
  targets.map((t) => t.id),
  { handle: SOURCE_ACCOUNT, proxy, gapMs: 700 }
);

hr('结果');
for (const t of targets) {
  const rec = scanned.find((s) => s.id === t.id) ?? {};
  const got = fullTexts.get(t.id) ?? '';
  const before = String(t.text ?? '').length;
  const mark = got.length > before ? '✓ 更长' : '✗ 没更长';
  console.log(
    `\n${t.id}  ${mark}  库内 ${before} → 详情页 ${got.length}  取法=${rec.via ?? '—'}` +
      `  [DOM ${rec.domLength ?? '?'} / payload ${rec.payloadLength ?? '?'}]` +
      `  仍有展开入口=${rec.showMore ?? '?'}${rec.error ? `  错误=${rec.error}` : ''}`
  );
  if (got) console.log(`  尾部：…${got.slice(-90)}`);
  if (got && before) console.log(`  库内尾部：…${String(t.text).slice(-60)}`);
  if (rec._diag) console.log(`  诊断：HTML 里 client: ${rec._diag.clientKey} / full_text ${rec._diag.fullTextWord} / base64 键 ${rec._diag.b64Key}`);
}

console.log(`\n耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
