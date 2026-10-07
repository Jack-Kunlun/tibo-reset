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
    if (!id || !created || Number.isNaN(created.getTime())) continue;
    if (sinceMs > 0 && created.getTime() < sinceMs) continue;
    if (seen.has(id)) continue;
    seen.set(id, {
      id,
      text,
      created_at: created.toISOString(),
      url: it.url ?? `https://x.com/${opts.handle ?? ''}/status/${id}`,
      // 被回复的内容由上游的 pairReplyContext 在收割时挂上，这里只负责透传。
      // 丢了它，识别算法就只能看到他的半句话。
      ...(it.inReplyTo ? { inReplyTo: it.inReplyTo } : {}),
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
 * 归属仍以 `id` 为准：只有 article 内含 `/<handle>/status/<id>` 链接时才赋值，
 * 所以 `id` 非空 ⟺ 这条是他的。转发别人的推文拿不到 id，混进来会让增量永不停止。
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
    var tm=a.querySelector('time');
    var id='',url='';
    a.querySelectorAll('a[href*="/status/"]').forEach(function(l){
      if(id)return;
      var href=l.getAttribute('href')||'';
      var m=href.match(/^\\/([^\\/]+)\\/status\\/(\\d+)/);
      if(m&&m[1].toLowerCase()===H){id=m[2];url='https://x.com'+href;}
    });
    var author='';
    var un=a.querySelector('[data-testid="User-Name"]');
    if(un){var m2=(un.innerText||'').match(/@([A-Za-z0-9_]+)/);if(m2)author=m2[1];}
    var more=!!a.querySelector('[data-testid="tweet-text-show-more-link"]');
    out.push({id:id,url:url,time:tm?tm.getAttribute('datetime'):'',text:t?t.innerText.replace(/\\s+/g,' '):'',author:author,truncated:more,poll:pollOf(a)});
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
 * 所以往前找最近一条**不属于他**且有内容的条目。
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
  let lastOther = null;

  for (const raw of items ?? []) {
    const it = { ...raw };
    const author = String(it.author ?? '').toLowerCase();
    const isMine = !!it.id; // harvest 只在作者匹配时给 id
    const isOther = !isMine && !!author && author !== h && !!it.text && !!it.time;

    if (isMine) {
      // 自我回复（上一条也是他的）时不更新 lastOther，继续往前找真正被回复的那条
      if (lastOther && String(lastOther.time) < String(it.time)) {
        it.inReplyTo = {
          account: lastOther.author,
          id: lastOther.id ?? null,
          text: lastOther.text,
          created_at: lastOther.time,
          url: lastOther.url ?? null,
        };
      } else {
        it.inReplyTo = null;
      }
    } else {
      it.inReplyTo = null;
      if (isOther) lastOther = it;
    }
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

    const { fullTexts, report: fullTextReport } = fetchFullText
      ? await collectFullTexts(cdp, streams, {
          handle,
          minLength: fullTextMinLength,
          max: fullTextMax,
          gapMs: fullTextGapMs,
          onProgress: onFullTextProgress,
        })
      : { fullTexts: new Map(), report: null };

    return { streams, errors, fullTexts, fullTextReport };
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
          const truncated = Boolean(prev.truncated || it.truncated);
          if (inReplyTo !== prev.inReplyTo || truncated !== prev.truncated) {
            harvested.set(it.id, { ...prev, inReplyTo, truncated });
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
 * 为什么只走 DOM、不去翻 RSC payload：payload 那一路**实现过又删掉了**。
 * 实测（2026-09-29）详情页的 `document.documentElement.outerHTML` 里
 * `client:` / `full_text` / base64 键**一个都不出现** —— 详情页是纯客户端渲染，
 * payload 不在序列化出来的 DOM 里。留着一路恒为 0 的「备份」不是安全网，
 * 是虚假的信心：真正的失效（DOM 选择器变了）它一样兜不住，还会让报告里
 * 多出一个永远为 0 的数字。真需要结构化数据时正确的路是 CDP 的
 * `Network.getResponseBody` 去接 TweetDetail 的响应，不是猜 DOM 里有没有 payload。
 *
 * 已知边界：实测最长的一条（1917 字符）在详情页完整渲染、无折叠；
 * 极端长的「Long Post」是否仍会折叠，等真遇到再处理（`showMore` 会在报告里露出来）。
 */
export function detailProbeExpression(id) {
  const idLit = JSON.stringify(String(id ?? ''));
  return `(function(){var ID=${idLit};
    var out={url:location.href,dom:'',showMore:false};
    var arts=document.querySelectorAll('article');
    for(var i=0;i<arts.length;i++){
      var a=arts[i],hit=false;
      a.querySelectorAll('a[href*="/status/"]').forEach(function(l){
        var h=l.getAttribute('href')||'';
        if(h.indexOf('/status/'+ID)>=0)hit=true;
      });
      if(!hit)continue;
      var t=a.querySelector('[data-testid="tweetText"]');
      if(t)out.dom=(t.innerText||'').replace(/\\s+/g,' ').trim();
      out.showMore=!!a.querySelector('[data-testid="tweet-text-show-more-link"]');
      break;
    }
    return out;})()`;
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
  const { handle, gapMs = 900, settleMs = 400, maxWaitMs = 12_000, onProgress = null } = opts;
  const fullTexts = new Map();
  const scanned = [];

  for (const id of ids) {
    const rec = { id, length: 0, showMore: false };
    const prevSession = cdp.sessionId;
    let targetId = null;
    try {
      ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
      const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      cdp.sessionId = attached.sessionId;
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Page.navigate', { url: `https://x.com/${handle}/status/${id}` });

      // 轮询而不是等 Page.loadEventFired：正文是客户端渲染的，load 之后还要一会儿才挂上来，
      // 而导航中途求值会抛「执行上下文被销毁」——两种情况都用同一个循环兜住。
      let probe = null;
      const deadline = Date.now() + maxWaitMs;
      while (Date.now() < deadline) {
        await sleep(settleMs);
        try {
          const p = await cdp.evalJs(detailProbeExpression(id));
          if (p?.dom) {
            probe = p;
            break;
          }
        } catch {
          /* 导航中求值会短暂失败，继续等 */
        }
      }
      if (!probe) throw new Error('详情页未渲染出正文');

      const text = String(probe.dom ?? '')
        .replace(/\s+/g, ' ')
        .trim();

      rec.length = text.length;
      // 详情页**还**挂着展开入口 —— 正常应当是 false（详情页的意义就是完整渲染）。
      // 记下来是因为它一旦为 true，就说明这个页面的正文也不是全文，
      // 而那时只看长度是看不出来的（长度照样比时间线上那半句长）。
      rec.showMore = Boolean(probe.showMore);
      if (text) fullTexts.set(id, text);
    } catch (err) {
      rec.error = err.message;
    } finally {
      if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      cdp.sessionId = prevSession;
    }
    scanned.push(rec);
    if (onProgress) onProgress(rec);
    if (gapMs) await sleep(gapMs); // 限流礼貌间隔
  }

  return { fullTexts, scanned };
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
export function pickFullTextCandidates(streams, opts = {}) {
  const minLength = Number(opts.minLength ?? TRUNCATED_MIN_LENGTH);
  const max = Number(opts.max ?? 12);
  const candidates = [];
  const seen = new Set();

  for (const s of streams ?? []) {
    const flagged = new Set(s?.truncatedIds ?? []);
    for (const t of s?.tweets ?? []) {
      if (!t?.id || seen.has(t.id)) continue;
      if (!flagged.has(t.id) && String(t.text ?? '').length < minLength) continue;
      seen.add(t.id);
      candidates.push(t.id);
    }
  }

  return { candidates, picked: candidates.slice(0, max), skipped: Math.max(0, candidates.length - max) };
}

/**
 * 从各条流已收下的推文里挑出候选并去详情页取全文。
 *
 * 上游给了上限 `max`，理由与取法见 `pickFullTextCandidates`。
 */
async function collectFullTexts(cdp, streams, opts) {
  const { handle, minLength, max, gapMs, onProgress } = opts;
  const { candidates, picked, skipped } = pickFullTextCandidates(streams, { minLength, max });

  if (!picked.length) {
    return {
      fullTexts: new Map(),
      report: { candidates: 0, attempted: 0, fetched: 0, skipped: 0, scanned: [] },
    };
  }

  const { fullTexts, scanned } = await harvestFullTexts(cdp, picked, { handle, gapMs, onProgress });
  return {
    fullTexts,
    report: {
      candidates: candidates.length,
      attempted: picked.length,
      fetched: fullTexts.size,
      // 被上限截掉的条数。非 0 就意味着「有长推文这轮没补全」，要看得见。
      skipped,
      scanned,
    },
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
