/**
 * 登录态时间线采集 —— 走 Chrome DevTools Protocol。
 *
 * 为什么必须有它：未登录的 x.com 只给 profile 首屏 **7 条**原创，而且这不只是
 * 「少一点」——2026-09-12 那次重置的 5 条（含 "Reset all propagated"）全部落在
 * 7 条窗口之外，观测台因此**一次都没看见它本该盯住的那件事**。7 条是 X 的权限
 * 设计，不是请求头能解的问题，所以只能走登录态。
 *
 * 为什么是 CDP 而不是 AppleScript：本机宿主 App 的 seatbelt 策略默认全拒、
 * 白名单里没有 `appleevent-send`，所有 Apple Event 在沙箱层就被拦下，
 * 用户把「自动化」和「允许 Apple 事件中的 JavaScript」两个开关都打开也没用。
 * 而 CDP 只需要一个回环端口 + 本机已登录的 Chrome profile，不读 cookie 文件、
 * 不需要任何系统授权。
 *
 * 边界：这条链路依赖本机 Chrome。CI（无浏览器、无登录 profile）上不可用，
 * 调用方需要保留免登录 HTML 路径作为降级。
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

/** 远程调试端口。 */
export const CDP_PORT = Number(process.env.X_CDP_PORT ?? 9222);

/**
 * 采集专用 profile 目录（放在 HOME 下，**绝不能进仓库**）。
 * 登录一次后 cookie 留在该目录，后续直接复用。
 */
export const PROFILE_DIR = process.env.X_PROFILE_DIR ?? join(homedir(), '.tibo-reset-chrome');

export const CHROME_BIN =
  process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * headless 的 UA 会带 `HeadlessChrome`，x.com 见到它稳定返回 403
 * （实测对照：不加 → 403/53B；加上 → 200/1373B。**与代理出口 IP 无关**）。
 * 这串与真实 Chrome 一致，登录态才不会因为指纹变化被判失效。
 */
export const BROWSER_UA =
  process.env.X_BROWSER_UA ??
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

/**
 * 默认代理 —— 只作**兜底**：正常路径由调用方传入 `opts.proxy`，
 * 而那个值是 `proxy.mjs` 实测探测出来的。
 *
 * ⚠ 刻意**不读 `HTTPS_PROXY`**。在本机它被沙箱设成自己的出口端口，
 * 那个端口连不通 x.com（实测 HTTP 000）；Chrome 一旦用它启动，页面加载不出来，
 * 表现成「收割到 0 条推文」，看不出是代理的错。要么用 X_PROXY 显式指定，
 * 要么让上层传探测结果。
 */
const PROXY = process.env.X_PROXY ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 「疑似被截断」的长度门槛（字符）。
 *
 * X 对长推文在时间线 / 搜索页只渲染前约 280 字符，"Show more" 之后的节点
 * **不在 DOM 里**，而收割取的是 `innerText` —— 长推文于是天然只采到前半段
 * （KI-002 只修了「上游收录后的回填」，上游自己没收录时依然丢；见 KI-009）。
 *
 * 实测截断点落在 275–278 之间，取 240 是往下留了余量。判错方向的代价
 * **不对称**，所以门槛只往下压、不往上抬：
 *   · 假阳性（把完整推文当成截断）→ 多开一次详情页。详情页给出的正文若不更长，
 *     回填逻辑（更长者胜）什么都不会替换，白花的只是一次请求；
 *   · 假阴性（把截断推文当成完整）→ 后半段的语义永久丢掉，且**不报错不告警**，
 *     只有把上游正文与本地正文逐字节对齐才看得见。
 */
export const TRUNCATED_MIN_LENGTH = Number(process.env.X_TRUNCATED_MIN_LENGTH ?? 240);

function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

/* --------------------------- 纯函数：结果规范化 --------------------------- */

/**
 * 把页面 DOM 收割到的条目规范化成推文记录，并按时间下界裁剪。
 *
 * 抽成纯函数是为了可测：这一层的错（id 归属、时间下界切早切晚）是静默的，
 * 不会报错，只会让数据悄悄少几条 —— 正是我们这次要修的那类 bug。
 *
 * @param {Array<{id?:string,text?:string,time?:string,url?:string}>} items
 * @param {{handle?:string, sinceMs?:number}} [opts] `sinceMs` 为下界（含）。
 */
export function normalizeTimelineItems(items, opts = {}) {
  const sinceMs = Number(opts.sinceMs ?? 0);
  const seen = new Map();
  for (const it of items ?? []) {
    const id = String(it?.id ?? '').trim();
    const text = String(it?.text ?? '').trim();
    const created = it?.time ? new Date(it.time) : null;
    if (opts.handle && String(it?.author ?? '').toLowerCase() !== opts.handle.toLowerCase()) continue;
    if (!id || !created || Number.isNaN(created.getTime())) continue;
    if (sinceMs > 0 && created.getTime() < sinceMs) continue;
    if (seen.has(id)) continue;
    seen.set(id, {
      id,
      text,
      created_at: created.toISOString(),
      url: it.url ?? `https://x.com/${opts.handle ?? ''}/status/${id}`,
      ...(opts.handle ? { author_verified: true } : {}),
      // 被回复的内容由上游的 pairReplyContext 在收割时挂上，这里只负责透传。
      // 丢了它，识别算法就只能看到他的半句话。
      ...(it.inReplyTo ? { inReplyTo: it.inReplyTo } : {}),
      ...(it.quotedTweet ? { quotedTweet: it.quotedTweet } : {}),
      // 民调同理：它是正文之外**唯一**带量化民意的字段（正文只有 "Vote" 一个词）。
      // 不带出来，采集侧就等于把这条民意扔了。
      ...(it.poll ? { poll: it.poll } : {}),
    });
  }
  return [...seen.values()]
    .filter((t) => t.text)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

/**
 * 增量停止判据（纯函数，单独抽出来是为了可测）。
 *
 * 返回 true 表示「本屏收下来的条目**全部**已入库」—— 连续若干屏如此即可停止。
 *
 * 两个刻意的选择：
 *   1) 要求整屏全旧，而不是「命中一条就停」。首屏必然混着旧的，单条命中太容易误停；
 *      整屏全旧意味着新内容都在更上面，早在上一步就收完了。
 *   2) 只统计**取得到 id** 的条目。转发别人的推文拿不到他自己的 id，
 *      混进来会让 `every` 恒为 false，增量就永远不会停。
 */
export function isKnownScreen(batch, known) {
  const withId = (batch ?? []).filter((it) => it?.id);
  return withId.length > 0 && withId.every((it) => known.has(it.id));
}

/* ------------------------------ CDP 客户端 ------------------------------ */

/** 单条求值用的最小 CDP 通道：Native WebSocket（Node ≥22）+ 会话扁平化。 */
class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.sessionId = null;
    this.onEvent = null;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.method && this.onEvent) {
        this.onEvent(msg);
      }
    });
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (this.sessionId) msg.sessionId = this.sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, timeoutMs);
    });
  }

  async evalJs(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`页面脚本异常：${JSON.stringify(res.exceptionDetails).slice(0, 160)}`);
    }
    return res.result.value;
  }
}

