#!/usr/bin/env node
/** 运行管理页真实列表函数，避免手动到账在有效记录与修订账本中各算一次。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext, Script } from 'node:vm';
import { createHash } from 'node:crypto';
const url = new URL('../server/manage.html', import.meta.url);
const html = await readFile(url, 'utf8');
const digest = text => createHash('sha256').update(text).digest('hex');
const before = digest(html);
new Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
function rowsFrom(source, records, entries, tab = "landed", tweets = []) {
  const start = source.indexOf('      function buildRows(tab) {');
  const end = source.indexOf('      function cleanExcerpt(', start);
  assert.ok(start > 0 && end > start);
  const indexes = { records, tweets, byTweet: new Map(), recordByTweet: new Map() };
  const context = { rowForTweet: tweet => ({ key: 'tweet:'+tweet.id, tweet, status:'none', title:tweet.text }), state: { data: { entries } }, buildIndexes: () => indexes,
    recordId: record => record?.id || '', tweetIdFromRecord: () => '', manualForTweet: () => null,
    manualForRecord: record => entries.find(entry => record.manualEntryId === entry.id) || null,
    entryKey: entry => entry.id, entryTweetId: entry => entry.tweetId || '', entryRecordId: entry => entry.recordId || '',
    effectiveStatus: () => 'landed', eventTypeOf: type => type || 'reset', recordTitle: record => record.text,
    str: value => String(value || ''), Map, Set };
  return runInNewContext(source.slice(start, end) + `; buildRows(${JSON.stringify(tab)})`, context);
}
const entry = { id: 'one', status: 'landed', title: '额度重置已到账', occurredAt: '2026-10-23T07:00:00Z' };
const record = { id: 'manual-one', manualEntryId: 'one', type: 'reset', announced_at: entry.occurredAt, text: entry.title };
assert.equal(rowsFrom(html, [record], [entry]).length, 1, '同一笔手动到账只显示一行');
assert.equal(rowsFrom(html, [record, { id: 'auto', text: '另一笔自动到账' }], [entry]).length, 2, '无关自动到账继续保留');
const independent = { id:'without-tweet', status:'announced', title:'无推文的预告', updatedAt:'2026-10-23T07:10:00Z' };
assert.equal(rowsFrom(html,[record],[entry,independent],'allEvents',[{id:'post',text:'普通推文'}]).length,3,'全部事件包含原始推文、无推文到账和独立预告');
const dropRecord = html.replace('if (representedRecords.has(record.id)) continue;', 'if (true) continue;');
assert.notEqual(dropRecord,html);
assert.equal(rowsFrom(dropRecord,[record],[entry,independent],'allEvents',[{id:'post',text:'普通推文'}]).filter(row=>row.kind==='record').length,0,'跳过无推文记录的反例可被列表检查发现');

const statusStart = html.indexOf('      function draftStatus(');
const statusEnd = html.indexOf('      function selectRef(', statusStart);
const draftStatus = runInNewContext(html.slice(statusStart,statusEnd) + '; draftStatus');
assert.equal(draftStatus({kind:'tweet',status:'none'},null,null),'','普通动态不预选为重置预告');
assert.equal(draftStatus({kind:'tweet',status:'hint'},null,null),'','线索修订需主动选择状态');
assert.equal(draftStatus({kind:'tweet',status:'landed'},null,null),'landed','同组非主帖沿用当前到账状态');
assert.equal(draftStatus({kind:'new'},null,null),'landed','无推文补录默认已到账');
const autoAnnounce = runInNewContext(html.slice(statusStart,statusEnd).replace("return target?.kind === 'new' ? 'landed' : '';", "return target?.kind === 'new' ? 'landed' : 'announced';") + '; draftStatus');
assert.equal(autoAnnounce({kind:'tweet',status:'none'},null,null),'announced','旧默认值的隔离反例会把普通动态预选为预告');

const duplicate = html.replace('if (entry) used.add(`entry:${entryKey(entry)}`);', '');
assert.notEqual(duplicate, html);
assert.equal(rowsFrom(duplicate, [record], [entry]).length, 2, '去掉关联去重的隔离反例会重复计数');
assert.match(html, /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important/);
assert.doesNotMatch(html, /\.innerHTML\s*=/);
assert.equal(digest(await readFile(url)), before);
console.log('✓ 管理页完整列表、到账去重、编辑初始状态、隐藏态及安全 DOM 通过；隔离反例和源码哈希通过');
