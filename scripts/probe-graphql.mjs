/**
 * 阶段二探针：验证「guest token + GraphQL」这条链路能不能端到端拿到推文列表。
 *
 * 背景（来自阶段一探针在 runner 上的实测）：
 *   - x.com 网页端         → 403 Cloudflare 挑战（四个头部变体全挂）
 *   - api.x.com guest/activate → 200，拿到 guest_token
 *   - api.x.com GraphQL    → 200，有数据
 *   结论：403 不是「X 封了整个机房」，而是**专挡网页端**。API 域名是另一套策略。
 *
 * 本脚本要回答三件事：
 *   A. UserTweets 的 queryId 能不能**动态取到**（而非写死一个会过期的值）
 *   B. 用 guest token 打 UserTweets，能不能真的拿到推文正文列表
 *   C. 备选通道（syndication 退避重试 / Nitter 实例）有没有活着的
 *
 * 只读、无副作用。
 */

const UA_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** X web 客户端里硬编码的公开 bearer（非密钥，任何人可从 JS 里抓到） */
const X_WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const ACCOUNT = process.env.SOURCE_ACCOUNT || 'thsottiaux';
const TIMEOUT = Number(process.env.PROBE_TIMEOUT ?? 25_000);

async function req(url, opts = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        'user-agent': UA_CHROME,
        accept: 'application/json,text/html,*/*',
        'accept-language': 'en-US,en;q=0.9',
        ...(opts.headers ?? {}),
      },
      body: opts.body,
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, status: 'ERR', body: '', ms: Date.now() - started, err: err.message };
  }
}

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${'='.repeat(76)}\n${t}\n${'='.repeat(76)}`);

/**
 * 递归收集 JSON 中所有「像推文」的对象。
 *
 * 为什么不按固定路径取（data.user.result.timeline_v2...）：
 * X 的响应结构每隔几个月就会调整一次，写死路径等于写死一个过期时间。
 * 这里只认「有 full_text 或 tweet_results 的对象」，结构怎么变都能捞出来。
 */
function collectTweets(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (seen.has(node)) return out;
  seen.add(node);

  if (typeof node.full_text === 'string') {
    out.push({
      text: node.full_text,
      id: node.id_str ?? node.rest_id ?? null,
      created_at: node.created_at ?? null,
    });
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') collectTweets(v, out, seen);
  }
  return out;
}

/** 从任意 JSON 里找出 screen_name 对应的 rest_id（用户数字 ID） */
function findUserId(node, seen = new Set()) {
  if (!node || typeof node !== 'object') return null;
  if (seen.has(node)) return null;
  seen.add(node);
  if (typeof node.rest_id === 'string' && /^\d+$/.test(node.rest_id)) return node.rest_id;
  if (node.result && typeof node.result === 'object') {
    const r = findUserId(node.result, seen);
    if (r) return r;
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') {
      const r = findUserId(v, seen);
      if (r) return r;
    }
  }
  return null;
}

/* ---------------------- A. 动态获取 GraphQL queryId ---------------------- */

hr('A. queryId 探测：能否从 X 的公开静态资源里动态取到 UserTweets 的 queryId');

const QUERYID_SOURCES = [
  'https://abs.twimg.com/responsive-web/client-web-api.json',
  'https://abs.twimg.com/responsive-web/client-web/bundle-api.json',
  'https://abs.twimg.com/responsive-web/client-web/api.json',
  'https://abs.twimg.com/responsive-web/client-web-manifest.json',
  'https://abs.twimg.com/responsive-web/client-web/manifest.json',
];

let queryIdMap = {};
let queryIdSource = null;

for (const url of QUERYID_SOURCES) {
  const r = await req(url);
  const flag = r.ok ? '✅' : '❌';
  log(`${flag} ${String(r.status).padEnd(5)} ${String(r.body.length).padStart(7)}B  ${url}`);
  if (!r.ok || !r.body) continue;

  // 从文本里扫「operationName 附近出现 22 位 base64url」的形态。
  // 不假设 JSON 结构 —— 该文件的键名在不同版本里改过。
  const found = {};
  for (const m of r.body.matchAll(/"([A-Za-z]+)"\s*:\s*\{[^{}]*"queryId"\s*:\s*"([\w-]{20,24})"/g)) {
    found[m[1]] = m[2];
  }
  // 另一种形态：{ "queryId": "...", "operationName": "UserTweets" }
  for (const m of r.body.matchAll(/"queryId"\s*:\s*"([\w-]{20,24})"[^{}]*?"operationName"\s*:\s*"([A-Za-z]+)"/g)) {
    found[m[2]] = m[1];
  }
  const names = Object.keys(found);
  log(`      解析出 ${names.length} 个 operation → queryId`);
  if (names.length) {
    queryIdMap = found;
    queryIdSource = url;
    log(`      样例：${names.slice(0, 6).map((n) => `${n}=${found[n]}`).join(', ')}`);
    break;
  }
}

const knownUserTweets = queryIdMap.UserTweets ?? null;
log(`\nUserTweets queryId = ${knownUserTweets ?? '未取到'}` + (queryIdSource ? `  （来源 ${queryIdSource}）` : ''));
const knownUserByScreenName = queryIdMap.UserByScreenName ?? '32pL5BWe9WKeSK1MoPvFQQ';
log(`UserByScreenName queryId = ${knownUserByScreenName}`);

/* ------------------ B. guest token + GraphQL 端到端取时间线 ------------------ */

hr('B. 端到端：guest token → user_id → UserTweets → 推文正文');

const g = await req('https://api.x.com/1.1/guest/activate.json', {
  method: 'POST',
  headers: { authorization: `Bearer ${X_WEB_BEARER}`, 'content-type': 'application/json' },
});
let guestToken = null;
try {
  guestToken = JSON.parse(g.body)?.guest_token ?? null;
} catch {
  /* 非 JSON */
}
log(`guest/activate → ${g.status}  token=${guestToken ? guestToken.slice(0, 10) + '…' : '未取得'}`);

const apiHeaders = {
  authorization: `Bearer ${X_WEB_BEARER}`,
  'x-guest-token': guestToken ?? '',
  'x-twitter-active-user': 'yes',
  'x-twitter-client-language': 'en',
  'content-type': 'application/json',
};

let userId = null;
if (guestToken) {
  const vars = encodeURIComponent(JSON.stringify({ screen_name: ACCOUNT }));
  const u = await req(
    `https://api.x.com/graphql/${knownUserByScreenName}/UserByScreenName?variables=${vars}`,
    { headers: apiHeaders }
  );
  log(`UserByScreenName → ${u.status}  ${u.body.length}B`);
  try {
    const j = JSON.parse(u.body);
    userId = j?.data?.user?.result?.rest_id ?? findUserId(j);
    log(`      解析出 userId = ${userId ?? '未取到'}`);
    if (!userId) log(`      响应片段：${u.body.slice(0, 400)}`);
  } catch {
    log(`      非 JSON：${u.body.slice(0, 200)}`);
  }
}