/**
 * 页面里跑：按 **DOM 顺序**收下当前所有 `article`，带上作者。
 *
 * 为什么收「所有」而不是只收他自己的：`with_replies` 流里，
 * 「被回复的推文」和「他的回复」是**成对渲染**的 —— 拿掉前者就没了上下文，
 * 而他的回复本身常常一个额度词都没有（「OK fine. But it's also still coming
 * in Tuesday」），只有连着被回复的内容才读得出「这是在说重置」。
 *
 * 作者与 status 链接要同时匹配，引用卡里的目标链接不能证明整条正文属于他。
 */
export function harvestExpression(handle) {
  const h = JSON.stringify(String(handle ?? '').toLowerCase());
  return `(function(){var H=${h};
  /* 民调：他的「今天算不算好日子」投票是**唯一会给出量化民意**的东西
     （实测 2026-10-06：76% 投「needs a reset」，他随后回「I accept your vote」）。
     而正文里只有 "Vote" 一个词 —— 选项与得票率**只在 DOM 的 cardPoll 里**，
     不采就等于这条民意在系统里不存在。

     两种形态必须都认，只写一种会在另一种上静默返回空：
       · 已有结果：ul[role=list] > li[role=listitem]，每项 = 填充条(style width%) + 文本 + NN%
       · 进行中  ：div[role=radiogroup] > div[role=radio]，只有文本、没有得票率

     ⚠ 页脚文案是**本地化**的（实测界面为中文：「74,565 次投票 · 最终结果」）。
       所以票数只能从数字里取（取其中最大的那个），status 原样留档、**不按词解释** ——
       按 "votes" 之类的英文词匹配，换个界面语言就静默失效。 */
  function pollOf(a){
    var card=a.querySelector('[data-testid="cardPoll"]');
    if(!card)return null;
    var opts=[],i;
    var items=card.querySelectorAll('li[role="listitem"]');
    if(items.length){
      for(i=0;i<items.length;i++){
        var li=items[i];
        var pct=null;
        var fill=li.querySelector('div[style*="width"]');
        if(fill){var mm=(fill.getAttribute('style')||'').match(/width:\\s*([0-9.]+)%/);if(mm)pct=parseFloat(mm[1]);}
        var dl=li.querySelectorAll('div[dir="ltr"]');
        var tx=dl[0]?(dl[0].innerText||'').replace(/\\s+/g,' ').trim():'';
        // 万一百分比排在前面，跳过它取下一个
        if(/^\\d+(\\.\\d+)?%$/.test(tx)&&dl[1])tx=(dl[1].innerText||'').replace(/\\s+/g,' ').trim();
        opts.push({text:tx,pct:pct});
      }
    }else{
      var rs=card.querySelectorAll('[role="radio"]');
      for(i=0;i<rs.length;i++){
        var d=rs[i].querySelector('div[dir="ltr"]');
        opts.push({text:(d?(d.innerText||''):'').replace(/\\s+/g,' ').trim(),pct:null});
      }
    }
    if(!opts.length)return null;
    var ul=card.querySelector('ul[role="list"]');
    var fb=card.lastElementChild;
    var foot=fb&&fb!==ul?(fb.innerText||'').replace(/\\s+/g,' ').trim():'';
    var total=null;
    var nums=foot.match(/\\d[\\d,]{1,14}/g);
    if(nums){var best=0;for(i=0;i<nums.length;i++){var v=parseInt(nums[i].replace(/,/g,''),10);if(v>best)best=v;}if(best>0)total=best;}
    return {options:opts,totalVotes:total,status:foot};
  }
  var out=[];document.querySelectorAll('article').forEach(function(a){
    var t=a.querySelector('[data-testid="tweetText"]');
    var tm=null;
    var id='',url='';
    var author='';
    var un=a.querySelector('[data-testid="User-Name"]');
    if(un){var m2=(un.innerText||'').match(/@([A-Za-z0-9_]+)/);if(m2)author=m2[1];}
    // 引用卡要**先**定位：它也是同一作者的推文，且它的时间戳在 DOM 里排在本帖之前。
    // 只按「作者匹配 + 取第一个」筛 time，引用卡会把本帖的 id/时刻整个顶掉
    // （2026-10-15 实测：「Done and dusted」被抽成「Landing within the next 2 hours」的 id）。
    var quoted=null,q=a.querySelector('div[role="link"] [data-testid="tweetText"]');
    var card=q?q.closest('div[role="link"]'):null;
    a.querySelectorAll('time').forEach(function(time){
      if(card&&card.contains(time))return;
      var l=time.closest('a'),href=l?(l.getAttribute('href')||''):'';
      var m=href.match(/^\\/([^\\/]+)\\/status\\/(\\d+)$/);
      if(!tm&&m&&m[1].toLowerCase()===author.toLowerCase()){tm=time;id=m[2];url='https://x.com'+href;}
    });
    if(author.toLowerCase()!==H){id='';url='';}
    if(card){
      var qt=card.querySelector('time');
      var qa=(card.innerText||'').match(/@([A-Za-z0-9_]+)/);
      if(qa&&qt)quoted={account:qa[1],text:(q.innerText||'').replace(/\\s+/g,' ').trim(),created_at:qt.getAttribute('datetime'),relation:'quote'};
      if(t===q)t=null;
    }
    var more=!!a.querySelector('[data-testid="tweet-text-show-more-link"]');
    out.push({id:id,url:url,time:tm?tm.getAttribute('datetime'):'',text:t?t.innerText.replace(/\\s+/g,' '):'',author:author,truncated:more,poll:pollOf(a),quotedTweet:quoted});
  });return out;})()`;
}

/**
 * 给「他的回复」挂上被回复的内容（纯函数，单独抽出来是为了可测）。
 *
 * **必须在每步收割时就做，不能等滚完再统一做**：X 的列表是虚拟化的，滚过去
 * 若干屏之后条目会被卸载，而 DOM 顺序是配对关系的**唯一载体** —— 事后拿到的
 * 只是一堆散条目，配不出谁回了谁。
 *
 * 配对规则：`with_replies` 流里「被回复的推文」紧邻在「他的回复」之前。
 * 所以只检查紧挨当前条目的上一篇；任何中间 article 都会切断这条弱关系。
 *
 * 两条防呆，都是为了不生出**假的**上下文（假上下文比没有上下文更糟：
 * 它会把一条无关推文的内容当成他的回复语境，直接污染识别结果）：
 *   1) 原推文必须早于回复 —— 时间更晚的一律不认；
 *   2) 作者取不到（`author` 为空）的条目既不算他的、也不拿来当上下文。
 *
 * @param {Array<{id?:string,author?:string,text?:string,time?:string}>} items 按 DOM 顺序
 * @param {string} handle 目标账号
 */
