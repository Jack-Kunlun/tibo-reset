#!/usr/bin/env node
/**
 * 密钥与证书的防线校验（.gitignore + .dockerignore）。
 *
 * 守的是一类**不可逆**的错：
 *   · TLS 私钥进了公开仓库 —— git 历史是永久的，删文件删不掉已 push 的那份，
 *     只能吊销重签（`*_nginx/` 里躺着 `reset.example.com.key`）
 *   · 私钥进了镜像层 —— 镜像层是叠加的，事后 `rm` 也删不掉那份残留，
 *     push 到 registry 就等于公开私钥
 *   · `data/subscriptions.json` 含 openid，同属个人信息，两条通道都要挡
 *
 * 为什么要有这个套件：这条防线**只有两行 ignore 规则**，没有任何代码依赖它，
 * 所以删掉规则不会有任何测试变红 —— 直到私钥被推上去为止。这里把它钉住。
 *
 * 判据分两层，都是「在能验证时验证，不能验证时明说跳过」：
 *   1. **规则层**：用 `git check-ignore` 对**假想路径**实测（不需要文件真实存在），
 *      所以任何机器上都能跑，能抓住「规则被删/被写窄」。
 *   2. **实物层**：证书目录**真的存在**时才查（别人的 clone 里没有），
 *      查「确实没被跟踪」「私钥权限不是人人可读」。
 * 另有一条兜底：扫全仓库已跟踪文件的内容，抓「有人 `git add -f` 绕过忽略」。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const failures = [];
let skipped = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function skip(name, why) {
  skipped++;
  console.log(`  ⊘ ${name} —— 跳过：${why}`);
}

const section = (t) => console.log(`\n【${t}】`);

/* ============ git 侧：用 check-ignore 实测（对不存在的路径同样有效）============ */

/** @returns {boolean} 该路径是否被 .gitignore 忽略 */
function gitIgnored(path) {
  const r = spawnSync('git', ['check-ignore', '-q', path], { cwd: ROOT });
  return r.status === 0;
}

section('git：证书与私钥被 .gitignore 挡住');

// 用**假想路径**测规则本身。写死具体域名是常见的退化方式（换域名重签后就静态失效），
// 所以多测一个别的域名 —— 规则必须按腾讯云证书包的解压命名约定（`<域名>_nginx/`）写。
check(
  '当前域名的证书目录被忽略（私钥在内）',
  gitIgnored('reset.example.com_nginx/reset.example.com.key'),
  '规则被删或写窄了：私钥会直接进仓库'
);
check(
  '换一个域名同样被忽略（规则不是写死域名的）',
  gitIgnored('other-domain.example_nginx/other-domain.example.key'),
  '证书 90 天到期要重签，写死域名 = 重签后静默失效'
);
check('证书签名请求（.csr）被忽略', gitIgnored('reset.example.com.csr'));

// 反向断言：忽略规则不能被写成「把产品文件也一起吞掉」。
// 这几条如果红，说明规则写得太宽（比如裸写 *.key 之外的过度通配）。
const mustNotIgnore = ['package.json', 'data/resets.json', 'docs/deploy.md', 'Dockerfile', '.gitignore'];
check(
  '没有误伤要跟踪的文件',
  mustNotIgnore.every((p) => !gitIgnored(p)),
  mustNotIgnore.filter(gitIgnored).join('、') + ' 被误忽略'
);

/* ============ docker 侧：.dockerignore 没有 CLI，自己解析模式 ============ */

/**
 * 极简 dockerignore 匹配：只实现本项目用到的语法（`*` / `?` / 结尾 `/` 表目录 / `!` 取反）。
 * 目录被排除 = 目录下内容全被排除，所以路径的每一层父目录都要参与判断。
 */
function globMatch(pattern, path) {
  const core = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(
    '^' +
      core
        .split('/')
        .map((seg) =>
          [...seg].map((ch) => (ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')
        )
        .join('/') +
      '$'
  );
  return re.test(path);
}

function dockerIgnored(path, lines) {
  const rules = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => (l.startsWith('!') ? { neg: true, pat: l.slice(1) } : { neg: false, pat: l }));
  const parts = path.split('/');
  const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  let ignored = false;
  for (const { neg, pat } of rules) if (prefixes.some((p) => globMatch(pat, p))) ignored = !neg;
  return ignored;
}

section('docker：私钥进不了镜像层');

const dockerIgnoreLines = readFileSync(resolve(ROOT, '.dockerignore'), 'utf8').split('\n');

check(
  '证书目录被 .dockerignore 排除',
  dockerIgnored('reset.example.com_nginx/reset.example.com.key', dockerIgnoreLines),
  'Dockerfile 是 `COPY . .`，不排除就会把私钥打进镜像层（层是叠加的，删不掉）'
);
check(
  'F9 订阅名单被排除（含 openid）',
  dockerIgnored('data/subscriptions.json', dockerIgnoreLines)
);
// 反向断言：构建必需的 lock 与运行必需的 data 不能被排除掉
check(
  '.dockerignore 没把构建与运行必需的东西排掉',
  !dockerIgnored('package-lock.json', dockerIgnoreLines) && !dockerIgnored('data/resets.json', dockerIgnoreLines),
  'package-lock.json 排掉会让 `npm ci` 直接失败；data/ 排掉镜像就没有种子数据'
);

/* ============ 实物层：证书真在本机时才查 ============ */

section('实物：本机的证书目录（他人 clone 里没有，跳过是正常的）');

const certDirs = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.endsWith('_nginx'))
  .map((e) => e.name);

