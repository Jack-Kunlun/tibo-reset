#!/usr/bin/env node
/** 单账号实测与公开完成是两类证据；不把手工反馈倒灌进全量历史。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as signals from '../src/lib/signals.mjs';
import * as calendar from '../src/lib/reset-calendar.mjs';
import * as subscribe from '../server/subscribe.mjs';
import { mergeConfirmedResets, mergeTweetBatch } from '../src/lib/collect.mjs';
import { buildChartData } from '../src/lib/chart-data.js';
const [today, todayReply, root, reply, compensation, previous] = JSON.parse(await readFile(new URL('./fixtures/reset-lifecycle-oct23.json',import.meta.url)));
const observedAt = '2026-10-22T17:10:00.000Z';
const recordedAt = '2026-10-23T06:57:00.000Z';
const now=Date.parse('2026-10-23T07:10:00Z');
const report={...root,accountObservation:{kind:'restored',source:'maintainer-account',precision:'approximate-minute',observed_at:observedAt,recorded_at:recordedAt,announcement_text:root.text}};
const posts=[report,reply,today,todayReply,compensation];
const records=[{id:'older',type:'reset',announced_at:'2026-10-18T05:12:00Z'},{...previous,type:'reset',announced_at:previous.created_at}];
const lastResetAt=Date.parse(previous.created_at);
const sig=signals.detectSignals(posts,{now,lastResetAt});
const calInput={records,tweets:[{...root,id:'day-one',text:'Day 1/ Improvements',created_at:'2026-10-05T08:00:00Z'},...posts],signals:{...sig,program:{days:28,announcedAt:'2026-10-04T20:00:00Z'}},now};
const modules={signals,calendar,subscribe};const sources={};
for(const [key,path] of Object.entries({signals:'../src/lib/signals.mjs',calendar:'../src/lib/reset-calendar.mjs',subscribe:'../server/subscribe.mjs'})){
  const url=new URL(path,import.meta.url), text=await readFile(url,'utf8');sources[key]={url,text,hash:createHash('sha256').update(text).digest('hex')};
}
let checks=0,mutants=0;
async function check(name,key,run,from,to){
  run(modules[key]);checks++;
  if(from){const src=sources[key];assert.ok(src.text.includes(from),name+' 变异点不存在');
    const text=src.text.replace(from,to).replace(/from (['"])(\.[^'"]+)\1/g,(_,q,p)=>`from ${q}${new URL(p,src.url).href}${q}`);
    const bad=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
    assert.throws(()=>run(bad),undefined,name+' 未拦截反例');mutants++;
  }console.log('✓ '+name);
}
await check('北京时间23日01:10左右保留为近似账号实测，非官方完成时间','signals',m=>{
  const o=m.readAccountObservation(report,{now});assert.equal(o.observedAt,observedAt);assert.equal(o.precision,'approximate-minute');assert.equal(o.sourceLabel,'维护者账号实测');
});
await check('未记录前的历史回放看不到后来才收到的反馈','signals',m=>assert.equal(m.readAccountObservation(report,{now:Date.parse(recordedAt)-1}),null),
  'recordedAt > now','false');
await check('早于预告发布的观测不能关联本次重置','signals',m=>assert.equal(m.readAccountObservation({...report,accountObservation:{...report.accountObservation,observed_at:'2026-10-21T17:10:00Z'}},{now}),null),
  'observedAt < publishedAt','false');
await check('未来观测与倒置的记录时间不能生效','signals',m=>{
  for(const patch of [{observed_at:'2026-10-24T17:10:00Z'},{recorded_at:'2026-10-22T07:00:00Z'}])assert.equal(m.readAccountObservation({...report,accountObservation:{...report.accountObservation,...patch}},{now}),null);
},'observedAt > recordedAt','false');
await check('报告绑定预告全文，编辑或错配后停止沿用','signals',m=>assert.equal(m.readAccountObservation({...report,text:root.text+' Changed.'},{now}),null),
  'withoutUrls(report.announcement_text) !== withoutUrls(tweet.text)','false');
await check('缺少维护者来源或可信原帖身份不能展示实测','signals',m=>{
  assert.equal(m.readAccountObservation({...report,author_verified:false},{now}),null);
  assert.equal(m.readAccountObservation({...report,accountObservation:{...report.accountObservation,source:'anonymous'}},{now}),null);
});
await check('实测兑现的是Day17，Day18新预告不被抹掉','signals',m=>{
  const s=m.detectSignals(posts,{now,lastResetAt});assert.equal(s.forecasts.length,1);assert.equal(s.forecasts[0].createdAt,todayReply.created_at);
  assert.equal(s.observedForecasts.length,1);assert.equal(s.overdueForecasts.length,0);assert.equal(s.latestAccountObservation.announcementId,root.id);
},'.filter((f) => !observationFor(f))','.filter(() => true)');
await check('同一预告在窗口结束前已有实测，也不会继续作为待到账预告','signals',m=>{
  const earlyReport={...report,accountObservation:{...report.accountObservation,recorded_at:'2026-10-22T17:15:00Z'}};
  const s=m.detectSignals([earlyReport,reply],{now:Date.parse('2026-10-22T17:20:00Z'),lastResetAt});
  assert.equal(s.forecasts.length,0);assert.equal(s.observedForecasts.length,1);
},'hypothesis).filter((f) => !observationFor(f))','hypothesis)');
await check('单账号反馈不改作者发言判定，也不能直接新增全量完成事件','signals',m=>{
  assert.equal(m.analyzeTweet(report,{tweets:posts}).level,'explicit');assert.equal(m.confirmedResetEvent(report,{tweets:posts}),null);
});
const merged=mergeConfirmedResets(records,posts,{now});assert.equal(merged.added,0);assert.equal(merged.updated,0);checks++;
assert.deepEqual(buildChartData(merged.records,now),buildChartData(records,now));checks++;
assert.deepEqual(mergeTweetBatch([report],[root])[0].accountObservation,report.accountObservation);checks++;
await check('实测观察不被误发成未来预告通知','subscribe',m=>{
  const hypothetical={...sig.observedForecasts[0],window:{...sig.observedForecasts[0].window,toTs:now+3600000,to:new Date(now+3600000).toISOString()}};
  assert.equal(m.announcementEventsFromForecasts([hypothetical],now).length,0);
}," || forecast.status === 'observed'",'');
await check('日历按北京实际观测日期归格，详情保留原始时间','calendar',m=>{
  const c=m.buildResetCalendar(calInput),cell=c.cells.find(x=>x.date==='2026-10-23');assert.equal(cell.status,'observed');assert.equal(cell.observedCount,1);assert.equal(cell.confirmedCount,0);
  assert.equal(cell.details.find(x=>x.roles.includes('observed')).observedAt,observedAt);
},"else if (cell.observedCount) plain.status = 'observed';",'');
await check('Day17同步实测状态，Day18仍保持预告，统计不冒充全量确认','calendar',m=>{
  const c=m.buildResetCalendar(calInput),r=c.plan.rows.find(x=>x.day===17);assert.equal(r.status,'observed');assert.equal(r.entries[0].sourceLabel,'维护者账号实测');assert.equal(r.confirmedCount,0);assert.equal(c.plan.rows.find(x=>x.day===18).status,'pending');
},"else if (observedCount) { status = 'observed'; statusLabel = '实测到账'; }",'');
await check('后续公开完成覆盖活动状态，但仍保留实测来源留档','signals',m=>{
  const s=m.detectSignals(posts,{now,lastResetAt:Date.parse('2026-10-22T17:30:00Z')});assert.equal(s.observedForecasts.length,0);assert.equal(s.accountObservations.length,1);
},'observationFor(f) && !publiclyFulfilled(f)','observationFor(f)');
for(const src of Object.values(sources))assert.equal(createHash('sha256').update(await readFile(src.url)).digest('hex'),src.hash);
console.log(`\n${checks} 项通过；${mutants} 个隔离源码反例被拦截，源码哈希未变`);
