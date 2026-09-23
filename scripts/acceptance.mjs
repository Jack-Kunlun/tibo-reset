#!/usr/bin/env node
/**
 * 验收 A1–A10 编排器（PRD 第七节）。
 *
 * 分两类跑：
 *   · **直接判定**（A1 / A2 / A6 / A7 / A8 / A10）—— 本脚本自己做，判定命令与实测值都记录下来
 *   · **复用已有套件**（A3 / A4 / A5 / A9）—— 那些断言已在各自脚本里，这里只负责跑一遍并取结果，
 *     不重复实现（重复实现意味着两处会各自漂移）
 *
 * A10 只能**部分**自动化：能自动验的是「卡片文件存在、尺寸正确、meta 齐备且是绝对地址」；
 * 「分享到微信里真的展开出预览」必须人工做一次。本脚本会在结论里明确标出来，不假装验过。
 *
 * 用法：
 *   node scripts/acceptance.mjs           # 跑一遍，打印结果
 *   node scripts/acceptance.mjs --write   # 顺带把结果写成 docs/acceptance.md
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const WRITE = process.argv.includes('--write');

/** 固定构建时刻：A8 要比较两次构建的字节，锚点必须一致 */
const FIXED_NOW = '2026-09-21T02:00:00.000Z';

const rows = [];
function record(id, name, ok, how, detail) {
  rows.push({ id, name, ok, how, detail });
  console.log(`  ${ok === true ? '✓' : ok === 'manual' ? '·' : '✗'} ${id} ${name}${detail ? ' — ' + detail : ''}`);
}

/* ------------------------------ 工具 ------------------------------ */

function run(cmd, args, opts = {}) {
  return new Promise((ok) => {
    const p = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (b) => (out += b.toString()));
    p.stderr.on('data', (b) => (err += b.toString()));
    p.on('error', (e) => ok({ code: -1, out, err: err + e.message }));
    p.on('exit', (code) => ok({ code, out, err }));
  });
}

/** 跑一个已有测试套件，取它的结论行 */
async function suite(label, script) {
  const r = await run(NODE, [join('scripts', script)]);
  const last = r.out.trim().split('\n').filter(Boolean).pop() ?? '(无输出)';
  return { ok: r.code === 0, last };
}

/* ------------------------------ 前置：重建 ------------------------------ */

// 验收必须读**本次**构建的产物。否则 dist 是上一次留下的，报出来的 ✓ 说的是旧页面。
// SITE_URL 是硬门禁：A10 要求 og:image / og:url 是绝对地址，
// 不知道公开域名就无法判定这一项，降级成「跳过」等于把失败伪装成通过。
const SITE_URL = (process.env.SITE_URL ?? '').trim().replace(/\/+$/, '');

if (!SITE_URL) {
  console.error('✗ 缺少 SITE_URL：A10 需要它才能判定 og:image / og:url 是绝对地址。');
  console.error('  用法：SITE_URL=https://你的域名 node scripts/acceptance.mjs --write');
  process.exit(2);
}

console.log(`\n【前置】以 SITE_URL=${SITE_URL} 重建 dist`);

// 报告里**不回显真实站点地址**：docs/acceptance.md 会进公开仓库（见 AGENTS.md 的文案红线）。
// 记录要说清的是「当天给了 SITE_URL、并用它重建了 dist」，不是域名本身 —— 而域名一旦
// 落进报告，下一次 `--write` 就会把它再提交上去。终端里照旧打印真值（本机可见）。
const SITE_URL_IN_REPORT = 'https://<你的域名>';
{
  const r = await run(NODE, ['scripts/build.mjs'], { env: { SITE_URL } });
  if (r.code !== 0) {
    console.error('✗ 构建失败，验收中止：');
    console.error((r.err || r.out).slice(-1200));
    process.exit(2);
  }
  const warn = (r.err || '').split('\n').filter((l) => l.includes('⚠'));
  console.log(`  ✓ 构建完成（${(r.out || '').split('\n').filter(Boolean).slice(-1)[0] ?? 'ok'}）`);
  for (const w of warn) console.log(`  ${w.trim()}`);
}

