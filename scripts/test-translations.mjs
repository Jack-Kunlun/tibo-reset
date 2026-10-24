#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { translationFor, withTweetTranslations } from '../src/lib/tweet-translations.mjs';
import { buildProgramPlanView, buildSignal } from '../miniprogram/utils/view.js';
import { renderProgramPlan, renderSignal } from '../src/lib/render.mjs';
import { detectSignals } from '../src/lib/signals.mjs';

const registryUrl=new URL('../src/lib/tweet-translations.json',import.meta.url);
const source=await readFile(new URL('../src/lib/tweet-translations.mjs',import.meta.url),'utf8');
const hash=value=>createHash('sha256').update(value).digest('hex');
const originalHash=hash(source);
const copies=JSON.parse(await readFile(registryUrl,'utf8'));
const post={id:'2113492187770175603',account:'thsottiaux',author_verified:true,foundVia:'timeline-browser',created_at:'2026-10-23T04:46:19.000Z',url:'https://x.com/thsottiaux/status/2113492187770175603',text:'Day 18/ Decisions API is GA, OpenResponses joined the Linux Foundation, we shipped some performance improvements and Uber is going all-in on codex & work. But yes… that’s a reset!'};
assert.ok(translationFor(post)?.text.includes('Decisions API 正式上线'));
assert.equal(translationFor({...post,text:post.text+' edited'}),null,'编辑后的原文不展示过期译文');
assert.equal(translationFor({...post,id:'unknown'}),null,'无译文时不冒充已翻译');
const before=JSON.stringify(post);
const enriched=withTweetTranslations({evidence:[post]});
assert.equal(JSON.stringify(post),before,'补译不改写原文');
assert.equal(enriched.evidence[0].translation.language,'zh-CN');
assert.equal(withTweetTranslations({id:'unknown',text:'hello',translation:{text:'伪造旧译文'}}).translation,undefined);
const machinePost={...post,id:'2119999999999999001'};
const cachedEntries={[machinePost.id]:{sourceHash:hash(machinePost.text),text:'第18天：功能更新与重置预告',language:'zh-CN',provider:'mymemory'}};
assert.equal(translationFor(machinePost,cachedEntries)?.provider,'mymemory');
assert.equal(translationFor({...machinePost,text:machinePost.text+' edited'},cachedEntries),null,'机器译文同样随原文编辑失效');
assert.equal(translationFor(machinePost,{[machinePost.id]:{...cachedEntries[machinePost.id],provider:'unknown'}}),null);
assert.equal(translationFor(post,{[post.id]:cachedEntries[machinePost.id]}).text,translationFor(post).text,'已有人工译文优先');
const machineSignal=withTweetTranslations(detectSignals([machinePost],{now:Date.parse('2026-10-23T05:00:00Z'),account:'thsottiaux'}),cachedEntries);
assert.ok(buildSignal(machineSignal).ev.some(e=>e.translation==='第18天：功能更新与重置预告'));
assert.match(renderSignal(machineSignal),/第18天：功能更新与重置预告/);
for(const [id,copy]of Object.entries(copies)){
 assert.match(id,/^\d+$/,'译文绑定来源编号');
 assert.match(copy.sourceHash,/^[a-f0-9]{64}$/,'每条译文保留准确全文校验值');
 assert.ok(copy.text.trim().length>0,'译文非空');
}
const now=Date.parse('2026-10-23T05:00:00Z');
const raw=detectSignals([post],{now,account:'thsottiaux'});
const translated=withTweetTranslations(raw);
assert.deepEqual(translated.counts,raw.counts,'翻译不参与信号判定');
assert.equal(translated.forecasts.length,raw.forecasts.length);
const signal=buildSignal(translated);
assert.ok(signal.ev.some(e=>e.translation?.includes('Decisions API')));
assert.ok(signal.ev.some(e=>e.text===post.text),'译文旁保留完整英文原文');
const plan=withTweetTranslations({title:'Tibo 28 天计划',days:28,latestDay:18,rows:[{day:18,status:'pending',statusLabel:'重置预告',entries:[{id:post.id,text:post.text,kind:'announcement'}]}]});
const view=buildProgramPlanView(plan);
assert.ok(view.days.find(d=>d.day===18).entries[0].translation.includes('Decisions API'));
assert.match(renderProgramPlan(plan),/查看原文与翻译/);
assert.match(renderSignal(translated),/中文翻译/);
const malicious=structuredClone(plan);malicious.rows[0].entries[0].translation.text='<script>alert(1)</script>';
assert.ok(!renderProgramPlan(malicious).includes('<script>alert(1)</script>'),'译文按文本转义');
const mutantUrl=new URL('data:text/javascript;base64,'+Buffer.from(source.replace("createHash('sha256').update(item.text).digest('hex') !== copy.sourceHash","false")
 .replace("import { readFileSync } from 'node:fs';",'')
 .replace("JSON.parse(readFileSync(new URL('./tweet-translations.json', import.meta.url), 'utf8'))",JSON.stringify(copies))).toString('base64'));
const mutant=await import(mutantUrl.href);
assert.notEqual(mutant.translationFor({...post,text:post.text+' edited'}),null,'真实匹配分支的哈希闸门反例会展示旧译文');
assert.equal(hash(await readFile(new URL('../src/lib/tweet-translations.mjs',import.meta.url))),originalHash);
console.log(`✓ ${Object.keys(copies).length} 条译文绑定、双端透传、转义、无判定影响通过；隔离旧译文反例及源码哈希通过`);
