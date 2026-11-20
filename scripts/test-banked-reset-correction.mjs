#!/usr/bin/env node
/** 11 月储备重置卡类型更正：只在临时账本与本机 HTTP 服务上验收。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:http';

import { correctBankedReset, BANKED_RESET_CORRECTION } from './correct-banked-reset.mjs';
import { createStore } from '../server/store.mjs';
import { handleManage } from '../server/manage.mjs';
import { projectManualData } from '../src/lib/manual-state.mjs';

const SCRIPT = new URL('./correct-banked-reset.mjs', import.meta.url);
const scriptText = await readFile(SCRIPT, 'utf8');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const NOW = Date.parse('2026-11-17T04:00:00.000Z');
const OTHER = Object.freeze({
  id: 'a4b902d1-a3e5-4bbd-923b-f4d866b040f0', tweetId: '2120000000000000001',
  status: 'landed', title: 'Earlier confirmed reset', note: 'Unrelated ledger entry',
  sourceUrl: 'https://x.com/thsottiaux/status/2120000000000000001',
  occurredAt: '2026-11-01T10:00:00.000Z', eventType: 'reset',
  createdAt: '2026-11-01T10:05:00.000Z', updatedAt: '2026-11-01T10:05:00.000Z',
});
const TARGET = Object.freeze({
  id: BANKED_RESET_CORRECTION.entryId,
  tweetId: BANKED_RESET_CORRECTION.tweetId,
  title: BANKED_RESET_CORRECTION.title,
  sourceUrl: BANKED_RESET_CORRECTION.sourceUrl,
  status: 'landed', note: 'Confirmed arrival by user', eventType: 'reset', occurredAt: '2026-11-12T21:59:39.000Z',
  createdAt: '2026-11-15T00:55:22.588Z', updatedAt: '2026-11-15T00:55:22.588Z',
});
const PREFIX = Object.freeze({ action: 'save', at: '2026-11-01T10:05:00.000Z', entryId: OTHER.id,
  before: null, after: OTHER });

function tweet(id, createdAt, text) {
  return { id, text, created_at: createdAt, account: 'thsottiaux', kind: 'credit', role: 'post',
    foundVia: 'timeline-browser', author_verified: true,
    url: `https://x.com/thsottiaux/status/${id}` };
}

async function fixture() {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'tibo-banked-reset-correction-'));
  const raw = {
    resets: { records: [] },
    tweets: { updated_at: '2026-11-16T04:03:50.000Z', source: 'browser', tweets: [
      tweet(TARGET.tweetId, TARGET.occurredAt, 'Banked reset has been activated.'),
      tweet(OTHER.tweetId, OTHER.occurredAt, 'Earlier reset.'),
    ] },
    statsFile: { generated_at: '2026-11-17T04:00:00.000Z' },
  };
  const initial = { revision: 9, entries: [TARGET, OTHER], history: [PREFIX] };
  await Promise.all([
    writeFile(resolve(dataDir, 'resets.json'), JSON.stringify(raw.resets)),
    writeFile(resolve(dataDir, 'tweets.json'), JSON.stringify(raw.tweets)),
    writeFile(resolve(dataDir, 'stats.json'), JSON.stringify(raw.statsFile)),
    writeFile(resolve(dataDir, 'manual-state.json'), JSON.stringify(initial)),
  ]);
  const store = createStore(dataDir);
  const server = createServer((req, res) => handleManage(req, res, {
    store, account: 'thsottiaux', now: NOW,
  }));
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  return {
    dataDir, raw, initial, store,
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      await new Promise((resolveClose) => server.close(resolveClose));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function totals(records) {
  return { total: records.length, reset: records.filter((item) => item.type === 'reset').length,
    credit: records.filter((item) => item.type === 'credit').length };
}

const isolated = await fixture();
try {
  const before = projectManualData({ ...isolated.raw, manual: isolated.initial, now: NOW });
  assert.deepEqual(totals(before.resets.records), { total: 2, reset: 2, credit: 0 });

  const diskBeforeDryRun = await readFile(resolve(isolated.dataDir, 'manual-state.json'), 'utf8');
  const dryRun = await correctBankedReset({ baseUrl: isolated.baseUrl });
  assert.equal(dryRun.status, 'dry-run');
  assert.equal(dryRun.before.eventType, 'reset');
  assert.equal(dryRun.update.eventType, 'credit');
  assert.equal(await readFile(resolve(isolated.dataDir, 'manual-state.json'), 'utf8'), diskBeforeDryRun,
    '预览不能写账本');
  console.log('✓ 默认预览仅提出 reset→credit，手动账本逐字节不变');

  const updated = await correctBankedReset({ baseUrl: isolated.baseUrl, apply: true });
  assert.equal(updated.status, 'updated');
  assert.equal(updated.revision, isolated.initial.revision + 1);
  assert.equal(updated.entry.id, BANKED_RESET_CORRECTION.entryId);
  assert.equal(updated.entry.tweetId, TARGET.tweetId);
  assert.equal(updated.entry.title, TARGET.title);
  assert.equal(updated.entry.note, TARGET.note);
  assert.equal(updated.entry.occurredAt, TARGET.occurredAt);
  assert.equal(updated.entry.createdAt, TARGET.createdAt);
  assert.equal(updated.entry.eventType, 'credit');

  const saved = await isolated.store.getManualState();
  assert.deepEqual(saved.history.slice(0, 1), [PREFIX], '既有审计历史前缀保留');
  assert.equal(saved.entries.find((entry) => entry.id === OTHER.id).eventType, 'reset', '无关账目未变');
  assert.deepEqual(saved.entries.find((entry) => entry.id === BANKED_RESET_CORRECTION.entryId), updated.entry);
  const after = projectManualData({ ...isolated.raw, manual: saved, now: NOW });
  assert.deepEqual(totals(after.resets.records), { total: 2, reset: 1, credit: 1 });
  assert.equal(after.resets.records.find((record) => record.manualEntryId === BANKED_RESET_CORRECTION.entryId).announced_at,
    TARGET.occurredAt, '事件日期保持不变');
  assert.equal(after.resets.records.find((record) => record.manualEntryId === OTHER.id).type, 'reset');
  console.log('✓ 账本 revision 递增，到账总数/日期不变，只把目标事件计为发券');

  const beforeSecondRun = await readFile(resolve(isolated.dataDir, 'manual-state.json'), 'utf8');
  const repeated = await correctBankedReset({ baseUrl: isolated.baseUrl, apply: true });
  assert.equal(repeated.status, 'already-correct');
  assert.equal(await readFile(resolve(isolated.dataDir, 'manual-state.json'), 'utf8'), beforeSecondRun,
    '重复执行不能再次写入');
  console.log('✓ 重复执行幂等，不再增加账本 revision 或历史记录');

  const malformed = async (body, status = 200) => ({ ok: status >= 200 && status < 300,
    status, json: async () => body });
  for (const [name, entries, expected] of [
    ['缺失目标', [OTHER], /只能有一条匹配记录/],
    ['重复目标', [TARGET, { ...TARGET, id: '38b336f3-5a8e-440a-b6e9-e960891f3022' }], /只能有一条匹配记录/],
    ['错配 ID', [{ ...TARGET, tweetId: OTHER.tweetId }, OTHER], /不在同一条账本记录/],
    ['标题不符', [{ ...TARGET, title: 'Other title' }, OTHER], /标题或原帖地址/],
    ['状态不是到账', [{ ...TARGET, status: 'announced' }, OTHER], /状态不是 landed/],
  ]) {
    await assert.rejects(correctBankedReset({ baseUrl: 'https://example.test',
      fetchImpl: async () => malformed({ revision: 1, entries }),
      target: BANKED_RESET_CORRECTION }), expected, `${name} 应拒绝操作`);
  }
  console.log('✓ 缺失/重复/错配/错误状态目标均被拦截');

  let calls = 0;
  await assert.rejects(correctBankedReset({ baseUrl: 'https://example.test', apply: true,
    fetchImpl: async (_url, options) => {
      calls++;
      if (!options.method) return malformed({ revision: 9, entries: [TARGET, OTHER] });
      return malformed({ error: 'revision conflict', revision: 10 }, 409);
    } }), /HTTP 409.*revision conflict.*revision=10/);
  assert.equal(calls, 2, '遇到 revision 冲突不能自动重试覆盖');
  console.log('✓ revision 冲突立即停止，不自动重试覆盖并发更改');
} finally {
  await isolated.close();
}

// 变异只载入 data URL 内存模块，不落盘修改被测源文件。
const importMutation = async (label, from, to) => {
  assert.ok(scriptText.includes(from), `${label} 变异锚点存在`);
  const mutantSource = scriptText.replace(from, to);
  assert.notEqual(mutantSource, scriptText, `${label} 变异确实改变源码`);
  const url = `data:text/javascript;base64,${Buffer.from(mutantSource).toString('base64')}`;
  const mutant = await import(url);
  assert.equal(typeof mutant.correctBankedReset, 'function', `${label} 隔离模块可执行`);
  return mutant;
};

const dryRunMutation = await importMutation('dry-run 写入闸门被移除',
  'if (!apply) return { status: \'dry-run\', revision: before.revision, before: entry, update };',
  'if (false) return { status: \'dry-run\', revision: before.revision, before: entry, update };');
await assert.rejects((async () => {
  const mutantFixture = await fixture();
  try {
    const before = await readFile(resolve(mutantFixture.dataDir, 'manual-state.json'), 'utf8');
    await dryRunMutation.correctBankedReset({ baseUrl: mutantFixture.baseUrl });
    const after = await readFile(resolve(mutantFixture.dataDir, 'manual-state.json'), 'utf8');
    if (after !== before) throw new Error('dry-run 写入闸门缺失：预览修改了账本');
  } finally { await mutantFixture.close(); }
})(), /dry-run 写入闸门缺失/, '移除 dry-run 闸门必须触发回归失败');
console.log('✓ 隔离变异：移除 dry-run 闸门会因账本被写而失败');

const eventTypeMutation = await importMutation('eventType 指向错误值',
  'const result = { ...entry, eventType: target.to };',
  'const result = { ...entry, eventType: target.from };');
await assert.rejects((async () => {
  const mutantFixture = await fixture();
  try {
    await eventTypeMutation.correctBankedReset({ baseUrl: mutantFixture.baseUrl, apply: true });
  } finally { await mutantFixture.close(); }
})(), /保存结果与目标不符/, '把 eventType 写错必须被响应校验拦住');
console.log('✓ 隔离变异：错误 eventType 被保存结果校验拦住');

const targetGuard = "requireCondition(entry.id === target.entryId && String(entry.tweetId ?? '') === target.tweetId,\n    '目标 entryId 与 tweetId 不在同一条账本记录中');";
const identityMutation = await importMutation('entry 与 tweet 的 ID 绑定校验被移除', targetGuard,
  "requireCondition(true, '目标 entryId 与 tweetId 不在同一条账本记录中');");
await assert.rejects((async () => {
  const wrongTarget = { ...TARGET, tweetId: '2120000000000000001' };
  const response = { ok: true, status: 200, json: async () => ({ revision: 9, entries: [wrongTarget] }) };
  let error;
  try {
    await identityMutation.correctBankedReset({ baseUrl: 'https://example.test',
      fetchImpl: async () => response });
  } catch (caught) { error = caught; }
  assert.match(error?.message ?? '', /不在同一条账本记录中/,
    '移除 ID 绑定校验会接受错误原帖，必须触发此回归失败');
})(), /移除 ID 绑定校验会接受错误原帖/, '移除 ID 绑定校验必须触发回归失败');
console.log('✓ 隔离变异：移除 entryId/tweetId 绑定检查会接受错配目标并被拦住');

const conflictMutation = await importMutation('revision 冲突响应校验被移除',
  'if (!response.ok) {', 'if (false) {');
await assert.rejects((async () => {
  let calls = 0;
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300,
    status, json: async () => body });
  let error;
  try {
    await conflictMutation.correctBankedReset({ baseUrl: 'https://example.test', apply: true,
      fetchImpl: async (_url, options) => {
        calls++;
        return options.method
          ? response({ error: 'revision conflict', revision: 10 }, 409)
          : response({ revision: 9, entries: [TARGET, OTHER] });
      } });
  } catch (caught) { error = caught; }
  assert.match(error?.message ?? '', /HTTP 409.*revision conflict.*revision=10/,
    'revision 冲突必须原样暴露，不能被当成普通保存结果错误');
  assert.equal(calls, 2, '冲突不能触发自动重试');
})(), /revision 冲突必须原样暴露/, '吞掉 revision 冲突必须触发回归失败');
console.log('✓ 隔离变异：吞掉 HTTP 409 会丢失并发冲突信息并被拦住');

assert.equal(hash(await readFile(SCRIPT, 'utf8')), hash(scriptText), '回归测试未写入更正脚本');
console.log('✓ 隔离源码变异只在 data URL 运行；更正入口磁盘 hash 未变化');