/** 造一个可构建的仓库副本（node_modules 用软链，省时间也省磁盘） */
function makeSandbox() {
  const dst = mkdtempSync(join(tmpdir(), 'tibo-accept-'));
  cpSync(ROOT, dst, {
    recursive: true,
    filter: (src) => !/[/\\](node_modules|dist|\.git)([/\\]|$)/.test(src),
  });
  symlinkSync(join(ROOT, 'node_modules'), join(dst, 'node_modules'), 'dir');
  return dst;
}

const writeFileSyncSafe = (p, s) => writeFileSync(p, s, 'utf8');

/**
 * 从 stderr 里取真正的错误信息。
 *
 * Node 抛未捕获异常时会**先打印一行源码**（那行里含模板字面量 `${token}`），
 * 再打印 `Error: …`。直接对整段 stderr 做正则，抓到的是源码行 ——
 * 报告里就会出现 `${leftover.join(', ')}` 这种看着像坏掉的内容。
 */
function errorLine(stderr, re) {
  const lines = stderr
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const hit = lines.find((l) => l.startsWith('Error:') && re.test(l)) ?? lines.find((l) => re.test(l));
  return hit ? hit.replace(/^Error:\s*/, '') : stderr.trim().slice(-120);
}

const stripScripts = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

/* ============================== A1 ============================== */

console.log('\n【A1】无脚本环境首屏完整');

const html = await readFile(resolve(ROOT, 'dist/index.html'), 'utf8');
const noJs = stripScripts(html);

{
  const need = [
    ['生存曲线 SVG', /<svg id="survival"[^>]*width="\d+"[^>]*height="\d+"/],
    ['点阵分布 SVG', /<svg id="strip"[^>]*width="\d+"[^>]*height="\d+"/],
    ['滚动数字容器', /class="reel"/],
    ['判定文案', /class="verdict v-(calm|watch|long|rare)"/],
    ['预测区块', /中位剩余等待/],
    ['回测区块', /样本外回测/],
    ['节奏分段', /节奏在加速/],
    ['最近记录', /最近记录/],
    ['数据更新时间', /id="gen"/],
  ];
  const missing = need.filter(([, re]) => !re.test(noJs)).map(([n]) => n);
  record(
    'A1',
    '剥离 <script> 后内容不缺',
    missing.length === 0,
    '剥离所有 <script> 与注释后逐项断言关键区块',
    missing.length ? `缺：${missing.join('、')}` : `${need.length} 个区块全在`
  );
}

/* ============================== A2 ============================== */

console.log('\n【A2】数字可渲染性');

{
  const tokens = ['NaN', 'undefined', 'Infinity'].filter((t) => noJs.includes(t));
  record(
    'A2',
    '页面无 NaN / undefined / Infinity',
    tokens.length === 0,
    '在剥离脚本后的 HTML 上搜三个坏值标记',
    tokens.length ? `出现：${tokens.join('、')}` : '未出现'
  );
}

/* ============================== A4 / A5（信号） ============================== */

console.log('\n【A4 / A5】信号识别（复用信号套件）');

const sig = await suite('signals', 'test-signals.mjs');
record('A4', '信号误报为 0（真实推文回归）', sig.ok, 'node scripts/test-signals.mjs', sig.last);
record('A5', '明确信号双解读 + 双时区', sig.ok, '同上（含 next Tuesday / tomorrow / in 2 hours / 绝对日期用例）', sig.last);

/* ============================== A9（小程序图元） ============================== */

console.log('\n【A9】小程序图元与渲染');

const mp = await suite('miniprogram', 'test-miniprogram.mjs');
record('A9', '图元不越界、文字不小于可读下限', mp.ok, 'node scripts/test-miniprogram.mjs', mp.last);

/* ============================== A3（一致性） ============================== */

console.log('\n【A3】页面数字 ↔ API');

const cons = await suite('consistency', 'check-consistency.mjs');
record('A3', '页面内联数字与 API 返回一致', cons.ok, 'node scripts/check-consistency.mjs', cons.last);

