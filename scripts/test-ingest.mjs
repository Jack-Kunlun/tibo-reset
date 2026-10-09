#!/usr/bin/env node
/**
 * 入站写入端点（POST /api/ingest）的回归测试。
 *
 * 为什么单独测它：这是全项目**唯一一个能从外部改写线上数据**的入口。
 * 它一旦写坏，页面会在两次采集之间一直是坏的，而采集侧一切正常、毫无察觉。
 * 所以这里既不追求覆盖率，也不测别的模块 —— 只把这道门的每一条路径钉死：
 * 鉴权、形状校验、幂等、以及「坏数据绝不能落盘」。
 *
 * 用 mock 的 req/res 直接调处理器，不起网络：跑得快，且不占端口。
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleIngest } from '../server/ingest.mjs';
import { ogPaths, readOgMeta } from '../server/og.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

function makeReq(method, body, headers = {}) {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined && body !== null) yield Buffer.from(body);
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
    /** 解析出来的响应体 */
    json() {
      try {
        return JSON.parse(this.body);
      } catch {
        return null;
      }
    },
  };
}

/** 与 server/index.mjs 里的 send 行为一致（状态码 + JSON 体） */
const send = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const AUTH = { authorization: 'Bearer test-token' };
const TOKEN = 'test-token';

const dataDir = await mkdtemp(join(tmpdir(), 'tibo-ingest-'));

/** 构造一份形状合法的载荷 */
function payload(generatedAt, records = 3) {
  const base = Date.parse('2026-09-01T00:00:00Z');
  return {
    generatedAt,
    resets: {
      records: Array.from({ length: records }, (_, i) => ({
        id: `r${i}`,
        announced_at: new Date(base + i * 86_400_000).toISOString(),
        type: 'reset',
        text: `tweet ${i}`,
      })),
    },
    tweets: { tweets: [{ id: 'tw1', text: 'hello' }], updated_at: generatedAt },
    stats: { stats: { count: records }, errors: [] },
  };
}

const post = async (body, headers = AUTH, ctx = { dataDir, token: TOKEN, send }) => {
  const res = makeRes();
  await handleIngest(makeReq('POST', body, headers), res, ctx);
  return res;
};

/* ---------------------------- 用例 ---------------------------- */

section('1. 鉴权');

{
  const res = await post(JSON.stringify(payload('2026-09-10T00:00:00Z')), {});
  check('缺 Authorization → 401', res.statusCode === 401, `实际 ${res.statusCode}`);
}
{
  const res = await post(JSON.stringify(payload('2026-09-10T00:00:00Z')), {
    authorization: 'Bearer wrong-token',
  });
  check('token 不对 → 401', res.statusCode === 401, `实际 ${res.statusCode}`);
}
{
  // 没配 token 时绝不放行 —— 否则等于把这台机器开放成公开写入点
  const res = await post(JSON.stringify(payload('2026-09-10T00:00:00Z')), AUTH, {
    dataDir,
    token: '',
    send,
  });
  check('服务端未配 token → 503（不是放行）', res.statusCode === 503, `实际 ${res.statusCode}`);
}
{
  const res = makeRes();
  await handleIngest(makeReq('GET', null, AUTH), res, { dataDir, token: TOKEN, send });
  check('GET → 405', res.statusCode === 405, `实际 ${res.statusCode}`);
}

section('2. 形状校验（坏数据绝不能落盘）');

const badCases = [
  ['未解析的 JSON', 'not json at all'],
  ['载荷不是对象', '"just a string"'],
  ['generatedAt 非法', JSON.stringify({ ...payload('2026-09-10T00:00:00Z'), generatedAt: '昨天' })],
  ['resets.records 不是数组', JSON.stringify({ ...payload('2026-09-10T00:00:00Z'), resets: { records: {} } })],
  ['记录数 < 2', JSON.stringify(payload('2026-09-10T00:00:00Z', 1))],
  [
    '记录缺 announced_at',
    JSON.stringify({
      ...payload('2026-09-10T00:00:00Z'),
      resets: { records: [{ id: 'a' }, { id: 'b', announced_at: '2026-09-01T00:00:00Z' }] },
    }),
  ],
  [
    'announced_at 非法',
    JSON.stringify({
      ...payload('2026-09-10T00:00:00Z'),
      resets: {
        records: [
          { id: 'a', announced_at: 'not-a-date' },
          { id: 'b', announced_at: '2026-09-01T00:00:00Z' },
        ],
      },
    }),
  ],
  ['tweets.tweets 不是数组', JSON.stringify({ ...payload('2026-09-10T00:00:00Z'), tweets: { tweets: 3 } })],
  ['stats 缺失', JSON.stringify({ ...payload('2026-09-10T00:00:00Z'), stats: undefined })],
];

