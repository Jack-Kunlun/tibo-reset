/**
 * 阶段四探针：改从 archive.org 取页面源码，绕开 Cloudflare 对站点的拦截。
 *
 * 为什么换思路：阶段三实测 x.com / twitter.com / mobile.twitter.com
 * **三个域名的 CF 策略完全一致，全部 403**（同一份 5749B 挑战页）。
 * 「换个域名绕过」这条假设被证伪了。
 *
 * 但阶段三顺带确认了两件事：
 *   1. archive.org 在 runner 上可达，且 x.com 有快照
 *   2. guest/activate 那次返回 401（阶段二同一个 bearer 却是 200）
 *      → 要么 bearer 已被轮换，要么是 IP 频控，必须查清
 *
 * 本脚本要验证的链路（全程无硬编码，bearer 与 queryId 都当场发现）：
 *   archive.org 取 x.com HTML
 *     → 提取 JS 地址
 *     → 下载 JS（abs.twimg.com 在 runner 上域名可达）
 *       └ 若 404，退回 archive 上的 JS 快照
 *     → 正则挖出 bearer 与 UserTweets queryId
 *     → 用新 bearer 拿 guest token
 *     → 调 GraphQL 拉时间线
 *
 * 只读、无副作用。
 */

const UA_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ACCOUNT = process.env.SOURCE_ACCOUNT || 'thsottiaux';
const TIMEOUT = Number(process.env.PROBE_TIMEOUT ?? 30_000);

const hr = (t) => console.log(`\n${'='.repeat(76)}\n${t}\n${'='.repeat(76)}`);
const clip = (s, n = 200) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