export function pairReplyContext(items, handle) {
  const h = String(handle ?? '').toLowerCase();
  const out = [];
  let previous = null;

  for (const raw of items ?? []) {
    const it = { ...raw };
    const author = String(it.author ?? '').toLowerCase();
    const isMine = !!it.id && author === h;
    const isOther = !isMine && !!author && author !== h && !!it.text && !!it.time;

    if (isMine) {
      // 只有紧邻的外部 article 才可能是回复对象；不跨过自己的帖子或未知节点猜关系。
      if (previous && String(previous.time) < String(it.time)) {
        it.inReplyTo = {
          account: previous.author,
          id: previous.id ?? null,
          text: previous.text,
          created_at: previous.time,
          url: previous.url ?? null,
        };
      } else {
        it.inReplyTo = null;
      }
    } else {
      it.inReplyTo = null;
    }
    // 处理每个 article 后都推进邻接状态；未知 article 也必须清掉旧外帖。
    previous = isOther ? it : null;
    out.push(it);
  }

  return out;
}

/* -------------------------------- 浏览器 -------------------------------- */

/** 已有实例就复用（登录窗口常驻时不能再用同一 profile 起第二个），否则自己起一个。 */
async function withBrowser({ port, proxy }) {
  try {
    const ver = JSON.parse(await httpGet(`http://127.0.0.1:${port}/json/version`));
    return { ver, spawned: null, close: async () => {} };
  } catch {
    /* 没有在跑，自己起 */
  }

  const args = [
    '--headless=new',
    // 宿主 sandbox 之下 Chrome 自己的沙箱会初始化失败（sandbox initialization failed）
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${PROFILE_DIR}`,
    // Chrome ≥136 起，默认 profile 禁用远程调试；这里必须是独立目录
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-agent=${BROWSER_UA}`,
  ];
  if (proxy) args.push(`--proxy-server=${proxy}`);
  args.push('about:blank');

  const proc = spawn(CHROME_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });

  // 留着 Chrome 自己的报错，失败时能说清原因。
  // 不加这层，起不来时只能报「端口未就绪」—— 而 Chrome 已经把真正的原因
  // （profile 被占用、参数不认识、它自己的沙箱起不来）写在那一行里了。
  const tail = [];
  proc.stderr.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      const s = line.trim();
      // macOS 上必然刷屏、且与启动成败无关的两类噪声
      if (!s || /CVDisplayLink|Trying to load the allocator/.test(s)) continue;
      tail.push(s);
      if (tail.length > 12) tail.shift();
    }
  });

  const close = async () => {
    try {
      proc.kill();
    } catch {
      /* 已经退了 */
    }
  };

  // ≈120 秒。首次用一个新 profile 冷启动会明显慢于热启动（实测冷启 >18s、
  // 热启 <7s），预算给小了会把「只是慢」误判成「起不来」。
  for (let i = 0; i < 400; i++) {
    await sleep(300);
    try {
      const ver = JSON.parse(await httpGet(`http://127.0.0.1:${port}/json/version`));
      return { ver, spawned: proc, close };
    } catch {
      /* 还没起来 */
    }
  }
  await close();
  throw new Error(
    `Chrome 调试端口未就绪（profile: ${PROFILE_DIR}）` +
      (tail.length ? `\n    Chrome 说：\n      ${tail.join('\n      ')}` : '')
  );
}

/**
 * 采集一个账号的时间线，滚动收割直到「追上上次的进度」或越过时间下界。
 *
 * 滚动必须**小步**（一次约一屏的 85%），不能用 `scrollTo(0, scrollHeight)` 一把跳到底：
 * X 的列表是虚拟化的，两次收割之间被渲染掉又卸载的条目就永久丢了。实测同一窗口，
 * 跳屏滚动拿到 12 条，小步滚动拿到 16 条 —— 少的 4 条不报错、不告警，只是悄悄没有。
 *
 * 增量（`knownIds`）：X 的时间线只能从最新往下翻，没有「给我某段时间」的查询入口，
 * 所以「只取未读部分」的实现方式是 —— 翻到**连续若干屏都是已入库的推文**就停。
 * 这样滚动深度从「翻到上次重置那天」缩短到「翻到上次见到的最新一条」，
 * 通常 2–5 步。传入空集合等同于全量。
 *
 * ⚠ 增量的固有代价：两道边界都只在「时间线是连续且单调向下」时成立。
 * 若上轮采集在中间丢过条目（虚拟列表抖动）、或他删/改了推文，增量永远补不回来。
 * 所以调用方必须保留**周期性全量回补**（见 collect.mjs 的 fullScanHours）。
 *
 * `path` 决定收哪条流：
 *   · `''`（默认）= `/<handle>`，原创时间线
 *   · `'/with_replies'` = 原创 + 回复。**他的关键发言大量落在回复里** ——
 *     实测「OK fine. But it's also still coming in Tuesday」这种承诺只出现在
 *     回复中，原创流一个字都没有。所以这条路径不是可选增强，是覆盖率的一部分。
 *
 * @param {{handle:string, path?:string, sinceMs?:number,
 *          knownIds?:Iterable<string>|null,
 *          knownScreensToStop?:number, maxSteps?:number, port?:number,
 *          proxy?:string, settleMs?:number, stepRatio?:number,
 *          onProgress?:Function}} opts
 * @returns {Promise<{tweets:Array, loggedIn:boolean, steps:number,
 *          oldest:string|null, mode:'incremental'|'full', stoppedBy:string}>}
 */
/** 收一条流。等价于 `collectStreams({ paths: [path] }).streams[0]`。 */
export async function collectTimeline(opts) {
  const { handle, path = '', ...rest } = opts ?? {};
  const { streams } = await collectStreams({ ...rest, handle, paths: [path] });
  return streams[0];
}

/**
 * 收**多条流**，共用一个浏览器会话。
 *
 * 为什么必须合到一次会话：早先是每条流各调一次 `collectTimeline`，而它会自己
 * 起一次 Chrome 并在结束时 `close()`。于是第二条流启动时，前一个 Chrome 还没
 * 退干净，`json/version` 还能应答（于是被当成「已在运行、复用」），但
 * `Target.createTarget` 发过去就是石沉大海 —— 实测报 `CDP 超时：Target.createTarget`。
 * 冷启动的钱（首次数十秒）只该付一次。
 *
 * 全文补全（`fetchFullText`，默认开）也搭同一次会话 —— 它要逐条开详情页，
 * 而详情页依赖同一个登录态。放在这里而不是放在采集方：**两条流重叠的推文
 * 只该取一次全文**（原创流与 `/with_replies` 流收的是同一批帖子）。
 *
 * @param {{handle:string, paths?:string[], sinceMs?:number,
 *          knownIds?:Iterable<string>|null, knownScreensToStop?:number,
 *          maxSteps?:number, port?:number, proxy?:string, settleMs?:number,
 *          stepRatio?:number, onProgress?:Function,
 *          fetchFullText?:boolean, fullTextMinLength?:number,
 *          fullTextMax?:number, fullTextGapMs?:number,
 *          onFullTextProgress?:Function}} opts
 * @returns {Promise<{streams:Array<object|null>, errors:Array<{path:string,message:string}|null>,
 *          fullTexts:Map<string,string>, fullTextReport:object|null}>}
 *          `streams` 顺序与 `paths` 一致；某条流失败时该位置为 `null`，
 *          原因在同下标的 `errors` 里（互不牵连）。
 *          `fullTexts` 是 id → 详情页给出的正文。**不在这里比较长度** ——
 *          是否替换由下游的「更长者胜」（`patchTruncatedTexts`）决定，
 *          职责分开：这里只负责「把详情页的正文如实取回来」。
 */
