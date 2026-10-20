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
  announcementEventsFromForecasts,
  fmtWeChatTime,
  handleSubscribe,
  handleUnsubscribe,
  handleSubscriptionConfig,
  handleSubscriptionStatus,
  latestEventAt,
  notifyNewAnnouncements,
  notifyNewResets,
} from '../server/subscribe.mjs';
import { createWeChatClient } from '../server/wechat.mjs';
import { detectSignals } from '../src/lib/signals.mjs';
import subscriptionTemplate from '../server/subscribe-template.json' with { type: 'json' };

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
    { announced_at: '2026-09-01T00:00:00.000Z', type: 'reset' },
    { announced_at: '2026-09-10T00:00:00.000Z', type: 'reset' },
    { announced_at: '2026-09-05T00:00:00.000Z', type: 'reset' },
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
  check('缺模板 ID → 503（不落一条永远推不出去的订阅）', res.statusCode === 503, String(res.statusCode));

  res = makeRes();
  await handleSubscribe(makeReq('POST', { code: 'c', templateId: 'T' }), res, { store, client, templateId: 'T', send });
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
  await handleSubscribe(makeReq('POST', { code: 'used', templateId: 'T' }), res, { store, client: badClient, templateId: 'T', send });
  check('code 换 openid 失败 → 400', res.statusCode === 400, String(res.statusCode));

  // 未配置微信凭据 → 503（功能整体关闭）
  res = makeRes();
  await handleSubscribe(makeReq('POST', { code: 'c' }), res, { store, client: createWeChatClient({}), send });
  check('未配置微信凭据 → 503', res.statusCode === 503, String(res.statusCode));

  // 退订
  res = makeRes();
  await handleUnsubscribe(makeReq('POST', { code: 'c' }), res, { store, client, templateId: 'T', send });
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

section('8. 已选模板的实际字段');
{
  const dataDir = await makeDir(), store = createSubscriptionStore(dataDir);
  await seedResets(dataDir, ['2026-09-01T00:00:00.000Z', '2026-09-20T02:30:00.000Z']);
  await store.write({ last_event_at: '2026-09-01T00:00:00.000Z', items: [{ openid: 'U', template_id: subscriptionTemplate.templateId }] });
  let message;
  await notifyNewResets({ dataDir, store, templateId: subscriptionTemplate.templateId, templateSpec: subscriptionTemplate.data, client: { configured: true, sendSubscribeMessage: async (m) => { message = m; } }, log: silence });
  check('落地通知文案声明公开完成公告已确认', message.templateId === subscriptionTemplate.templateId && JSON.stringify(message.data) === JSON.stringify({ thing13: { value: '重置已落地｜公开完成公告已确认' }, time10: { value: '2026-09-20 10:30' }, thing5: { value: '查看观测台了解详情' } }));
}

section('8. 实际开启、状态与并发回归');

