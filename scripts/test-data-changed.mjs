#!/usr/bin/env node
/**
 * 「实质变化」判据的校验（scripts/data-changed.mjs）。
 *
 * 守的是一类**双向的错**：
 *   · 判太松 → 为时间戳生成提交，每一轮都污染一条历史
 *     （实测：stats.json 的 20 次提交里 12 次是同一句「实时采集失败：HTTP 403」）
 *   · 判太严 → 该提交的没提交，数据丢档，页面与仓库不一致
 *
 * 所以两侧都要钉住：既要有「只有时刻在动 → 不提交」，也要有「任何一项真内容变了 → 提交」。
 *
 * 另外守一条**静默失效**：VOLATILE 清单里写的点号路径，必须在真实文件里真的存在。
 * 字段一旦改名（`stats.days_since_last` → `stats.daysSinceLast` 之类），抹除动作会变成
 * 空操作，判据悄悄退回字节级 —— 而所有用例照样全绿。这条专门盯这种退化。
 */

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findChanges, sameContent, VOLATILE } from './data-changed.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const section = (t) => console.log(`\n【${t}】`);

/** 造一个假的读写环境，直接喂纯函数（不用真的动 git）。 */
const io = (base, work) => ({
  readBase: (p) => (p in base ? base[p] : null),
  readWork: (p) => (p in work ? work[p] : null),
});

const verdict = (paths, base, work) => findChanges(paths, io(base, work));

const patch = (text, fn) => {
  const j = JSON.parse(text);
  fn(j);
  return JSON.stringify(j, null, 2) + '\n';
};

/* ==================== 1. 只有时刻在动 → 不算变化 ==================== */

section('1. 只有时刻在动 → 不算变化');

const parts = {};
for (const p of ['data/stats.json', 'data/signal.json', 'data/tweets.json']) {
  parts[p] = await readFile(resolve(ROOT, p), 'utf8');
}

check(
  '真实 stats.json：只推进 generated_at → 无实质变化',
  sameContent(
    'data/stats.json',
    parts['data/stats.json'],
    patch(parts['data/stats.json'], (j) => {
      j.generated_at = '2099-01-01T00:00:00.000Z';
    })
  ),
  '这是每轮必变、却与数据无关的那个字段'
);

check(
  '真实 stats.json：只涨 stats.days_since_last → 无实质变化',
  sameContent(
    'data/stats.json',
    parts['data/stats.json'],
    patch(parts['data/stats.json'], (j) => {
      j.stats.days_since_last += 1;
    })
  ),
  '这是嵌套在 stats 里的 now 派生字段，最容易漏'
);

check(
  '真实 signal.json：只推进 generatedAt / 时间窗边界 → 无实质变化',
  sameContent(
    'data/signal.json',
    parts['data/signal.json'],
    patch(parts['data/signal.json'], (j) => {
      j.generatedAt = '2099-01-01T00:00:00.000Z';
      j.windowFrom = '2098-11-01T00:00:00.000Z';
      j.windowTo = '2099-01-01T00:00:00.000Z';
    })
  )
);

check(
  '真实 tweets.json：只推进 updated_at → 无实质变化',
  sameContent(
    'data/tweets.json',
    parts['data/tweets.json'],
    patch(parts['data/tweets.json'], (j) => {
      j.updated_at = '2099-01-01T00:00:00.000Z';
    })
  )
);

check(
  '键的书写顺序不同不算差异（判据不该被 JSON 序列化顺序左右）',
  sameContent(
    'data/stats.json',
    parts['data/stats.json'],
    JSON.stringify(
      JSON.parse(parts['data/stats.json'], (k, v) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).reverse())
          : v
      ),
      null,
      2
    )
  )
);

/* ==================== 2. 真内容变了 → 必须提交 ==================== */

section('2. 真内容变了 → 必须提交');

const TW = JSON.stringify({
  updated_at: '2026-09-22T07:31:20.209Z',
  source: 'browser',
  tweets: [
    { id: 'a1', text: 'hello', created_at: '2026-09-22T01:00:00.000Z', role: 'post' },
    { id: 'a2', text: 'world', created_at: '2026-09-21T01:00:00.000Z', role: 'post' },
  ],
});

check(
  '出现新推文 → 有实质变化',
  verdict(['data/tweets.json'], { 'data/tweets.json': TW }, {
    'data/tweets.json': patch(TW, (j) => {
      j.tweets.unshift({ id: 'a3', text: 'new', created_at: '2026-09-22T02:00:00.000Z', role: 'post' });
    }),
  }).substantive.length === 1
);

check(
  '推文时间被纠正（id 不变、created_at 变了）→ 有实质变化',
  verdict(['data/tweets.json'], { 'data/tweets.json': TW }, {
    'data/tweets.json': patch(TW, (j) => {
      j.tweets[1].created_at = '2026-09-21T09:00:00.000Z';
    }),
  }).substantive.length === 1
);

check(
  '同一条推文 role 从 post 变 reply（本轮才配上被回复内容）→ 有实质变化',
  verdict(['data/tweets.json'], { 'data/tweets.json': TW }, {
    'data/tweets.json': patch(TW, (j) => {
      j.tweets[0].role = 'reply';
      j.tweets[0].inReplyTo = { text: 'someone else' };
    }),
  }).substantive.length === 1
);

