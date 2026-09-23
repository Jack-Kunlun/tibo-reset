#!/usr/bin/env node
/**
 * Tibo Reset Observatory —— 后端服务
 *
 * 职责：
 *   1) （可选）定时采集 Tibo 的推文与额度事件 —— 境内部署时必须关闭，见下方「部署位置」
 *   2) 用风险模型算出「下一次重置还要等多久」以及各时间窗的概率
 *   3) 通过 HTTP API 把这些数据交付给页面 / 群机器人 / 任何调用方
 *   4) 直接对外提供**网页本体**：请求时用当前数据实时渲染（调 src/lib/page.mjs）
 *
 * 页面为什么在请求时渲染，而不是读构建产物：
 *   数据由本机采集后直接 POST 到 /api/ingest，一天里会变很多次。若页面是构建期快照，
 *   每次数据变化都要重新构建 + 重新部署才生效；而「拿数据渲染页面」这件事后端本来
 *   就会做 —— 它与构建共用 src/lib/page.mjs 同一套代码，不存在两份实现。
 *   实时渲染之后，数据一到、刷新即新，构建只负责 OG 分享图那类**图片**产物。
 *   dist/index.html 仍在，但降级为兜底：渲染出错时退回它，宁可数据旧也不白屏。
 *
 * 零依赖（只用 node:http），因为要跑在一台只做转发的境内小机器上 —— 装依赖本身就是风险。
 *
 * 部署位置（由 M2 技术选型确定）：
 *   本服务**部署在境内**，给小程序提供 HTTPS API —— 微信要求 request 合法域名必须已 ICP
 *   备案，而境外域名备不了案，这一条单独就决定了服务只能落在境内。
 *
 *   采集**不在这里跑**：本服务跑在云机房，出口属**机房 IP 段**，而 x.com 的 Cloudflare
 *   拦的正是机房 IP 段（实测同一时刻：runner 403 挑战页 / 住宅出口 200 完整页面）。
 *   采集由**本机（住宅出口）**的定时任务完成，采完**直接 POST 到 /api/ingest**
 *   （见 server/ingest.mjs），同时 push 上仓库留档；本服务只负责接收、落盘、预测、出页面。
 *
 *   ⚠ 因此境内部署时**必须**把 COLLECT_INTERVAL_MIN 设为 0（Dockerfile 里已是默认值）：
 *     在机房出口跑采集必被挑战，只会每 30 分钟产生一条无意义的错误记录，把真正的错误淹没。
 *
 * 环境变量：
 *   PORT                 监听端口，默认 8787
 *   DATA_DIR             数据目录，默认 <repo>/data
 *   SITE_URL             对外访问地址（如 https://reset.example.com），用于拼
 *                        og:url / og:image。不配则这两条 meta 不输出 ——
 *                        宁可少两条，也不给平台一个抓不到的地址（抓不到会展开成空白卡）
 *   COLLECT_INTERVAL_MIN 采集间隔（分钟）。**默认 0，即关闭** ——
 *                        本服务唯一合法的部署地是境内的云机房，而那里开着采集必被挑战
 *   ADMIN_TOKEN          若设置，则 POST /api/refresh 需要 Authorization: Bearer <token>
 *   INGEST_TOKEN         若设置，则 POST /api/ingest 需要 Authorization: Bearer <token>；
 *                        未设置时该入口直接返回 503 —— 这是唯一能从外部改写线上数据的入口，
 *                        宁可关掉也不能裸奔
 *   SOURCE_ACCOUNT       被观测的 X 账号，默认 thsottiaux
 *
 * F9 订阅消息（不配即整体关闭，订阅端点回 503）：
 *   WX_APPID             小程序 AppID
 *   WX_SECRET            小程序 AppSecret（**只放服务器 .env，绝不进 git**）
 *   WX_TEMPLATE_ID       订阅消息模板 ID
 *   WX_SUBSCRIBE_PAGE    点击通知跳转的小程序页面，默认 pages/index/index
 *   WX_TEMPLATE_DATA     可选。覆盖模板字段的 JSON，值里可用 {event}/{time}/{eta} 占位
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCollection } from '../src/lib/collect.mjs';
import { predictAll, DEFAULT_CONFIG } from '../src/lib/predict.mjs';
import { detectSignals, latestEventMs, USER_ZONE, SOURCE_ZONE } from '../src/lib/signals.mjs';
import { buildChartData } from '../src/lib/chart-data.js';
import { derive, logoDataUri, renderPage } from '../src/lib/page.mjs';
import { createStore } from './store.mjs';
import { createScheduler } from './scheduler.mjs';
import { handleIngest } from './ingest.mjs';
import {
  createSubscriptionStore,
  handleSubscribe,
  handleUnsubscribe,
  notifyNewResets,
} from './subscribe.mjs';
import { createWeChatClient } from './wechat.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? resolve(ROOT, 'data');
// 对外访问地址。只用于 OG meta 的绝对地址 —— 分享平台抓不到相对路径。
const SITE_URL = (process.env.SITE_URL ?? '').trim().replace(/\/+$/, '');
// 默认 0（关闭内置采集）。本服务唯一合法的部署地是境内的云机房，而那里开着采集
// 必被 Cloudflare 挑战（见文件头的「部署位置」）。默认值取 0 而不是 30，是为了让
// 「忘了关」这个错误不可能发生 —— 与 collect.yml 里「阈值必须由周期推导」同一个思路：
// 靠默认值与推导，不靠人的记性。
const INTERVAL_MIN = Number(process.env.COLLECT_INTERVAL_MIN ?? 0);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const INGEST_TOKEN = process.env.INGEST_TOKEN ?? '';
const SOURCE_ACCOUNT = process.env.SOURCE_ACCOUNT ?? 'thsottiaux';

const WX_APPID = process.env.WX_APPID ?? '';
const WX_SECRET = process.env.WX_SECRET ?? '';
const WX_TEMPLATE_ID = process.env.WX_TEMPLATE_ID ?? '';
const WX_SUBSCRIBE_PAGE = process.env.WX_SUBSCRIBE_PAGE ?? 'pages/index/index';

// 模板字段名要与微信后台一致。这里允许用环境变量整份覆盖，避免为了改字段名去动代码。
let WX_TEMPLATE_DATA = null;
if (process.env.WX_TEMPLATE_DATA) {
  try {
    WX_TEMPLATE_DATA = JSON.parse(process.env.WX_TEMPLATE_DATA);
  } catch {
    console.error('[subscribe] WX_TEMPLATE_DATA 不是合法 JSON，已忽略并退回默认字段');
  }
}

const store = createStore(DATA_DIR);
const subs = createSubscriptionStore(DATA_DIR);
const wechat = createWeChatClient({ appId: WX_APPID, appSecret: WX_SECRET });

/* ---------------------------- 预测结果缓存 ---------------------------- */
// predictAll 内含 walk-forward 回测与 bootstrap，单次约几十毫秒。
// 数据没变就没必要重算，因此按数据文件 mtime 做缓存。