const authClient = { configured: true, codeToOpenid: async (code) => code, sendSubscribeMessage: async () => {} };
const register = async (store, code, templateId = 'T', kind, grantId) => {
  const res = makeRes();
  await handleSubscribe(makeReq('POST', { code, templateId, ...(kind ? { kind } : {}), ...(grantId ? { grantId } : {}) }), res, { store, client: authClient, templateId: 'T', send });
  return res;
};
const status = async (store, code, kind, grantId) => {
  const res = makeRes();
  await handleSubscriptionStatus(makeReq('POST', { code, templateId: 'T', ...(kind ? { kind } : {}), ...(grantId ? { grantId } : {}) }), res, { store, client: authClient, templateId: 'T', send });
  return res.json();
};
{
  const future = new Date(Date.now() + 3600000).toISOString();
  const old = '2026-09-01T00:00:00.000Z';
  const edited = { announced_at: '2026-09-20T00:00:00.000Z', first_confirmed_at: old, type: 'reset' };
  check('未来记录、未知类型及历史确认补正不触发新通知',
    detectNewResets([{ announced_at: future, type: 'reset' }, { announced_at: '2026-09-20T00:00:00Z', type: 'hint' }, { announced_at: '2026-09-20T00:00:00Z' }, edited], old).length === 0);
  const dataDir = await makeDir(), store = createSubscriptionStore(dataDir);
  await seedResets(dataDir, [old]);
  const invalid = await register(store, 'U', 'OTHER');
  let malformed = makeRes();
  await handleSubscribe(makeReq('POST', null), malformed, { store, client: authClient, templateId: 'T', send });
  check('模板不一致或非法请求均不能登记', invalid.statusCode === 422 && malformed.statusCode === 400 && (await store.read()).items.length === 0);
  await Promise.all([register(store, 'U'), register(store, 'V')]);
  check('并发登记保留全部用户，并在首次开启时建立历史基线', (await store.read()).items.length === 2 && (await store.read()).last_event_at === old);
  check('查询只返回当前用户的通知登记状态', (await status(store, 'U')).active === true && (await status(store, 'OTHER')).active === false && !JSON.stringify(await status(store, 'U')).includes('openid'));
  let config = makeRes();
  handleSubscriptionConfig(makeReq('GET'), config, { client: authClient, templateId: 'T', send });
  const enabled = config.json();
  config = makeRes();
  handleSubscriptionConfig(makeReq('GET'), config, { client: authClient, templateId: '', send });
  check('公开配置列出两类通知且不暴露服务凭据', enabled.enabled === true && enabled.templateId === 'T' && enabled.kinds.join() === 'announcement,landed' && config.json().enabled === false && Object.keys(enabled).sort().join() === 'enabled,kinds,scope,templateId');
  // 登记已完成，构造一个随后确认的事件；不用等待真实时间推进。
  const at = new Date(Date.now() - 1000).toISOString();
  await store.update((state) => { state.items.forEach((x) => { x.created_at = at; }); });
  await seedResets(dataDir, [old, new Date(Date.now()).toISOString()]);
  let sends = 0;
  const options = { dataDir, store, client: { ...authClient, sendSubscribeMessage: async () => { sends++; } }, templateId: 'T', log: silence };
  await Promise.all([notifyNewResets(options), notifyNewResets(options)]);
  check('重复并发采集只发送一次，发送后查询恢复未开启', sends === 2 && (await status(store, 'U')).active === false && (await status(store, 'V')).active === false);
}