async function req(url, opts = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        'user-agent': opts.ua ?? UA_CHROME,
        accept: opts.accept ?? 'text/html,application/xhtml+xml,*/*;q=0.8',
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

/* --------------- A. 从 archive.org 取站点源码 --------------- */

hr('A. archive.org 取 x.com 源码（绕开 CF 的入口）');

const snapUrls = [];
for (const u of [`x.com/${ACCOUNT}`, `twitter.com/${ACCOUNT}`]) {
  const av = await req(`https://archive.org/wayback/available?url=${u}`, { accept: 'application/json' });
  let closest = null;
  try {
    closest = JSON.parse(av.body)?.archived_snapshots?.closest ?? null;
  } catch {
    /* 非 JSON */
  }
  console.log(`${av.status}  ${u}  →  ${closest ? `${closest.timestamp} (${closest.status})` : '无快照'}`);
  if (closest?.url) snapUrls.push(closest.url);
}

let snapHtml = null;
let snapUsed = null;
for (const base of snapUrls) {
  // id_ 后缀要求 archive 返回**未经改写的原始内容**，避免它注入自己的工具栏与重写链接。
  // 先试 id_ 形态，失败再退回普通形态。
  const idUrl = base.replace(/(\/web\/\d+)\//, '$1id_/');
  for (const url of idUrl === base ? [base] : [idUrl, base]) {
    const r = await req(url);
    const looksReal = /<script/i.test(r.body) && r.body.length > 3000;
    console.log(
      `${looksReal ? '✅' : '❌'} ${String(r.status).padEnd(5)} ${String(r.body.length).padStart(8)}B  ${url.slice(0, 100)}`
    );
    if (looksReal) {
      snapHtml = r.body;
      snapUsed = url;
      break;
    }
  }
  if (snapHtml) break;
}

/* --------------- B. 从快照 HTML 挖 JS 地址 --------------- */

hr('B. 从快照 HTML 提取 JS 地址，并下载 JS（直连 abs.twimg.com，404 则退回 archive 快照）');

let jsSources = [];
if (snapHtml) {
  jsSources = [
    ...new Set([
      ...[...snapHtml.matchAll(/https?:\/\/abs\.twimg\.com\/[^"'\s\\)]+\.js/g)].map((m) => m[0]),
      // 相对路径形态：/x-web/xxx.js
      ...[...snapHtml.matchAll(/["'](\/[\w./-]+\.js)["']/g)].map((m) => `https://abs.twimg.com${m[1]}`),
    ]),
  ];
}
console.log(`快照 ${snapUsed ? snapUsed.slice(0, 80) : '（无）'}`);
console.log(`提取到 ${jsSources.length} 个 JS 地址`);
for (const u of jsSources.slice(0, 12)) console.log(`  · ${u}`);

const bearerCandidates = [];
const queryIds = {};
let jsDownloaded = 0;

for (const jsUrl of jsSources.slice(0, 10)) {
  let body = null;
  let via = '';

  const direct = await req(jsUrl, { accept: 'application/javascript,*/*' });
  if (direct.ok && direct.body.length > 5000) {
    body = direct.body;
    via = '直连';
  } else {
    // 直连失败（通常是该 hash 的文件已被 X 清理）→ 问 archive 要这份 JS 的快照
    const archived = `https://web.archive.org/web/2026id_/${jsUrl}`;
    const a = await req(archived, { accept: 'application/javascript,*/*' });
    if (a.ok && a.body.length > 5000) {
      body = a.body;
      via = 'archive 快照';
    } else {
      console.log(`  ❌ ${String(direct.status).padEnd(5)} ${jsUrl.slice(0, 84)}  (archive 也无：${a.status})`);
      continue;
    }
  }

  jsDownloaded++;
  console.log(`  ✅ ${String(body.length).padStart(9)}B  [${via}]  ${jsUrl.slice(-60)}`);

  for (const m of body.matchAll(/["'](AAA[a-zA-Z0-9%_-]{60,})["']/g)) bearerCandidates.push(m[1]);
  for (const m of body.matchAll(/\{queryId:"([\w-]{20,24})"[^{}]{0,400}?operationName:"([A-Za-z]+)"/g))
    queryIds[m[2]] = m[1];
  for (const m of body.matchAll(/operationName:"([A-Za-z]+)"[^{}]{0,400}?queryId:"([\w-]{20,24})"/g))
    queryIds[m[1]] = m[2];
  // 还有一种是 {operationName:"UserTweets",...queryId:"xxx"} 但中间含嵌套花括号，放宽再扫一遍
  for (const m of body.matchAll(/UserTweets[^{}]{0,300}?queryId:"([\w-]{20,24})"/g)) {
    if (!queryIds.UserTweets) queryIds.UserTweets = m[1];
  }
}

const names = Object.keys(queryIds);
console.log(`\nJS 下载成功 ${jsDownloaded} 份；bearer 候选 ${bearerCandidates.length} 个；queryId ${names.length} 个`);
if (names.length) console.log(`  UserTweets = ${queryIds.UserTweets ?? '未找到'}`);
if (names.length) console.log(`  UserByScreenName = ${queryIds.UserByScreenName ?? '未找到'}`);
if (names.length) console.log(`  全部：${names.slice(0, 30).join(', ')}`);

const bearer = bearerCandidates[0] ?? null;
console.log(`bearer = ${bearer ? bearer.slice(0, 24) + '…' : '未发现'}`);

/* --------------- C. guest token：诊断 401 的原因 --------------- */

hr('C. guest token：复现并诊断阶段三那次 401');

const FALLBACK_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRilgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const tokenAttempts = [];
for (const [label, url, tk] of [
  ['api.x.com + 发现的 bearer', 'https://api.x.com/1.1/guest/activate.json', bearer],
  ['api.x.com + 内置 bearer', 'https://api.x.com/1.1/guest/activate.json', FALLBACK_BEARER],
  ['api.twitter.com + 内置 bearer', 'https://api.twitter.com/1.1/guest/activate.json', FALLBACK_BEARER],
]) {
  if (!tk) {
    console.log(`—  ${label}：跳过（无 bearer）`);
    continue;
  }
  const r = await req(url, {
    method: 'POST',
    accept: '*/*',
    headers: {
      authorization: `Bearer ${tk}`,
      'content-type': 'application/json',
      // 加上这两个头：X 会据此判断调用方身份，缺了容易被当成脚本
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
    },
  });
  let token = null;
  try {
    token = JSON.parse(r.body)?.guest_token ?? null;
  } catch {
    /* 非 JSON */
  }
  console.log(`${token ? '✅' : '❌'} ${String(r.status).padEnd(5)} ${label}  token=${token ? token.slice(0, 10) + '…' : '无'}`);
  if (!token) console.log(`     body: ${clip(r.body, 220)}`);
  if (token) tokenAttempts.push({ label, token });
}

const guestToken = tokenAttempts[0]?.token ?? null;
const effectiveBearer = tokenAttempts[0]?.label.includes('发现的') ? bearer : FALLBACK_BEARER;

/* --------------- D. 用发现的 queryId 拉时间线 --------------- */

hr('D. 端到端：queryId + guest token → 推文正文');

function collectTweets(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (seen.has(node)) return out;
  seen.add(node);
  if (typeof node.full_text === 'string') {
    out.push({ text: node.full_text, id: node.id_str ?? node.rest_id ?? null, created_at: node.created_at ?? null });
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') collectTweets(v, out, seen);
  return out;
}

const FEATURES = encodeURIComponent(
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

if (!guestToken) {
  console.log('⚠ 没拿到 guest token（见 C 段），D 段无法进行。');
} else if (!queryIds.UserTweets && !queryIds.UserByScreenName) {
  console.log('⚠ 没发现任何 queryId（见 B 段），D 段无法进行。');
} else {
  const headers = {
    authorization: `Bearer ${effectiveBearer}`,
    'x-guest-token': guestToken,
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'content-type': 'application/json',
  };

  let userId = null;
  if (queryIds.UserByScreenName) {
    const vars = encodeURIComponent(JSON.stringify({ screen_name: ACCOUNT }));
    const u = await req(`https://api.x.com/graphql/${queryIds.UserByScreenName}/UserByScreenName?variables=${vars}`, {
      accept: 'application/json',
      headers,
    });
    try {
      userId = JSON.parse(u.body)?.data?.user?.result?.rest_id ?? null;
    } catch {
      /* 非 JSON */
    }
    console.log(`UserByScreenName → ${u.status}  ${u.body.length}B  userId=${userId ?? '未取到'}`);
    if (!userId) console.log(`     body: ${clip(u.body, 260)}`);
  }

  const qid = queryIds.UserTweets;
  if (userId && qid) {
    const variables = encodeURIComponent(
      JSON.stringify({ userId, count: 20, includePromotedContent: false, withVoice: false, withV2Timeline: true })
    );
    const t = await req(`https://api.x.com/graphql/${qid}/UserTweets?variables=${variables}&features=${FEATURES}`, {
      accept: 'application/json',
      headers,
    });
    console.log(`UserTweets → ${t.status}  ${t.body.length}B  ${t.ms}ms`);
    try {
      const tweets = collectTweets(JSON.parse(t.body));
      console.log(`  ${tweets.length ? '✅' : '❌'} 捞到 ${tweets.length} 条推文正文`);
      for (const tw of tweets.slice(0, 6)) {
        console.log(`  · [${tw.created_at ?? '无时间'}] ${clip(tw.text, 88)}`);
      }
      if (!tweets.length) console.log(`  body: ${clip(t.body, 500)}`);
    } catch (err) {
      console.log(`  解析失败（${err.message}）：${clip(t.body, 300)}`);
    }
  } else {
    console.log(`⚠ 缺 userId(${userId}) 或 UserTweets queryId(${qid})，跳过`);
  }
}

hr('完成');