for (const [name, body] of badCases) {
  const res = await post(body);
  check(`${name} → 拒绝`, res.statusCode >= 400, `实际 ${res.statusCode}`);
}

// 关键：被拒之后数据目录必须是空的 —— 「校验通过才落盘」不能只是纸面约定
{
  const files = await readdir(dataDir);
  check('坏数据一轮下来没有产生任何文件', files.length === 0, `实际 ${files.join(', ')}`);
}

section('3. 幂等');

const T1 = '2026-09-10T00:00:00Z';
const T2 = '2026-09-10T01:00:00Z';
const T3 = '2026-09-10T02:00:00Z';

{
  const res = await post(JSON.stringify(payload(T2)));
  const b = res.json();
  check('首个载荷 → accepted', res.statusCode === 200 && b?.status === 'accepted', JSON.stringify(b));
}
{
  const res = await post(JSON.stringify(payload(T2)));
  const b = res.json();
  check('同一载荷重复推 → stale（CI 重跑属正常，不能报错）', b?.status === 'stale', JSON.stringify(b));
  check('stale 也返回 200（不让工作流变红）', res.statusCode === 200, `实际 ${res.statusCode}`);
}
{
  const res = await post(JSON.stringify(payload(T1)));
  const b = res.json();
  check('更旧的载荷 → stale（不能把新数据覆盖回旧的）', b?.status === 'stale', JSON.stringify(b));
}
{
  const res = await post(JSON.stringify(payload(T3)));
  const b = res.json();
  check('更新的载荷 → accepted', b?.status === 'accepted', JSON.stringify(b));
  check('响应带回记录数', b?.records === 3, JSON.stringify(b));
}

section('4. 落盘结果');

{
  const stats = JSON.parse(await readFile(resolve(dataDir, 'stats.json'), 'utf8'));
  check('stats.json 已写入', !!stats);
  check('generated_at 以顶层 generatedAt 为准', stats.generated_at === T3, `实际 ${stats.generated_at}`);
  check('stats 内容被保留', stats.stats?.count === 3, JSON.stringify(stats.stats));
}

{
  const resets = JSON.parse(await readFile(resolve(dataDir, 'resets.json'), 'utf8'));
  check('resets.json 已写入且条数正确', resets.records?.length === 3, JSON.stringify(resets.records?.length));
}

{
  const tweets = JSON.parse(await readFile(resolve(dataDir, 'tweets.json'), 'utf8'));
  check('tweets.json 已写入', tweets.tweets?.length === 1);
}

{
  const files = await readdir(dataDir);
  check('没有残留临时文件', !files.some((f) => f.includes('.tmp-')), files.join(', '));
}

section('5. F8 分享卡片随载荷送达');

/**
 * 造一张**形状合法**的 PNG：8 字节签名 + IHDR 声明的宽高。
 * 服务端只做形状校验（不完整解码 —— 详见 server/og.mjs），所以这里不需要真实像素。
 * 真图那条链路由 test-og.mjs 覆盖。
 */