section('9. 预告通知与落地授权隔离');
{
  const now = Date.parse('2026-09-20T10:00:00.000Z');
  const forecastSignal = detectSignals([{
    id: 'announcement-1',
    account: 'thsottiaux',
    text: 'We will reset everyones usage limits next Tuesday',
    created_at: '2026-09-19T18:00:00.000Z',
    foundVia: 'timeline-browser',
    author_verified: true,
  }], { now, account: 'thsottiaux' });
  const forecasts = forecastSignal.forecasts;
  const events = announcementEventsFromForecasts(forecasts, now);
  check('仅当前仍有效的 explicit forecast 生成预告事件', forecasts.length === 1 && events.length === 1 && events[0].id === `day:${forecasts[0].window.dayNum}` && events[0].created_at === forecasts[0].createdAt);
  check('hint、occurred、软证据、未来时间和缺来源 ID 均不生成通知', announcementEventsFromForecasts([
    { ...forecasts[0], level: 'hint' },
    { ...forecasts[0], level: 'occurred' },
    { ...forecasts[0], evidence: forecasts[0].evidence.map((e) => ({ ...e, weight: 'soft' })) },
    { ...forecasts[0], createdAt: new Date(now + 1).toISOString() },
    { ...forecasts[0], evidence: forecasts[0].evidence.map((e) => ({ ...e, createdAt: new Date(now + 1).toISOString() })) },
    { ...forecasts[0], evidence: [{ ...forecasts[0].evidence[0], id: null }] },
  ], now).length === 0);

  // 使用 detectSignals 的真实输出复现小时级窗口；这类有效窗口没有 dayNum。
  const shortNow = Date.now();
  const shortTweet = {
    id: 'short-window-1', account: 'thsottiaux',
    text: 'We will reset everyone’s usage limits within the next 2 hours.',
    created_at: new Date(shortNow - 10 * 60_000).toISOString(),
    foundVia: 'timeline-browser', author_verified: true,
  };
  const shortForecasts = detectSignals([shortTweet], { now: shortNow, account: 'thsottiaux' }).forecasts;
  const shortEvents = announcementEventsFromForecasts(shortForecasts, shortNow);
  const shortReplay = announcementEventsFromForecasts(
    detectSignals([shortTweet], { now: shortNow + 60_000, account: 'thsottiaux' }).forecasts,
    shortNow + 60_000,
  );
  check('真实 detectSignals 小时窗口（dayNum=null、from/to 有效）生成稳定预告键',
    shortForecasts[0]?.level === 'explicit' && shortForecasts[0]?.window?.dayNum === null &&
    Number.isFinite(Date.parse(shortForecasts[0]?.window?.from)) && Date.parse(shortForecasts[0]?.window?.to) > Date.parse(shortForecasts[0]?.window?.from) &&
    shortEvents.length === 1 && shortEvents[0].id.startsWith('window:') && shortReplay[0]?.id === shortEvents[0].id);
  const shortStore = createSubscriptionStore(await makeDir());
  await shortStore.write({ items: [{ openid: 'SHORT', template_id: 'T', kind: 'announcement', created_at: new Date(shortNow - 11 * 60_000).toISOString() }] });
  let shortSends = 0;
  const shortOptions = {
    store: shortStore, templateId: 'T', now: shortNow, forecasts: shortForecasts, log: silence,
    client: { configured: true, sendSubscribeMessage: async () => { shortSends++; } },
  };
  const shortSent = await notifyNewAnnouncements(shortOptions);
  await notifyNewAnnouncements(shortOptions);
  check('短时明确窗口会派发一次，重放仍按稳定键去重', shortSent.sent === 1 && shortSends === 1);

  const dataDir = await makeDir(), store = createSubscriptionStore(dataDir);
  await seedResets(dataDir, ['2026-09-01T00:00:00.000Z']);
  await store.write({
    last_event_at: '2026-09-01T00:00:00.000Z',
    items: [
      { openid: 'U', template_id: 'T', kind: 'announcement', created_at: '2026-09-19T17:59:00.000Z' },
      { openid: 'U', template_id: 'T', created_at: '2026-09-19T17:59:00.000Z' },
    ],
  });
  let sent = [];
  const options = {
    store, client: { configured: true, sendSubscribeMessage: async (m) => sent.push(m) },
    templateId: 'T', templateSpec: subscriptionTemplate.data, forecasts, now, log: silence,
  };
  const r = await notifyNewAnnouncements(options);
  check('预告只发送给预告授权，且明确尚未确认落地', r.sent === 1 && sent[0].data.thing13.value === '重置预告｜尚未确认落地' && sent[0].data.thing5.value === '尚未确认重置完成');
  check('发送预告不推进落地水位，也不消耗落地授权', (await store.read()).last_event_at === '2026-09-01T00:00:00.000Z' && (await status(store, 'U')).active === true && (await status(store, 'U', 'announcement')).active === false);
  const duplicate = await notifyNewAnnouncements(options);
  check('重复 ingest / 并发重放同一 forecast 不会重复预告', duplicate.skipped === 'no-new-announcement' && sent.length === 1);

  const confirmedDir = await makeDir(), confirmedStore = createSubscriptionStore(confirmedDir);
  const landedAt = '2026-09-20T00:00:00.000Z';
  await seedResets(confirmedDir, ['2026-09-01T00:00:00.000Z', landedAt]);
  await confirmedStore.write({ last_event_at: '2026-09-01T00:00:00.000Z', items: [
    { openid: 'CONFIRMED', template_id: 'T', kind: 'announcement', created_at: '2026-09-19T17:00:00.000Z' },
    { openid: 'CONFIRMED', template_id: 'T', kind: 'landed', created_at: '2026-09-19T17:00:00.000Z' },
  ] });
  let confirmedMessages = [];
  const confirmed = await notifyNewResets({
    dataDir: confirmedDir, store: confirmedStore, client: { configured: true, sendSubscribeMessage: async (m) => confirmedMessages.push(m) },
    templateId: 'T', templateSpec: subscriptionTemplate.data, log: silence,
  });
  check('确认落地事件只消耗落地授权，不触发预告通知', confirmed.sent === 1 && confirmedMessages.length === 1 && confirmedMessages[0].data.thing13.value.startsWith('重置已落地') && (await status(confirmedStore, 'CONFIRMED')).active === false && (await status(confirmedStore, 'CONFIRMED', 'announcement')).active === true);

  // 旧客户端省略 kind 时只落 landed 订阅；旧名单同样按 landed 解释。
  const defaultKind = await register(store, 'LEGACY');
  check('旧客户端省略 kind 时默认登记为落地通知', defaultKind.statusCode === 200 && (await status(store, 'LEGACY')).active === true && (await status(store, 'LEGACY', 'announcement')).active === false);
  const invalidKind = await register(store, 'INVALID', 'T', 'probability');
  const invalidStatus = makeRes();
  await handleSubscriptionStatus(makeReq('POST', { code: 'INVALID', templateId: 'T', kind: 'probability' }), invalidStatus, { store, client: authClient, templateId: 'T', send });
  const invalidUnsubscribe = makeRes();
  await handleUnsubscribe(makeReq('POST', { code: 'U', kind: 'probability' }), invalidUnsubscribe, { store, client: authClient, send });
  check('非法 kind 在登记、状态查询和退订中均被拒绝', invalidKind.statusCode === 400 && invalidStatus.statusCode === 400 && invalidUnsubscribe.statusCode === 400);

  const unsubscribeStore = createSubscriptionStore(await makeDir());
  await unsubscribeStore.write({ items: [
    { openid: 'UNSUB', template_id: 'T', kind: 'announcement' },
    { openid: 'UNSUB', template_id: 'T' },
  ] });
  const unsub = makeRes();
  await handleUnsubscribe(makeReq('POST', { code: 'UNSUB', kind: 'announcement' }), unsub, { store: unsubscribeStore, client: authClient, send });
  check('按 kind 退订只移除对应通知', unsub.json().removed === 1 && (await status(unsubscribeStore, 'UNSUB')).active === true && (await status(unsubscribeStore, 'UNSUB', 'announcement')).active === false);
  const legacyUnsub = makeRes();
  await handleUnsubscribe(makeReq('POST', { code: 'UNSUB' }), legacyUnsub, { store: unsubscribeStore, client: authClient, send });
  check('省略 kind 的旧退订仍清除该用户全部通知', legacyUnsub.json().removed === 1 && (await status(unsubscribeStore, 'UNSUB')).active === false);
}

