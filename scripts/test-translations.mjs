#!/usr/bin/env node
/**
 * 推文译文（D-082）的反例测试。
 *
 * ⭐ 这套测试要证明的不是「译文能显示」，而是**三条不可退让的性质**：
 *
 *   ① **译文对不上原文就不存在** —— 原文被编辑后旧译文必须自动失效；
 *      否则页面上会挂着一段与原文无关的译文，读者会以为那就是作者的意思。
 *      这是本项目最不能出的错（比不显示译文坏得多）。
 *
 *   ② **译文不参与任何判定** —— 计数、等级、时间窗口全都在补挂之前算好。
 *      译文是「阅读辅助」，一旦它能影响结论，翻译质量就变成了判定正确性的前提。
 *
 *   ③ **译文必须能上线** —— 这是 D-080 死掉的地方：译文放在独立文件里，
 *      而 ingest 载荷契约不收那个文件 ⇒ 本机译出来了，线上永远收不到，
 *      而且**静默**（推送返回 200，页面没变）。现在译文挂在推文对象上随
 *      `tweets` 载荷走，契约零改动 —— 这条要有端到端断言钉住。
 *
 * 每条关键断言都配一个**隔离变异**：把源码改坏（去掉哈希闸门 / 让译文覆盖原文 /
 * 让采集覆盖译文……），断言必须变红。断言不会红 = 它没有牙。
 *
 * ⚠ 隔离变异的手法（沿用 test-reset-calendar.mjs）：
 *   · 纯模块（只依赖 node: 内建）→ 直接用 data: URL 加载变异版；
 *   · 有相对 import 的模块 → 把它的**直接**相对 import 替换成绝对 file:// URL，
 *     其下游由 file:// 机制正常解析（不必递归替换）；
 *   · 改完只在内存里跑，磁盘源码逐字未变（末尾用 sha256 核对）。
 */

import assert from 'node:assert/strict';
import { readFile, writeFile, realpath, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  sourceHash,
  translationFingerprint,
  hasValidTranslation,
  translationFor,
  withTranslations,
  attachTranslations,
  translationIndex,
  withChartTranslations,
  pruneStaleTranslations,
} from '../src/lib/tweet-translations.mjs';
import { withSignalTranslations } from '../src/lib/signals.mjs';
import { withCalendarTranslations } from '../src/lib/reset-calendar.mjs';
import { validateEntry } from './apply-translations.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const dataUrl = (text) => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');

let passed = 0;
const check = (name, value) => { assert.ok(value, name); passed++; console.log(`✓ ${name}`); };
const section = (title) => console.log(`\n【${title}】`);

/* ------------------------------ 夹具 ------------------------------ */

const tweet = (id, text, extra = {}) => ({
  id,
  account: 'thsottiaux',
  created_at: '2026-10-20T04:00:00.000Z',
  text,
  url: `https://x.com/thsottiaux/status/${id}`,
  foundVia: 'timeline-browser',
  author_verified: true,
  ...extra,
});

/** 给推文挂一条合法译文（sha256 绑定原文） */
const withZh = (t, zh) => ({
  ...t,
  translation: { text: zh, sourceHash: sourceHash(t.text), language: 'zh-CN', provider: 'agent' },
});

const ORIGIN = 'We will reset all usage limits next Tuesday.';
const ORIGIN_ZH = '我们将在下周二重置所有使用额度。';

/* ===================== 1. 数据层：sha256 绑定与失效 ===================== */

section('1. 原文与译文的 sha256 绑定');

{
  const base = tweet('1', ORIGIN);

  check('同一原文哈希稳定，空白差异不算原文被编辑',
    sourceHash('a  b\n c') === sourceHash('a b c') && sourceHash(ORIGIN) === sourceHash(ORIGIN));
  check('空原文没有哈希（无从绑定）', sourceHash('') === null && sourceHash(null) === null && sourceHash('   ') === null);

  const first = withZh(tweet('fp-1', 'First original.'), '第一条译文');
  const second = withZh(tweet('fp-2', 'Second original.'), '第二条译文');
  const fingerprint = translationFingerprint([first, second]);
  check('有效译文内容生成 64 位 SHA-256 指纹', /^[0-9a-f]{64}$/.test(fingerprint));
  check('同一批译文重排后指纹稳定', translationFingerprint([second, first]) === fingerprint);
  const duplicateA = withZh(tweet('fp-duplicate-a', 'Repeated source.'), '重复译文');
  const duplicateB = withZh(tweet('fp-duplicate-b', 'Repeated source.'), '重复译文');
  check('重复原文内容相同时，重排后指纹稳定',
    translationFingerprint([duplicateA, duplicateB]) === translationFingerprint([duplicateB, duplicateA]));
  check('条数不变但译文文本变化时指纹变化',
    translationFingerprint([first, withZh(second, '修订后的译文')]) !== fingerprint);
  check('无有效译文时指纹为 0', translationFingerprint([tweet('fp-3', 'No translation.')]) === 0);
  check('原文变化会进入内容指纹',
    translationFingerprint([withZh(tweet('fp-1', 'Edited original.'), '第一条译文')]) !==
      translationFingerprint([first]));
  check('语言与来源变化会进入内容指纹',
    translationFingerprint([{ ...first, translation: { ...first.translation, language: 'zh-TW' } }]) !==
      translationFingerprint([first]) &&
    translationFingerprint([{ ...first, translation: { ...first.translation, provider: 'other' } }]) !==
      translationFingerprint([first]));

  const good = withZh(base, ORIGIN_ZH);
  check('哈希对得上时译文有效', hasValidTranslation(good) === true && translationFor(good)?.text === ORIGIN_ZH);

  // ⭐ 核心性质①：原文被编辑 → 旧译文自动失效
  const edited = { ...good, text: 'We will reset all usage limits next Wednesday.' };
  check('原文被编辑后旧译文立即失效（不显示对不上的译文）',
    hasValidTranslation(edited) === false && translationFor(edited) === null);

  const noText = { ...good, translation: { ...good.translation, text: '   ' } };
  check('空译文无效', hasValidTranslation(noText) === false);

  const tooLong = { ...good, translation: { ...good.translation, text: 'x'.repeat(20_001) } };
  check('超长译文无效（模型跑飞时不能上页面）', hasValidTranslation(tooLong) === false);

  const noField = tweet('2', ORIGIN);
  check('没有 translation 字段就是没有译文', hasValidTranslation(noField) === false && translationFor(noField) === null);

  const index = translationIndex([good, noField, edited]);
  check('译文索引只收有效译文（编辑过的那条不进索引）', index.size === 1 && index.has(sourceHash(ORIGIN) ? 'We will reset all usage limits next Tuesday.' : ''));

  const list = withTranslations([good, noField, edited]);
  check('withTranslations 不给无译文的推文补出空 translation 字段',
    list[0].translation?.text === ORIGIN_ZH && !('translation' in list[1]));
}

