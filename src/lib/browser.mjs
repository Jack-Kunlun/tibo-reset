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

/** 页面里跑：把当前已在 DOM 里的推文收下来。 */
export function harvestExpression(handle) {
  const h = JSON.stringify(String(handle ?? '').toLowerCase());
  return `(function(){var H=${h};var out=[];document.querySelectorAll('article').forEach(function(a){
    var t=a.querySelector('[data-testid="tweetText"]');
    var tm=a.querySelector('time');
    var id='',url='';
    a.querySelectorAll('a[href*="/status/"]').forEach(function(l){
      if(id)return;
      var href=l.getAttribute('href')||'';
      var m=href.match(/^\\/([^\\/]+)\\/status\\/(\\d+)/);
      if(m&&m[1].toLowerCase()===H){id=m[2];url='https://x.com'+href;}
    });
    out.push({id:id,url:url,time:tm?tm.getAttribute('datetime'):'',text:t?t.innerText.replace(/\\s+/g,' '):''});
  });return out;})()`;
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
 * @param {{handle:string, sinceMs?:number, knownIds?:Iterable<string>|null,
 *          knownScreensToStop?:number, maxSteps?:number, port?:number,
 *          proxy?:string, settleMs?:number, stepRatio?:number,
 *          onProgress?:Function}} opts
 * @returns {Promise<{tweets:Array, loggedIn:boolean, steps:number,
 *          oldest:string|null, mode:'incremental'|'full', stoppedBy:string}>}
 */
export async function collectTimeline(opts) {
  const {
    handle,
    sinceMs = 0,
    knownIds = null,
    knownScreensToStop = 2,
    maxSteps = 60,
    port = CDP_PORT,
    proxy = PROXY,
    settleMs = 800,
    stepRatio = 0.85,
    onProgress = null,
  } = opts ?? {};
  if (!handle) throw new Error('缺少 handle');

  const known = knownIds instanceof Set ? knownIds : new Set(knownIds ?? []);
  const incremental = known.size > 0;

  const { ver, close } = await withBrowser({ port, proxy });
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
  });

  const cdp = new CdpSession(ws);
  const harvested = new Map();
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.sessionId = attached.sessionId;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    let loaded = false;
    cdp.onEvent = (m) => {
      if (m.method === 'Page.loadEventFired') loaded = true;
    };
    await cdp.send('Page.navigate', { url: `https://x.com/${handle}` });
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

    for (let step = 1; step <= maxSteps; step++) {
      const batch = await cdp.evalJs(harvestExpression(handle));
      let fresh = 0;
      for (const it of batch ?? []) {
        if (it.id && !harvested.has(it.id)) {
          harvested.set(it.id, it);
          fresh++;
        }
      }
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

    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});

    const tweets = normalizeTimelineItems([...harvested.values()], { handle, sinceMs });
    return {
      tweets,
      loggedIn: !!state.loggedIn,
      steps,
      oldest: tweets.length ? tweets[tweets.length - 1].created_at : null,
      mode: incremental ? 'incremental' : 'full',
      stoppedBy,
    };
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    await close();
  }
}
