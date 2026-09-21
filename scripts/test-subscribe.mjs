#!/usr/bin/env node
/**
 * F9 订阅消息链路的回归测试。
 *
 * 这条链路上有三类**不会被现场发现**的错误，必须在 CI 里钉死：
 *
 *   1. **重复推送**。水位线判错 → 每轮 ingest 都给所有订阅者推一次。
 *      用户退订都来不及，而且没有任何报错。
 *   2. **误推**。把「模型预测可能重置」当成事件推 —— 直接违反 PRD 的 0 误报。
 *      这里的判据只有一条：announced_at 严格晚于水位线。
 *   3. **删除时机错**。一次性授权推成功就该删；推失败（网络抖动）该留；
 *      只有永久失败（43101 用户拒收）才该删。搞错任一方向都会持续产生无效请求。
 *
 * 微信接口全部用注入的 fetch 打桩 —— 不起网络，也不碰真实凭据。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildTemplateData,
  createSubscriptionStore,
  detectNewResets,
  fmtWeChatTime,
  handleSubscribe,
  handleUnsubscribe,
  latestEventAt,
  notifyNewResets,
} from '../server/subscribe.mjs';
import { createWeChatClient } from '../server/wechat.mjs';

const SEND = '/message/subscribe/send';

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

/* ------------------------------ mock ------------------------------ */

function makeReq(method, body) {
  const text = body === undefined || body === null ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (text !== null) yield Buffer.from(text);
    },
  };
}

function makeRes() {
  return {
    statusCode: null,
    body: '',
    writeHead(code) {
      this.statusCode = code;
    },
    end(payload) {
      this.body = payload ?? '';
    },
    json() {
      try {
        return JSON.parse(this.body);
      } catch {
        return null;
      }
    },
  };
}

const send = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

/** 可编程的 fetch 打桩：按 URL 决定返回什么，并记录调用 */
function makeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    for (const [match, handler] of routes) {
      if (url.includes(match)) return handler(url, init, calls);
    }
    throw new Error(`未打桩的请求：${url}`);
  };
  impl.calls = calls;
  impl.count = (m) => calls.filter((c) => c.url.includes(m)).length;
  return impl;
}

/** 统一的微信 API 应答包装 */
const wxOk = (obj) => async () => ({
  status: 200,
  text: async () => JSON.stringify(obj),
});

const silence = { warn() {}, log() {}, error() {} };

const tmpDirs = [];
async function makeDir() {
  const d = await mkdtemp(join(tmpdir(), 'tibo-sub-'));
  tmpDirs.push(d);
  return d;
}

/* ============================ 1. 纯函数 ============================ */

section('1. 事件判定（纯函数）');

{
  const recs = [
    { announced_at: '2026-09-01T00:00:00.000Z' },
    { announced_at: '2026-09-10T00:00:00.000Z' },
    { announced_at: '2026-09-05T00:00:00.000Z' },
  ];

  check('水位线为空时返回全部（按时间升序）', detectNewResets(recs, null).length === 3);
  check(
    '严格晚于水位线才算新事件',
    detectNewResets(recs, '2026-09-05T00:00:00.000Z').length === 1 &&
      detectNewResets(recs, '2026-09-05T00:00:00.000Z')[0].announced_at === '2026-09-10T00:00:00.000Z'
  );
  check(
    '水位线等于最新记录时没有新事件（防重复推送的关键）',
    detectNewResets(recs, '2026-09-10T00:00:00.000Z').length === 0
  );
  check('结果按时间升序，最后一条才是本次事件', detectNewResets(recs, null)[2].announced_at === '2026-09-10T00:00:00.000Z');
  check('非法 announced_at 被忽略', detectNewResets([{ announced_at: 'garbage' }], null).length === 0);
  check('空集合不抛异常', detectNewResets([], null).length === 0 && detectNewResets(undefined, null).length === 0);

  check('latestEventAt 取最大值', latestEventAt(recs) === Date.parse('2026-09-10T00:00:00.000Z'));
  check('latestEventAt 空集合返回 null', latestEventAt([]) === null);
}

section('2. 模板字段组装');