/* ===================== 2. 挂载层：只补不改、不冒充 ===================== */

section('2. 挂载只补不改，且不冒充已翻译');

{
  const t = tweet('10', ORIGIN);
  const zh = withZh(t, ORIGIN_ZH);

  const index = translationIndex([zh]);
  const plain = { text: ORIGIN, id: 'x' };
  const mounted = attachTranslations(plain, index);
  check('有原文的对象能挂上译文', mounted.translation?.text === ORIGIN_ZH);

  const noText = { id: 'y' };
  check('没有原文的对象不会被挂译文', attachTranslations(noText, index).translation === undefined);

  // ⭐ 只补不改：远端（已有）的译文不被本地索引覆盖
  const own = { text: ORIGIN, translation: { text: '远端已挂的译文', sourceHash: sourceHash(ORIGIN), language: 'zh-CN' } };
  const kept = attachTranslations(own, index);
  check('已有合法译文不被覆盖（只补不改）', kept.translation.text === '远端已挂的译文');

  const nested = attachTranslations({ list: [{ text: ORIGIN }], deep: { inner: { text: ORIGIN } } }, index);
  check('递归结构里的每一处原文都能挂上', nested.list[0].translation?.text === ORIGIN_ZH && nested.deep.inner.translation?.text === ORIGIN_ZH);

  const empty = attachTranslations({ text: ORIGIN }, new Map());
  check('没有译文索引时原样返回（不凭空造 translation 字段）',
    empty.translation === undefined && 'translation' in empty === false);

  // 失效译文的清理
  const valid = withZh(tweet('11', ORIGIN), ORIGIN_ZH);
  const stale = { ...valid, text: '作者改过的正文' };
  const pruned = pruneStaleTranslations([valid, stale, tweet('12', ORIGIN)]);
  check('pruneStaleTranslations 清掉失效译文、保留有效译文',
    pruned[0].translation?.text === ORIGIN_ZH && !('translation' in pruned[1]) && !('translation' in pruned[2]));
  check('清理只删 translation 字段，不动其它字段',
    pruned[1].id === stale.id && pruned[1].text === stale.text && pruned[1].url === stale.url);
}

/* ===================== 3. 译文不参与任何判定 ===================== */

section('3. 译文不参与识别与计数');

{
  const t = tweet('20', ORIGIN);
  const zh = withZh(t, ORIGIN_ZH);
  const { detectSignals } = await import('../src/lib/signals.mjs');
  const plain = detectSignals([t], { now: Date.parse('2026-10-20T06:00:00Z'), account: 'thsottiaux' });
  const withZhSignals = detectSignals([zh], { now: Date.parse('2026-10-20T06:00:00Z'), account: 'thsottiaux' });

  check('挂译文前后识别结论完全一致（counts / level / window 都不变）',
    JSON.stringify(plain.counts) === JSON.stringify(withZhSignals.counts) &&
    plain.forecasts.length === withZhSignals.forecasts.length &&
    JSON.stringify(plain.forecasts.map((f) => f.level)) === JSON.stringify(withZhSignals.forecasts.map((f) => f.level)) &&
    JSON.stringify(plain.forecasts.map((f) => f.window)) === JSON.stringify(withZhSignals.forecasts.map((f) => f.window)) &&
    JSON.stringify(plain.hints.map((h) => h.level)) === JSON.stringify(withZhSignals.hints.map((h) => h.level)));

  const mounted = withSignalTranslations(plain, [zh]);
  check('withSignalTranslations 补挂译文但不改动判定结果',
    mounted.counts.explicit === plain.counts.explicit &&
    mounted.counts.hint === plain.counts.hint &&
    mounted.forecasts.length === plain.forecasts.length);
  check('有译文时 translationRevision 使用有效译文内容指纹',
    mounted.translationRevision === translationFingerprint([zh]));
  check('同条数译文修订会改变 translationRevision',
    withSignalTranslations(plain, [withZh(t, '更新后的译文')]).translationRevision !== mounted.translationRevision);
  check('没有任何译文时 translationRevision 为 0（前端刷新判据不能永远认为「没变化」）',
    withSignalTranslations(plain, [t]).translationRevision === 0);

  const cal = withCalendarTranslations({ plan: { rows: [{ entries: [{ text: ORIGIN }] }] } }, [zh]);
  check('日历挂载同样只补不改', cal.plan.rows[0].entries[0].translation?.text === ORIGIN_ZH);
}

