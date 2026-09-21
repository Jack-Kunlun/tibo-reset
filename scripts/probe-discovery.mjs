/**
 * 阶段三探针：验证「从站点 HTML 动态发现 bearer / queryId」这条路能否走通。
 *
 * 为什么是这条路：阶段一、二已确认
 *   - x.com 网页端       → 403 Cloudflare 挑战（四种头部变体全挂）
 *   - api.x.com GraphQL  → 200，guest token 与 UserByScreenName 均可用
 *   - abs.twimg.com      → 域名可达（返回 404 而非 CF 挑战，说明只是路径不对）
 *   缺的只有 UserTweets 的 queryId，而 queryId 会随 X 发版而变化，
 *   硬编码等于给自己定了个过期时间。所以正确做法是**每次运行时当场发现它**。
 *
 * 发现方法（来自开源实现 get_tweets.py 的成熟做法，非我发明）：
 *   1. 取站点 HTML → 正则提取其中的 .js 文件地址
 *   2. 下载这些 JS → 正则提取 bearer 与 queryId
 *   3. 用 guest token 调 GraphQL
 *
 * 本脚本要回答的关键问题：**twitter.com 的 CF 策略是否比 x.com 宽松**。
 * x.com 被挡不代表 twitter.com 被挡 —— 它们是两套配置，必须分别实测。
 *
 * 只读、无副作用。
 */

const UA_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ACCOUNT = process.env.SOURCE_ACCOUNT || 'thsottiaux';
const TIMEOUT = Number(process.env.PROBE_TIMEOUT ?? 25_000);

const hr = (t) => console.log(`\n${'='.repeat(76)}\n${t}\n${'='.repeat(76)}`);