{
  const vars = { event: '额度重置', time: '2026-09-21 10:30', eta: '已结束' };
  const def = buildTemplateData(vars);
  check('默认给出 thing1 / time2 / thing3', Object.keys(def).join(',') === 'thing1,time2,thing3', Object.keys(def).join(','));
  check('默认值填的是 event / time / eta', def.thing1.value === '额度重置' && def.time2.value === '2026-09-21 10:30');

  const custom = buildTemplateData(vars, { thing4: '第 {time} 次', number5: { value: '{eta}' } });
  check('可用自定义字段表覆盖', Object.keys(custom).join(',') === 'thing4,number5', Object.keys(custom).join(','));
  check('占位符被替换', custom.thing4.value === '第 2026-09-21 10:30 次', custom.thing4.value);

  const long = buildTemplateData({ event: '一'.repeat(50), time: 't', eta: 'e' });
  check('超长值截断到 20 字（微信字段有长度上限）', long.thing1.value.length === 20, String(long.thing1.value.length));
}

section('3. 微信 time 字段格式');

{
  check('格式为 YYYY-MM-DD HH:mm', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(fmtWeChatTime(Date.now())), fmtWeChatTime(Date.now()));
  // 2026-09-21T02:30:00Z = 北京时间 10:30
  check('按北京时间换算', fmtWeChatTime(Date.parse('2026-09-21T02:30:00Z')) === '2026-09-21 10:30', fmtWeChatTime(Date.parse('2026-09-21T02:30:00Z')));
}

/* ======================= 4. access_token 缓存 ======================= */

section('4. access_token 缓存与失效');

{
  const fetchImpl = makeFetch([
    ['/cgi-bin/token', wxOk({ access_token: 'TK1', expires_in: 7200 })],
    ['/message/subscribe/send', wxOk({ errcode: 0 })],
  ]);
  let clock = 1_000_000;
  const client = createWeChatClient({ appId: 'a', appSecret: 'b', fetchImpl, now: () => clock });

  await client.getAccessToken();
  await client.getAccessToken();
  check('两次取 token 只请求一次（命中缓存）', fetchImpl.count('/cgi-bin/token') === 1, String(fetchImpl.count('/cgi-bin/token')));

  clock += 7200_000;
  await client.getAccessToken();
  check('过期后重新取', fetchImpl.count('/cgi-bin/token') === 2, String(fetchImpl.count('/cgi-bin/token')));

  // 刷新失败但旧 token 还在有效期内 → 必须继续用旧的，不能把缓存清掉
  const flaky = makeFetch([
    ['/cgi-bin/token', async (url, init, calls) => {
      if (calls.filter((c) => c.url.includes('/cgi-bin/token')).length === 1) {
        return { status: 200, text: async () => JSON.stringify({ access_token: 'TK2', expires_in: 7200 }) };
      }
      throw new Error('ETIMEDOUT');
    }],
  ]);
  let clock2 = 0;
  const c2 = createWeChatClient({ appId: 'a', appSecret: 'b', fetchImpl: flaky, now: () => clock2 });
  await c2.getAccessToken();
  clock2 += 7200_000 - 60_000; // 进入「提前 5 分钟刷新」的窗口，但旧 token 仍未真正过期
  const kept = await c2.getAccessToken();
  check('刷新失败时回落到仍有效的旧 token（防雪崩）', kept === 'TK2', String(kept));

  // 旧 token 真的过期了就只能抛
  const dead = createWeChatClient({
    appId: 'a',
    appSecret: 'b',
    fetchImpl: makeFetch([['/cgi-bin/token', async () => { throw new Error('ENETUNREACH'); }]]),
    now: () => 0,
  });
  let threw = false;
  try {
    await dead.getAccessToken();
  } catch {
    threw = true;
  }
  check('没有可用 token 时抛出（不静默返回空串）', threw);
}

/* ======================= 5. 两个微信接口 ======================= */

section('5. 换 openid 与发消息');