/* ============================== A6（构建期报错） ============================== */

console.log('\n【A6】占位符缺失时构建报错');

{
  const sandbox = makeSandbox();
  let okA = false;
  let okB = false;
  let msgA = '';
  let msgB = '';
  try {
    // 情况一：删掉一个必需的占位符 → 必须明说缺哪一个
    const tplPath = join(sandbox, 'src/index.html');
    const tpl = readFileSync(tplPath, 'utf8');
    writeFileSyncSafe(tplPath, tpl.replace('<!--__SIGNAL__-->', ''));
    const r1 = await run(NODE, ['scripts/build.mjs'], { cwd: sandbox });
    okA = r1.code !== 0 && /模板缺少占位符\s*<!--__SIGNAL__-->/.test(r1.err);
    msgA = errorLine(r1.err, /模板缺少占位符/);

    // 情况二：模板里留一个没人负责的占位符 → 兜底校验必须拦下它。
    // 注意要保持 SIGNAL 在位，否则会先撞上「缺占位符」那条，测不到这条。
    writeFileSyncSafe(tplPath, tpl + '\n<!--__NOPE__-->\n');
    const r2 = await run(NODE, ['scripts/build.mjs'], { cwd: sandbox });
    okB = r2.code !== 0 && /未替换的占位符/.test(r2.err);
    msgB = errorLine(r2.err, /未替换的占位符/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
  record(
    'A6',
    '占位符缺失 / 残留时构建失败（不静默产出空白页）',
    okA && okB,
    '在仓库副本里破坏模板后跑 npm run build，断言非零退出',
    okA && okB ? `${msgA} ｜ ${msgB}` : `缺占位符：${okA ? '通过' : msgA}；残留占位符：${okB ? '通过' : msgB}`
  );
}

/* ============================== A8（时区无关） ============================== */

console.log('\n【A8】时间显示不随机器时区变化');

{
  const sandbox = makeSandbox();
  let ok = false;
  let detail = '';
  try {
    const env = { BUILD_NOW: FIXED_NOW, SITE_URL: 'https://tibo.example.com' };
    const z1 = await run(NODE, ['scripts/build.mjs'], { cwd: sandbox, env: { ...env, TZ: 'Asia/Shanghai' } });
    const a = readFileSync(join(sandbox, 'dist/index.html'), 'utf8');
    const z2 = await run(NODE, ['scripts/build.mjs'], { cwd: sandbox, env: { ...env, TZ: 'UTC' } });
    const b = readFileSync(join(sandbox, 'dist/index.html'), 'utf8');
    const z3 = await run(NODE, ['scripts/build.mjs'], { cwd: sandbox, env: { ...env, TZ: 'America/New_York' } });
    const c = readFileSync(join(sandbox, 'dist/index.html'), 'utf8');

    const built = z1.code === 0 && z2.code === 0 && z3.code === 0;
    ok = built && a === b && a === c;
    const shown = (a.match(/id="gen">([^<]*)</) ?? [, '?'])[1];
    detail = built
      ? `Shanghai / UTC / New_York 三次构建${a === b && a === c ? '字节完全一致' : '存在差异'} · 页面时间为 ${shown}（北京时间）`
      : `构建失败：${(z1.err || z2.err || z3.err).slice(-120)}`;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
  record('A8', '时间显示与机器时区无关', ok, '同一 BUILD_NOW 下用三个 TZ 各构建一次并逐字节比较', detail);
}

/* ============================== A7（窄屏） ============================== */

console.log('\n【A7】窄屏无横向溢出');

{
  const r = await run(NODE, ['scripts/check-layout.mjs']);
  const lines = r.out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  // 取真正的结论行。不能直接取末行 —— 末行是「内部横向滚动」那条注解。
  const summary = lines.find((l) => /个宽度页面级均无横向溢出/.test(l)) ?? lines.slice(-1)[0] ?? '(无输出)';
  const hasInner = lines.some((l) => l.startsWith('注：') && l.includes('内部'));
  const detail = summary + (hasInner && /✓/.test(summary) ? ' ｜ 注：图表容器在窄屏下为内部横向滚动（页面本身不溢出，属既定取舍）' : '');
  record('A7', '≤500px 无横向溢出', r.code === 0, 'node scripts/check-layout.mjs（无头 Chrome + iframe 定宽）', detail);
}

/* ============================== A10（分享卡片） ============================== */

console.log('\n【A10】分享卡片');

{
  const checks = [];
  const img = resolve(ROOT, 'dist/og-image.png');
  const meta = {
    'og:title': /property="og:title" content="[^"]+"/,
    'og:description': /property="og:description" content="[^"]+"/,
    'og:image（绝对地址）': /property="og:image" content="https?:\/\/[^"]+"/,
    'og:image:width/height': /og:image:width" content="1200"/,
    'twitter:card': /name="twitter:card" content="summary_large_image"/,
    'og:url': /property="og:url" content="https?:\/\/[^"]+"/,
  };
  for (const [k, re] of Object.entries(meta)) checks.push([k, re.test(html)]);

  const exists = existsSync(img);
  let dims = '';
  if (exists) {
    const buf = readFileSync(img);
    // PNG 的 IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型之后
    dims = `${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)}`;
    checks.push(['og-image.png 是 1200×630 的 PNG', dims === '1200×630']);
  } else {
    checks.push(['og-image.png 存在', false]);
  }

  const failed = checks.filter(([, v]) => !v).map(([k]) => k);
  record(
    'A10',
    '卡片物料齐备（微信内实际展开需人工确认）',
    failed.length === 0,
    `断言 meta 齐备 + 读 PNG 头取尺寸（构建用 SITE_URL=${SITE_URL_IN_REPORT}）`,
    failed.length ? `缺：${failed.join('、')}` : `meta ${Object.keys(meta).length} 项齐全 · 图 ${dims}`
  );
  record('A10', '在微信里分享一次、确认预览展开', 'manual', '人工：把链接发到微信（文件传输助手即可）看卡片', '需你手动做一次');
}