if (guestToken && userId) {
  // features 参数：新版 GraphQL 需要它，缺了会报 400/错误。
  // 这里用的是社区维护的通用全集；X 增删字段只影响返回的字段丰富度，不影响能否取到。
  const features = encodeURIComponent(
    JSON.stringify({
      rweb_video_screen_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      tweetypie_unmention_optimization_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      tweet_awards_web_tipping_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      responsive_web_enhance_cards_enabled: false,
    })
  );
  const variables = encodeURIComponent(
    JSON.stringify({
      userId,
      count: 20,
      includePromotedContent: false,
      withQuickPromoteEligibilityTweetFields: false,
      withVoice: false,
      withV2Timeline: true,
    })
  );

  if (!knownUserTweets) {
    log('\n⚠ 没有可用的 UserTweets queryId，跳过该步（需要 A 步成功）');
  } else {
    const url = `https://api.x.com/graphql/${knownUserTweets}/UserTweets?variables=${variables}&features=${features}`;
    const t = await req(url, { headers: apiHeaders });
    log(`UserTweets → ${t.status}  ${t.body.length}B  ${t.ms}ms`);
    // 解析必须兜住：响应不是 JSON 时（HTML 错误页 / 空体）若在这里抛出，
    // 后面的 C、D 两段备选通道就整段跑不到了 —— 探针不能因为一段失败就交白卷。
    try {
      const tweets = collectTweets(JSON.parse(t.body));
      log(`      捞到 ${tweets.length} 条推文正文`);
      for (const tw of tweets.slice(0, 4)) {
        log(`      · [${tw.created_at ?? '无时间'}] ${String(tw.text).slice(0, 90).replace(/\n/g, ' ')}`);
      }
      if (!tweets.length) log(`      响应片段：${t.body.slice(0, 500)}`);
    } catch (err) {
      log(`      解析失败（${err.message}），原响应片段：${t.body.slice(0, 300)}`);
    }
  }
}

/* --------------------------- C. syndication 退避重试 --------------------------- */

hr('C. 备选：syndication timeline-profile（阶段一返回 429，判断是永久拒绝还是限流）');

for (let i = 1; i <= 3; i++) {
  const r = await req(
    `https://syndication.twitter.com/srv/timeline-profile/screen-name/${ACCOUNT}`,
    {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        referer: 'https://platform.twitter.com/',
        origin: 'https://platform.twitter.com',
      },
    }
  );
  const has = /full_text"/.test(r.body) || /__NEXT_DATA__/.test(r.body);
  log(
    `第 ${i} 次 → ${String(r.status).padEnd(5)} ${String(r.body.length).padStart(7)}B  ` +
      `${has ? '✅ 含时间线数据' : '无数据'}${r.status === 429 ? '  (429 限流)' : ''}`
  );
  if (has) break;
  if (i < 3) await new Promise((s) => setTimeout(s, 4000));
}

/* ------------------------------ D. Nitter 实例 ------------------------------ */

hr('D. 备选：Nitter 实例（社区镜像，RSS 输出，免 key）');

const NITTER = [
  'xcancel.com',
  'nitter.privacyredirect.com',
  'lightbrd.com',
  'nitter.space',
  'nitter.tiekoetter.com',
];
for (const host of NITTER) {
  const r = await req(`https://${host}/${ACCOUNT}/rss`);
  const has = /<item>/.test(r.body) && /<title>/.test(r.body);
  log(
    `${has ? '✅' : '❌'} ${String(r.status).padEnd(5)} ${String(r.body.length).padStart(7)}B  ${host}` +
      (has ? '  ← 有 RSS 条目' : r.err ? `  ← ${r.err}` : '')
  );
}

hr('完成');