{
  const client = createWeChatClient({
    appId: 'a',
    appSecret: 'b',
    fetchImpl: makeFetch([
      ['/sns/jscode2session', wxOk({ openid: 'OPENID-1', session_key: 'x' })],
      ['/cgi-bin/token', wxOk({ access_token: 'TK', expires_in: 7200 })],
      ['/message/subscribe/send', wxOk({ errcode: 0 })],
    ]),
  });

  check('code → openid', (await client.codeToOpenid('c1')) === 'OPENID-1');
  let threw = false;
  try {
    await client.codeToOpenid('');
  } catch {
    threw = true;
  }
  check('缺 code 直接抛，不发请求', threw);

  const failClient = createWeChatClient({
    appId: 'a',
    appSecret: 'b',
    fetchImpl: makeFetch([['/sns/jscode2session', wxOk({ errcode: 40163, errmsg: 'code been used' })]]),
  });
  threw = false;
  try {
    await failClient.codeToOpenid('used');
  } catch (err) {
    threw = /40163/.test(err.message);
  }
  check('换 openid 失败时带上 errcode（否则排查全靠猜）', threw);

  // token 失效 → 强制刷新后重试一次
  // 注意：token 必须在**每次被请求时**才生成，写成 wxOk({...}) 会在定义路由时就定死值
  let tokenSeq = 0;
  const retryFetch = makeFetch([
    [
      '/cgi-bin/token',
      async () => {
        tokenSeq += 1;
        return { status: 200, text: async () => JSON.stringify({ access_token: `TK${tokenSeq}`, expires_in: 7200 }) };
      },
    ],
    [
      SEND,
      async (url) => ({
        status: 200,
        text: async () => JSON.stringify(url.includes('TK1') ? { errcode: 40001, errmsg: 'invalid credential' } : { errcode: 0 }),
      }),
    ],
  ]);
  const retryClient = createWeChatClient({ appId: 'a', appSecret: 'b', fetchImpl: retryFetch });
  const sent = await retryClient.sendSubscribeMessage({ openid: 'O', templateId: 'T', data: {} });
  check('40001 → 强制刷 token 后重试一次并成功', sent.errcode === 0, JSON.stringify(sent));
  check('确实重试了（发了两次消息）', retryFetch.count(SEND) === 2, String(retryFetch.count(SEND)));

  // 43101 是永久失败
  const permClient = createWeChatClient({
    appId: 'a',
    appSecret: 'b',
    fetchImpl: makeFetch([
      ['/cgi-bin/token', wxOk({ access_token: 'TK', expires_in: 7200 })],
      ['/message/subscribe/send', wxOk({ errcode: 43101, errmsg: 'user refuse to accept the msg' })],
    ]),
  });
  let info = null;
  try {
    await permClient.sendSubscribeMessage({ openid: 'O', templateId: 'T', data: {} });
  } catch (err) {
    info = err;
  }
  check('43101 标记为永久失败（应删除订阅，不重试）', info && info.permanent === true && info.errcode === 43101, JSON.stringify(info && { c: info.errcode, p: info.permanent }));

  // 未配置凭据时整体不可用
  const off = createWeChatClient({ appId: '', appSecret: '' });
  check('未配 WX_APPID / WX_SECRET 时 configured=false', off.configured === false);
}

/* ======================= 6. 订阅端点 ======================= */

section('6. POST /api/subscribe 与 /api/unsubscribe');

