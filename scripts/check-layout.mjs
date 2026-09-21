#!/usr/bin/env node
/**
 * 验收 A7：窄屏（≤500px）无横向溢出。
 *
 * 为什么不能只用 `--window-size`：无头 Chrome 有最小窗口宽度（实测约 485px），
 * 给 `--window-size=320,800` 它也只按 ~485px 排版 —— 量出来的是假象，不是 320px 的真相。
 * 这里改用 **iframe 固定宽度**：iframe 的视口宽度就等于它的 CSS 宽度，
 * 媒体查询按真实窄屏生效，量到的 scrollWidth 才有意义。
 *
 * 判据只有一条：`scrollWidth <= clientWidth`。溢出 1px 也算失败 ——
 * 手机上的横向滚动条就是这么来的。
 *
 * 用法：node scripts/check-layout.mjs [--json]
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

/** 目标宽度：覆盖到常见最窄机型（320）到平板竖屏 */
const WIDTHS = [320, 360, 375, 390, 414, 500, 768];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const PROBE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>probe</title></head>
<body style="margin:0">
<div id="host"></div><pre id="result">pending</pre>
<script>
var WIDTHS = ${JSON.stringify(WIDTHS)};
var host = document.getElementById('host');
var frames = WIDTHS.map(function (w) {
  var f = document.createElement('iframe');
  f.style.cssText = 'width:' + w + 'px;height:1000px;border:0;display:block';
  f.setAttribute('data-w', String(w));
  f.src = '/index.html';
  host.appendChild(f);
  return f;
});
Promise.all(frames.map(function (f) {
  return new Promise(function (r) { f.onload = r; f.onerror = r; });
})).then(function () {
  // 留一帧给媒体查询与内联 SVG 完成布局
  setTimeout(function () {
    var out = frames.map(function (f) {
      var d = f.contentDocument;
      var de = d.documentElement;
      // 找出真正溢出的那个元素，方便定位（比只报一个差值有用得多）
      var worst = null;
      // 内部横向滚动：只有当元素自身是 overflow-x:auto|scroll 且内容更宽时才算 ——
      // 否则 .reel 这类 overflow:hidden 的容器会误报成「可滚动」。
      var inner = [];
      var nodes = d.querySelectorAll('body *');
      for (var i = 0; i < nodes.length; i++) {
        var r = nodes[i].getBoundingClientRect();
        var over = r.right - de.clientWidth;
        if (over > 1 && (!worst || over > worst.over)) {
          worst = {
            over: Math.round(over),
            tag: nodes[i].tagName.toLowerCase(),
            cls: String(nodes[i].className || '').slice(0, 40),
          };
        }
        var ox = getComputedStyle(nodes[i]).overflowX;
        if (ox !== 'auto' && ox !== 'scroll') continue;
        var scrollable = nodes[i].scrollWidth - nodes[i].clientWidth;
        if (scrollable > 1) {
          inner.push({
            over: Math.round(scrollable),
            tag: nodes[i].tagName.toLowerCase(),
            cls: String(nodes[i].className || '').slice(0, 40),
          });
        }
      }
      return {
        w: Number(f.getAttribute('data-w')),
        scrollW: de.scrollWidth,
        clientW: de.clientWidth,
        bodyScrollW: d.body.scrollWidth,
        worst: worst,
        inner: inner,
      };
    });
    document.getElementById('result').textContent = JSON.stringify(out);
  }, 300);
});
</script></body></html>`;

/* ------------------------------ 本地静态服务 ------------------------------ */

function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/__probe.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PROBE);
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = resolve(DIST, rel);
    if (!file.startsWith(DIST)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port }));
  });
}

/* ------------------------------ 跑 Chrome ------------------------------ */

function chromePath() {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* 忽略非法路径 */
    }
  }
  return null;
}

/** Chrome 单次运行的最长等待（毫秒）。macOS + Chrome 153 上 `--dump-dom` 输出完 DOM 也不会自行退出，超时是必备兜底。 */
const DUMP_TIMEOUT_MS = Number(process.env.DUMP_TIMEOUT_MS) > 0 ? Number(process.env.DUMP_TIMEOUT_MS) : 60_000;

async function dumpDom(url, profileDir) {
  const bin = chromePath();
  if (!bin) throw new Error('找不到 Chrome / Chromium。可用 CHROME_PATH 指定路径。');

  const args = [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    '--disable-background-networking',
    '--virtual-time-budget=15000',
    '--user-data-dir=' + profileDir,
    '--dump-dom',
    url,
  ];

  return new Promise((ok, bad) => {
    // detached：让 Chrome 自成一个进程组，收尾时可以整组击杀，不留孤儿渲染进程。
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let err = '';
    let settled = false;

    const killTree = () => {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {
        try {
          p.kill('SIGKILL');
        } catch {
          /* 进程已消失 */
        }
      }
    };

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree();
      fn(arg);
    };

    const timer = setTimeout(
      () => finish(bad, new Error(`Chrome ${DUMP_TIMEOUT_MS}ms 内未产出完整 DOM：${err.slice(-300) || '(无 stderr)'}`)),
      DUMP_TIMEOUT_MS
    );

    p.stdout.on('data', (b) => {
      out += b.toString();
      // 关键：不能在 exit 事件上判定结束 —— 新版 headless 的 `--dump-dom` 输出完 DOM 后
      // 主进程不会退出，等 exit 就是死等。收尾标签 `</html>` 是输出的最后一段，见到即完成。
      if (out.includes('</html>')) finish(ok, out);
    });
    p.stderr.on('data', (b) => (err += b.toString()));
    p.on('error', (e) => finish(bad, e));
    p.on('exit', (code) => finish(bad, new Error(`Chrome 提前退出（码 ${code}）：${err.slice(-300)}`)));
  });
}

/* ------------------------------ 主流程 ------------------------------ */

const { server, port } = await startServer();
const profileDir = await mkdtemp(join(tmpdir(), 'tibo-chrome-'));

let results = null;
let error = null;
try {
  const dom = await dumpDom(`http://127.0.0.1:${port}/__probe.html`, profileDir);
  const m = dom.match(/<pre id="result">([\s\S]*?)<\/pre>/);
  if (!m) throw new Error('探针页没有回填结果（页面可能没跑起来）');
  const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  results = JSON.parse(raw);
} catch (e) {
  error = e.message;
} finally {
  server.close();
  await rm(profileDir, { recursive: true, force: true });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(results ?? { error }, null, 2));
  process.exit(error ? 1 : 0);
}

