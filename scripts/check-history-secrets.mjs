#!/usr/bin/env node
/**
 * 历史敏感信息防线：扫**全部提交**，而不只是当前树。
 *
 * 为什么需要单独一个脚本（test-secrets.mjs 已经扫了工作区与暂存区）：
 * 脱敏是「再提交一次」做到的，而**提交是追加的**。改掉当前文件只能让「树」干净，
 * 早先那些提交照旧留在历史里 —— 如果推送过，就已经在公开仓库上了，删不掉。
 * 这个区别导致过一个真实的漏判：当时报了「已提交树 0 命中」，但历史里还躺着一处。
 *
 * 判据必须是**结构性的**，不能写真实值：
 *   写「不得含 reset.<真域名>」等于把秘密原文抄进脚本，防线自己成为泄露源。
 *   所以这里只守「形状固定、与具体值无关」的几类（本机绝对路径 / 私钥正文 /
 *   appid 形态 / openid 键值对 / 部署地址是否为保留域）。公网 IP **不守** ——
 *   没有通用判据能把真实地址与 UA 里的版本号、文档里的示例区分开，详见 RULES 附近的说明。
 *
 * 已知残留的处理方式：**登记 + 只拦新增**。
 *   已经公开的那部分不可能靠改历史真正抹除（GitHub 保留旧提交可按 SHA 访问，
 *   别人的 fork 删不掉），所以不把它做成永远红的失败项 —— 那样只会让人把整条防线忽略掉。
 *   这里把它的「路径 + blob 数」作为基线登记下来（见 KI-007），断言变成：
 *   ① 命中必须全部落在基线登记的路径上；② 同一路径的 blob 数不得增加。
 *   于是「有人往别的文件里写 /Users/<用户名>/」或「又提交了一版旧内容」都会立刻报红。
 *
 * 覆盖范围：所有 ref 可达的对象（= 会被推送、也会被公开读到的那部分）。
 * 另有【7】段顺带查**不可达对象**——那些只在本地 .git 里，GitHub 上没有，
 * 但拿到这个项目目录的人仍能挖出来。它只提示、不判失败。
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const section = (t) => console.log(`\n【${t}】`);

/* ============================ git 对象遍历 ============================ */

const git = (args, opts = {}) =>
  spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, ...opts });

/* ---- 浅克隆守卫 ---- */
//
// CI 里常见 `fetch-depth: 1` —— 那种克隆只有一条提交，「扫历史」会**全绿但什么都没查**。
// 这正是本项目最忌讳的静默空转（防线看起来在跑、实际是空的），所以显式跳过并说明，
// 而不是假装通过。它意味着这个检查的适用范围是**完整克隆**（本机 / 发布前），
// 不适合塞进 CI 的 `npm test` —— 那样只会得到「绿了但没查」的错觉。
const shallow = (git(['rev-parse', '--is-shallow-repository']).stdout || '').trim() === 'true';
if (shallow) {
  console.log('⊘ 跳过：当前是浅克隆（只有部分历史），扫历史没有意义。');
  console.log('  要真正扫描请用完整克隆：`git fetch --unshallow`（或 CI 里配 fetch-depth: 0）。');
  process.exit(0);
}

/** 所有 ref 可达的 oid -> 路径（同一 blob 被多个路径引用时取先出现的那个）。 */
function reachableObjects() {
  const out = git(['rev-list', '--all', '--objects']).stdout || '';
  const map = new Map();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const oid = sp > 0 ? line.slice(0, sp) : line;
    if (!map.has(oid)) map.set(oid, sp > 0 ? line.slice(sp + 1) : '（提交/树）');
  }
  return map;
}

/**
 * 一次性读出指定 oid 的内容。走 `git cat-file --batch` 的二进制流，
 * 而不是逐对象开进程 —— 上百个对象时差别明显。
 * @returns {Map<string, Buffer>}
 */
function readBlobs(oids) {
  if (oids.length === 0) return new Map();
  const r = spawnSync('git', ['cat-file', '--batch'], {
    cwd: ROOT,
    input: oids.join('\n') + '\n',
    maxBuffer: 1 << 30,
  });
  const buf = r.stdout;
  const blobs = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const [sha, type, sizeStr] = buf.toString('utf8', pos, nl).split(' ');
    const size = Number(sizeStr);
    const start = nl + 1;
    if (type !== 'blob' || !Number.isFinite(size)) {
      pos = start; // `missing` 之类的应答，跳过
      continue;
    }
    blobs.set(sha, buf.subarray(start, start + size));
    pos = start + size + 1; // 跳过分隔用的换行
  }
  return blobs;
}