export async function collectStreams(opts) {
  const {
    handle,
    paths = [''],
    sinceMs = 0,
    knownIds = null,
    knownTweets = [],
    knownScreensToStop = 2,
    maxSteps = 60,
    port = CDP_PORT,
    proxy = PROXY,
    settleMs = 800,
    stepRatio = 0.85,
    onProgress = null,
    fetchFullText = true,
    fullTextMinLength = TRUNCATED_MIN_LENGTH,
    fullTextMax = 12,
    fullTextGapMs = 900,
    onFullTextProgress = null,
  } = opts ?? {};
  if (!handle) throw new Error('缺少 handle');
  if (!paths.length) throw new Error('paths 为空');

  const known = knownIds instanceof Set ? knownIds : new Set(knownIds ?? []);
  const incremental = known.size > 0;

  const { ver, close } = await withBrowser({ port, proxy });
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
  });

  const cdp = new CdpSession(ws);
  try {
    const streams = [];
    const errors = [];
    for (const p of paths) {
      // 每条流独立兜错：一条流挂了不该把另一条的成果一起丢掉
      // （原创流是主、回复流是补充，两者的重要程度并不相同）。
      try {
        streams.push(
          await harvestStream(cdp, {
            handle,
            path: p,
            sinceMs,
            known,
            incremental,
            knownScreensToStop,
            maxSteps,
            settleMs,
            stepRatio,
            onProgress,
          })
        );
        errors.push(null);
      } catch (err) {
        streams.push(null);
        errors.push({ path: p, message: err.message });
      }
    }

    const { fullTexts, tweetContexts, report: fullTextReport } = fetchFullText
      ? await collectFullTexts(cdp, streams, {
          handle,
          minLength: fullTextMinLength,
          max: fullTextMax,
          gapMs: fullTextGapMs,
          onProgress: onFullTextProgress,
          knownTweets,
        })
      : { fullTexts: new Map(), tweetContexts: new Map(), report: null };

    return { streams, errors, fullTexts, tweetContexts, fullTextReport };
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    await close();
  }
}

/** 在一个已连接的 CDP 会话里收完一条流（各流各用一个 tab）。 */
async function harvestStream(cdp, o) {
  const {
    handle,
    path,
    sinceMs,
    known,
    incremental,
    knownScreensToStop,
    maxSteps,
    settleMs,
    stepRatio,
    onProgress,
  } = o;
  const prevSession = cdp.sessionId;
  const harvested = new Map();
  let targetId = null;
  try {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.sessionId = attached.sessionId;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    let loaded = false;
    cdp.onEvent = (m) => {
      if (m.method === 'Page.loadEventFired') loaded = true;
    };
    await cdp.send('Page.navigate', { url: `https://x.com/${handle}${path}` });
    for (let i = 0; i < 60 && !loaded; i++) await sleep(250);
    await sleep(3000);

    const state = await cdp.evalJs(
      `(function(){return {url:location.href,` +
        `loggedIn: !!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')}})()`
    );

    let steps = 0;
    let stagnant = 0;
    let knownStreak = 0;
    let stoppedBy = 'exhausted';
    /**
     * 作者解析失败的条目（按文本去重）。回复流的配对全靠作者，
     * 静默失效等于「收了一堆没有上下文的半句话」，而这件事不看计数发现不了。
     * 必须去重：同一条 article 在多屏里重复渲染，逐屏累加会虚高好几倍。
     */
    const authorless = new Set();

    for (let step = 1; step <= maxSteps; step++) {
      const raw = await cdp.evalJs(harvestExpression(handle));
      // ⚠ 配对必须在下一次滚动之前完成 —— 滚过去之后条目会被虚拟列表卸载，
      //   DOM 顺序（配对关系的唯一载体）就没了。
      const batch = pairReplyContext(raw, handle);
      let fresh = 0;
      for (const it of batch ?? []) {
        if (!it.id) continue;
        const prev = harvested.get(it.id);
        if (!prev) {
          harvested.set(it.id, it);
          fresh++;
        } else {
          // 同一条可能在不同屏重复出现。两处「后出现的不一定更好」的字段要**取并**：
          //   · inReplyTo：先收进去那次可能恰好落在屏幕边缘，前一条被卸载了，配对因此失败；
          //   · truncated：页面渲染时机不同，某一屏可能还没挂上「展开」入口 ——
          //     漏掉它就等于放弃补全这条的正文（`||` 而不是覆盖，正是为此）。
          const inReplyTo = prev.inReplyTo ?? it.inReplyTo ?? null;
          const quotedTweet = prev.quotedTweet ?? it.quotedTweet ?? null;
          const truncated = Boolean(prev.truncated || it.truncated);
          if (inReplyTo !== prev.inReplyTo || quotedTweet !== prev.quotedTweet || truncated !== prev.truncated) {
            harvested.set(it.id, { ...prev, inReplyTo, quotedTweet, truncated });
          }
        }
      }
      for (const it of raw ?? []) if (!it.author && it.text) authorless.add(it.text.slice(0, 40));
      // 连续多步无新增才认为到底了：小步滚动下偶尔一两步不吐新条目是正常的
      // （懒加载有延迟），阈值太小会在还没翻够之前就收工。
      if (fresh === 0) {
        if (++stagnant >= 6) {
          stoppedBy = 'no-more';
          break;
        }
      } else {
        stagnant = 0;
      }

      const oldest = [...harvested.values()].reduce(
        (min, x) => (x.time && x.time < min ? x.time : min),
        '9999'
      );
      if (onProgress) onProgress({ step, harvested: harvested.size, oldest, knownStreak });

      // 已经翻过下界，再往下翻都是浪费
      if (sinceMs > 0 && oldest !== '9999' && new Date(oldest).getTime() <= sinceMs) {
        stoppedBy = 'floor';
        break;
      }

      // 增量停止：本屏收下来的条目全部已入库 → 已经追上上次的进度。
      // 连续 `knownScreensToStop` 屏，是为了容忍两屏之间恰好夹着一条纯粹已知内容的情况。
      if (incremental && isKnownScreen(batch, known)) {
        if (++knownStreak >= knownScreensToStop) {
          stoppedBy = 'known';
          break;
        }
      } else {
        knownStreak = 0;
      }

      await cdp.evalJs(
        `window.scrollBy(0, Math.round(window.innerHeight * ${Number(stepRatio)})); 1`
      );
      steps = step;
      await sleep(settleMs);
    }

    const tweets = normalizeTimelineItems([...harvested.values()], { handle, sinceMs });
    return {
      tweets,
      loggedIn: !!state.loggedIn,
      steps,
      path,
      oldest: tweets.length ? tweets[tweets.length - 1].created_at : null,
      mode: incremental ? 'incremental' : 'full',
      stoppedBy,
      // 作者解析失败的条目数：回复流的配对完全依赖它，静默失效等于「收了一堆
      // 没有上下文的半句话」，而这件事不看计数是发现不了的。
      authorsMissing: authorless.size,
      // 带上下文的条数 = 收下来的回复条数。**以归一化后的结果为准** ——
      // 收割 Map 与最终入库之间还隔着时间下界与空文本两道过滤，
      // 拿 Map 统计会给出「收下 52 条、其中 54 条带上下文」这种自相矛盾的数字。
      replyCount: tweets.filter((t) => t.inReplyTo).length,
      // 页面上仍带「展开」入口的条目 id —— 它们的正文在 DOM 里是被截断的。
      // 归一化会重建记录（只留 id/正文/时间/链接/上下文），所以这个标记**不落进
      // tweets**，而是单独一条通道送出去：它只服务于「要不要去详情页取全文」，
      // 不是推文的属性，不该混进落盘的数据里。
      truncatedIds: [...harvested.values()].filter((it) => it.truncated && it.id).map((it) => it.id),
    };
  } finally {
    // 收完就关这个 tab，别把标签页留给下一条流（也避免它继续在后台加载）
    if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    cdp.sessionId = prevSession;
    cdp.onEvent = null;
  }
}