/* ===================== 4. 采集覆盖时译文不被冲掉 ===================== */

section('4. 采集覆盖不冲掉译文，原文变更则自动失效');

{
  const { mergeTweetBatch } = await import('../src/lib/collect.mjs');
  const base = withZh(tweet('30', ORIGIN), ORIGIN_ZH);

  const merged = mergeTweetBatch([base], [tweet('30', ORIGIN)]);
  check('再次采集到同一条推文时译文保留（采集不带 translation 字段，不能把译文冲掉）',
    merged[0].translation?.text === ORIGIN_ZH && hasValidTranslation(merged[0]) === true);

  const edited = mergeTweetBatch([base], [tweet('30', 'We will reset all usage limits next Wednesday.')]);
  check('原文被采集到新版本后旧译文自动失效（对不上就不显示）',
    hasValidTranslation(edited[0]) === false);
  check('失效的 translation 字段本身也被清掉（否则它会随 tweets 载荷推到线上，' +
    '而 /api/state 的 tweets 数组原样吐出推文对象）',
    !('translation' in edited[0]));
  check('清理只删 translation 字段，别的字段一个不动',
    edited[0].id === '30' && edited[0].url === base.url && edited[0].created_at === base.created_at &&
    edited[0].text === 'We will reset all usage limits next Wednesday.');
}

/* ===================== 5. 图表挂载：摘要对不上就不挂 ===================== */

section('5. 历史记录摘要对不上原文时不挂译文');

{
  const zh = withZh(tweet('40', ORIGIN), ORIGIN_ZH);
  const index = translationIndex([zh]);

  const same = withChartTranslations({ records: [{ text: ORIGIN }] }, [zh]);
  check('上游摘要与原文逐字相同时挂上译文', same.records[0].translation?.text === ORIGIN_ZH);

  const summary = withChartTranslations({ records: [{ text: 'Tibo announced a reset of usage limits.' }] }, [zh]);
  check('上游摘要与原文不同时不挂译文（宁可不显示，也不显示对不上的）',
    summary.records[0].translation === undefined);

  check('无译文时图表原样返回', withChartTranslations({ records: [{ text: ORIGIN }] }, [tweet('41', ORIGIN)]).records[0].translation === undefined);
}

/* ===================== 6. 写盘闸门 ===================== */

section('6. 写盘前逐条校验');

{
  const t = tweet('50', ORIGIN);
  check('哈希相符的译文通过校验', validateEntry(t, { text: ORIGIN_ZH, sourceHash: sourceHash(ORIGIN) }).ok === true);
  check('哈希不符的译文被拒绝', validateEntry(t, { text: ORIGIN_ZH, sourceHash: sourceHash('别的原文') }).ok === false);
  check('缺少原文哈希的译文被拒绝', validateEntry(t, { text: ORIGIN_ZH }).ok === false);
  check('null、空值、错误格式与大写哈希均被拒绝',
    [null, '', 'xyz', 'g'.repeat(64), sourceHash(ORIGIN).toUpperCase()].every((sourceHashValue) =>
      validateEntry(t, { text: ORIGIN_ZH, sourceHash: sourceHashValue }).ok === false));
  check('空译文被拒绝', validateEntry(t, { text: '  ', sourceHash: sourceHash(ORIGIN) }).ok === false);
  check('超长译文被拒绝', validateEntry(t, { text: 'x'.repeat(20_001), sourceHash: sourceHash(ORIGIN) }).ok === false);
  check('没有原文的推文无法绑定译文', validateEntry(tweet('51', ''), { text: ORIGIN_ZH, sourceHash: sourceHash(ORIGIN) }).ok === false);
  check('译文条目不是对象时被拒绝', validateEntry(t, null).ok === false);
}

/* ===================== 6b. 隔离 CLI：采集时刻与哈希身份 ===================== */

section('6b. 隔离 CLI 不伪造采集时间且拒绝无哈希译文');

