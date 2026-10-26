#!/usr/bin/env node
/** 活动 Day 通知身份：不同预告锚点独立，同一承诺别名去重。 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createSubscriptionStore, notifyNewResets } from '../server/subscribe.mjs';

const sourceUrl = new URL('../server/subscribe.mjs', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const sourceHash = createHash('sha256').update(source).digest('hex');
const tempDirs = [];
const failures = [];
let pass = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function makeDir() {
  const dir = await mkdtemp(join(tmpdir(), 'tibo-program-notify-'));
  tempDirs.push(dir);
  return dir;
}

const iso = (at) => new Date(at).toISOString();
const now = Date.now();
const baseAt = now - 4 * 60 * 60_000;
const atA = now - 3 * 60 * 60_000;
const atB = now - 2 * 60 * 60_000;
const base = { id: 'program-base', type: 'reset', announced_at: iso(baseAt), first_confirmed_at: iso(baseAt) };

function automaticRecord({ id, at, anchorId, assignmentSource = 'source', sourceId }) {
  return {
    id,
    type: 'reset',
    announced_at: iso(at),
    first_confirmed_at: iso(at),
    programId: '190',
    programDay: 18,
    programAssignmentSource: assignmentSource,
    programAnchorId: anchorId,
    ...(sourceId ? { url: `https://x.com/thsottiaux/status/${sourceId}` } : {}),
  };
}

function manualRecord({ id, at, anchorId, assignmentSource = 'source', sourceId }) {
  return {
    ...automaticRecord({ id: `manual-${id}`, at, anchorId, assignmentSource, sourceId }),
    manualEntryId: id,
    manual: true,
  };
}

function grant(id, openid, createdAt = now - 5 * 60 * 60_000) {
  return { id, openid, template_id: 'T', kind: 'landed', created_at: iso(createdAt) };
}

function configuredClient(sent) {
  return { configured: true, sendSubscribeMessage: async (message) => { sent.push(message.openid); } };
}

function automaticOptions({ dataDir, store, sent, records, notifications = records }) {
  return {
    dataDir,
    store,
    client: configuredClient(sent),
    templateId: 'T',
    log: { warn() {}, log() {}, error() {} },
    getRecords: async () => records,
    getNotificationRecords: async () => notifications,
  };
}

console.log('\n【1】自动归属使用 Day + anchor，公开别名按 anchor 去重');
{
  const dataDir = await makeDir();
  const store = createSubscriptionStore(dataDir);
  const a = automaticRecord({ id: 'auto-A', at: atA, anchorId: '2114200291319124163', sourceId: '2114200291319124163' });
  const b = automaticRecord({ id: 'auto-B', at: atB, anchorId: '2114237083652882932', assignmentSource: 'announcement-window', sourceId: '2114237083652882932' });
  let records = [base, a];
  let notifications = [base, a];
  const sent = [];
  await store.write({ last_event_at: iso(baseAt), items: [grant('grant-A', 'A')] });
  const first = await notifyNewResets(automaticOptions({ dataDir, store, sent, getRecords: undefined, records, notifications }));
  await store.update((state) => state.items.push(grant('grant-B', 'B', atA + 30_000)));
  records = [base, a, b];
  notifications = [base, a, b];
  const second = await notifyNewResets(automaticOptions({ dataDir, store, sent, records, notifications }));
  const alias = automaticRecord({ id: 'auto-B-alias', at: atB + 30_000, anchorId: b.programAnchorId,
    assignmentSource: 'source', sourceId: '2114237083652882999' });
  await store.update((state) => state.items.push(grant('grant-alias', 'ALIAS', atB - 30_000)));
  records = [base, a, b, alias];
  notifications = [base, a, b, alias];
  const third = await notifyNewResets(automaticOptions({ dataDir, store, sent, records, notifications }));
  const state = await store.read();
  check('同一 Day 的两个不同 anchor 都各自通知', first.sent === 1 && second.sent === 1 && sent.includes('A') && sent.includes('B'));
  check('同 anchor 新 source 别名不重发，新增授权保持可用', third.skipped === 'no-new-event' && sent.length === 2 &&
    state.items.some((item) => item.openid === 'ALIAS' && !item.pending_event));
  check('自动记录保存 anchor-qualified Day key，不写宽 Day key',
    state.landed_event_keys.includes('program:190:18:anchor:2114200291319124163') &&
    state.landed_event_keys.includes('program:190:18:anchor:2114237083652882932') &&
    !state.landed_event_keys.includes('program:190:18'));
}

console.log('\n【2】自动来源锚点无效时不退化为宽 Day key');
{
  const dataDir = await makeDir();
  const store = createSubscriptionStore(dataDir);
  const invalid = automaticRecord({ id: 'invalid-anchor', at: atA, anchorId: '0', sourceId: '2114200291319124163' });
  const sent = [];
  await store.write({ last_event_at: iso(baseAt), items: [grant('invalid-anchor-grant', 'INVALID')] });
  const result = await notifyNewResets(automaticOptions({ dataDir, store, sent, records: [base, invalid], notifications: [base, invalid] }));
  const keys = (await store.read()).landed_event_keys;
  check('无效 auto anchor 仍保留记录与原推身份，但不添加 program Day 身份', result.sent === 1 &&
    keys.includes('record:invalid-anchor') && keys.includes('source:2114200291319124163') &&
    !keys.includes('program:190:18') && !keys.some((key) => key.startsWith('program:190:18:anchor:')));
}

console.log('\n【3】手工自动归属不共享时间戳键，旧宽 Day key 不冒充 wildcard');
{
  const dataDir = await makeDir();
  const store = createSubscriptionStore(dataDir);
  const eventAt = now - 45 * 60_000;
  const firstId = '00000000-0000-4000-8000-000000000101';
  const secondId = '00000000-0000-4000-8000-000000000102';
  const firstRecord = manualRecord({ id: firstId, at: eventAt, anchorId: '2114200291319124163', sourceId: '2114200291319124163' });
  const secondRecord = manualRecord({ id: secondId, at: eventAt, anchorId: '2114237083652882932', assignmentSource: 'announcement-window', sourceId: '2114237083652882932' });
  const confirmedAt = iso(now - 5 * 60_000);
  const sent = [];
  await store.write({ last_event_at: iso(baseAt), items: [grant('manual-auto-A', 'MANUAL-A')] });
  const invoke = (record) => notifyNewResets({
    dataDir, store, templateId: 'T', client: configuredClient(sent), log: { warn() {}, log() {}, error() {} },
    getRecords: async () => [base], getNotificationRecords: async () => [base, record],
    manualEvent: { manualEntryId: record.manualEntryId, confirmedAt },
  });
  const first = await invoke(firstRecord);
  await store.update((state) => state.items.push(grant('manual-auto-B', 'MANUAL-B', now - 60 * 60_000)));
  const second = await invoke(secondRecord);
  const state = await store.read();
  check('同一秒、同一 Day 的两个手工自动归属 anchor 各自通知', first.sent === 1 && second.sent === 1 && sent.join(',') === 'MANUAL-A,MANUAL-B');
  check('自动归属手工事件不生成无作用域 manual-event 时间戳键',
    state.landed_event_keys.includes(`program:190:18:anchor:2114200291319124163`) &&
    state.landed_event_keys.includes(`program:190:18:anchor:2114237083652882932`) &&
    !state.landed_event_keys.includes(`manual-event:reset:${eventAt}`));

  const legacyDir = await makeDir();
  const legacyStore = createSubscriptionStore(legacyDir);
  const auto = automaticRecord({ id: 'new-auto-after-legacy-key', at: atA, anchorId: '2114200291319124163', sourceId: '2114200291319124163' });
  const legacySent = [];
  await legacyStore.write({ last_event_at: iso(baseAt), landed_event_keys: ['program:190:18'], items: [grant('legacy-day-grant', 'LEGACY-DAY')] });
  const legacyResult = await notifyNewResets(automaticOptions({ dataDir: legacyDir, store: legacyStore, sent: legacySent,
    records: [base, auto], notifications: [base, auto] }));
  check('旧未限定 program Day key 不吞掉新的 anchor-qualified 自动事件', legacyResult.sent === 1 && legacySent.includes('LEGACY-DAY'));
}

console.log('\n【4】迁移已通知的显式人工整日 override');
async function runLegacyManualOverride(implementation) {
  const dataDir = await makeDir();
  const store = implementation.createSubscriptionStore(dataDir);
  const manualId = '00000000-0000-4000-8000-000000000103';
  const manualAt = now - 90 * 60_000;
  const automaticAt = now - 30 * 60_000;
  const manual = { id: `manual-${manualId}`, manualEntryId: manualId, manual: true, type: 'reset',
    announced_at: iso(manualAt), first_confirmed_at: iso(manualAt), programId: '190', programDay: 18 };
  const automatic = automaticRecord({ id: 'override-alias', at: automaticAt, anchorId: '2114237083652882932', sourceId: '2114237083652882932' });
  const sent = [];
  await store.write({ last_event_at: iso(baseAt), landed_event_keys: [`manual:${manualId}`, 'program:190:18'],
    items: [grant('late-override-grant', 'LATE-OVERRIDE')] });
  const result = await implementation.notifyNewResets({
    dataDir, store, templateId: 'T', client: configuredClient(sent), log: { warn() {}, log() {}, error() {} },
    getRecords: async () => [base, automatic], getNotificationRecords: async () => [base, manual, automatic],
  });
  return { result, sent, state: await store.read(), manualId };
}

{
  const control = await runLegacyManualOverride({ createSubscriptionStore, notifyNewResets });
  check('旧显式手工到账稳定身份迁移为 override，抑制同日自动 alias 且保留晚授权',
    control.result.skipped === 'no-new-event' && control.sent.length === 0 &&
    control.state.landed_event_keys.includes('program-override:190:18') &&
    control.state.items.some((item) => item.openid === 'LATE-OVERRIDE' && !item.pending_event));
}

console.log('\n【5】内存源码变异：宽 Day、override 匹配和迁移');
const rewriteRelativeImports = (text) => text.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,
  (_match, quote, relative) => `from ${quote}${new URL(relative, sourceUrl).href}${quote}`);
async function importMutation(mutatedSource, label) {
  assert.notEqual(mutatedSource, source, `${label} 变异锚点存在`);
  return import(`data:text/javascript;base64,${Buffer.from(rewriteRelativeImports(mutatedSource)).toString('base64')}`);
}

{
  const broadAnchor = 'if (hasProgramAnchor) add(`program:${programId}:${programDay}:anchor:${anchorId}`);';
  const broadMutantText = source.replace(broadAnchor,
    'if (hasProgramAnchor) { add(`program:${programId}:${programDay}:anchor:${anchorId}`); add(`program:${programId}:${programDay}`); }');
  const broadMutant = await importMutation(broadMutantText, '自动 identity 退化宽 Day');
  const dataDir = await makeDir(), store = broadMutant.createSubscriptionStore(dataDir), sent = [];
  const a = automaticRecord({ id: 'mutant-A', at: atA, anchorId: '2114200291319124163' });
  const b = automaticRecord({ id: 'mutant-B', at: atB, anchorId: '2114237083652882932' });
  await store.write({ last_event_at: iso(baseAt), items: [grant('mutant-grant-A', 'MUTANT-A')] });
  await broadMutant.notifyNewResets(automaticOptions({ dataDir, store, sent, records: [base, a], notifications: [base, a] }));
  await store.update((state) => state.items.push(grant('mutant-grant-B', 'MUTANT-B', atA + 30_000)));
  const result = await broadMutant.notifyNewResets(automaticOptions({ dataDir, store, sent,
    records: [base, a, b], notifications: [base, a, b] }));
  check('把 auto identity 退化成宽 Day 的反例会错误吞掉 B', sent.length === 1 && result.skipped === 'no-new-event');
}

{
  const overrideBranch = 'return overrideMatchesAnchor(left, right) || overrideMatchesAnchor(right, left);';
  const overrideMutantText = source.replace(overrideBranch, 'return false;');
  const overrideMutant = await importMutation(overrideMutantText, '移除 override wildcard 匹配');
  const mutant = await runLegacyManualOverride(overrideMutant);
  check('移除 override anchor 匹配的反例会误发并消费晚授权', mutant.result.sent === 1 && mutant.sent.length === 1 && mutant.state.items.length === 0);
}

{
  const migrationCall = 'migrateManualProgramOverrides(state, notificationRecords);';
  const migrationMutantText = source.replace(migrationCall, '/* isolated mutant: no legacy override migration */');
  const migrationMutant = await importMutation(migrationMutantText, '移除旧 override 迁移');
  const mutant = await runLegacyManualOverride(migrationMutant);
  check('移除旧 override 迁移的反例会误发并消费晚授权', mutant.result.sent === 1 && mutant.sent.length === 1 && mutant.state.items.length === 0);
}

assert.equal(createHash('sha256').update(await readFile(sourceUrl, 'utf8')).digest('hex'), sourceHash,
  '所有内存变异都不得写回 server/subscribe.mjs');
check('内存变异未改写生产源码（SHA-256 不变）', true);

for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
console.log(`\nserver/subscribe.mjs SHA-256: ${sourceHash}`);
console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const failure of failures) console.log(`   · ${failure}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