const RS = JSON.stringify({ records: [{ announced_at: '2026-09-12T08:09:17.000Z', text: 'reset' }] });
check(
  'resets.json 的记录变化 → 有实质变化',
  verdict(['data/resets.json'], { 'data/resets.json': RS }, {
    'data/resets.json': patch(RS, (j) => {
      j.records.push({ announced_at: '2026-09-22T07:00:00.000Z', text: 'reset again' });
    }),
  }).substantive.length === 1
);

const ST = JSON.stringify({
  stats: { total: 53, days_since_last: 10 },
  generated_at: '2026-09-22T07:31:20.209Z',
  last_full_at: '2026-09-22T04:36:24.366Z',
  collect: { mode: 'incremental', newTweets: 6 },
  errors: [],
});

check(
  'errors 从 [] 变成 [403] → 有实质变化（首次失败必须落档，否则横幅在仓库里没有痕迹）',
  verdict(['data/stats.json'], { 'data/stats.json': ST }, {
    'data/stats.json': patch(ST, (j) => {
      j.errors = ['实时采集失败：HTTP 403'];
    }),
  }).substantive.length === 1
);

const ST_FAIL = patch(ST, (j) => {
  j.errors = ['实时采集失败：HTTP 403'];
});

check(
  'errors 内容一致（连续两轮同样的失败）→ 无实质变化，不重复落档',
  verdict(['data/stats.json'], { 'data/stats.json': ST_FAIL }, {
    'data/stats.json': patch(ST_FAIL, (j) => {
      j.generated_at = '2099-01-01T00:00:00.000Z';
      j.stats.days_since_last += 1;
    }),
  }).volatileOnly.length === 1,
  '基线是「已经落过档的同一条错误」，本轮只是又试了一次'
);

check(
  'errors 从 [403] 变成 [503] → 有实质变化（错误内容变了是新信息）',
  verdict(['data/stats.json'], { 'data/stats.json': patch(ST, (j) => { j.errors = ['HTTP 403']; }) }, {
    'data/stats.json': patch(ST, (j) => { j.errors = ['HTTP 503']; }),
  }).substantive.length === 1
);

check(
  'collect 里的采集形态变了（source 从 browser 降级成 html）→ 有实质变化',
  verdict(['data/stats.json'], { 'data/stats.json': ST }, {
    'data/stats.json': patch(ST, (j) => {
      j.collect.source = 'html';
    }),
  }).substantive.length === 1,
  'collect 没进忽略清单：它是采集链路的留档，不该被当成纯噪音'
);

check(
  '非 JSON 文件（scene.js）任意变化 → 有实质变化',
  verdict(['miniprogram/utils/scene.js'], { 'miniprogram/utils/scene.js': 'const a = 1;\n' }, {
    'miniprogram/utils/scene.js': 'const a = 2;\n',
  }).substantive.length === 1
);

check(
  '基线里没有的文件（新增）→ 有实质变化',
  verdict(['data/new-file.json'], {}, { 'data/new-file.json': '{}' }).substantive.length === 1
);

check(
  '工作区里没有的文件（被删）→ 有实质变化',
  verdict(['data/stats.json'], { 'data/stats.json': ST }, {}).substantive.length === 1
);

check(
  'JSON 解析失败 → 算有实质变化（保守：宁可多提交一次）',
  verdict(['data/stats.json'], { 'data/stats.json': ST }, { 'data/stats.json': '{ 坏掉的 json' })
    .substantive.length === 1
);

/* ==================== 3. 忽略清单不能静默失效 ==================== */

section('3. 忽略清单不能静默失效');

const hasPath = (obj, dotted) => {
  let cur = obj;
  for (const seg of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(seg in cur)) return false;
    cur = cur[seg];
  }
  return true;
};

for (const [path, fields] of Object.entries(VOLATILE)) {
  const json = JSON.parse(await readFile(resolve(ROOT, path), 'utf8'));
  for (const field of fields) {
    check(
      `清单有效：${path} 里确实有 ${field}`,
      hasPath(json, field),
      '字段改名后抹除会变成空操作，判据悄悄退回字节级'
    );
  }
}

// 忽略清单是**白名单**，不是正则猜出来的。新增一项必须显式改这条断言 ——
// 让「往清单里塞字段」变成一个需要复核的动作，而不是顺手就加上去。
const ALLOWED_VOLATILE = new Set([
  'data/stats.json:generated_at',
  'data/stats.json:last_full_at',
  'data/stats.json:stats.days_since_last',
  'data/signal.json:generatedAt',
  'data/signal.json:windowFrom',
  'data/signal.json:windowTo',
  'data/tweets.json:updated_at',
]);

const declared = Object.entries(VOLATILE).flatMap(([path, fields]) =>
  fields.map((f) => `${path}:${f}`)
);
const unexpected = declared.filter((d) => !ALLOWED_VOLATILE.has(d));

check(
  '忽略清单里没有意料之外的字段（新增忽略项要显式复核）',
  unexpected.length === 0,
  unexpected.join(' / ')
);

check(
  '白名单里的每一项都还在清单里（清单被删空时这条会红）',
  [...ALLOWED_VOLATILE].every((a) => declared.includes(a)),
  `清单实际 ${declared.length} 项`
);

/* ==================== 4. CLI ==================== */

section('4. CLI');

const runCli = (args) => {
  try {
    execFileSync(process.execPath, ['scripts/data-changed.mjs', ...args], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return 0;
  } catch (err) {
    return err.status;
  }
};

check(
  '关注范围内无改动 → 退出码 1（跳过提交）',
  runCli(['data/__no_such_file__']) === 1,
  `实际 ${runCli(['data/__no_such_file__'])}`
);

/* ======================== 结果 ======================== */

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