/* --------------------------- 详情页：取完整正文 --------------------------- */

/**
 * 页面里跑：取焦点推文的完整正文，以及它是否**仍**挂着「展开」入口。
 *
 * 「焦点推文」的判据是 article 内含指向**本 id** 的链接 —— 详情页第一条 article 就是
 * 主推文，但回复里也可能引用同一个 id（自引用），所以按链接认，而不是按位置认。
 *
 * 正文仍从页面 DOM 读取；RSC payload 那一路**实现过又删掉了**。
 * 实测（2026-09-29）详情页的 `document.documentElement.outerHTML` 里
 * `client:` / `full_text` / base64 键**一个都不出现** —— 详情页是纯客户端渲染，
 * payload 不在序列化出来的 DOM 里。需要补充真实回复/引用 ID 时，由详情采集器
 * 定向读取当前推文的 X 网络响应，不从 HTML 猜 payload，也不改变 DOM 原文。
 *
 * 已知边界：实测最长的一条（1917 字符）在详情页完整渲染、无折叠；
 * 极端长的「Long Post」是否仍会折叠，等真遇到再处理（`showMore` 会在报告里露出来）。
 */
export function detailProbeExpression(id, handle = 'thsottiaux') {
  const idLit = JSON.stringify(String(id ?? ''));
  return `(function(){var ID=${idLit};
    var out={url:location.href,id:'',author:'',time:'',dom:'',showMore:false};
    if(location.href.indexOf('/status/'+ID)<0)return out;
    var rows=${harvestExpression(handle)};
    for(var i=0;i<rows.length;i++){
      var row=rows[i];if(row.id!==ID)continue;
      out.id=row.id;out.author=row.author;out.time=row.time;
      out.dom=row.text;out.showMore=row.truncated;out.quotedTweet=row.quotedTweet;
      // 详情页中焦点帖子之前的是会话祖先；不再跨过自我回复去借陌生人的话。
      var parent=rows[i-1];
      if(parent&&parent.id&&parent.author===row.author&&parent.time<row.time){
        out.inReplyTo={id:parent.id,account:parent.author,text:parent.text,created_at:parent.time,url:parent.url,relation:'reply',verified:true};
      }
      break;
    }
    return out;})()`;
}

function identityText(text) {
  return String(text ?? '').replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
}

function sameInstant(left, right) {
  const a = Date.parse(left ?? '');
  const b = Date.parse(right ?? '');
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

/**
 * 只从 X 单帖详情 API 的对象树里取焦点推文。TweetDetail 会同时带祖先和引用帖，
 * 因此不能取「第一个 tweet」；必须按服务端 rest_id 精确匹配目标 ID。
 */
export function extractTweetDetailMetadata(payload, targetId) {
  let root = payload;
  if (typeof root === 'string') {
    try { root = JSON.parse(root); } catch { return null; }
  }
  const id = String(targetId ?? '');
  if (!id || !root || typeof root !== 'object') return null;
  const found = [];
  const seen = new WeakSet();
  const visit = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const value of node) visit(value);
      return;
    }
    const legacy = node.legacy;
    const candidateId = String(node.rest_id ?? legacy?.id_str ?? '');
    if (legacy && candidateId === id) {
      const user = node.core?.user_results?.result;
      const fullText = node.note_tweet?.note_tweet_results?.result?.text ??
        legacy.full_text ?? legacy.text ?? null;
      found.push({
        id: candidateId,
        author: user?.core?.screen_name ?? user?.legacy?.screen_name ?? null,
        fullText: typeof fullText === 'string' ? fullText : null,
        createdAt: legacy.created_at ?? null,
        inReplyToId: legacy.in_reply_to_status_id_str ?? null,
        quotedId: legacy.quoted_status_id_str ?? null,
      });
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(root);
  if (!found.length) return null;
  const signature = (item) => JSON.stringify(item);
  const unique = [...new Map(found.map((item) => [signature(item), item])).values()];
  return unique.length === 1 ? unique[0] : null;
}

function metadataMatchesSource(metadata, source) {
  if (String(source?.id ?? '') !== metadata.id ||
      String(source?.author ?? source?.account ?? '').toLowerCase() !== metadata.author.toLowerCase() ||
      !sameInstant(source?.time ?? source?.created_at, metadata.createdAt)) return false;
  const sourceText = identityText(source?.text ?? source?.dom);
  const apiText = identityText(metadata.fullText);
  if (!sourceText || !apiText) return false;
  if (sourceText === apiText) return true;
  // 只有时间线正文明确带「展开」标记或达到 X 的长文截断区间时，才接受 API 全文包含它。
  const mayBeTruncated = source?.truncated === true || source?.showMore === true ||
    (source?.text_full !== true && sourceText.length >= 200);
  return mayBeTruncated && apiText.startsWith(sourceText);
}

function sameVerifiedContext(left, right) {
  if (!left) return true;
  return String(left.account ?? '').toLowerCase() === String(right.account ?? '').toLowerCase() &&
    (!left.id || String(left.id) === String(right.id)) &&
    sameInstant(left.created_at ?? left.time, right.created_at) &&
    identityText(left.text) === identityText(right.text);
}

