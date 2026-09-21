/**
 * 数据源通道探针 —— 诊断用，不改任何数据。
 *
 * 为什么需要它：采集主链路（x.com 未登录 HTML）在 GitHub Actions 上返回 403，
 * 而在本地是超时（境内 DNS 污染）。**两个环境都不可能靠另一方推断**，
 * 只能在 runner 里实测。用法：
 *
 *   node scripts/probe-sources.mjs            # 全员探一遍
 *   node scripts/probe-sources.mjs syndication # 只探名字含该关键字的通道
 *
 * 输出：每条通道的状态码 / 耗时 / 字节数 / 是否含推文正文 / 失败原因，
 * 末尾给一张「可用通道」汇总表。判定「含推文正文」是关键 ——
 * 200 不代表可用，很多端点会返回 200 但只是一个空壳页面。
 */

const UA_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** X web 客户端里硬编码的公开 bearer（非密钥，任何人可抓），用于 guest token 链路 */
const X_WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const ACCOUNT = process.env.SOURCE_ACCOUNT || 'thsottiaux';
const FILTER = process.argv[2] ?? '';

// 单条通道超时。本地自查语法时可调小（PROBE_TIMEOUT=2500），
// 因为境内对 twitter 系域名是超时而非快速失败，全量 20s 会把本地跑成十分钟。
const TIMEOUT = Number(process.env.PROBE_TIMEOUT ?? 20_000);

/**
 * 判定响应体里有没有真实推文内容。
 * 只看出现位置 —— 空壳页、错误页、challenge 页都不含这些标记。
 *
 * ⚠ 判定必须严：`api.fxtwitter.com/<account>` 返回的 profile JSON 里
 *   也含一个 "text"（那是**用户简介**，不是推文），早期版本把它判成
 *   「含推文正文」，会让探针给出虚假的好消息。所以 JSON 路径一律要求
 *   ≥2 条 text / 出现时间字段 —— 单条 text 是简介，列表才可能是时间线。
 */
function looksLikeTweets(body) {
  if (!body) return null;
  if (/full_text:"/.test(body)) return 'full_text(原生页面)';
  if (/created_at_ms:\d/.test(body)) return 'created_at_ms';
  if (/<item>[\s\S]*?<title>/.test(body)) return 'rss item';
  if (/"full_text"\s*:/.test(body)) return 'json full_text';
  const textCount = (body.match(/"text"\s*:/g) ?? []).length;
  const hasTime = /"created_at"\s*:|"createdAt"\s*:|"tweeted_at"\s*:/.test(body);
  if (textCount >= 2 && hasTime) return `json 时间线(${textCount} 条)`;
  if (textCount >= 1 && hasTime) return 'json 单条';
  return null;
}

function whyFailed(body) {
  if (!body) return '';
  if (/Just a moment|challenge-platform|cf-chl/i.test(body)) return 'Cloudflare 挑战';
  if (/<title>403|Forbidden/i.test(body)) return '403 页面';
  if (/rate limit|Rate limit/i.test(body)) return '限流';
  if (/login|Log in|Sign in/i.test(body) && body.length < 5000) return '要求登录';
  if (/suspended|not found/i.test(body)) return '账号不可见';
  return '';
}

async function hit(name, url, opts = {}) {
  const started = Date.now();
  const rec = { name, url, status: null, ms: 0, bytes: 0, has: null, why: '', note: '' };
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        'user-agent': opts.ua ?? UA_CHROME,
        accept: opts.accept ?? 'text/html,application/json,*/*',
        'accept-language': 'en-US,en;q=0.9',
        ...(opts.headers ?? {}),
      },
      body: opts.body,
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const body = await res.text();
    rec.status = res.status;
    rec.bytes = body.length;
    rec.ms = Date.now() - started;
    rec.has = looksLikeTweets(body);
    rec.why = res.ok ? '' : whyFailed(body) || `HTTP ${res.status}`;
    rec.note = `${(res.headers.get('content-type') ?? '').split(';')[0]}`;
    if (opts.capture) opts.capture(body, res);
  } catch (err) {
    rec.status = 'ERR';
    rec.ms = Date.now() - started;
    rec.why = err.message;
  }
  const tag = rec.has ? '✅' : rec.status === 200 ? '🟡' : '❌';
  console.log(
    `${tag} ${String(rec.status).padEnd(5)} ${String(rec.ms).padStart(6)}ms ${String(rec.bytes).padStart(7)}B  ${name}\n` +
      `      ${rec.url}\n` +
      `      ${rec.has ? `含推文正文：${rec.has}` : rec.why || '无推文正文'}` +
      (rec.note ? `  [${rec.note}]` : '')
  );
  return rec;
}

/* ------------------------------ 通道清单 ------------------------------ */

const results = [];

async function probe(name, url, opts) {
  if (FILTER && !name.toLowerCase().includes(FILTER.toLowerCase())) return null;
  const r = await hit(name, url, opts);
  results.push(r);
  return r;
}

console.log(`探针目标账号：${ACCOUNT}`);
console.log(`运行环境：${process.env.GITHUB_ACTIONS ? `GitHub Actions (${process.env.RUNNER_OS})` : '本地'}`);
console.log('='.repeat(78));