/** 对象清单（含不可达），用于【7】段。 */
function allObjectTypes() {
  const out = git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']).stdout || '';
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(' '));
}

/* ============================ 判据 ============================ */

// 占位用户名白名单。理由：CI（GitHub Actions 的 `runner`）、文档示例（`user`/`example`）
// 都会出现 /Users/... 或 /home/... 的形状，不该报警。
const PLACEHOLDER_USERS = new Set([
  'user', 'users', 'username', 'example', 'test', 'me', 'you', 'someone', 'shared',
  'runner', 'runneradmin', 'node', 'nobody', 'local', 'yourname', 'xxx', 'foo',
]);

// 本机绝对路径。前后不吃相邻的路径字符，避免匹配到 URL 里的片段。
const ABS_PATH_RE = /(?:^|[^A-Za-z0-9._-])\/(?:Users|home)\/([A-Za-z0-9._-]+)\//gm;

// PEM 必须带**实际 base64 正文**才算命中。
// 只匹配头部标记会误报 —— test-secrets.mjs 里就有一句
// `grepTracked('-----BEGIN CERTIFICATE-----')`，那是判据字面，不是证书正文。
const PEM_RE = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----\r?\n(?:[A-Za-z0-9+/=]{60,}\r?\n){1,}/;

// 小程序 appid 形态：wx + 16 位十六进制。真实 appid 属于账号标识，不进公开仓库。
const APPID_RE = /\bwx[0-9a-f]{16}\b/;

// openid 键值对。全仓库唯一的合法出现是测试里的哨兵值，所以按值形态排除哨兵。
//
// ⚠ 这里**不能**用 `o[A-Za-z0-9_-]{27}` 这种裸正则去匹配 openid ——
//   package-lock.json 里 `integrity: "sha512-…"` 的 base64 片段会长得一模一样
//   （实测把 4 个哈希片段误报成 openid）。必须按键值对匹配。
const OPENID_PAIR_RE = /"openid"\s*:\s*"([^"]+)"/g;
// 哨兵形态：`fake` / `OPENID-9`（测试断言里的假值）与 `"..."`（文档里的占位省略号）。
// ASCII 的三个点容易漏 —— 第一版就是漏了它，把 docs/tech-selection.md 的占位报成真值。
const OPENID_SENTINEL_RE = /fake|test|example|openid|should_never_leak|placeholder|xxxx|<|…|\.{2,}/i;