function trustedParentContext(parentId, metadata, knownTweets, relation, maxAgeMs) {
  if (!parentId) return null;
  const candidates = (knownTweets ?? []).filter((tweet) =>
    tweet?.author_verified === true && String(tweet.id) === String(parentId) &&
    String(tweet.account ?? '').toLowerCase() === metadata.author.toLowerCase() &&
    Boolean(String(tweet.text ?? '').trim())
  );
  if (candidates.length !== 1) return null;
  const parent = candidates[0];
  const childTime = Date.parse(metadata.createdAt);
  const parentTime = Date.parse(parent.created_at ?? '');
  if (!Number.isFinite(childTime) || !Number.isFinite(parentTime) ||
      parentTime >= childTime || childTime - parentTime > maxAgeMs) return null;
  return {
    id: String(parent.id),
    account: parent.account,
    text: parent.text,
    created_at: parent.created_at,
    url: parent.url ?? `https://x.com/${parent.account}/status/${parent.id}`,
    relation,
    verified: true,
    verificationSource: 'tweet-detail-api',
  };
}

/**
 * 把网络响应与页面/已采集原文交叉核对，再用真实父 ID 查可信同作者历史帖。
 * 任何字段缺失、矛盾或超出 24 小时都只返回未验证，不推断最近邻关系。
 */
export function verifyTweetDetailMetadata(metadata, opts = {}) {
  const targetId = String(opts.targetId ?? '');
  const handle = String(opts.handle ?? '').toLowerCase();
  const result = { verified: false, inReplyTo: null, quotedTweet: null };
  if (!metadata || metadata.id !== targetId || typeof metadata.author !== 'string' ||
      metadata.author.toLowerCase() !== handle || !metadata.fullText || !metadata.createdAt ||
      !Number.isFinite(Date.parse(metadata.createdAt))) return result;

  const sources = [];
  const dom = opts.domProbe;
  if (dom?.id === targetId && dom.author && dom.time && dom.dom) {
    sources.push({ id: dom.id, author: dom.author, time: dom.time, text: dom.dom, showMore: dom.showMore });
  }
  for (const tweet of opts.knownTweets ?? []) {
    if (tweet?.author_verified === true && String(tweet.id) === targetId) {
      sources.push({ id: tweet.id, account: tweet.account, created_at: tweet.created_at,
        text: tweet.text, text_full: tweet.text_full });
    }
  }
  if (!sources.length || sources.some((source) => !metadataMatchesSource(metadata, source))) return result;

  const maxAgeMs = Number(opts.maxAgeMs ?? 24 * 60 * 60 * 1000);
  result.verified = true;
  result.inReplyTo = trustedParentContext(metadata.inReplyToId, metadata, opts.knownTweets, 'reply', maxAgeMs);
  result.quotedTweet = trustedParentContext(metadata.quotedId, metadata, opts.knownTweets, 'quote', maxAgeMs);
  return result;
}

