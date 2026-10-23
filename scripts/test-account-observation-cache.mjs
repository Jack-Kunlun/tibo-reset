#!/usr/bin/env node
/** 手工反馈不伪造采集新鲜度，同一小时的 API 缓存仍须立即失效。 */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {setTimeout as pause} from 'node:timers/promises';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('..',import.meta.url));
const sourceUrl=new URL('../server/index.mjs',import.meta.url);
const source=await readFile(sourceUrl,'utf8');
const hash=createHash('sha256').update(source).digest('hex');
const [today,todayReply,yesterday,reply,,last]=JSON.parse(await readFile(new URL('./fixtures/reset-lifecycle-oct23.json',import.meta.url)));
const observedAt='2026-10-22T17:10:00.000Z';
const metadata={kind:'restored',source:'maintainer-account',precision:'approximate-minute',observed_at:observedAt,recorded_at:'2026-10-23T06:57:00.000Z',announcement_text:yesterday.text};
async function replay(text){
  const folder=await mkdtemp(resolve(tmpdir(),'tibo-observation-cache-'));
  const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const executable="Date.now = () => Date.parse('2026-10-23T07:10:00Z');\n" + text.replace(/^#!.*\n/,'').replace("const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');",`const ROOT = ${JSON.stringify(root)};`)
    .replace(/from (['"])(\.[^'"]+)\1/g,(_,q,p)=>`from ${q}${new URL(p,sourceUrl).href}${q}`);
  await writeFile(resolve(folder,'server.mjs'),executable);
  const tweets={updated_at:'2026-10-23T06:01:51.538Z',tweets:structuredClone([yesterday,reply,today,todayReply])};
  await Promise.all([
    writeFile(resolve(folder,'tweets.json'),JSON.stringify(tweets)),
    writeFile(resolve(folder,'resets.json'),JSON.stringify({records:[{id:'earlier',type:'reset',announced_at:'2026-10-18T05:12:00Z'},{...last,type:'reset',announced_at:last.created_at}]})),
    writeFile(resolve(folder,'stats.json'),JSON.stringify({generated_at:tweets.updated_at,errors:[]})),
  ]);
  const child=spawn(process.execPath,[resolve(folder,'server.mjs')],{cwd:root,env:{...process.env,PORT:String(port),DATA_DIR:folder,COLLECT_INTERVAL_MIN:'0',WX_APPID:'',WX_SECRET:'',ADMIN_TOKEN:'',INGEST_TOKEN:''},stdio:['ignore','pipe','pipe']});
  const closed=new Promise(resolve => child.once('close',resolve));
  let output='';child.stdout.on('data',x=>{output+=x});child.stderr.on('data',x=>{output+=x});
  try{
    let ready=false;for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok){ready=true;break;}}catch{}await pause(30);}
    assert.ok(ready,'隔离后端未启动：'+output.slice(-1500));
    const first=await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(first.signals.observedForecasts.length,0);
    await pause(20);
    tweets.tweets[0].accountObservation=metadata;
    await writeFile(resolve(folder,'tweets.json'),JSON.stringify(tweets));
    const second=await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(second.dataUpdatedAt,first.dataUpdatedAt,'不能用修改成功采集时间来强迫刷新');
    return {first:first.signals,second:second.signals};
  }finally{
    if(child.exitCode===null && child.signalCode===null) child.kill('SIGTERM');
    await closed;await rm(folder,{recursive:true,force:true});
  }
}
const fresh=await replay(source);assert.equal(fresh.second.observedForecasts.length,0);assert.equal(fresh.second.overdueForecasts.length,0);assert.equal(fresh.first.overdueForecasts.length,1);assert.equal(fresh.second.forecasts.length,1);
const mutant=source.replace('|${JSON.stringify(resets.records)}|','|');assert.notEqual(mutant,source,'缓存变异点存在');
const stale=await replay(mutant);assert.equal(stale.second.overdueForecasts.length,1,'旧缓存变异必须复现漏刷新');
assert.equal(createHash('sha256').update(await readFile(sourceUrl)).digest('hex'),hash);
console.log('✓ 同小时补录账号恢复后，按普通到账更新 API，采集时刻不变');
console.log('✓ 隔离旧缓存变异复现漏刷新，源码哈希未变；两个临时服务与数据已清理');