let cache = { key: null, value: null };

async function getPrediction() {
  const { records } = await store.getResets();
  if (!records.length) return null;
  const key = `${await store.latestMtime()}|${DEFAULT_CONFIG.maxIntervals}|${DEFAULT_CONFIG.halfLifeDays}`;
  if (cache.key === key) return cache.value;
  const value = predictAll(records);
  cache = { key, value };
  return value;
}

/* ---------------------------- 信号与图表缓存 ---------------------------- */

// 信号识别依赖 tweets.json，图表依赖 resets.json。两者独立缓存，
// 因为采集失败时通常只有其中一个文件被更新。

let sigCache = { key: null, value: null };

async function getSignals() {
  const [file, resets] = await Promise.all([store.getTweets(), store.getResets()]);
  const tweets = file.tweets ?? [];
  const lastResetAt = latestEventMs(resets.records ?? []);
  // 缓存 key 里这两项都是**必需**的，少一个这次修复就等于没做：
  //   · lastResetAt —— 预告兑现的那一刻要立刻失效（本次修复的核心场景）；
  //   · hourBucket —— 「窗口已经过去」是**时间驱动**的判据，没有数据变化也必须能失效。
  //     按小时重算足够：窗口边界精确到分钟的场景一年也遇不上几次，
  //     而 signals 只是对几十条推文做正则，重算的开销可忽略。
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  const key = `${file.updated_at ?? ''}|${tweets.length}|${lastResetAt}|${hourBucket}|${SOURCE_ACCOUNT}|${SOURCE_ZONE}|${USER_ZONE}`;
  if (sigCache.key === key) return sigCache.value;
  const value = detectSignals(tweets, { account: SOURCE_ACCOUNT, lastResetAt });
  sigCache = { key, value };
  return value;
}