{
  const dir = await mkdtemp(resolve(tmpdir(), 'tibo-apply-translations-'));
  try {
    const scriptPath = await realpath(resolve(ROOT, 'scripts/apply-translations.mjs'));
    const fixture = {
      tweets: [tweet('cli-1', ORIGIN, { signal: { status: 'forecast', level: 'explicit' } })],
      updated_at: '2026-10-20T08:00:00.000Z',
    };
    const tweetsPath = resolve(dir, 'tweets.json');
    const translationsPath = resolve(dir, 'translations.json');
    await writeFile(tweetsPath, `${JSON.stringify(fixture)}\n`);

    const runCli = (entries) => {
      return writeFile(translationsPath, `${JSON.stringify(entries)}\n`).then(() => spawnSync(
        process.execPath,
        [scriptPath, '--data-dir', dir, '--file', translationsPath],
        { encoding: 'utf8' },
      ));
    };

    const validRun = await runCli({ 'cli-1': { text: ORIGIN_ZH, sourceHash: sourceHash(ORIGIN) } });
    assert.equal(validRun.status, 0, validRun.stderr || validRun.stdout);
    const appliedFile = JSON.parse(await readFile(tweetsPath, 'utf8'));
    check('有效隔离回填保留原 updated_at（成功采集时间不被推进）',
      appliedFile.updated_at === fixture.updated_at);
    check('有效隔离回填写入输入中已校验的原文哈希',
      appliedFile.tweets[0].translation?.sourceHash === sourceHash(ORIGIN));
    check('有效隔离回填不改原文及事件状态',
      appliedFile.tweets.length === fixture.tweets.length &&
      appliedFile.tweets[0].text === fixture.tweets[0].text &&
      JSON.stringify(appliedFile.tweets[0].signal) === JSON.stringify(fixture.tweets[0].signal));

    const noTimestampDir = resolve(dir, 'without-timestamp');
    await mkdir(noTimestampDir);
    const noTimestampPath = resolve(noTimestampDir, 'tweets.json');
    await writeFile(noTimestampPath, `${JSON.stringify({ tweets: [tweet('cli-1', ORIGIN)] })}\n`);
    const noTimestampValidRun = await writeFile(translationsPath,
      `${JSON.stringify({ 'cli-1': { text: ORIGIN_ZH, sourceHash: sourceHash(ORIGIN) } })}\n`)
      .then(() => spawnSync(process.execPath,
        [scriptPath, '--data-dir', noTimestampDir, '--file', translationsPath], { encoding: 'utf8' }));
    assert.equal(noTimestampValidRun.status, 0, noTimestampValidRun.stderr || noTimestampValidRun.stdout);
    const noTimestampApplied = JSON.parse(await readFile(noTimestampPath, 'utf8'));
    check('原数据没有 updated_at 时，成功回填也不新增该字段',
      !Object.hasOwn(noTimestampApplied, 'updated_at') &&
      noTimestampApplied.tweets[0].translation?.sourceHash === sourceHash(ORIGIN));

    await writeFile(noTimestampPath, `${JSON.stringify({ tweets: [tweet('cli-1', ORIGIN)] })}\n`);
    const missingHashRun = await writeFile(translationsPath, `${JSON.stringify({ 'cli-1': { text: ORIGIN_ZH } })}\n`)
      .then(() => spawnSync(process.execPath, [scriptPath, '--data-dir', noTimestampDir, '--file', translationsPath], { encoding: 'utf8' }));
    assert.equal(missingHashRun.status, 0, missingHashRun.stderr || missingHashRun.stdout);
    const rejectedFile = JSON.parse(await readFile(noTimestampPath, 'utf8'));
    check('缺哈希 CLI 条目不写入，也不凭空生成合法 sourceHash',
      rejectedFile.tweets[0].translation === undefined && rejectedFile.updated_at === undefined &&
      missingHashRun.stdout.includes('应用：0 条｜拒绝：1 条'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ===================== 7. 端到端：译文随 tweets 载荷上线 ===================== */

section('7. 译文随 tweets 载荷进 ingest 并落盘（D-080 死因的反面）');

{
  const { handleIngest } = await import('../server/ingest.mjs');
  const { createStore } = await import('../server/store.mjs');

  const dir = await mkdtemp(resolve(tmpdir(), 'tibo-translations-'));
  try {
    const zh = withZh(tweet('60', ORIGIN), ORIGIN_ZH);
    const payload = {
      generatedAt: '2026-10-20T08:00:00.000Z',
      resets: {
        records: [
          { id: 'r1', type: 'reset', announced_at: '2026-10-18T04:00:00.000Z', text: ORIGIN },
          { id: 'r2', type: 'reset', announced_at: '2026-10-20T04:00:00.000Z', text: ORIGIN },
        ],
      },
      tweets: { tweets: [zh], updated_at: '2026-10-20T08:00:00.000Z' },
      stats: { stats: { count: 2 }, errors: [] },
    };

    const makeReq = (body) => ({
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
    });
    const makeRes = () => ({
      statusCode: null,
      body: '',
      writeHead(code) { this.statusCode = code; },
      end(payload) { this.body = payload ?? ''; },
    });

    const res = makeRes();
    await handleIngest(makeReq(JSON.stringify(payload)), res, {
      dataDir: dir,
      token: 'test-token',
      send: (r, code, obj) => { r.writeHead(code); r.end(JSON.stringify(obj)); },
    });
    check('带 translation 字段的推文载荷被 ingest 接受（契约零改动，没有新增必填项）',
      res.statusCode === 200, `实际 ${res.statusCode} ${res.body}`);

    const onDisk = JSON.parse(await readFile(resolve(dir, 'tweets.json'), 'utf8'));
    check('落盘后译文仍在推文对象上（没被 ingest 剥掉）',
      onDisk.tweets[0].translation?.text === ORIGIN_ZH &&
      onDisk.tweets[0].translation?.sourceHash === sourceHash(ORIGIN));

    const store = createStore(dir, { account: 'thsottiaux' });
    const data = await store.getData();
    const signals = withSignalTranslations(
      (await import('../src/lib/signals.mjs')).detectSignals(data.tweets.tweets, {
        now: Date.parse('2026-10-20T09:00:00Z'), account: 'thsottiaux',
      }),
      data.tweets.tweets,
    );
    check('线上读到的数据同样能挂上译文（数据层到展示层不断链）',
      signals.translationRevision === translationFingerprint(data.tweets.tweets) &&
      signals.forecasts[0]?.evidence?.[0]?.translation?.text === ORIGIN_ZH);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ===================== 8. 隔离变异：每条断言都要有牙 ===================== */

section('8. 隔离变异（改坏源码 ⇒ 对应断言必须变红）');

const translationsPath = resolve(ROOT, 'src/lib/tweet-translations.mjs');
const translationsText = await readFile(translationsPath, 'utf8');
const signalsPath = resolve(ROOT, 'src/lib/signals.mjs');
const signalsText = await readFile(signalsPath, 'utf8');
const collectPath = resolve(ROOT, 'src/lib/collect.mjs');
const collectText = await readFile(collectPath, 'utf8');
const applyPath = resolve(ROOT, 'scripts/apply-translations.mjs');
const applyText = await readFile(applyPath, 'utf8');

/** 加载译文模块的隔离变异版（纯模块，data: URL 即可） */
async function mutantTranslations(mutate) {
  let text = translationsText;
  assert.ok(text.includes(mutate.from), '变异目标存在：' + mutate.from);
  text = text.replace(mutate.from, mutate.to);
  return import(dataUrl(text + '\n// isolated mutant ' + mutate.name));
}

/**
 * 加载带相对 import 的模块的隔离变异版（直接相对 import → 绝对 file:// URL）
 *
 * ⚠ 替换的必须是**带 `./` 前缀**的那个字面量 —— 源码里写的是 `'./signals.mjs'`，
 * 少写前缀就会一个都没替换上，然后 data: URL 模块解析 `./signals.mjs` 失败
 * （ERR_UNSUPPORTED_RESOLVE_REQUEST）。
 *
 * @param {string} text 变异后的源码
 * @param {Array<[string,string]>} pairs [源码里的字面量, 绝对路径] 列表
 */
async function mutantWithImports(text, pairs) {
  let out = text;
  for (const [literal, abs] of pairs) {
    assert.ok(out.includes(literal), '相对 import 目标存在：' + literal);
    out = out.replace(literal, JSON.stringify(pathToFileURL(abs).href));
  }
  return import(dataUrl(out));
}

/** src/lib 下的相对 import ⇒ 绝对 file URL（字面量 + 绝对路径） */
const libImport = (rel) => [`'./${rel}'`, resolve(ROOT, 'src/lib', rel)];

{
  // 变异①：去掉 sha256 闸门 —— 原文被编辑后旧译文仍被认为有效
  const m = await mutantTranslations({
    name: '去掉哈希闸门',
    from: 'return t.sourceHash === expected;',
    to: 'return true;',
  });
  const edited = { ...withZh(tweet('70', ORIGIN), ORIGIN_ZH), text: '完全不同的原文' };
  check('变异①（去掉哈希闸门）会让「原文编辑后译文失效」的断言变红',
    m.hasValidTranslation(edited) === true);
}

{
  // 变异②：识别层改读译文 —— 「译文参与判定」的真实形态。
  // 判据不是「挂载会不会改写 text」（挂载发生在识别之后，改不了），
  // 而是「识别那一步会不会去读译文」—— 那才是能改变结论的路径。
  const mutated = signalsText.replace(
    "const text = String(tweet.text ?? '').replace(/\\s+/g, ' ').trim();",
    "const text = String(tweet.translation?.text ?? tweet.text ?? '').replace(/\\s+/g, ' ').trim();",
  );
  assert.notEqual(mutated, signalsText, '变异②目标存在');
  const m = await mutantWithImports(mutated, [libImport('chart-data.js'), libImport('tweet-translations.mjs')]);
  const { detectSignals } = await import('../src/lib/signals.mjs');
  const t = tweet('71', ORIGIN);
  const zh = withZh(t, ORIGIN_ZH);
  const plain = detectSignals([t], { now: Date.parse('2026-10-20T06:00:00Z'), account: 'thsottiaux' });
  const mutatedSignals = m.detectSignals([zh], { now: Date.parse('2026-10-20T06:00:00Z'), account: 'thsottiaux' });
  check('变异②（识别层改读译文）会让「译文不参与判定」的断言变红',
    JSON.stringify(plain.counts) !== JSON.stringify(mutatedSignals.counts) ||
    plain.forecasts.length !== mutatedSignals.forecasts.length ||
    JSON.stringify(plain.forecasts.map((f) => f.level)) !== JSON.stringify(mutatedSignals.forecasts.map((f) => f.level)),
    '译文一旦进入识别输入，判定结论就会变 —— 这正是必须钉死它的原因');
}

{
  // 变异②b：挂载时把译文写进 text（挂载只补不改的镜像错误）
  const mutated = translationsText.replace(
    "out.translation = { text: entry.text, sourceHash: entry.sourceHash, language: entry.language ?? 'zh-CN' };",
    "out.text = entry.text;",
  );
  assert.notEqual(mutated, translationsText, '变异②b目标存在');
  const m = await import(dataUrl(mutated));
  const zh = withZh(tweet('78', ORIGIN), ORIGIN_ZH);
  const mounted = m.attachTranslations({ text: ORIGIN }, m.translationIndex([zh]));
  check('变异②b（挂载把译文写进 text）会让「只补不改」的断言变红',
    mounted.text === ORIGIN_ZH && mounted.text !== ORIGIN);
}

{
  // 变异③：attachTranslations 改成「覆盖」而不是「只补不改」
  const mutated = translationsText.replace(
    'if (entry && (!value.translation || !hasValidTranslation({ ...value, translation: entry }))) {',
    'if (entry) {',
  );
  assert.notEqual(mutated, translationsText, '变异③目标存在');
  const m = await import(dataUrl(mutated));
  const zh = withZh(tweet('72', ORIGIN), ORIGIN_ZH);
  const own = { text: ORIGIN, translation: { text: '远端已挂的译文', sourceHash: sourceHash(ORIGIN), language: 'zh-CN' } };
  const overwritten = m.attachTranslations(own, m.translationIndex([zh]));
  check('变异③（挂载改为覆盖）会让「只补不改」的断言变红',
    overwritten.translation.text === ORIGIN_ZH && overwritten.translation.text !== '远端已挂的译文');
}

{
  // 变异④：withSignalTranslations 补挂时改写 counts —— 「挂载不改判定」被破坏
  const mutated = signalsText.replace(
    'export function withSignalTranslations(signals, tweets) {',
    'export function withSignalTranslations(signals, tweets) {\n  signals.counts.explicit = 99;',
  );
  assert.notEqual(mutated, signalsText, '变异④目标存在');
  const m = await mutantWithImports(mutated, [libImport('chart-data.js'), libImport('tweet-translations.mjs')]);
  const { detectSignals } = await import('../src/lib/signals.mjs');
  const plain = detectSignals([tweet('73', ORIGIN)], { now: Date.parse('2026-10-20T06:00:00Z'), account: 'thsottiaux' });
  // ⚠ 先取快照：变异版会**就地**改 plain.counts（它就是传进去的那个对象），
  // 事后读 plain 会把基准也一起改掉，断言就成了自己比自己。
  const plainExplicit = plain.counts.explicit;
  const broken = m.withSignalTranslations(plain, [withZh(tweet('73', ORIGIN), ORIGIN_ZH)]);
  check('变异④（补挂时改写 counts）会让「译文不参与判定」的断言变红',
    broken.counts.explicit === 99 && plainExplicit !== 99);
}

{
  // 变异⑤：采集合并时丢掉旧译文
  const mutated = collectText.replace(
    'const next = {\n      ...prev,\n      ...t,',
    'const next = {\n      ...t,',
  );
  assert.notEqual(mutated, collectText, '变异⑤目标存在');
  const m = await mutantWithImports(mutated, [libImport('signals.mjs'), libImport('browser.mjs'), libImport('proxy.mjs'), libImport('tweet-translations.mjs')]);
  const base = withZh(tweet('74', ORIGIN), ORIGIN_ZH);
  const merged = m.mergeTweetBatch([base], [tweet('74', ORIGIN)]);
  check('变异⑤（合并时丢掉旧译文）会让「采集不冲掉译文」的断言变红',
    merged[0].translation === undefined);
}

{
  // 变异⑤b：合并后不清理失效译文 —— 过期 translation 字段会随载荷推到线上
  const mutated = collectText.replace(
    'return pruneStaleTranslations([...merged.values()]).sort(',
    'return [...merged.values()].sort(',
  );
  assert.notEqual(mutated, collectText, '变异⑤b目标存在');
  const m = await mutantWithImports(mutated, [libImport('signals.mjs'), libImport('browser.mjs'), libImport('proxy.mjs'), libImport('tweet-translations.mjs')]);
  const base = withZh(tweet('75', ORIGIN), ORIGIN_ZH);
  const edited = m.mergeTweetBatch([base], [tweet('75', '作者改过的正文')]);
  check('变异⑤b（不清理失效译文）会让「失效字段被清掉」的断言变红',
    'translation' in edited[0] && hasValidTranslation(edited[0]) === false);
}

{
  // 变异⑥：写盘校验不再比对哈希
  const mutated = applyText.replace(
    'if (entry.sourceHash !== expected) {',
    'if (false) {',
  );
  assert.notEqual(mutated, applyText, '变异⑥目标存在');
  // ⚠ apply-translations.mjs **不能**用 data: URL 整体加载：它顶层有
  // `fileURLToPath(import.meta.url)`，而 data: URL 的协议不是 file ⇒ ERR_INVALID_URL_SCHEME。
  // 所以只抠出被测的那段函数源码，注入它依赖的 sourceHash，单独跑。
  const fnSource = mutated.match(/export function validateEntry\(tweet, entry\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fnSource, '抠出 validateEntry 源码');
  // ⚠ 两个坑：
  //   ① vm 沙箱里不能有 `export` 关键字（那不是表达式）—— 抠出来时要去掉；
  //   ② `runInNewContext` 跑的是**脚本**，函数声明不会挂到沙箱对象上 ⇒
  //      要用「表达式」把返回值取出来（`(function(){...})()`），不能读沙箱属性。
  const body = fnSource.replace('export function validateEntry', 'function validateEntry');
  const validateEntryMutant = runInNewContext(`(() => { ${body}; return validateEntry; })()`, { sourceHash });
  const result = validateEntryMutant(tweet('79', ORIGIN), { text: ORIGIN_ZH, sourceHash: sourceHash('别的原文') });
  check('变异⑥（写盘不校验哈希）会让「哈希不符被拒绝」的断言变红', result.ok === true);
}

{
  // 变异⑥b：恢复旧的「有哈希才比对」逻辑 —— 缺哈希也会被接受。
  const mutated = applyText.replace(
    "if (typeof entry.sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sourceHash)) {\n    return { ok: false, reason: '缺少有效的原文 sha256（必须是 64 位小写十六进制）' };\n  }\n  if (entry.sourceHash !== expected) {",
    'if (entry.sourceHash && entry.sourceHash !== expected) {',
  );
  assert.notEqual(mutated, applyText, '变异⑥b目标存在');
  const fnSource = mutated.match(/export function validateEntry\(tweet, entry\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fnSource, '抠出 validateEntry 源码');
  const body = fnSource.replace('export function validateEntry', 'function validateEntry');
  const validateEntryMutant = runInNewContext(`(() => { ${body}; return validateEntry; })()`, { sourceHash });
  const result = validateEntryMutant(tweet('79b', ORIGIN), { text: ORIGIN_ZH });
  check('变异⑥b（恢复可选哈希旧逻辑）会接受缺少原文哈希的译文', result.ok === true);
}

{
  // 变异⑦：图表挂载不再按原文匹配 —— 给每条记录都挂上同一份译文
  const mutated = translationsText.replace(
    'export function withChartTranslations(chart, tweets) {\n  if (!chart || typeof chart !== \'object\') return chart;\n  const index = translationIndex(tweets);\n  if (index.size === 0) return chart;\n  return attachTranslations(chart, index);\n}',
    'export function withChartTranslations(chart, tweets) {\n  if (!chart || typeof chart !== \'object\') return chart;\n  const index = translationIndex(tweets);\n  if (index.size === 0) return chart;\n  const first = [...index.values()][0];\n  const records = (chart.records ?? []).map((r) => ({ ...r, translation: first }));\n  return { ...chart, records };\n}',
  );
  assert.notEqual(mutated, translationsText, '变异⑦目标存在');
  const m = await import(dataUrl(mutated));
  const zh = withZh(tweet('76', ORIGIN), ORIGIN_ZH);
  const summary = m.withChartTranslations({ records: [{ text: '上游自己写的摘要' }] }, [zh]);
  check('变异⑦（图表挂载不按原文匹配）会让「摘要对不上不挂译文」的断言变红',
    summary.records[0].translation?.text === ORIGIN_ZH);
}

assert.equal(hash(await readFile(translationsPath, 'utf8')), hash(translationsText), '译文模块源码必须逐字未变');
assert.equal(hash(await readFile(signalsPath, 'utf8')), hash(signalsText), '信号模块源码必须逐字未变');
assert.equal(hash(await readFile(collectPath, 'utf8')), hash(collectText), '采集模块源码必须逐字未变');
assert.equal(hash(await readFile(applyPath, 'utf8')), hash(applyText), '写盘脚本源码必须逐字未变');

/* ===================== 9. 网页端渲染：两处展示位与结构约束 ===================== */

/**
 * 这一节守的是 2026-10-25 实测发现的两个真漏位：
 *
 *   ① **展示位漏挂**：「最近记录」与「更多记录（时间线）」两处只渲染原文，
 *      译文虽已挂在数据层（`model.records` 上）却没输出 —— 页面上看不到。
 *      小程序端当时是渲染了的，所以这是**网页端单边缺**。
 *
 *   ② **结构违规**：`最近记录`的卡片原本整张是 `<a>`，把译文 `<details>`
 *      塞进去之后：`<a>` 只能包含 phrasing content，`<details>` 是 flow content；
 *      浏览器**不会**把它踢出 `<a>`（Chrome 155 实测 `details_parentTag = "A"`），
 *      于是「点『中文翻译』展开译文」会**同时触发外层链接跳转** ——
 *      实测 `outer_a_click_fired = true`，用户想看译文却被带去了 X。
 *
 * 两条都曾经**没有任何断言看着**，所以能长期存活。
 */

section('9. 网页端渲染：两处展示位与 <details> 结构');

{
  // 用**真实的**渲染链路（page.mjs 的 derive + render.mjs 的 renderPage），
  // 不另造夹具 —— 漏位恰恰是因为「数据层挂好了、渲染层没接」，
  // 夹具渲染只会把那个缺口糊掉。
  const { derive, renderPage } = await import('../src/lib/page.mjs');
  const readJson = async (p) => JSON.parse(await readFile(resolve(ROOT, 'data', p), 'utf8'));
  const [resets, tweets, statsFile] = await Promise.all([
    readJson('resets.json'), readJson('tweets.json'), readJson('stats.json'),
  ]);
  const model = derive({ resets, tweets, statsFile, now: Date.now(), account: 'thsottiaux' });
  const template = await readFile(resolve(ROOT, 'src/index.html'), 'utf8');
  const html = renderPage({ template, ...model, og: null });

  // ---- ① 数据层：译文确实挂在历史记录上 ----
  const records = model.model?.records ?? [];
  const withZhRecords = records.filter((r) => r.translation?.text);
  check('历史记录里确有带译文的条目（数据层已挂载）', withZhRecords.length > 0,
    `records=${records.length} 带译文=${withZhRecords.length}`);

  // ---- ② 展示位：两处都要输出译文块 ----
  //
  // 判据按**容器**切，不按全文计数 —— 全文计数会被 CSS 里的类名污染。
  const slice = (from, len) => {
    const i = html.indexOf(from);
    return i < 0 ? '' : html.slice(i, i + len);
  };
  const recordsZone = slice('id="records"', 4000);
  const timelineZone = slice('<ul class="tl"', 30000);
  const blocksIn = (zone) => (zone.match(/<details class="tweet-translation">/g) ?? []).length;

  check('「最近记录」区输出了译文块', blocksIn(recordsZone) > 0, `块数=${blocksIn(recordsZone)}`);
  check('「更多记录（时间线）」区输出了译文块', blocksIn(timelineZone) > 0, `块数=${blocksIn(timelineZone)}`);

  // 两处渲染的条目数必须与数据层对得上 —— 少一条就说明有展示位没接上。
  const recentSlice = records.slice(-3).reverse();
  const timelineSlice = [...records].reverse().slice(0, 14);
  check(
    '「最近记录」的译文块数 = 该区带译文的条目数（不多不少）',
    blocksIn(recordsZone) === recentSlice.filter((r) => r.translation?.text).length,
    `页面=${blocksIn(recordsZone)} 数据=${recentSlice.filter((r) => r.translation?.text).length}`
  );
  check(
    '「更多记录（时间线）」的译文块数 = 该区带译文的条目数（不多不少）',
    blocksIn(timelineZone) === timelineSlice.filter((r) => r.translation?.text).length,
    `页面=${blocksIn(timelineZone)} 数据=${timelineSlice.filter((r) => r.translation?.text).length}`
  );

  // ---- ③ 结构约束：<details> 不能落在 <a> 里 ----
  //
  // 判据用「`<a ...>` 到 `</a>` 的区间里有没有 `<details`」——
  // 不依赖 DOM 解析器（HTML 解析器**不会**纠正这个违规），纯文本即可判。
  //
  // ⚠ **必须先剥掉 <style> 区块**（2026-10-25 实测踩到）：
  // CSS 注释里会出现 `<a>` 与 `<details>` 这两个词（本项目那条注释就写了
  // 「<details> 不能放进 <a>」）⇒ 不剥样式就会**假阳性**。
  // 这是判据本身的缺陷，不是页面有违规 —— 别把真违规当假警报放过。
  const bodyOnly = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  const anchorsWithDetails = (bodyOnly.match(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*?<details\b/gi) ?? []).length;
  check('页面里没有把 <details> 放进 <a>（点展开不会连带跳转）', anchorsWithDetails === 0,
    `违规处数=${anchorsWithDetails}`);

  // 「最近记录」的卡片里，链接与译文块必须是**同级**（译文在 <a> 之外）。
  const recordBlock = bodyOnly.match(/<div class="am-record">[\s\S]*?<\/div><\/div>/)?.[0] ?? '';
  check('「最近记录」卡片：链接与译文块同级（译文不在 <a> 内）',
    /<a\b[^>]*>[\s\S]*?<\/a><details\b/.test(recordBlock) && !/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*?<details\b/.test(recordBlock),
    recordBlock.slice(0, 160));

  // ---- ④ 第四个展示位：「公告原文」块（主卡上第一眼看到的原文）----
  //
  // 这一处曾经漏掉，根因在**数据层**：`outlook.announcement` 是
  // `buildOutlook` 在渲染期派生的新对象（`announcement = f ?? pending`），
  // 那个字面量只抄了 4 个字段（pending/text/url/createdAt），**把译文漏掉了**
  // ⇒ 主卡上只剩一段没有译文的英文原文，
  // 而同一条推文在依据区（第二层，要展开）里是有译文的。
  //
  // 两段判据：
  //   ① 数据层：outlook.announcement 必须带上译文（不许丢）；
  //   ② 展示层：主卡「公告原文」块后面必须跟着译文块。
  const { buildOutlook } = await import('../src/lib/outlook.mjs');
  const outlook = buildOutlook({
    chart: model.chart,
    prediction: model.prediction,
    signals: model.signals,
    now: Date.now(),
  });
  const ann = outlook?.announcement;
  check('数据层：outlook.announcement 带上了译文字段（没被抄字段时丢掉）',
    Boolean(ann) && 'translation' in ann,
    ann ? `keys=${Object.keys(ann).join(',')}` : 'announcement=null');
  check('数据层：outlook.announcement 的译文与信号里的原文对得上',
    Boolean(ann?.translation) === Boolean(model.signals?.forecasts?.[0]?.translation)
      && (!ann?.translation || ann.translation.language === 'zh-CN'),
    `ann=${ann?.translation?.language ?? 'null'} fc=${model.signals?.forecasts?.[0]?.translation?.language ?? 'null'}`);

  const annZone = (() => {
    const i = bodyOnly.indexOf('class="pc-announcement"');
    return i < 0 ? '' : bodyOnly.slice(i, i + 1200);
  })();
  check('展示层：「公告原文」块后面跟着译文块', annZone.includes('<details class="tweet-translation">'),
    annZone.slice(0, 160));
  check('展示层：公告原文块与译文块同级（译文不在 <a> 内）',
    /<\/a><details\b/.test(annZone) && !/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*?<details\b/.test(annZone),
    annZone.slice(0, 200));
}

console.log(`\n${passed} 项通过；9 个隔离变异全部被对应断言拦住，源码哈希未变`);