/* --- 1. 现状主链路 --- */
console.log('\n【1】现状主链路：x.com 未登录 HTML');
await probe('1a x.com 原生页面（现状）', `https://x.com/${ACCOUNT}`);
await probe('1b x.com 裸 UA（判断是否头相关）', `https://x.com/${ACCOUNT}`, { ua: 'curl/8.0' });
await probe('1c x.com ?f=live', `https://x.com/${ACCOUNT}?f=live`);
await probe('1d x.com 完整浏览器头', `https://x.com/${ACCOUNT}`, {
  headers: {
    'sec-ch-ua': '"Chromium";v="120", "Not(A:Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'upgrade-insecure-requests': '1',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  },
});

/* --- 2. X 官方免 key 嵌入通道 --- */
console.log('\n【2】X 官方嵌入通道（免 key、免登录，官网自己 embed 用的）');
await probe(
  '2a syndication timeline-profile',
  `https://syndication.twitter.com/srv/timeline-profile/screen-name/${ACCOUNT}`
);
await probe(
  '2b syndication timeline（无 /srv）',
  `https://syndication.twitter.com/timeline/profile?screen_name=${ACCOUNT}`
);
await probe(
  '2c syndication widget iframe',
  `https://platform.twitter.com/embed/Tweet.html?dnt=true&id=1`
);

/* --- 3. X API guest token 链路 --- */
console.log('\n【3】X API：公开 bearer + guest token（不依赖页面 HTML）');
let guestToken = null;
await probe('3a guest/activate', 'https://api.x.com/1.1/guest/activate.json', {
  method: 'POST',
  accept: 'application/json',
  headers: { authorization: `Bearer ${X_WEB_BEARER}`, 'content-type': 'application/json' },
  capture: (body) => {
    try {
      guestToken = JSON.parse(body)?.guest_token ?? null;
    } catch {
      /* 非 JSON 即失败 */
    }
  },
});
console.log(`      guest_token = ${guestToken ? guestToken.slice(0, 12) + '…' : '未取得'}`);

if (guestToken) {
  await probe('3b UserByScreenName', `https://api.x.com/graphql/32pL5BWe9WKeSK1MoPvFQQ/UserByScreenName?variables=%7B%22screen_name%22%3A%22${ACCOUNT}%22%7D`, {
    accept: 'application/json',
    headers: {
      authorization: `Bearer ${X_WEB_BEARER}`,
      'x-guest-token': guestToken,
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
    },
  });
}

/* --- 4. 第三方镜像 --- */
console.log('\n【4】第三方镜像 / 桥接');
await probe('4a rsshub.app', `https://rsshub.app/twitter/user/${ACCOUNT}`);
await probe('4b nitter.net RSS', `https://nitter.net/${ACCOUNT}/rss`);
await probe('4c fxtwitter profile', `https://api.fxtwitter.com/${ACCOUNT}`, { accept: 'application/json' });
await probe('4d vxtwitter', `https://api.vxtwitter.com/${ACCOUNT}`, { accept: 'application/json' });
await probe('4e twitterapi.io（无 key，仅看状态）', `https://api.twitterapi.io/twitter/user/last_tweets?userName=${ACCOUNT}`, {
  accept: 'application/json',
});

/* --- 5. 免费代理中转（借别人的出口 IP 拿 x.com） --- */
console.log('\n【5】免费代理中转：换一个出口 IP 去请求 x.com');
const XURL = encodeURIComponent(`https://x.com/${ACCOUNT}`);
await probe('5a allorigins', `https://api.allorigins.win/raw?url=${XURL}`);
await probe('5b codetabs', `https://api.codetabs.com/v1/proxy?quest=${XURL}`);
await probe('5c r.jina.ai', `https://r.jina.ai/https://x.com/${ACCOUNT}`);
await probe('5d corsproxy.io', `https://corsproxy.io/?url=${XURL}`);
await probe('5e thingproxy', `https://thingproxy.freeboard.io/fetch/https://x.com/${ACCOUNT}`);

/* --- 6. 现有的历史 API（对照组：确认出口网络本身没问题） --- */
console.log('\n【6】对照组：已知可用的端点');
await probe('6a codex-resets 历史 API', 'https://codex-resets.com/api/v1/resets?limit=3', {
  accept: 'application/json',
});
await probe('6b example.com', 'https://example.com');

/* ------------------------------- 汇总 ------------------------------- */
console.log('\n' + '='.repeat(78));
console.log('可用通道（含推文正文）');
console.log('='.repeat(78));
const usable = results.filter((r) => r.has);
if (!usable.length) {
  console.log('（无）—— 所有通道都没拿到推文正文');
} else {
  for (const r of usable) console.log(`  ✅ ${r.name}  [${r.has}]  ${r.url}`);
}

console.log('\n全部结果');
console.log('-'.repeat(78));
for (const r of results) {
  console.log(
    `${String(r.status).padEnd(5)} ${String(r.bytes).padStart(7)}B  ${r.has ? '有正文' : '无正文'}  ${r.name}` +
      (r.why ? `  ← ${r.why}` : '')
  );
}

// 失败原因分布，便于一眼看出是「全被 CF 拦」还是「DNS 不通」
console.log('\n失败原因分布');
const reasons = {};
for (const r of results) if (!r.has) reasons[r.why || '无正文'] = (reasons[r.why || '无正文'] ?? 0) + 1;
for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(2)} × ${k}`);
}