if (certDirs.length === 0) {
  skip('证书目录逐文件核对', '本机没有 `*_nginx/` 目录');
} else {
  for (const dir of certDirs) {
    const files = readdirSync(join(ROOT, dir));
    const notIgnored = files.filter((f) => !gitIgnored(`${dir}/${f}`));
    check(`\`${dir}/\` 下 ${files.length} 个文件全部被忽略`, notIgnored.length === 0, notIgnored.join('、'));

    const tracked = execFileSync('git', ['ls-files', '--', dir], { cwd: ROOT, encoding: 'utf8' }).trim();
    check(`\`${dir}/\` 下没有任何文件已被 git 跟踪`, tracked === '', tracked.replace(/\n/g, '、'));

    // 私钥不该是人人可读（腾讯云下载包默认 666，拷过来就带着这个权限）
    const keys = files.filter((f) => f.endsWith('.key'));
    const loose = keys.filter((f) => (statSync(join(ROOT, dir, f)).mode & 0o077) !== 0);
    check(
      `私钥权限不含组/其他位（${keys.join('、') || '无 .key'}）`,
      keys.length > 0 && loose.length === 0,
      loose.length ? `${loose.join('、')} 是 ${loose.map((f) => (statSync(join(ROOT, dir, f)).mode & 0o777).toString(8)).join('/')}，应 chmod 600` : '没找到 .key'
    );
  }
}

/* ============ 兜底层：抓 `git add -f` 绕过忽略 ============ */

section('兜底：已跟踪文件里没有证书正文');

/** git grep 只搜已跟踪文件；无匹配时退出码 1，不抛异常。 */
function grepTracked(pattern) {
  const r = spawnSync('git', ['grep', '-l', '-I', '-E', pattern], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

const certHits = grepTracked('-----BEGIN CERTIFICATE-----');
check('已跟踪文件里没有证书正文', certHits === '', certHits.replace(/\n/g, '、'));

const keyHits = grepTracked('-----BEGIN [A-Z ]*PRIVATE KEY-----');
check('已跟踪文件里没有私钥正文', keyHits === '', keyHits.replace(/\n/g, '、'));

/* ============ 兜底层：环境标识（域名 / IP / 实例 ID / 账号）不进仓库 ============ */

// 与 test-ship.mjs 的 SITE_URL 断言同一条约定：**环境标识属于部署环境，不进仓库**。
//
// ⚠ 这里只用**不含秘密的通用模式**。不能把真实域名/IP 写成断言 ——
//   那等于把秘密原文抄进测试文件，防线自己变成泄露源。
//   所以只兜两类「形状固定、与具体值无关」的：本机绝对路径、文档保留段之外的公网 IP。
//   域名与账号名没法通用地判（`example.com` 与真域名同形），交给各自的断言与人工复核。
section('兜底：已跟踪文件里的环境标识');

const absPathHits = grepTracked('/Users/[A-Za-z0-9._-]+/');
check(
  '没有本机绝对路径（/Users/<用户名>/）',
  absPathHits === '',
  `${absPathHits.replace(/\n/g, '、')} —— 换成 ~ 或相对路径`
);

/* ---- 小程序 config.js：查**暂存区**，不查工作区 ---- */

// 这个文件是特例：真实域名必须留在**本机**，否则小程序真机连不上（接口拿不到数据会
// 静默退回内置快照，排查起来很绕）。所以工作区里它长期带着真实域名、`git status`
// 一直显示 modified —— 那是设计，不是疏漏。
//
// 于是判据只能在**暂存那一刻**成立：`git show :<path>` 读的是 index，也就是
// 「这次要提交的那一份」。没暂存时它等于 HEAD。这样既不会误报工作区的正常状态，
// 又能在 `git add` 之后、commit 之前把误提交拦住。
//
// 断言写成「必须是保留域」而不是「不能是某个真实域名」—— 后者等于把秘密抄进测试。
function readIndex(rel) {
  const r = spawnSync('git', ['show', `:${rel}`], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

section('最小程序 config.js：入库的那一份不含真实域名');

const cfg = readIndex('miniprogram/config.js');
if (cfg === null) {
  skip('config.js 暂存区断言', '读不到 index 里的 miniprogram/config.js');
} else {
  const apiBase = (cfg.match(/apiBase:\s*'([^']*)'/) || [])[1];
  const enabled = (cfg.match(/enabled:\s*(true|false)/) || [])[1];
  // RFC 2606 / RFC 6761 保留域，或留空
  const isPlaceholder =
    apiBase === '' ||
    apiBase === undefined ||
    /:\/\/([^/]*\.)?(example|invalid|test|localhost)(\.(com|org|net))?([:/]|$)/.test(apiBase);

  // ⚠ 失败文案里**不回显** apiBase 的原文：这份输出常被贴到聊天、issue 里，
  //   防线自己不该变成泄露源。外面只需要知道「是不是保留域」这一位信息。
  const hint =
    apiBase === undefined
      ? '（没有 apiBase 行）'
      : apiBase === ''
        ? '（空）'
        : `不是保留域（长度 ${apiBase.length}，应以 example / invalid / test / localhost 结尾）`;

  check('入库的 apiBase 是保留域（真实域名只留在本机）', isPlaceholder, `index 里：${hint}`);
  check(
    '占位域名配套 enabled=false（否则 request 全走 fail 回调，静默失败）',
    !isPlaceholder || enabled === 'false',
    `apiBase ${hint} 而 enabled=${JSON.stringify(enabled)}`
  );
}

/* ============ 结果 ============ */

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项${skipped ? `（另跳过 ${skipped} 项）` : ''}`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过${skipped ? `（跳过 ${skipped} 项）` : ''}`);