/* ------------------------------ 汇总 ------------------------------ */

const auto = rows.filter((r) => r.ok !== 'manual');
const bad = auto.filter((r) => r.ok !== true);

console.log(`\n${'─'.repeat(52)}`);
console.log(`自动判定 ${auto.length - bad.length} / ${auto.length} 通过；人工待确认 ${rows.length - auto.length} 项`);

if (WRITE) {
  const md = [
    '# 验收记录（M3）',
    '',
    `- 生成时间：${new Date().toISOString()}（UTC）`,
    `- 判定方式：\`SITE_URL=${SITE_URL_IN_REPORT} node scripts/acceptance.mjs --write\``,
    `- 构建锚点：本次验收**先重建** dist（SITE_URL=${SITE_URL_IN_REPORT}），所有断言读的是本次产物`,
    `- 结论：自动判定 **${auto.length - bad.length}/${auto.length} 通过**，另有 ${rows.length - auto.length} 项需人工确认`,
    '',
    '| # | 验收项 | 判定命令 / 依据 | 实测结果 | 结论 |',
    '|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.name} | \`${r.how}\` | ${r.detail} | ${r.ok === true ? '通过' : r.ok === 'manual' ? '待人工' : '**失败**'} |`
    ),
    '',
    '> A10 只能部分自动化：卡片文件与 meta 可断言，「分享到微信里真的展开」必须人工做一次。',
    '> A7 的「无横向溢出」指**页面级**底部不出现横向滚动条；两个图表面板（生存曲线 / 点阵分布）',
    '> 因 \`svg{min-width:520px}\` 在窄屏下会**内部**横向滚动，这是避免图内文字被压到 5px 的既定取舍。',
    '',
  ].join('\n');
  await writeFile(resolve(ROOT, 'docs/acceptance.md'), md, 'utf8');
  console.log('✓ 已写入 docs/acceptance.md');
}

if (bad.length) {
  for (const r of bad) console.log(`   · ${r.id} ${r.name} — ${r.detail}`);
  process.exit(1);
}