async function req(url, opts = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        'user-agent': opts.ua ?? UA_CHROME,
        accept: opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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

function describe(r) {
  if (r.err) return `ERR ${r.err}`;
  if (/Just a moment|challenge-platform|cf-chl/i.test(r.body)) return 'Cloudflare 挑战';
  if (r.status !== 200) return `HTTP ${r.status}`;
  return 'OK';
}

/* ------------------- A. 三个站点的 HTML 可达性对比 ------------------- */

hr('A. 站点 HTML：twitter.com 的 CF 策略是否比 x.com 宽松？（这是整条路的前提）');

const SITES = [
  ['x.com', `https://x.com/${ACCOUNT}`],
  ['twitter.com', `https://twitter.com/${ACCOUNT}`],
  ['mobile.twitter.com', `https://mobile.twitter.com/${ACCOUNT}`],
];

const htmlByHost = {};
for (const [label, url] of SITES) {
  const r = await req(url);
  console.log(
    `${r.ok && /<script|react-root|__NEXT/i.test(r.body) ? '✅' : '❌'} ` +
      `${label.padEnd(20)} ${String(r.status).padEnd(5)} ${String(r.body.length).padStart(8)}B  ${describe(r)}`
  );
  if (r.ok && r.body.length > 1000) htmlByHost[label] = r.body;
}

/* ------------------- B. 从 HTML 提取 JS 并挖 queryId ------------------- */

hr('B. 从可用 HTML 提取 JS 地址，下载后在 JS 里挖 bearer / queryId');

const X_WEB_BEARER_FALLBACK =
  'AAAAAAAAAAAAAAAAAAAAANRilgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

let discovered = null; // { bearer, userTweets, userByScreenName, userTweetsAndReplies, jsCount }

for (const [host, html] of Object.entries(htmlByHost)) {
  // X 的 HTML 里 script 一般是绝对地址；兼容相对地址写法
  const jsUrls = [
    ...new Set([
      ...[...html.matchAll(/https:\/\/abs\.twimg\.com\/[^"'\s]+\.js/g)].map((m) => m[0]),
      ...[...html.matchAll(/src=["']([^"']+\.js)["']/g)].map((m) =>
        m[1].startsWith('http') ? m[1] : `https://${host}/${m[1].replace(/^\//, '')}`
      ),
    ]),
  ];

  console.log(`\n${host}: HTML 里找到 ${jsUrls.length} 个 JS 地址`);
  if (!jsUrls.length) continue;

  // 只取前 6 个：X 首页的 script 通常 2–4 个，取多了只是白等带宽
  let bearer = null;
  const queryIds = {};
  for (const jsUrl of jsUrls.slice(0, 6)) {
    const j = await req(jsUrl, { accept: 'application/javascript,*/*' });
    console.log(`  ${j.ok ? '✅' : '❌'} ${String(j.status).padEnd(5)} ${String(j.body.length).padStart(9)}B  ${jsUrl.slice(0, 96)}`);
    if (!j.ok) continue;

    // bearer：形如 AAA...%...（URL 编码过的）
    const bt = j.body.match(/["'](AAA[a-zA-Z0-9%_-]+%[a-zA-Z0-9%_-]+)["']/);
    if (bt && !bearer) bearer = bt[1];

    // queryId：形如 {queryId:"xxxx",operationName:"UserTweets",...}
    // operationName 可能在 queryId 之后，所以用「大括号内不含大括号」的宽松匹配再过滤
    for (const m of j.body.matchAll(/\{queryId:"([\w-]{20,24})"[^{}]{0,400}?operationName:"([A-Za-z]+)"/g)) {
      queryIds[m[2]] = m[1];
    }
    for (const m of j.body.matchAll(/operationName:"([A-Za-z]+)"[^{}]{0,400}?queryId:"([\w-]{20,24})"/g)) {
      queryIds[m[1]] = m[2];
    }
  }

  const names = Object.keys(queryIds);
  console.log(`  → bearer ${bearer ? '已找到' : '未找到'}；queryId 解析出 ${names.length} 个`);
  if (names.length) {
    console.log(`  → 含 UserTweets: ${queryIds.UserTweets ?? '无'}`);
    console.log(`  → 含 UserByScreenName: ${queryIds.UserByScreenName ?? '无'}`);
    console.log(`  → 全部：${names.slice(0, 25).join(', ')}`);
  }
  if (bearer && (queryIds.UserTweets || queryIds.UserTweetsAndReplies)) {
    discovered = {
      host,
      bearer,
      userTweets: queryIds.UserTweets ?? null,
      userTweetsAndReplies: queryIds.UserTweetsAndReplies ?? null,
      userByScreenName: queryIds.UserByScreenName ?? null,
      featuresCount: names.length,
    };
    break;
  }
}

/* --------------- C. 用发现的 queryId 真的拉一次时间线 --------------- */

hr('C. 端到端：guest token + 动态发现的 queryId → 推文正文');

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

const bearer = discovered?.bearer ?? X_WEB_BEARER_FALLBACK;
console.log(`使用 bearer：${bearer === X_WEB_BEARER_FALLBACK ? '内置兜底值' : '从 JS 中发现'}`);

const gt = await req('https://api.x.com/1.1/guest/activate.json', {
  method: 'POST',
  accept: 'application/json',
  headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
});
let guestToken = null;
try {
  guestToken = JSON.parse(gt.body)?.guest_token ?? null;
} catch {
  /* 非 JSON */
}
console.log(`guest/activate → ${gt.status}  token=${guestToken ? guestToken.slice(0, 10) + '…' : '未取得'}`);

if (!discovered) {
  console.log('\n⚠ 动态发现未成功（见 A/B 段），无法继续 C 段。');
  console.log('  这意味着 HTML 通道走不通，需要另找 queryId 来源。');
} else if (!guestToken) {
  console.log('\n⚠ 没拿到 guest token，无法继续。');
} else {
  const apiHeaders = {
    authorization: `Bearer ${bearer}`,
    'x-guest-token': guestToken,
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'content-type': 'application/json',
  };

  // 先拿 userId
  let userId = null;
  if (discovered.userByScreenName) {
    const vars = encodeURIComponent(JSON.stringify({ screen_name: ACCOUNT }));
    const u = await req(`https://api.x.com/graphql/${discovered.userByScreenName}/UserByScreenName?variables=${vars}`, {
      accept: 'application/json',
      headers: apiHeaders,
    });
    try {
      userId = JSON.parse(u.body)?.data?.user?.result?.rest_id ?? null;
    } catch {
      /* 非 JSON */
    }
    console.log(`UserByScreenName → ${u.status}  userId=${userId ?? '未取到'}`);
  }

  const op = discovered.userTweets ? 'UserTweets' : 'UserTweetsAndReplies';
  const qid = discovered.userTweets ?? discovered.userTweetsAndReplies;
  if (userId && qid) {
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
    const t = await req(`https://api.x.com/graphql/${qid}/${op}?variables=${variables}&features=${features}`, {
      accept: 'application/json',
      headers: apiHeaders,
    });
    console.log(`${op} → ${t.status}  ${t.body.length}B  ${t.ms}ms`);
    try {
      const tweets = collectTweets(JSON.parse(t.body));
      console.log(`  ✅ 捞到 ${tweets.length} 条推文正文`);
      for (const tw of tweets.slice(0, 5)) {
        console.log(`  · [${tw.created_at ?? '无时间'}] ${String(tw.text).slice(0, 88).replace(/\n/g, ' ')}`);
      }
      if (!tweets.length) console.log(`  响应片段：${t.body.slice(0, 400)}`);
    } catch (err) {
      console.log(`  解析失败（${err.message}）：${t.body.slice(0, 300)}`);
    }
  } else {
    console.log(`⚠ 缺 userId(${userId}) 或 queryId(${qid})，跳过`);
  }
}

/* ---------------- D. 兜底：archive.org 能否提供 HTML ---------------- */

hr('D. 兜底：archive.org 快照（当站点 HTML 直接被拦时的替代来源）');

const av = await req(`https://archive.org/wayback/available?url=twitter.com/${ACCOUNT}`, {
  accept: 'application/json',
});
console.log(`wayback available → ${av.status}  ${av.body.slice(0, 220)}`);
const av2 = await req(`https://archive.org/wayback/available?url=x.com/${ACCOUNT}`, { accept: 'application/json' });
console.log(`wayback (x.com) → ${av2.status}  ${av2.body.slice(0, 220)}`);

let snapUrl = null;
try {
  snapUrl = JSON.parse(av.body)?.archived_snapshots?.closest?.url ?? null;
} catch {
  /* 非 JSON */
}
if (snapUrl) {
  const s = await req(snapUrl);
  const jsFromSnap = [...new Set([...s.body.matchAll(/https:\/\/abs\.twimg\.com\/[^"'\s]+\.js/g)].map((m) => m[0]))];
  console.log(`快照 ${snapUrl.slice(0, 90)} → ${s.status} ${s.body.length}B，内含 ${jsFromSnap.length} 个 JS 地址`);
}

hr('完成');