async function getChart() {
  // buildChartData 以传入时刻为基准算 sinceDays / pct，本身只有几十条记录的
  // 线性扫描，开销远小于 JSON 序列化 —— 所以不缓存，每次按当前时刻重算。
  // 缓存它会让页面上的「已过 N 天」停在服务启动那一刻。
  const { records } = await store.getResets();
  if (!records.length) return null;
  return buildChartData(records, Date.now());
}

/* ------------------------------- 静态资源 ------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = resolve(ROOT, 'dist', normalize(rel));
  // 防目录穿越
  if (!target.startsWith(resolve(ROOT, 'dist'))) return send(res, 403, { error: 'forbidden' });
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'public, max-age=300',
    });
    res.end(body);
  } catch {
    send(res, 404, {
      error: 'not found',
      hint: '静态资源不存在。图标与 OG 图由 `npm run build` 生成到 dist/',
    });
  }
}

/* ---------------------------- 网页实时渲染 ---------------------------- */

// 页面的两个来源，优先前者：
//   1. 实时渲染（正常路径）—— 用当前 data/ 现渲染。数据一到、刷新即新，
//      不需要重新构建、不需要重启容器
//   2. dist/index.html（兜底）—— 渲染出错时退回构建期产物，宁可数据旧也不白屏
//
// 模板与品牌标随镜像发布、运行期不变，读一次缓存住；数据会随 /api/ingest 变化，
// 每次重新读（store 层按 mtime 缓存，未变时几乎零成本）。

let pageAssets = null;

async function loadPageAssets() {
  if (!pageAssets) {
    pageAssets = {
      template: await readFile(resolve(ROOT, 'src/index.html'), 'utf8'),
      logoUri: await logoDataUri(),
    };
  }
  return pageAssets;
}

// OG meta 里的绝对地址。OG 图是**构建期**产物（图片，接口改不了它），
// 所以启动后解析一次即可 —— 缺文件就整体不输出，避免给平台一个抓不到的地址。
let ogMetaResolved = false;
let ogMeta = null;

async function getOgMeta() {
  if (ogMetaResolved) return ogMeta;
  ogMetaResolved = true;
  if (!SITE_URL) return (ogMeta = null);
  try {
    const info = await stat(resolve(ROOT, 'dist/og-image.png'));
    ogMeta = info.isFile()
      ? { pageUrl: SITE_URL, imageUrl: `${SITE_URL}/og-image.png` }
      : null;
  } catch {
    ogMeta = null;
  }
  return ogMeta;
}

async function renderIndexHtml() {
  const [resets, tweets, statsFile, assets, og] = await Promise.all([
    store.getResets(),
    store.getTweets(),
    store.getStats(),
    loadPageAssets(),
    getOgMeta(),
  ]);
  const derived = derive({
    resets,
    tweets,
    statsFile,
    now: Date.now(),
    account: SOURCE_ACCOUNT,
  });
  return renderPage({
    template: assets.template,
    ...derived,
    og,
    // 「采集异常」与「数据未更新」两条提示都在页面里（渲染层保证两者互斥），
    // 所以这三个字段必须给对 —— lastLiveAt 只能是 tweets.json 的 updated_at，
    // 它才代表「数据多新」（stats.generated_at 采集失败时照样推进）。
    collect: {
      errors: statsFile.errors ?? [],
      attemptedAt: statsFile.generated_at ?? null,
      lastLiveAt: tweets.updated_at ?? null,
    },
    logoUri: assets.logoUri,
  });
}

async function serveIndex(res) {
  try {
    const html = await renderIndexHtml();
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      // 绝不能被缓存住：页面内容跟着数据变，缓存住就等于把「数据一到即新」
      // 这件事原样还回去了 —— 读者会拿到一份旧快照，还以为是最新的。
      'cache-control': 'no-cache',
    });
    res.end(html);
  } catch (err) {
    console.error(`[page] 实时渲染失败，退回构建期产物（dist/index.html）：${err.message}`);
    return serveStatic(res, '/index.html');
  }
}

/* -------------------------------- 响应工具 -------------------------------- */

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

const withCors = (res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization,content-type');
};

/* -------------------------------- 调度器 -------------------------------- */