section('10. 预告通知重试与开启前不追发');
{
  const now = Date.parse('2026-09-20T10:00:00.000Z');
  const forecasts = detectSignals([{
    id: 'announcement-retry', account: 'thsottiaux',
    text: 'We will reset everyones usage limits next Tuesday',
    created_at: '2026-09-19T18:00:00.000Z', foundVia: 'with-replies', author_verified: true,
  }], { now, account: 'thsottiaux' }).forecasts;
  const dataDir = await makeDir(), store = createSubscriptionStore(dataDir);
  await store.write({ items: [{ openid: 'U', template_id: 'T', kind: 'announcement', created_at: '2026-09-19T17:59:00.000Z' }] });
  let attempts = 0;
  const options = {
    store, forecasts, now, templateId: 'T', log: silence,
    client: { configured: true, sendSubscribeMessage: async () => { if (++attempts === 1) throw new Error('network'); } },
  };
  const failed = await notifyNewAnnouncements(options);
  check('瞬时失败保留预告授权和已落盘待发送事件', failed.failed === 1 && (await store.read()).items[0].pending_announcement?.id);
  const retried = await notifyNewAnnouncements(options);
  check('同一预告在后续 ingest 重试成功后才消耗授权', retried.sent === 1 && attempts === 2 && (await store.read()).items.length === 0);

  const lateDir = await makeDir(), lateStore = createSubscriptionStore(lateDir);
  await lateStore.write({ items: [{ openid: 'LATE', template_id: 'T', kind: 'announcement', created_at: '2026-09-19T19:00:00.000Z' }] });
  let lateSends = 0;
  const late = await notifyNewAnnouncements({ ...options, store: lateStore, client: { configured: true, sendSubscribeMessage: async () => { lateSends++; } } });
  check('预告发生后才开启的订阅不追发历史预告', late.skipped === 'no-new-announcement' && lateSends === 0 && (await lateStore.read()).items.length === 1);

  const withdrawnStore = createSubscriptionStore(await makeDir());
  await withdrawnStore.write({ items: [{ openid: 'WITHDRAWN', template_id: 'T', kind: 'announcement', created_at: '2026-09-19T17:59:00.000Z' }] });
  let withdrawnAttempts = 0;
  const withdrawnOptions = {
    ...options, store: withdrawnStore,
    client: { configured: true, sendSubscribeMessage: async () => { withdrawnAttempts++; throw new Error('network'); } },
  };
  await notifyNewAnnouncements(withdrawnOptions);
  const invalidated = await notifyNewAnnouncements({ ...withdrawnOptions, forecasts: [] });
  const withdrawnItem = (await withdrawnStore.read()).items[0];
  check('已撤回或过期的待发预告被清除且授权保留', invalidated.skipped === 'no-valid-announcement' && withdrawnAttempts === 1 && !withdrawnItem.pending_announcement && withdrawnItem.kind === 'announcement');

  const evolvingStore = createSubscriptionStore(await makeDir());
  await evolvingStore.write({ items: [{ openid: 'EVOLVING', template_id: 'T', kind: 'announcement', created_at: '2026-09-19T17:59:00.000Z' }] });
  const tweet = (text) => ({ id: 'same-hard-evidence', account: 'thsottiaux', text, created_at: '2026-09-19T18:00:00.000Z', foundVia: 'timeline-browser', author_verified: true });
  const pendingForecasts = detectSignals([tweet('We will reset everyones usage limits')], { now, account: 'thsottiaux' }).forecasts;
  const datedForecasts = detectSignals([tweet('We will reset everyones usage limits next Tuesday')], { now, account: 'thsottiaux' }).forecasts;
  let evolvingAttempts = 0;
  const evolvingOptions = {
    ...options, store: evolvingStore,
    client: { configured: true, sendSubscribeMessage: async () => { if (++evolvingAttempts <= 2) throw new Error('network'); } },
  };
  const pendingResult = await notifyNewAnnouncements({ ...evolvingOptions, forecasts: pendingForecasts });
  const pendingId = (await evolvingStore.read()).items[0].pending_announcement.id;
  const dateUpdate = await notifyNewAnnouncements({ ...evolvingOptions, forecasts: datedForecasts });
  const datedId = (await evolvingStore.read()).items[0]?.pending_announcement?.id;
  const dayAlias = announcementEventsFromForecasts(datedForecasts, now)[0]?.id;
  const aliasRecorded = (await evolvingStore.read()).announcement_ids.includes(dayAlias);
  const datedResult = await notifyNewAnnouncements({ ...evolvingOptions, forecasts: datedForecasts });
  check('预告补上日期后更新原待发项并登记日期别名，再重试成功', pendingForecasts[0]?.timing === 'pending' && datedForecasts[0]?.window && pendingId.startsWith('pending:') && datedId?.startsWith('day:') && aliasRecorded && pendingResult.failed === 1 && dateUpdate.failed === 1 && datedResult.sent === 1 && evolvingAttempts === 3 && (await evolvingStore.read()).items.length === 0);

  const laterTweet = {
    id: 'new-hard-evidence-same-day', account: 'thsottiaux',
    text: 'We will reset everyones usage limits next Tuesday',
    created_at: '2026-09-19T18:30:00.000Z', foundVia: 'timeline-browser', author_verified: true,
  };
  const laterForecasts = detectSignals([laterTweet], { now, account: 'thsottiaux' }).forecasts;
  await evolvingStore.update((state) => state.items.push({
    id: 'reauthorized-after-first-notice', openid: 'NEW-GRANT', template_id: 'T', kind: 'announcement',
    created_at: '2026-09-19T18:15:00.000Z', grant_id: 'new-grant',
  }));
  let aliasSends = 0;
  const aliasReplay = await notifyNewAnnouncements({
    ...evolvingOptions, client: { configured: true, sendSubscribeMessage: async () => { aliasSends++; } },
    forecasts: laterForecasts,
  });
  check('同日新硬证据沿用已登记日期别名，不向重新授权者重复推送',
    laterForecasts[0]?.window?.dayNum === datedForecasts[0]?.window?.dayNum &&
    aliasReplay.skipped === 'no-new-announcement' && aliasSends === 0 &&
    !(await evolvingStore.read()).items[0].pending_announcement);
}
{
  const now = Date.now();
  const forecasts = detectSignals([{
    id: 'withdraw-during-batch', account: 'thsottiaux', text: 'We will reset everyones usage limits next Tuesday',
    created_at: new Date(now - 10 * 60_000).toISOString(), foundVia: 'timeline-browser', author_verified: true,
  }], { now, account: 'thsottiaux' }).forecasts;
  const store = createSubscriptionStore(await makeDir());
  await store.write({ items: ['U', 'V'].map((openid) => ({
    openid, template_id: 'T', kind: 'announcement', created_at: new Date(now - 11 * 60_000).toISOString(),
  })) });
  let currentForecasts = forecasts;
  let release, started;
  const waiting = new Promise((r) => { release = r; });
  const entered = new Promise((r) => { started = r; });
  const recipients = [];
  const client = { configured: true, sendSubscribeMessage: async (message) => {
    recipients.push(message.openid);
    if (message.openid === 'U') { started(); await waiting; }
  } };
  const options = { store, client, templateId: 'T', getForecasts: async () => currentForecasts, now, log: silence };
  const sending = notifyNewAnnouncements(options);
  await entered;
  currentForecasts = [];
  const invalidation = notifyNewAnnouncements(options);
  release();
  const [first, second] = await Promise.all([sending, invalidation]);
  const state = await store.read();
  const v = state.items.find((item) => item.openid === 'V');
  check('长批次中当前预告撤回后跳过下一位并保留授权',
    first.sent === 1 && second.skipped === 'no-valid-announcement' && recipients.join() === 'U' &&
    v && !v.pending_announcement && (await status(store, 'V', 'announcement')).active === true);
}
{
  const dataDir = await makeDir(), store = createSubscriptionStore(dataDir);
  await seedResets(dataDir, ['2026-09-01T00:00:00.000Z', '2026-09-20T00:00:00.000Z']);
  await store.write({ last_event_at: '2026-09-01T00:00:00.000Z', items: [{ openid: 'U', template_id: 'T' }] });
  let attempts = 0;
  const options = { dataDir, store, templateId: 'T', log: silence, client: { ...authClient, sendSubscribeMessage: async () => { if (++attempts === 1) throw new Error('network'); } } };
  await notifyNewResets(options);
  const failed = await store.read();
  await notifyNewResets(options);
  await notifyNewResets(options);
  check('失败事件持久化，下轮无新事件也补推，成功后停止', Boolean(failed.items[0].pending_event_at) && attempts === 2 && (await store.read()).items.length === 0);
}
{
  const dataDir = await makeDir(), store = createSubscriptionStore(dataDir);
  const validAt = new Date(Date.now() - 60 * 60_000).toISOString();
  const deletedAt = new Date(Date.now() - 30 * 60_000).toISOString();
  await seedResets(dataDir, [validAt]);
  await store.write({ last_event_at: validAt, items: [{
    id: 'obsolete-landed-pending', openid: 'OBSOLETE', template_id: 'T', kind: 'landed',
    created_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), pending_event_at: deletedAt,
  }] });
  let sends = 0;
  const result = await notifyNewResets({
    dataDir, store, templateId: 'T', log: silence,
    client: { ...authClient, sendSubscribeMessage: async () => { sends++; } },
  });
  const remaining = (await store.read()).items[0];
  check('当前完成记录已删除时清除旧落地 pending 但保留授权',
    result.skipped === 'no-new-event' && sends === 0 && !remaining.pending_event_at && (await status(store, 'OBSOLETE')).active === true);
}
{
  const dataDir = await makeDir(), store = createSubscriptionStore(dataDir);
  const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const event = new Date(Date.now() - 60 * 60_000).toISOString();
  await seedResets(dataDir, [old, event]);
  await store.write({ last_event_at: event, items: [
    { id: 'landed-U', openid: 'U', template_id: 'T', kind: 'landed', created_at: old, pending_event_at: event },
    { id: 'landed-V', openid: 'V', template_id: 'T', kind: 'landed', created_at: old, pending_event_at: event },
  ] });
  let release, started;
  const waiting = new Promise((r) => { release = r; });
  const entered = new Promise((r) => { started = r; });
  const recipients = [];
  const options = {
    dataDir, store, templateId: 'T', log: silence,
    client: { ...authClient, sendSubscribeMessage: async (message) => {
      recipients.push(message.openid);
      if (message.openid === 'U') { started(); await waiting; }
    } },
  };
  const sending = notifyNewResets(options);
  await entered;
  await seedResets(dataDir, [old]);
  release();
  await sending;
  const v = (await store.read()).items.find((item) => item.openid === 'V');
  check('长批次中落地记录被删除后跳过下一位并保留其授权',
    recipients.join() === 'U' && v && !v.pending_event_at && (await status(store, 'V')).active === true);
}
{
  const dataDir = await makeDir(), store = createSubscriptionStore(dataDir);
  const old = '2026-09-01T00:00:00.000Z', event = '2026-09-20T00:00:00.000Z';
  await seedResets(dataDir, [old, event]);
  await store.write({ last_event_at: old, items: [{ openid: 'U', template_id: 'T' }] });
  let release, started;
  const waiting = new Promise((r) => { release = r; });
  const entered = new Promise((r) => { started = r; });
  let sends = 0;
  const options = { dataDir, store, templateId: 'T', log: silence, client: { ...authClient, sendSubscribeMessage: async () => { sends++; started(); await waiting; } } };
  const sending = notifyNewResets(options);
  await entered;
  await register(store, 'NEW');
  release();
  await sending;
  await notifyNewResets(options);
  check('发送期间新订阅不丢失，也不追发开启前的事件', sends === 1 && (await status(store, 'NEW')).active === true);
}
for (const kind of ['announcement', 'landed']) {
  const now = Date.now();
  const createdAt = new Date(now - 10 * 60_000).toISOString();
  const old = new Date(now - 2 * 60 * 60_000).toISOString();
  const eventAt = new Date(now - 60 * 60_000).toISOString();
  const dataDir = await makeDir(), store = createSubscriptionStore(dataDir);
  await seedResets(dataDir, [old, eventAt]);
  await store.write({ last_event_at: kind === 'landed' ? old : null, items: [{
    id: 'old-grant', openid: 'U', template_id: 'T', kind, grant_id: 'grant-old',
    created_at: kind === 'announcement' ? new Date(now - 11 * 60_000).toISOString() : old,
  }] });
  const forecastNow = Date.now();
  const forecasts = detectSignals([{
    id: `grant-${kind}-event`, account: 'thsottiaux', text: 'We will reset everyones usage limits',
    created_at: createdAt, foundVia: 'timeline-browser', author_verified: true,
  }], { now: forecastNow, account: 'thsottiaux' }).forecasts;
  let release, started;
  const waiting = new Promise((r) => { release = r; });
  const entered = new Promise((r) => { started = r; });
  let sends = 0;
  const client = { ...authClient, sendSubscribeMessage: async () => { sends++; started(); await waiting; } };
  const sending = kind === 'announcement'
    ? notifyNewAnnouncements({ store, client, templateId: 'T', forecasts, now: forecastNow, log: silence })
    : notifyNewResets({ dataDir, store, client, templateId: 'T', log: silence });
  await entered;
  const oldGrantStillActive = await status(store, 'U', kind);
  const newGrantNotRegistered = await status(store, 'U', kind, 'grant-new');
  const first = await register(store, 'U', 'T', kind, 'grant-new');
  const afterFirst = await store.read();
  const newId = afterFirst.items.find((item) => item.grant_id === 'grant-new')?.id;
  const repeated = await register(store, 'U', 'T', kind, 'grant-new');
  const afterRepeat = await store.read();
  const exactStatus = await status(store, 'U', kind, 'grant-new');
  const wrongStatus = await status(store, 'U', kind, 'not-registered');
  release();
  await sending;
  const finalState = await store.read();
  const newGrant = finalState.items.find((item) => item.grant_id === 'grant-new');
  check(`${kind} 发送中重新授权保留为独立授权，重试同 grantId 幂等`,
    first.statusCode === 200 && repeated.statusCode === 200 && afterFirst.items.length === 2 && afterRepeat.items.length === 2 &&
    newGrant?.id === newId && finalState.items.length === 1 && exactStatus.active && !wrongStatus.active &&
    oldGrantStillActive.active && !newGrantNotRegistered.active && (await status(store, 'U', kind)).active === true && sends === 1);
}
{
  const dataDir = await makeDir(), store = createSubscriptionStore(dataDir);
  await writeFile(store.path, 'broken json');
  let rejected = false;
  try { await register(store, 'U'); } catch { rejected = true; }
  check('损坏的名单不会被当成空名单覆盖', rejected && await readFile(store.path, 'utf8') === 'broken json');
}
{
  const client = createWeChatClient({ appId: 'a', appSecret: 'b', fetchImpl: makeFetch([
    ['/cgi-bin/token', wxOk({ access_token: 'TK', expires_in: 7200 })], [SEND, wxOk({})],
  ]) });
  let rejected = false;
  try { await client.sendSubscribeMessage({ openid: 'U', templateId: 'T', data: {} }); } catch { rejected = true; }
  check('微信未明确返回成功时不能消耗订阅', rejected);
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