function needsReplyContext(text) {
  const value = String(text ?? '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  const hasOwnResetScope = /\b(?:reset|quota|allowance|usage|credits?|limits?)\b/i.test(value);
  const isFutureLanding = /\b(?:lands?|landing)\b[\s\S]{0,100}\b(?:today|tomorrow|before|by|within|next)\b/i.test(value);
  const isDeadlineShortText = /^by\s+(?:midnight|noon|\d{1,2}(?::\d{2})?(?:\s*[ap]m)?)\s*(?:PST|PDT|PT|UTC(?:[+-]\d{1,2})?)?[.!]?$/i.test(value);
  const isCompletionFollowup = isLinkedCompletionText(value);
  return !hasOwnResetScope && (isFutureLanding || isDeadlineShortText || isCompletionFollowup);
}

function requiresExactNetworkContext(text) {
  const value = identityText(text);
  const propagated = /^(?:it[’']s|it is)\s+all\s+propagated[.!](?:\s+enjoy\s+some\s+mad\s+codexing\s+tomorrow[.!])?(?:\s+fun\s+week\s+ahead\s+too[.!])?$/i;
  const byClock = /^by\s+(?:midnight|noon|\d{1,2}(?::\d{2})?(?:\s*[ap]m)?)\s*(?:PST|PDT|PT|UTC(?:[+-]\d{1,2})?)?[.!]?$/i;
  return propagated.test(value) || byClock.test(value);
}

function isLinkedCompletionText(text) {
  // 必须与 signals.mjs 的 RE_LINKED_DONE 保持同一锚定短句，避免把功能进度里的 done 当重置跟进。
  const value = String(text ?? '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  return /^(?:(?:it[’']s\s+|it is\s+)?done(?:\s+and\s+dusted)?[.!]?|(?:it[’']s|it is)\s+all\s+propagated[.!](?:\s+enjoy\s+some\s+mad\s+codexing\s+tomorrow[.!])?(?:\s+fun\s+week\s+ahead\s+too[.!])?)$/i.test(value);
}

function verifiedReplyContext(context) {
  return context?.verified === true && ['reply', 'quote'].includes(context.relation) &&
    Boolean(context.id && context.account && context.text && context.created_at);
}

/**
 * 正文出现后仍给关键的短到达回复一点时间，让详情页把会话祖先挂进 DOM。
 * 这里只等待证据，不按邻近时间或文字自行补造父帖。
 */
export async function waitForDetailProbe(readProbe, opts = {}) {
  const settleMs = Number(opts.settleMs ?? 400);
  const maxWaitMs = Number(opts.maxWaitMs ?? 12_000);
  const contextWaitMs = Number(opts.contextWaitMs ?? 1_600);
  const pause = opts.pause ?? sleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + maxWaitMs;
  let contextDeadline = null;
  let latest = null;

  while (now() < deadline) {
    await pause(settleMs);
    try {
      const probe = await readProbe();
      if (!probe?.dom) continue;

      const contextExpected = needsReplyContext(probe.dom);
      const exactNetworkContext = requiresExactNetworkContext(probe.dom);
      latest = {
        ...probe,
        needsReplyContext: contextExpected,
        requiresExactNetworkContext: exactNetworkContext,
        replyContextStatus: exactNetworkContext
          ? 'missing'
          : verifiedReplyContext(probe.inReplyTo) ? 'verified' : contextExpected ? 'missing' : 'not-required',
      };
      if ((!contextExpected && !exactNetworkContext) || (!exactNetworkContext && latest.replyContextStatus === 'verified')) return latest;

      contextDeadline ??= Math.min(deadline, now() + contextWaitMs);
      if (now() >= contextDeadline) return latest;
    } catch {
      /* 导航中求值会短暂失败，继续等 */
    }
  }
  return latest;
}

/** 仅暂存焦点推文详情查询的响应体，不保留请求 URL 或协议元数据。 */
function startTweetDetailNetworkCapture(cdp, sessionId, targetId) {
  const requests = new Map();
  const metadata = [];
  const tasks = [];
  let wakeMetadata = null;
  let nextMetadata = new Promise((resolve) => { wakeMetadata = resolve; });
  const previousHandler = cdp.onEvent;
  const handler = (event) => {
    if (event?.sessionId !== sessionId) return;
    if (event.method === 'Network.responseReceived') {
      const response = event.params?.response;
      if (!response || response.status !== 200) return;
      let operation = '';
      try {
        operation = new URL(response.url).pathname.match(/\/(TweetResultByRestId|TweetDetail)\/?$/)?.[1] ?? '';
      } catch { return; }
      if (operation) requests.set(event.params.requestId, operation);
      return;
    }
    if (event.method === 'Network.loadingFailed') {
      requests.delete(event.params?.requestId);
      return;
    }
    if (event.method !== 'Network.loadingFinished') return;
    const requestId = event.params?.requestId;
    if (!requests.has(requestId)) return;
    requests.delete(requestId);
    const task = (async () => {
      try {
        const response = await cdp.send('Network.getResponseBody', { requestId }, 2_500);
        const body = response.base64Encoded
          ? Buffer.from(response.body ?? '', 'base64').toString('utf8')
          : String(response.body ?? '');
        const extracted = extractTweetDetailMetadata(body, targetId);
        if (!extracted) return;
        metadata.push(extracted);
        const wake = wakeMetadata;
        nextMetadata = new Promise((resolve) => { wakeMetadata = resolve; });
        wake?.();
      } catch {
        // 单个详情 API 请求失败只丢弃该响应，DOM 结果仍可用。
      }
    })();
    tasks.push(task);
  };
  cdp.onEvent = handler;
  return {
    async waitForVerified(opts = {}) {
      const timeoutMs = Math.max(0, Number(opts.timeoutMs ?? 1_200));
      const end = Date.now() + timeoutMs;
      let checked = 0;
      while (true) {
        while (checked < metadata.length) {
          const candidate = metadata[checked++];
          const verified = verifyTweetDetailMetadata(candidate, {
            targetId,
            handle: opts.handle,
            domProbe: opts.domProbe,
            knownTweets: opts.knownTweets,
          });
          if (verified.verified) return { metadata: candidate, ...verified };
        }
        const remaining = end - Date.now();
        if (remaining <= 0) break;
        await Promise.race([nextMetadata, sleep(Math.min(remaining, 60))]);
      }
      while (checked < metadata.length) {
        const candidate = metadata[checked++];
        const verified = verifyTweetDetailMetadata(candidate, {
          targetId,
          handle: opts.handle,
          domProbe: opts.domProbe,
          knownTweets: opts.knownTweets,
        });
        if (verified.verified) return { metadata: candidate, ...verified };
      }
      return null;
    },
    async drain() {
      await Promise.allSettled(tasks);
    },
    restore() {
      if (cdp.onEvent === handler) cdp.onEvent = previousHandler;
      requests.clear();
    },
  };
}

/**
 * 在一个已连接的 CDP 会话里，逐条打开详情页取完整正文。
 *
 * 每条**单开一个 target 再关掉**，而不是复用同一个 tab 做导航：详情页是客户端
 * 路由，同一个 tab 再 `Page.navigate` 常常只换 SPA 视图、不重新渲染，
 * 于是取到的可能是**上一条**的正文 —— 会静默串号（不报错，只看长度也看不出来）。
 * 单开的代价实测约 1–2 秒/条。
 */
async function harvestFullTexts(cdp, ids, opts = {}) {
  const { handle, gapMs = 900, settleMs = 400, maxWaitMs = 12_000, contextWaitMs = 1_600, onProgress = null } = opts;
  const fullTexts = new Map();
  const tweetContexts = new Map();
  const scanned = [];
  const queue = [...ids];
  const queued = new Set(queue);
  let followed = 0;

  for (const id of queue) {
    const rec = { id, length: 0, showMore: false };
    const prevSession = cdp.sessionId;
    const prevHandler = cdp.onEvent;
    let targetId = null;
    let networkCapture = null;
    try {
      ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
      const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      cdp.sessionId = attached.sessionId;
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      try {
        await cdp.send('Network.enable');
        networkCapture = startTweetDetailNetworkCapture(cdp, attached.sessionId, id);
      } catch {
        // 详情网络不可用时仍保留 DOM 正文与其可见上下文。
      }
      await cdp.send('Page.navigate', { url: `https://x.com/${handle}/status/${id}` });

      // 正文与会话祖先不是同一时刻渲染；关键短回复要等到已核验上下文出现，
      // 或达到小的额外上限后显式报告缺失，不能把「正文已挂载」当成完整成功。
      let probe = await waitForDetailProbe(
        () => cdp.evalJs(detailProbeExpression(id, handle)),
        { settleMs, maxWaitMs, contextWaitMs },
      );
      if (!probe) throw new Error('详情页未渲染出正文');

      const exactNetworkContext = requiresExactNetworkContext(probe.dom);
      const networkResult = networkCapture
        ? await networkCapture.waitForVerified({
            timeoutMs: opts.networkWaitMs ?? 1_200,
            handle,
            domProbe: probe,
            knownTweets: opts.knownTweets,
          })
        : null;
      if (exactNetworkContext) {
        const parentRelationsAgree = Boolean(networkResult?.verified &&
          (networkResult.inReplyTo || networkResult.quotedTweet) &&
          (!probe.inReplyTo || (networkResult.inReplyTo && sameVerifiedContext(probe.inReplyTo, networkResult.inReplyTo))) &&
          (!probe.quotedTweet || (networkResult.quotedTweet && sameVerifiedContext(probe.quotedTweet, networkResult.quotedTweet))));
        // 这两类新锚句不能沿用 DOM 的相邻文章或引用卡关系；它们只认 API 父 ID。
        // 若可见 DOM 关系与 API 核验出来的 ID/作者/原文/时刻不一致，也整条拒绝。
        probe = {
          ...probe,
          inReplyTo: null,
          quotedTweet: null,
          replyContextStatus: 'missing',
        };
        if (parentRelationsAgree) {
          probe = {
            ...probe,
            ...(networkResult.inReplyTo ? { inReplyTo: networkResult.inReplyTo } : {}),
            ...(networkResult.quotedTweet ? { quotedTweet: networkResult.quotedTweet } : {}),
            replyContextStatus: 'verified',
          };
        }
        rec.networkMetadataStatus = parentRelationsAgree ? 'verified' : 'missing';
      } else if (networkResult) {
        rec.networkMetadataStatus = 'verified';
        // 网络关系用真实父 ID 核验；DOM 已有的关系只有在身份字段一致时才接受补全。
        probe = {
          ...probe,
          ...(networkResult.inReplyTo && sameVerifiedContext(probe.inReplyTo, networkResult.inReplyTo)
            ? { inReplyTo: { ...probe.inReplyTo, ...networkResult.inReplyTo } } : {}),
          ...(networkResult.quotedTweet && sameVerifiedContext(probe.quotedTweet, networkResult.quotedTweet)
            ? { quotedTweet: { ...probe.quotedTweet, ...networkResult.quotedTweet } } : {}),
        };
        if (probe.needsReplyContext &&
            (verifiedReplyContext(probe.inReplyTo) || verifiedReplyContext(probe.quotedTweet))) {
          probe.replyContextStatus = 'verified';
        }
      } else {
        rec.networkMetadataStatus = 'missing';
      }

      const text = String(probe.dom ?? '')
        .replace(/\s+/g, ' ')
        .trim();

      rec.length = text.length;
      rec.needsReplyContext = Boolean(probe.needsReplyContext);
      rec.replyContextStatus = probe.replyContextStatus ?? 'not-required';
      // 详情页**还**挂着展开入口 —— 正常应当是 false（详情页的意义就是完整渲染）。
      // 记下来是因为它一旦为 true，就说明这个页面的正文也不是全文，
      // 而那时只看长度是看不出来的（长度照样比时间线上那半句长）。
      rec.showMore = Boolean(probe.showMore);
      if (text) fullTexts.set(id, text);
      if (probe.inReplyTo || probe.quotedTweet) tweetContexts.set(id, {
        ...(probe.inReplyTo ? { inReplyTo: probe.inReplyTo } : {}),
        ...(probe.quotedTweet ? { quotedTweet: probe.quotedTweet } : {}),
      });
      const ref = probe.quotedTweet ?? probe.inReplyTo;
      if (ref && isFullTextContextCandidate(ref.text ?? '')) {
        const parentId = contextParentId(ref, opts.knownTweets);
        if (parentId && !queued.has(parentId) && followed < 4) {
          queued.add(parentId); queue.push(parentId); followed++;
        }
      }
    } catch (err) {
      rec.error = err.message;
    } finally {
      if (networkCapture) {
        await networkCapture.drain();
        networkCapture.restore();
      } else {
        cdp.onEvent = prevHandler;
      }
      if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      cdp.sessionId = prevSession;
    }
    scanned.push(rec);
    if (onProgress) onProgress(rec);
    if (gapMs) await sleep(gapMs); // 限流礼貌间隔
  }

  return { fullTexts, tweetContexts, scanned };
}

/**
 * 从各条流已收下的推文里挑出「疑似被截断」的候选（纯函数，单独抽出来是为了可测）。
 *
 * 判据是**两条取或**：
 *   1. 页面上还挂着「展开」入口（`truncatedIds`，DOM 硬判据）；
 *   2. 正文长度 ≥ `minLength`（长度启发式）——
 *      它兜住「入口没挂上、但正文确实被切在半句」的情形（渲染时机不同就会这样）。
 *
 * 两条流（原创 / `/with_replies`）收的是同一批帖子，所以必须**跨流去重**，
 * 否则同一条会被开两次详情页。
 *
 * 上游给了上限 `max`：全量回补一次可能翻出几十条长推文，逐条开详情页会把一轮
 * 采集从 1 分钟拉到 10 分钟以上。取舍写进 `skipped`，不静默 ——
 * 被截掉的不是「永远丢掉」（这些 id 下一轮已入库、通常不再进候选），
 * 而是「这一轮先不做」，所以它至少要在日志里露出一行。
 */
export function contextParentId(ref, tweets = []) {
  const matches = tweets.filter((t) => t.author_verified === true &&
    String(t.account).toLowerCase() === String(ref.account).toLowerCase() &&
    t.created_at === ref.created_at && String(t.text).replace(/\s+/g, ' ').trim() === ref.text);
  return matches.length === 1 ? matches[0].id : null;
}

function isFullTextContextCandidate(text) {
  const shortText = identityText(text);
  return /^(?:landing\s+within)\b/i.test(text) || isLinkedCompletionText(text) ||
    /\breset\s+day\b/i.test(text) ||
    /\b(?:land|lands|landing)\b[\s\S]{0,100}\b(?:today|tomorrow|before|by)\b/i.test(text) ||
    /^by\s+(?:midnight|noon|\d{1,2}(?::\d{2})?(?:\s*[ap]m)?)\s*(?:PST|PDT|PT|UTC(?:[+-]\d{1,2})?)?[.!]?$/i.test(shortText);
}

export function pickFullTextCandidates(streams, opts = {}) {
  const minLength = Number(opts.minLength ?? TRUNCATED_MIN_LENGTH);
  const max = Number(opts.max ?? 12);
  const candidates = [];
  const seen = new Set();
  const prioritized = new Set();

  for (const s of streams ?? []) {
    const flagged = new Set(s?.truncatedIds ?? []);
    for (const t of s?.tweets ?? []) {
      if (!t?.id) continue;
      const text = String(t.text ?? '');
      const needsContext = isFullTextContextCandidate(text);
      if (!flagged.has(t.id) && text.length < minLength && !needsContext) continue;
      if (seen.has(t.id)) {
        if (needsContext) prioritized.add(t.id);
        continue;
      }
      seen.add(t.id);
      candidates.push(t.id);
      if (needsContext) prioritized.add(t.id);
    }
  }

  const ordered = [
    ...candidates.filter((id) => prioritized.has(id)),
    ...candidates.filter((id) => !prioritized.has(id)),
  ];
  return { candidates: ordered, picked: ordered.slice(0, max), skipped: Math.max(0, ordered.length - max) };
}

export function makeFullTextReport(candidates, fetched, skipped, scanned = []) {
  return {
    candidates,
    attempted: scanned.length,
    fetched,
    // 被上限截掉的条数。非 0 就意味着「有长推文这轮没补全」，要看得见。
    skipped,
    // 短承诺即使全文已取到，也可能缺少详情页里的自我回复祖先；单独列出供采集留档排查。
    missingReplyContext: scanned.filter((item) => item.replyContextStatus === 'missing').map((item) => item.id),
    scanned,
  };
}

/**
 * 从各条流已收下的推文里挑出候选并去详情页取全文。
 *
 * 上游给了上限 `max`，理由与取法见 `pickFullTextCandidates`。
 */
async function collectFullTexts(cdp, streams, opts) {
  const { handle, minLength, max, gapMs, onProgress, knownTweets = [] } = opts;
  const { candidates, picked, skipped } = pickFullTextCandidates(streams, { minLength, max });

  if (!picked.length) {
    return {
      fullTexts: new Map(),
      tweetContexts: new Map(),
      report: makeFullTextReport(0, 0, 0),
    };
  }

  const pool = new Map(knownTweets.map((t) => [t.id, t]));
  for (const s of streams ?? []) for (const t of s?.tweets ?? []) pool.set(t.id, { ...t, account: handle });
  const { fullTexts, tweetContexts, scanned } = await harvestFullTexts(cdp, picked, { handle, gapMs, onProgress, knownTweets: [...pool.values()] });
  return {
    fullTexts,
    tweetContexts,
    report: makeFullTextReport(candidates.length, fullTexts.size, skipped, scanned),
  };
}

/**
 * 独立入口：给定一批推文 id，开一次浏览器把完整正文取回来。
 *
 * 与 `collectStreams` 内那条通道的区别只是「要不要顺带收时间线」——
 * 手工补数据、跑探针时用它，不必为此伪造一次采集。
 */
export async function fetchTweetFullTexts(ids, opts = {}) {
  const list = [...new Set((ids ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))];
  if (!list.length) return { fullTexts: new Map(), scanned: [] };

  const handle = opts.handle ?? process.env.SOURCE_ACCOUNT ?? 'thsottiaux';
  const { ver, close } = await withBrowser({ port: opts.port ?? CDP_PORT, proxy: opts.proxy ?? PROXY });
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
  });
  const cdp = new CdpSession(ws);
  try {
    return await harvestFullTexts(cdp, list, { ...opts, handle });
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    await close();
  }
}
