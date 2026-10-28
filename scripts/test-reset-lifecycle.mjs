#!/usr/bin/env node
/** 真实连续活动日回放：预告、补充时间、过期、确认与非重置补偿。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as signals from '../src/lib/signals.mjs';
import * as view from '../miniprogram/utils/view.js';
import * as render from '../src/lib/render.mjs';
import * as calendar from '../src/lib/reset-calendar.mjs';
import { mergeConfirmedResets } from '../src/lib/collect.mjs';
import { announcementEventsFromForecasts } from '../server/subscribe.mjs';
const [root, reply, yesterday, yesterdayReply, compensation, done] = JSON.parse(await readFile(new URL('./fixtures/reset-lifecycle-oct23.json',import.meta.url)));
const now = Date.parse('2026-10-23T05:10:00Z');
const last = Date.parse('2026-10-20T06:33:48Z');
const deadline = Date.parse('2026-10-23T18:00:00Z');
const posts = [root, reply, yesterday, yesterdayReply, compensation];
const options = {now, lastResetAt:last};
const sig = signals.detectSignals(posts,options);
const calInput = { records:[{...done,type:'reset',announced_at:done.created_at}],
  tweets:[{...root,id:'day-one',text:'Day 1/ Improvements',created_at:'2026-10-05T08:00:00Z'},...posts],
  signals:{...sig,program:{days:28,announcedAt:'2026-10-04T20:00:00Z'}}, now };
const modules = {signals,view,render,calendar};
const sources = {};
for(const name of Object.keys(modules)) {
  const path = name==='view'?'../miniprogram/utils/view.js':`../src/lib/${name==='calendar'?'reset-calendar':name}.mjs`;
  const url = new URL(path,import.meta.url); const text = await readFile(url,'utf8');
  sources[name]={url,text,hash:createHash('sha256').update(text).digest('hex')};
}
let checks=0, mutations=0;
async function check(name,key,run,from,to){
  run(modules[key]); checks++;
  if(from){
    const src=sources[key]; assert.ok(src.text.includes(from),'变异目标不存在：'+name);
    const text=src.text.replace(from,to).replace(/from (['"])(\.[^'"]+)\1/g,(_,q,p)=>`from ${q}${new URL(p,src.url).href}${q}`);
    const bad=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
    assert.throws(()=>run(bad),undefined,'反例未被拦截：'+name); mutations++;
  }
  console.log('✓ '+name);
}
await check('Day 18 独立重置宣告是预告，不能因夹有功能更新而漏检','signals',m=>assert.equal(m.analyzeTweet(root).level,'explicit'),
  'if (!RE_SCHEDULE_PREFIX.test(text)) return false;', 'return false; if (!RE_SCHEDULE_PREFIX.test(text)) return false;');
await check('独立宣告不遮蔽同帖的明确完成句','signals',m=>
  assert.equal(m.analyzeTweet({...root,text:root.text+' Reset all propagated. See you tomorrow!'}).level,'occurred'));
await check('主帖本身不能插入到账历史','signals',m=>assert.equal(m.confirmedResetEvent(root,{tweets:posts}),null));
await check('Landing 与 Lands 都通过已核验自回复补充截止时间','signals',m=>{
  const f=m.detectSignals(posts,options).forecasts; assert.equal(f.length,1); assert.equal(f[0].window.toTs,deadline);
  assert.deepEqual(f[0].evidence.map(x=>x.id).sort(),[root.id,reply.id].sort());
},'Boolean(linked && /^(?:lands?|landing)\\s+(?:tomorrow|today|before|by)\\b/i.test(text))','false');
await check('详情关联尚未采齐时仍保留主帖的明确预告','signals',m=>{
  const f=m.detectSignals([root,{...reply,inReplyTo:null}],options).forecasts;
  assert.equal(f.length,1); assert.equal(f[0].timing,'pending');
});
await check('未经核验的自回复不能生成确定的到达窗口','signals',m=>
  assert.notEqual(m.analyzeTweet({...reply,inReplyTo:{...reply.inReplyTo,verified:false}},{tweets:posts}).level,'explicit'));
await check('愿望、否定和疑问的活动帖不是重置承诺','signals',m=>{
  for(const text of ["Day 18/ Maybe that’s a reset!","Day 18/ I wish that’s a reset!","Day 18/ That’s not a reset!","Day 18/ Is that a reset?"])
    assert.notEqual(m.analyzeTweet({...root,text}).level,'explicit');
});
await check('定向账户纠错补偿不产生重置线索或时间窗口','signals',m=>{
  const a=m.analyzeTweet(compensation); assert.equal(a.level,'none'); assert.equal(a.window,null);
},'if (isTargetedCompensation(text)) {','if (false) {');
await check('首页只取最近一日上次到账之后的重置线索，旧档案仍留存','signals',m=>{
  const hint={...root,id:'hint-new',text:'A reset?'};
  const old={...hint,id:'hint-old',created_at:'2026-10-21T04:00:00Z'};
  const other={...hint,id:'usage',text:'Usage changes next week.'};
  const s=m.detectSignals([hint,old,other],options);
  assert.deepEqual(s.activeHints.map(x=>x.id),['hint-new']); assert.ok(s.hints.some(x=>x.id==='hint-old'));
},'now - at <= DAY','true');
await check('窗口过期进入待核实，不能抹去，也不能凭过期记到账','signals',m=>{
  const s=m.detectSignals([yesterday,yesterdayReply],options);
  assert.equal(s.forecasts.length,0); assert.equal(s.overdueForecasts.length,1);
  assert.equal(s.overdueForecasts[0].status,'overdue'); assert.equal(m.confirmedResetEvent(yesterdayReply,{tweets:posts}),null);
},".map((f) => ({ ...f, status: 'overdue', statusLabel: '预告窗口已结束，落地待核实' }))",'.filter(() => false)');
await check('已有实际完成时刻后清除待核实和旧预告','signals',m=>{
  const s=m.detectSignals([yesterday,yesterdayReply],{...options,lastResetAt:Date.parse('2026-10-22T16:00:00Z')});
  assert.equal(s.forecasts.length,0); assert.equal(s.overdueForecasts.length,0);
});
await check('未定时间主帖经回复修订后，截止过去不能复活成待公布','signals',m=>{
  const s=m.detectSignals([root,reply],{...options,now:deadline+1});
  assert.equal(s.forecasts.length,0); assert.equal(s.overdueForecasts.length,1);
},"a.window.toTs < now && a.viaContext",'false && a.viaContext');
await check('真实已完成句式继续识别为到账，保住相反方向','signals',m=>assert.equal(m.confirmedResetEvent(done,{tweets:[done]}).type,'reset'));
await check('首页不再从原始 hints 捞出定向补偿','view',m=>{
  const fake={forecasts:[],hints:[{...compensation,createdAt:compensation.created_at,level:'hint',window:{from:root.created_at,to:'2026-10-26T00:00:00Z'}}],activeHints:[]};
  assert.equal(m.buildObservationSignal(fake,last,now).show,false); assert.equal(m.buildSignal(fake).show,false);
},'(sig.activeHints || []).find','(sig.hints || []).find');
await check('缓存中的有效线索到期后首页撤下','view',m=>{
  const h={id:'h',level:'hint',intent:3,text:'A reset?',createdAt:root.created_at,expiresAt:'2026-10-23T05:00:00Z'};
  assert.equal(m.buildObservationSignal({activeHints:[h],forecasts:[]},last,now).show,false);
},' || toTs(hint.expiresAt) < now','');
await check('没有新预告时首页明确显示旧承诺落地待核实','view',m=>{
  const s=signals.detectSignals([yesterday,yesterdayReply],options);
  assert.equal(m.buildObservationSignal(s,last,now).status,'overdue');
},"status: 'overdue',","status: 'hint',");
await check('网页不再展示原始补偿线索','render',m=>assert.ok(!m.renderSignal({forecasts:[],activeHints:[],hints:[{window:{sourceZone:'BAD COMPENSATION'},text:'BAD COMPENSATION'}]}).includes('BAD COMPENSATION')),
  '(sig.activeHints ?? []).find','(sig.hints ?? []).find');
await check('网页能复核已过期的承诺，且不再为它倒计时','render',m=>{
  const html=m.renderSignal(signals.detectSignals([yesterday,yesterdayReply],options));
  assert.ok(html.includes('预告窗口已结束，落地待核实')); assert.ok(!html.includes('class="sig-cd"'));
},'if (!observed && overdue) blocks.push(forecastBlock(overdue, sig, now));','');
await check('实际日期日历保留昨天的待核实状态','calendar',m=>{
  const c=m.buildResetCalendar(calInput); assert.equal(c.cells.find(x=>x.date==='2026-10-22').statusLabel,'落地待核实');
},'...(signals?.overdueForecasts ?? [])','');
await check('逐日计划明确显示昨天待核实、今天含重置预告','calendar',m=>{
  const rows=m.buildResetCalendar(calInput).plan.rows;
  assert.equal(rows.find(x=>x.day===17).statusLabel,'落地待核实');
  assert.equal(rows.find(x=>x.day===18).status,'pending');
},'overdueIds.has(String(tweet.id))','false');
// 隔离的后续完成输入，验证真实公告形状经过同一入库链路后的状态转换；不写运行数据。
const completionId='2113500000000000000';
const completion={...reply,id:completionId,url:`https://x.com/thsottiaux/status/${completionId}`,
  text:'Done.',created_at:'2026-10-23T17:00:00Z',inReplyTo:{...reply,verified:true,relation:'reply'}};
await check('真实完成不受先前承诺窗口否决，提前与晚到均按完成帖时刻入库','signals',m=>{
  for(const at of ['2026-10-23T07:00:00Z','2026-10-23T18:30:00Z']) {
    const t={...completion,created_at:at}; const all=[root,reply,t];
    assert.equal(m.confirmedResetEvent(t,{tweets:all})?.announced_at,new Date(at).toISOString());
  }
},'!RE_LINKED_DONE.test(withoutUrls(tweet.text)) && windows.some','windows.some');
const completedPosts=[...posts,completion];
const completedAt=Date.parse(completion.created_at);
const merged=mergeConfirmedResets(calInput.records,completedPosts,{now:completedAt+1000});
assert.equal(merged.added,1); assert.equal(Date.parse(merged.records[0].announced_at),completedAt); checks++;
const settled=signals.detectSignals(completedPosts,{now:completedAt+1000,lastResetAt:completedAt});
assert.equal(settled.forecasts.length,0); assert.equal(settled.overdueForecasts.length,0); checks++;
const completedCal=calendar.buildResetCalendar({...calInput,records:merged.records,tweets:[...calInput.tweets,completion],signals:{...settled,program:calInput.signals.program},now:completedAt+1000});
// D-089：日历按北京时间归格 —— 完成帖 2026-10-23T17:00:00Z = 北京 10-24 01:00 ⇒ 落 10-24 格。
assert.equal(completedCal.cells.find(c=>c.date==='2026-10-24').status,'confirmed');
assert.equal(completedCal.cells.find(c=>c.date==='2026-10-23').status,'updated');
assert.equal(completedCal.plan.rows.find(r=>r.day===18).confirmedCount,1); checks++;
assert.equal(mergeConfirmedResets(merged.records,completedPosts,{now:completedAt+1000}).added,0); checks++;
const events=announcementEventsFromForecasts(sig.forecasts,now); assert.equal(events.length,1); checks++;
for(const {url,hash} of Object.values(sources)) assert.equal(createHash('sha256').update(await readFile(url)).digest('hex'),hash);
console.log(`\n${checks} 项通过；${mutations} 个隔离源码反例被拦截，源码哈希未变`);