// ⚠ 域名与公网 IP 不按「扫全部 URL / 全部 IP」的方式守 —— 没有通用判据。
//
// 试过一版「非文档保留段的公网 IP」，实测 11 个文件全命中且**没有一处是泄漏**：
//   · `Chrome/120.0.0.0`、`Chrome/153.0.0.0` —— User-Agent 里的版本号，与 IP 完全同形
//   · `8.134.121.112`、`151.101.66.146` —— 文档里记录的「DNS 被解析到的实测地址」
//   · `183.232.185.55` —— apt 报错信息里的 IP
//   · `1.2.3.4` —— 注释里的示例地址
// 误报率高到会让人忽略整条防线，所以宁可不要这条。
//
// 域名走**另一条**路子：从**键**入手，只抓「部署地址」这一类。
// 仓库里合法地存在大量外链（x.com、github.com、npmjs、debian 镜像……），全扫必然有噪音；
// 而真正在意的那个值只会通过 `apiBase` / `SITE_URL` / `INGEST_URL` 进入代码与文档。
// 判据与 test-secrets.mjs 对暂存区 config.js 的写法同源：**断言「主机名必须是保留域」**，
// 而不是「不能是某个真实域名」—— 后者等于把域名抄进脚本，防线自己成了泄露源。
//
// 两道前置过滤，都是实测撞出来的误报（第一版把这 5 类报成了泄漏）：
//   ① 值必须**真的长得像绝对 URL**。`SITE_URL=` 后面大量出现的是「取值方式」而非值本身：
//      `--build-arg SITE_URL=...`、`ENV SITE_URL=${SITE_URL}`、`(process.env.SITE_URL`、
//      `sed -n 's|^SITE_URL=||p'`。这些都不以 http(s):// 开头，一律跳过。
//   ② 主机名必须是纯 ASCII。`SITE_URL=https://你的域名`、`https://<你的域名>` 是文档占位符，
//      真实域名不会有非 ASCII 字符，所以主机名含非 ASCII 即视为占位。
const ENV_URL_RE = /(?:apiBase\s*:\s*'([^']*)')|(?:\b(?:SITE_URL|INGEST_URL)\s*=\s*'?([^\s'"`]+)'?)/g;
const URL_LOOKING_RE = /^https?:\/\/([A-Za-z0-9.-]+)/;
// 注意按**主机名**判，不按整个值判：文档里常写成 `SITE_URL=https://…），所有断言…`，
// 值的尾部粘着中文标点，按整值判会把保留域也误报成真实域名。
const RESERVED_HOST_RE = /(^|\.)(example|invalid|test|localhost)(\.(com|org|net))?$/;

const RULES = {
  'abs-path': { label: '本机绝对路径', test: testAbsPath },
  pem: { label: '私钥/证书正文', test: (s) => firstMatch(PEM_RE, s) },
  appid: { label: '小程序 appid 形态', test: (s) => firstMatch(APPID_RE, s) },
  openid: { label: 'openid 键值对（非哨兵）', test: testOpenid },
  'env-url': { label: '部署地址不是保留域（apiBase / SITE_URL / INGEST_URL）', test: testEnvUrl },
};

function firstMatch(re, s) {
  const m = re.exec(s);
  return m ? { at: m.index } : null;
}

function testAbsPath(s) {
  ABS_PATH_RE.lastIndex = 0;
  let m;
  while ((m = ABS_PATH_RE.exec(s))) {
    if (PLACEHOLDER_USERS.has(m[1])) continue;
    return { at: m.index };
  }
  return null;
}

function testOpenid(s) {
  OPENID_PAIR_RE.lastIndex = 0;
  let m;
  while ((m = OPENID_PAIR_RE.exec(s))) {
    if (OPENID_SENTINEL_RE.test(m[1])) continue;
    return { at: m.index };
  }
  return null;
}

function testEnvUrl(s) {
  ENV_URL_RE.lastIndex = 0;
  let m;
  while ((m = ENV_URL_RE.exec(s))) {
    const v = (m[1] !== undefined ? m[1] : m[2]) || '';
    const u = URL_LOOKING_RE.exec(v);
    if (!u) continue; // 不以 http(s):// 开头：取值方式、代码引用、省略号
    if (!/^[A-Za-z0-9.-]+$/.test(u[1])) continue; // 主机名含非 ASCII：文档占位符
    if (RESERVED_HOST_RE.test(u[1].toLowerCase())) continue;
    return { at: m.index };
  }
  return null;
}

/** 行号（1 起），只用于定位，不回显命中内容。 */
function lineOf(s, at) {
  return s.slice(0, at).split('\n').length;
}

/* ============================ 扫描 ============================ */

console.log('扫描范围：所有 ref 可达的对象（即已经/将会被公开读到的那部分）');

const reach = reachableObjects();
const blobs = readBlobs([...reach.keys()].filter((oid) => reach.get(oid) !== '（提交/树）'));

console.log(`对象：${reach.size} 个可达，其中 blob ${blobs.size} 个`);

/** @type {Map<string, {rule:string, path:string, lines:Set<number>, blobs:Set<string>}>} */
const hits = new Map();

for (const [oid, buf] of blobs) {
  const text = buf.toString('utf8');
  const path = reach.get(oid);
  for (const [rule, { test }] of Object.entries(RULES)) {
    const m = test(text);
    if (!m) continue;
    const key = `${rule}|${path}`;
    if (!hits.has(key)) hits.set(key, { rule, path, lines: new Set(), blobs: new Set() });
    const h = hits.get(key);
    h.lines.add(lineOf(text, m.at));
    h.blobs.add(oid);
  }
}

/* ============================ 已知残留基线 ============================ */

// 已经推送到公开仓库、无法真正抹除的历史残留。见 docs/known-issues.md 的 KI-007。
// 断言是「不新增」：命中必须落在登记的路径上，且 blob 数不超基线。
//
// ⚠ 每条都要写清「为什么可以接受」。这份清单不是「忽略名单」—— 它出现在每次运行的输出里，
//   是让人看见而不是让人忘记。凡是**当前版本里仍然存在**、且真属于凭据类的，一律不许登记进来。
const ACCEPTED = [
  {
    rule: 'abs-path',
    path: 'docs/data-source.md',
    maxBlobs: 7,
    note: '脱敏前的旧版本把本机工作目录写进了 §5 的表格；HEAD 里该行已整行删除，只剩历史。',
  },
  {
    rule: 'env-url',
    path: 'docs/acceptance.md',
    maxBlobs: 2,
    note:
      'M3 验收记录里的构建锚点，两个匹配版本都**只在历史里**：更早一版是自有域名的子域（后被' +
      '替换），后一版是 `<user>.github.io/<repo>` 形态 —— 由公开仓库地址可直接推出、不构成新' +
      '信息。2026-09-23 起报告改成占位符（`https://<你的域名>`，与 AGENTS.md 同约定），"当天' +
      '跑了什么"由命令形状与生成时间保留。⚠ 这个计数**不会因为新版脱敏而下降**（旧版成为祖先、' +
      '照旧可达），所以 2 就是它的下限；谁再把真实地址写回 HEAD，会多出一个匹配 blob（3 > 2）' +
      '→ 这条立刻报红。',
  },
];

const acceptedFor = (rule, path) => ACCEPTED.find((a) => a.rule === rule && a.path === path);
const acceptedHits = [];
const newHits = [];
for (const h of hits.values()) {
  (acceptedFor(h.rule, h.path) ? acceptedHits : newHits).push(h);
}

/* ============================ 断言 ============================ */

section('【1】历史里没有**新增**的敏感信息');

const NO_HIT_RULES = Object.entries(RULES).filter(([rule]) => !ACCEPTED.some((a) => a.rule === rule));
for (const [rule, { label }] of NO_HIT_RULES) {
  const bad = newHits.filter((h) => h.rule === rule);
  check(
    `${label}：${bad.length === 0 ? '全部提交 0 命中' : `${bad.length} 处命中`}`,
    bad.length === 0,
    bad
      .map((h) => `${h.path}:${[...h.lines].join(',')}（${h.blobs.size} 个版本）`)
      .join('；') || ''
  );
}

section('【2】已在基线上登记的残留：只允许存在，不允许变多');

if (acceptedHits.length === 0 && ACCEPTED.length > 0) {
  console.log('  · 基线登记的残留已消失（历史被改写或对象被回收）—— 可以把 ACCEPTED 清空了');
}

for (const a of ACCEPTED) {
  const h = acceptedHits.find((x) => x.rule === a.rule && x.path === a.path);
  const n = h ? h.blobs.size : 0;
  check(
    `\`${a.path}\` 的${RULES[a.rule].label}未超过基线（${n}/${a.maxBlobs} 个版本）`,
    n <= a.maxBlobs,
    n > a.maxBlobs ? '又提交了一版含该内容的历史 —— 见 KI-007 的处置方式' : ''
  );
}

// 有登记项的规则，还要防「跑到别的文件去」：登记是按 (规则, 路径) 配对的，
// 同一个规则出现在登记路径之外 = 新增泄漏。
for (const rule of new Set(ACCEPTED.map((a) => a.rule))) {
  const stray = newHits.filter((h) => h.rule === rule);
  check(
    `${RULES[rule].label}没有出现在登记路径之外的文件里`,
    stray.length === 0,
    stray.map((h) => `${h.path}:${[...h.lines].join(',')}`).join('；') || ''
  );
}

// 把登记理由摆到输出里。清单只出现在源码里的话，它就退化成了「忽略名单」。
console.log('\n  登记理由（已在公开历史里，撤回不了）：');
for (const a of ACCEPTED) console.log(`   · \`${a.path}\`（${RULES[a.rule].label}）—— ${a.note}`);

/* ============================ 本地残留（只提示）============================ */

section('【3】本地 .git 里的不可达对象（GitHub 上没有，但拿到目录就能挖出来）');

const all = allObjectTypes();
const unreachableBlobs = all.filter(([oid, type]) => type === 'blob' && !reach.has(oid)).map(([oid]) => oid);
const residue = [];
for (const [oid, buf] of readBlobs(unreachableBlobs)) {
  const text = buf.toString('utf8');
  for (const [rule, { test }] of Object.entries(RULES)) {
    if (test(text)) {
      residue.push({ oid, rule });
      break;
    }
  }
}

if (residue.length === 0) {
  console.log('  ✓ 不可达对象里没有敏感内容');
  pass++;
} else {
  console.log(`  ⚠ ${residue.length} 个不可达对象含敏感内容（仅本地，不影响 GitHub）：`);
  for (const r of residue) console.log(`     · ${r.oid.slice(0, 12)}  ${RULES[r.rule].label}`);
  console.log('    清理：git reflog expire --expire=now --all && git gc --prune=now');
  console.log('    （这条只提示、不判失败 —— 别人 clone 到的仓库里本来就没有这些对象）');
}

/* ============================ 结果 ============================ */

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const f of failures) console.log(`   · ${f}`);
  console.log('\n注意：历史是追加的 —— 已经推送出去的内容删不掉，只能吊销对应的凭据/密钥。');
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过${acceptedHits.length ? `（含 ${ACCEPTED.length} 处基线登记的已接受残留）` : ''}`);