const collectIntervalMs = INTERVAL_MIN > 0 ? INTERVAL_MIN * 60_000 : 0;
const scheduler = createScheduler({
  intervalMs: collectIntervalMs || 60_000,
  run: () => runCollection({ dataDir: DATA_DIR, account: SOURCE_ACCOUNT }),
  onError: (err) => console.error('[collect] 失败：', err.message),
});

/* --------------------------------- 路由 --------------------------------- */

const ROUTES = {
  '/api/health': async () => ({
    status: 'ok',
    uptimeSec: Math.round(process.uptime()),
    dataDir: DATA_DIR,
    account: SOURCE_ACCOUNT,
    collectIntervalMin: INTERVAL_MIN,
    scheduler: scheduler.state,
  }),

  '/api/state': async (url) => {
    const [statsFile, tweetsFile, prediction, signals, chart] = await Promise.all([
      store.getStats(),
      store.getTweets(),
      getPrediction(),
      getSignals(),
      getChart(),
    ]);
    const limit = Number(url.searchParams.get('tweets') ?? 12);
    return {
      generatedAt: new Date().toISOString(),
      dataUpdatedAt: statsFile.generated_at,
      chart,
      prediction,
      signals,
      stats: statsFile.stats,
      collectErrors: statsFile.errors ?? [],
      tweets: tweetsFile.tweets.slice(0, limit),
      research: {
        // 把「模型有多可信」和预测一起交付，避免调用方只拿到一个裸概率
        method: '分段常数风险模型 + 样本外平移校准',
        config: DEFAULT_CONFIG,
        notes: [
          '所有概率均为条件概率：条件于「距上次重置已过 N 天」。',
          '校准量与覆盖率由 walk-forward 回测实时算出，会随数据变化。',
          'Brier skill 接近 0 表示模型对「某天内是否发生」几乎没有区分力，',
          '模型的价值在于给出时间量级与范围，而不是判断某一天会不会发生。',
        ],
      },
    };
  },

  '/api/signals': async (url) => {
    const signals = await getSignals();
    const limit = Number(url.searchParams.get('limit') ?? 5);
    return {
      ...signals,
      signals: signals.signals.slice(0, limit),
      hints: signals.hints.slice(0, limit),
      rejected: signals.rejected.slice(0, limit),
    };
  },

  '/api/chart': async () => {
    const chart = await getChart();
    if (!chart) return { error: 'no data' };
    return chart;
  },

  '/api/prediction': async () => {
    const prediction = await getPrediction();
    if (!prediction) return { error: 'no data' };
    return prediction;
  },

  '/api/history': async (url) => {
    const { records } = await store.getResets();
    const limit = Number(url.searchParams.get('limit') ?? 0);
    const list = [...records].sort((a, b) => new Date(b.announced_at) - new Date(a.announced_at));
    return { total: list.length, records: limit > 0 ? list.slice(0, limit) : list };
  },

  '/api/tweets': async (url) => {
    const file = await store.getTweets();
    const limit = Number(url.searchParams.get('limit') ?? 20);
    return {
      updatedAt: file.updated_at ?? null,
      total: file.tweets.length,
      tweets: file.tweets.slice(0, limit),
    };
  },

  '/api/backtest': async (url) => {
    const { records } = await store.getResets();
    if (!records.length) return { error: 'no data' };
    const horizon = Number(url.searchParams.get('horizon') ?? 7);
    const { backtest, coverageBacktest } = await import('../src/lib/predict.mjs');
    // 必须与 /api/prediction 使用同一套参数，否则两个接口会给出互相打架的数字
    const bt = backtest(records, { ...DEFAULT_CONFIG, horizon });
    const cv = coverageBacktest(records, DEFAULT_CONFIG);
    return {
      horizon,
      config: DEFAULT_CONFIG,
      brier: { model: bt.brier, baseline: bt.brierBaseline, skill: bt.skill, n: bt.n },
      calibration: cv.conditional,
      calibrationUnconditional: cv.unconditional,
      note: 'calibration 中的 empirical 应接近 nominal；偏离说明模型区间偏窄或偏宽。',
    };
  },

  '/api/stats': async () => (await store.getStats()).stats,
};