function fakeOgPng(width = 1200, height = 630) {
  const buf = Buffer.alloc(24);
  buf.write('\x89PNG\r\n\x1a\n', 0, 'latin1');
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

const T4 = '2026-09-10T03:00:00Z';
const T5 = '2026-09-10T04:00:00Z';
const DESC = '距上次重置 1 天 2 小时，中位剩余等待 1 天 19 小时（80% 区间 20 小时–6 天 19 小时）。';
const ogPath = ogPaths(dataDir);
/** 带 og 的载荷。og 传 undefined 表示「这一份不带卡片」 */
const postWithOg = (t, og) => post(JSON.stringify({ ...payload(t), og }));

{
  // 不带 og 必须照样通 —— 老版本推送脚本、或本机还没构建过时走的就是这条路
  const res = await postWithOg(T4, undefined);
  const b = res.json();
  check(
    '不带 og 的载荷照常 accepted（og 是可选字段）',
    res.statusCode === 200 && b?.status === 'accepted' && b?.og === 'absent',
    JSON.stringify(b)
  );
  check('没带 og 时不产生卡片目录', !existsSync(ogPath.dir), 'og 目录被凭空建了出来');
}

const cardPng = fakeOgPng();
{
  const res = await postWithOg(T5, {
    png: cardPng.toString('base64'),
    description: DESC,
    builtAt: T5,
  });
  const b = res.json();
  check('带合法 og → accepted，且响应说明卡片已写', b?.status === 'accepted' && b?.og === 'written', JSON.stringify(b));

  const written = await readFile(ogPath.png);
  check('PNG 逐字节落盘', Buffer.compare(written, cardPng) === 0, `${written.length} / ${cardPng.length}`);
  const meta = await readOgMeta(dataDir);
  check('描述可被运行期读回', meta?.description === DESC, JSON.stringify(meta));
  check('builtAt 一并留下（/api/health 用它报新鲜度）', meta?.builtAt === T5, String(meta?.builtAt));
}

// 坏卡片必须整份拒收，且**不能破坏已有的那张**：卡片是页面上唯一对外可见的东西，
// 「数据更新了、卡片停在旧图」正是这次要根治的静默不一致。
const badOgCases = [
  ['png 不是 PNG', { png: Buffer.from('hello').toString('base64'), description: DESC, builtAt: T5 }],
  ['png 尺寸不是 1200×630', { png: fakeOgPng(800, 600).toString('base64'), description: DESC, builtAt: T5 }],
  ['png 过小（截断的 base64）', { png: cardPng.subarray(0, 8).toString('base64'), description: DESC, builtAt: T5 }],
  ['description 缺失', { png: cardPng.toString('base64'), builtAt: T5 }],
  ['description 全空白', { png: cardPng.toString('base64'), description: '   ', builtAt: T5 }],
  ['description 超长', { png: cardPng.toString('base64'), description: 'x'.repeat(301), builtAt: T5 }],
  ['builtAt 非法', { png: cardPng.toString('base64'), description: DESC, builtAt: '昨天' }],
  ['本身不是对象', 'just a string'],
  ['png 体积超上限', { png: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64'), description: DESC, builtAt: T5 }],
];

let badIdx = 0;
for (const [name, og] of badOgCases) {
  // 每条都用一个**更新的**时刻，否则会被幂等判定拦成 stale，测的就不是形状校验了
  badIdx++;
  const t = `2026-09-10T1${badIdx}:00:00Z`;
  const res = await postWithOg(t, og);
  check(`og ${name} → 拒绝`, res.statusCode >= 400, `实际 ${res.statusCode}`);
}

{
  const still = await readFile(ogPath.png);
  const meta = await readOgMeta(dataDir);
  check(
    '坏了 9 次之后，原先那张卡一字未动',
    Buffer.compare(still, cardPng) === 0 && meta?.description === DESC,
    `png ${still.length}B / 描述 ${meta?.description?.slice(0, 12)}`
  );
}

{
  // 更旧的载荷带着**另一句**描述推过来 —— 必须整份判 stale，卡片不能被改写
  const res = await postWithOg('2026-09-10T00:00:00Z', {
    png: cardPng.toString('base64'),
    description: '这句不该出现在线上',
    builtAt: '2026-09-10T00:00:00Z',
  });
  const b = res.json();
  const meta = await readOgMeta(dataDir);
  check('更旧的载荷 → stale', b?.status === 'stale', JSON.stringify(b));
  check('stale 载荷的卡片不被改写', meta?.description === DESC, String(meta?.description));
}

{
  const files = await readdir(ogPath.dir);
  check('卡片目录没有残留临时文件', !files.some((f) => f.includes('.tmp-')), files.join(', '));
}

/* ---------------------------- 清理 ---------------------------- */

await rm(dataDir, { recursive: true, force: true });

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