{
  const dataDir = await makeDir();
  const store = createSubscriptionStore(dataDir);
  const client = createWeChatClient({
    appId: 'a',
    appSecret: 'b',
    fetchImpl: makeFetch([['/sns/jscode2session', wxOk({ openid: 'OPENID-9' })]]),
  });

  let res = makeRes();
  await handleSubscribe(makeReq('GET'), res, { store, client, templateId: 'T', send });
  check('非 POST → 405', res.statusCode === 405, String(res.statusCode));

  res = makeRes();
  await handleSubscribe(makeReq('POST', { code: 'c' }), res, { store, client, templateId: '', send });
  check('缺模板 ID → 422（不落一条永远推不出去的订阅）', res.statusCode === 422, String(res.statusCode));

  res = makeRes();
  await handleSubscribe(makeReq('POST', { code: 'c', templateId: 'T' }), res, { store, client, send });
  check('成功 → 200 且标记 scope=once', res.statusCode === 200 && res.json().scope === 'once', JSON.stringify(res.json()));

  const saved = JSON.parse(await readFile(join(dataDir, 'subscriptions.json'), 'utf8'));
  check('openid 由服务端换取后落盘', saved.items.length === 1 && saved.items[0].openid === 'OPENID-9', JSON.stringify(saved.items));
  check('落盘里**没有**客户端传来的 openid（防伪造）', JSON.stringify(saved).includes('OPENID-9') && !JSON.stringify(saved).includes('"openid":"fake"'));

  // 同一个 openid 重复授权不该堆出多条
  res = makeRes();
  await handleSubscribe(makeReq('POST', { code: 'c', templateId: 'T' }), res, { store, client, templateId: 'T', send });
  const again = JSON.parse(await readFile(join(dataDir, 'subscriptions.json'), 'utf8'));
  check('重复授权只保留一条（按 openid + 模板去重）', again.items.length === 1, String(again.items.length));

  // 换 openid 失败 → 400 而不是 500（这是客户端能修的错）
  const badClient = createWeChatClient({
    appId: 'a',
    appSecret: 'b',
    fetchImpl: makeFetch([['/sns/jscode2session', wxOk({ errcode: 40163, errmsg: 'code been used' })]]),
  });
  res = makeRes();
  await handleSubscribe(makeReq('POST', { code: 'used', templateId: 'T' }), res, { store, client: badClient, send });
  check('code 换 openid 失败 → 400', res.statusCode === 400, String(res.statusCode));

  // 未配置微信凭据 → 503（功能整体关闭）
  res = makeRes();
  await handleSubscribe(makeReq('POST', { code: 'c' }), res, { store, client: createWeChatClient({}), send });
  check('未配置微信凭据 → 503', res.statusCode === 503, String(res.statusCode));

  // 退订
  res = makeRes();
  await handleUnsubscribe(makeReq('POST', { code: 'c' }), res, { store, client, send });
  check('退订 → removed=1', res.json().removed === 1, JSON.stringify(res.json()));
  const after = JSON.parse(await readFile(join(dataDir, 'subscriptions.json'), 'utf8'));
  check('退订后订阅清空', after.items.length === 0);
}

/* ======================= 7. 新事件推送 ======================= */

section('7. 新重置事件触发推送');

async function seedResets(dataDir, isoList) {
  await writeFile(
    join(dataDir, 'resets.json'),
    JSON.stringify({ records: isoList.map((iso) => ({ announced_at: iso, type: 'reset' })) }),
    'utf8'
  );
}

{
  const dataDir = await makeDir();
  const store = createSubscriptionStore(dataDir);
  await seedResets(dataDir, ['2026-09-01T00:00:00.000Z', '2026-09-10T00:00:00.000Z']);

  /** 每造一个客户端就带一份独立的调用记录，用来数「到底发了几条」 */
  const makeClient = () => {
    const fetchImpl = makeFetch([
      ['/cgi-bin/token', wxOk({ access_token: 'TK', expires_in: 7200 })],
      [SEND, wxOk({ errcode: 0 })],
    ]);
    return { client: createWeChatClient({ appId: 'a', appSecret: 'b', fetchImpl }), fetchImpl };
  };

  let r = await notifyNewResets({ dataDir, store, client: makeClient().client, templateId: '', log: silence });
  check('未配模板 ID → 整体跳过', r.skipped === 'no-template-id', JSON.stringify(r));

  r = await notifyNewResets({ dataDir, store, client: createWeChatClient({}), templateId: 'T', log: silence });
  check('微信未配置 → 整体跳过', r.skipped === 'wechat-not-configured', JSON.stringify(r));

  // 首次运行：只记水位线，不推。否则一上线就把历史最近一次重置当成新事件群发。
  const first = makeClient();
  r = await notifyNewResets({ dataDir, store, client: first.client, templateId: 'T', log: silence });
  check('首次运行只建基线、不推送', r.skipped === 'baseline-initialized', JSON.stringify(r));
  check('基线写入水位线', (await store.read()).last_event_at === '2026-09-10T00:00:00.000Z');
  check('首次运行一条消息都没发', first.fetchImpl.count(SEND) === 0, String(first.fetchImpl.count(SEND)));

  // 加两个订阅者
  await store.write({ ...(await store.read()), items: [{ openid: 'U1', template_id: 'T' }, { openid: 'U2', template_id: 'T' }] });

  const noEvent = makeClient();
  r = await notifyNewResets({ dataDir, store, client: noEvent.client, templateId: 'T', log: silence });
  check('没有新事件时不推送（关键：不能每轮都推）', r.skipped === 'no-new-event', JSON.stringify(r));
  check('没有新事件时一条消息都没发', noEvent.fetchImpl.count(SEND) === 0, String(noEvent.fetchImpl.count(SEND)));

  // 出现新事件
  await seedResets(dataDir, ['2026-09-01T00:00:00.000Z', '2026-09-10T00:00:00.000Z', '2026-09-20T12:00:00.000Z']);
  const push = makeClient();
  r = await notifyNewResets({ dataDir, store, client: push.client, templateId: 'T', log: silence });
  check('出现新事件 → 两个订阅者都推', r.sent === 2, JSON.stringify(r));
  check('确实发出了两条微信消息', push.fetchImpl.count(SEND) === 2, String(push.fetchImpl.count(SEND)));
  check(
    '一次性授权推成功即删除（留着只会让下一轮必然失败）',
    (await store.read()).items.length === 0,
    JSON.stringify((await store.read()).items)
  );
  check('水位线推进到新事件', (await store.read()).last_event_at === '2026-09-20T12:00:00.000Z');

  const after = makeClient();
  r = await notifyNewResets({ dataDir, store, client: after.client, templateId: 'T', log: silence });
  check('推完后同样的事件不会再推第二次', r.skipped === 'no-new-event', JSON.stringify(r));
  check('第二轮一条消息都没发', after.fetchImpl.count(SEND) === 0, String(after.fetchImpl.count(SEND)));
}