async function handleApi(req, res, url) {
  withCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === '/api/refresh') {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    if (ADMIN_TOKEN) {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${ADMIN_TOKEN}`) return send(res, 401, { error: 'unauthorized' });
    }
    try {
      const result = await runCollection({ dataDir: DATA_DIR, account: SOURCE_ACCOUNT });
      return send(res, result.ok ? 200 : 502, result);
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  }

  // 接收本机采集任务推来的产物。放在这里而不是 ROUTES 表里，
  // 因为它要读请求体（ROUTES 的处理器只吃 url）。
  if (url.pathname === '/api/ingest') {
    return handleIngest(req, res, {
      dataDir: DATA_DIR,
      token: INGEST_TOKEN,
      send,
      // F9：确认收到**新的重置事件**才推送。不在「预测可能重置」时推 —— 那是误报。
      onAccepted: () =>
        notifyNewResets({
          dataDir: DATA_DIR,
          store: subs,
          client: wechat,
          templateId: WX_TEMPLATE_ID,
          page: WX_SUBSCRIBE_PAGE,
          templateSpec: WX_TEMPLATE_DATA,
        }).then((r) => {
          if (r.skipped) console.log(`[subscribe] 未推送：${r.skipped}`);
          else console.log(`[subscribe] 推送完成：${JSON.stringify(r)}`);
        }),
    });
  }

  // F9 订阅。这两个也读请求体，同样放在 ROUTES 之外。
  if (url.pathname === '/api/subscribe') {
    return handleSubscribe(req, res, {
      store: subs,
      client: wechat,
      templateId: WX_TEMPLATE_ID,
      send,
    });
  }
  if (url.pathname === '/api/unsubscribe') {
    return handleUnsubscribe(req, res, { store: subs, client: wechat, send });
  }

  const handler = ROUTES[url.pathname];
  if (!handler) {
    return send(res, 404, {
      error: 'unknown endpoint',
      endpoints: [
        ...Object.keys(ROUTES),
        '/api/refresh (POST)',
        '/api/ingest (POST)',
        '/api/subscribe (POST)',
        '/api/unsubscribe (POST)',
      ],
    });
  }

  try {
    return send(res, 200, await handler(url));
  } catch (err) {
    console.error(`[api] ${url.pathname} 失败：`, err);
    return send(res, 500, { error: err.message });
  }
}

/* -------------------------------- 服务启动 -------------------------------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  // 首屏走实时渲染（两个来源的取舍见 serveIndex 上方注释）；
  // 图标、OG 图、以及渲染失败时的兜底产物仍从 dist/ 出。
  if (url.pathname === '/' || url.pathname === '/index.html') return serveIndex(res);
  return serveStatic(res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`▸ Tibo Reset Observatory 后端已启动`);
  console.log(`  监听      http://127.0.0.1:${PORT}`);
  console.log(`  数据目录  ${DATA_DIR}`);
  console.log(`  观测账号  x.com/${SOURCE_ACCOUNT}`);
  console.log(`  页面      请求时实时渲染 · 渲染失败退回 dist/index.html`);
  console.log(`  对外地址  ${SITE_URL || '未设置（不影响页面本身，只少 og:url / og:image）'}`);
  console.log(
    `  采集间隔  ${INTERVAL_MIN > 0 ? INTERVAL_MIN + ' 分钟' : '已关闭（仅手动触发）'}`
  );
  console.log(
    `  鉴权      /api/refresh ${ADMIN_TOKEN ? '需 Bearer token' : '未启用'}` +
      ` · /api/ingest ${INGEST_TOKEN ? '需 Bearer token' : '已关闭（未配 INGEST_TOKEN）'}`
  );
  console.log(
    `  F9 订阅    ${
      !wechat.configured
        ? '已关闭（未配 WX_APPID / WX_SECRET）'
        : WX_TEMPLATE_ID
          ? `已启用 · 模板 ${WX_TEMPLATE_ID.slice(0, 12)}…`
          : '已关闭（缺 WX_TEMPLATE_ID）'
    }`
  );
  if (INTERVAL_MIN > 0) {
    scheduler.start();
    console.log('  ⚠ 内置采集调度已开启 —— 本服务将自行抓取 x.com。');
    console.log('     若本服务跑在云机房（云服务器 / 容器平台），出口属机房 IP 段，');
    console.log('     而 x.com 的 Cloudflare 拦的正是机房 IP 段，采集必被挑战。');
    console.log('     请设 COLLECT_INTERVAL_MIN=0 关掉它，采集交给本机（住宅出口）。');
  } else {
    console.log('  采集      已关闭（数据由本机采集后直接 POST /api/ingest 推送）');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n▸ 收到 ${sig}，正在关闭…`);
    scheduler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