if (error) {
  console.error(`✗ A7 无法执行：${error}`);
  process.exit(1);
}

console.log('【A7】窄屏横向溢出（iframe 固定视口宽度）\n');
let bad = 0;
for (const r of results) {
  const over = r.scrollW - r.clientW;
  const ok = over <= 0;
  if (!ok) bad++;
  console.log(
    `  ${ok ? '✓' : '✗'} ${String(r.w).padStart(3)}px  视口 ${r.clientW} · 滚动宽 ${r.scrollW}` +
      (ok ? '' : `  溢出 ${over}px` + (r.worst ? ` · 最宽元素 <${r.worst.tag} class="${r.worst.cls}">` : ''))
  );
}

// 面板内部横向滚动：不是失败项（页面本身不溢出），但要如实报出来，
// 否则「7 个宽度全 ✓」会掩盖「窄屏下图表需要自己横向滚」这个真实行为。
const innerAgg = new Map();
for (const r of results) {
  for (const it of r.inner ?? []) {
    const key = `${it.tag}.${it.cls}`;
    const cur = innerAgg.get(key) ?? { tag: it.tag, cls: it.cls, over: 0, perWidth: new Map() };
    cur.over = Math.max(cur.over, it.over);
    cur.perWidth.set(r.w, (cur.perWidth.get(r.w) ?? 0) + 1);
    innerAgg.set(key, cur);
  }
}

console.log(`\n${'─'.repeat(52)}`);
if (bad) {
  console.log(`✗ ${bad} / ${results.length} 个宽度存在横向溢出`);
  process.exit(1);
}
console.log(`✓ ${results.length} 个宽度页面级均无横向溢出（scrollWidth ≤ clientWidth）`);

if (innerAgg.size) {
  console.log('\n注：以下容器在窄屏下**内部**横向滚动（页面本身不溢出，属既定设计取舍）：');
  for (const it of innerAgg.values()) {
    const n = Math.max(...it.perWidth.values());
    const ws = [...it.perWidth.keys()].sort((a, b) => a - b);
    console.log(`  · <${it.tag} class="${it.cls}"> ×${n} 处  最大超出 ${it.over}px  触发宽度 ${ws.join(', ')}px`);
  }
}