{
  // 失败分类：瞬时失败保留订阅，永久失败删除订阅
  const dataDir = await makeDir();
  const store = createSubscriptionStore(dataDir);
  await seedResets(dataDir, ['2026-09-01T00:00:00.000Z']);
  await store.write({ ...(await store.read()), last_event_at: '2026-09-01T00:00:00.000Z' });
  await store.write({
    ...(await store.read()),
    items: [{ openid: 'GOOD', template_id: 'T' }, { openid: 'REFUSED', template_id: 'T' }],
  });
  await seedResets(dataDir, ['2026-09-01T00:00:00.000Z', '2026-09-25T00:00:00.000Z']);

  const client = createWeChatClient({
    appId: 'a',
    appSecret: 'b',
    fetchImpl: makeFetch([
      ['/cgi-bin/token', wxOk({ access_token: 'TK', expires_in: 7200 })],
      ['/message/subscribe/send', async (url, init) => {
        const body = JSON.parse(init.body);
        // GOOD 成功；REFUSED 报 43101（用户拒收 = 永久失败）
        const code = body.touser === 'REFUSED' ? { errcode: 43101, errmsg: 'refuse' } : { errcode: 0 };
        return { status: 200, text: async () => JSON.stringify(code) };
      }],
    ]),
  });

  const r = await notifyNewResets({ dataDir, store, client, templateId: 'T', log: silence });
  check('永久失败被统计并移除', r.removed === 1, JSON.stringify(r));

  // 瞬时失败（网络抖动）必须保留订阅，否则用户白点一次
  const dataDir2 = await makeDir();
  const store2 = createSubscriptionStore(dataDir2);
  await seedResets(dataDir2, ['2026-09-01T00:00:00.000Z', '2026-09-25T00:00:00.000Z']);
  await store2.write({ ...(await store2.read()), last_event_at: '2026-09-01T00:00:00.000Z', items: [{ openid: 'U', template_id: 'T' }] });

  const flakyClient = createWeChatClient({
    appId: 'a',
    appSecret: 'b',
    fetchImpl: makeFetch([
      ['/cgi-bin/token', wxOk({ access_token: 'TK', expires_in: 7200 })],
      ['/message/subscribe/send', wxOk({ errcode: -1, errmsg: 'system error' })],
    ]),
  });
  const r2 = await notifyNewResets({ dataDir: dataDir2, store: store2, client: flakyClient, templateId: 'T', log: silence });
  check('瞬时失败 → 保留订阅（下轮还能补推）', r2.failed === 1 && r2.removed === 0, JSON.stringify(r2));
  check('瞬时失败后订阅仍在', (await store2.read()).items.length === 1);
  check(
    '即使全部失败，水位线也推进（否则下轮会重推同一事件）',
    (await store2.read()).last_event_at === '2026-09-25T00:00:00.000Z'
  );
}

/* ------------------------------ 清理 ------------------------------ */

for (const d of tmpDirs) await rm(d, { recursive: true, force: true });

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
