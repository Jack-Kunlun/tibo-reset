#!/usr/bin/env node
/**
 * 发布脚本（ship-image.sh / fetch-base-image.sh）的约束校验。
 *
 * 为什么单独来一套：这两个脚本守的几条约束**错了也不报错**，只把排查方向带偏。
 *
 *   · **目标架构**：本机 Apple Silicon（arm64）、服务器腾讯云 Ubuntu 64bit（x86_64）。
 *     若 `--platform linux/amd64` 被去掉或默认值被改，产出的镜像搬到服务器上起不来，
 *     而报错只有 `exec format error` —— 它一个字都不提「架构」。这条约束没有任何
 *     运行期反馈，本地怎么跑都是绿的，只能靠断言钉住。
 *   · **代理地址**：容器里看宿主要用 `host.docker.internal`。写成 `127.0.0.1` 时
 *     代理看起来「配好了」，实际指向容器自己 —— 表现为下载失败或极慢，同样不说原因。
 *   · **`$var` 紧跟中文**：/bin/sh 会把紧跟其后的 UTF-8 字节吃进变量名，
 *     `$alt（` 被当成变量 `alt（`，在 `set -u` 下直接 unbound variable。
 *     实测踩过：脚本前 85 行都跑完了，报错只指向那一行，很容易误以为变量没定义。
 *
 * 与 test-secrets.mjs 同一层级：测的不是产品逻辑，而是「一条防线还在不在」。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

/* ============================== 读取与工具 ============================== */

const SHIP = 'scripts/ship-image.sh';
const FETCH = 'scripts/fetch-base-image.sh';

const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
const exists = (rel) => existsSync(resolve(ROOT, rel));

/** 去掉行首注释行（那些是说明文字，允许出现反例写法） */
const codeLines = (src) => src.split('\n').filter((l) => !/^\s*#/.test(l));

/**
 * 找「$var 紧跟非 ASCII」——这类写法在 /bin/sh 下会被吃进变量名。
 * `$` 后紧跟 `{` 的是安全的（显式界定了名字），所以不匹配。
 * @returns {string[]} 形如 ['L86', 'L92']
 */
function riskyVarRefs(src) {
  return codeLines(src)
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line))
    .map(({ n }) => `L${n}`);
}

const stat = (rel) => (exists(rel) ? statSync(resolve(ROOT, rel)) : null);

for (const rel of [SHIP, FETCH]) {
  if (!exists(rel)) {
    console.log(`  ✗ 缺少脚本 ${rel} —— 后面的断言无从谈起`);
    process.exit(1);
  }
}

const ship = read(SHIP);
const fetch = read(FETCH);

/* ============================ 目标架构（最要命） ============================ */

section('ship-image.sh：目标架构（错了不报错，只把排查带偏）');

check(
  '默认目标是 linux/amd64（本机 arm64、服务器 x86_64）',
  /^\s*ARCH="linux\/amd64"/m.test(ship),
  '没找到 ARCH="linux/amd64" 这一行'
);

check(
  'docker build 显式带 --platform（不依赖本机默认架构）',
  /docker build\s+--platform\s+"\$ARCH"/.test(ship),
  'docker build 少了 --platform "$ARCH"，产出的会是本机架构'
);

check(
  '基础镜像架构不符时先拦下来（不静默用错的那份）',
  /missing=""/.test(ship) && /exit 1/.test(ship),
  '没看到前置守卫'
);

check(
  '守卫里指向了 fetch-base-image.sh（给了可执行的补救路径）',
  /fetch-base-image\.sh/.test(ship),
  '报错文案里没提补救脚本，用户只能对着 502 猜'
);

check(
  '临时换了基础镜像 tag 后会还原（构建失败也还原，靠 trap 兜底）',
  /trap restore_base_tags EXIT/.test(ship) && /^restore_base_tags$/m.test(ship),
  '没有 trap 兜底，构建失败会把本机的 arm64 tag 留成 amd64'
);

/* ============================== 产物与服务器步骤 ============================== */

section('ship-image.sh：产物完整性与服务器侧动作');

check(
  '导出后生成 .sha256（百兆二进制走 scp 可能悄悄截断）',
  /shasum -a 256/.test(ship) && /\.sha256/.test(ship),
  '没看到校验和生成'
);

check(
  '服务器侧步骤用的是 docker load，不是 docker build',
  /docker load/.test(ship),
  '服务器侧没走 load —— 构建不该发生在服务器上'
);

// apt 源这条与架构那条同性质：**失败时报的错完全不提真正的原因**。
// deb.debian.org 在国内常被 DNS 解析到坏地址（实测解析成 8.134.121.112），
// 直连 000、经代理 502，apt 层于是 exit 100，而报错只说
// "repository is not signed / 502 Bad Gateway" —— 一个「网络」字都不提。
// 所以「能按环境切源」这件事必须钉住：Dockerfile 里留 ARG，脚本里传进去。
check(
  'apt 源可按环境切换（国内取不到 deb.debian.org 索引时切国内源）',
  /ARG\s+APT_MIRROR/.test(read('Dockerfile')) && /--build-arg\s+"APT_MIRROR=\$APT_MIRROR"/.test(ship),
  'Dockerfile 少了 ARG APT_MIRROR，或 ship-image.sh 没把它传进 docker build'
);

// 只看代码行：注释里出现「不要 git clone」这类反例是好的文档，不该被当成违反
const shipCode = codeLines(ship).join('\n');

check(
  '服务器侧步骤里没有 git（服务器不需要 git）',
  !/git clone/.test(shipCode) && !/git pull/.test(shipCode),
  '代码里出现了 git 拉取动作'
);

/* ============================== SITE_URL 的来源 ============================== */

// 与 Dockerfile / build.mjs / acceptance.mjs 同一约定：**域名属于部署环境，不进仓库**。
// 这里曾经违反过 —— ship-image.sh 里留着一行硬编码的真实域名默认值。而且错了不报错：
// 构建照样成功，只是 og:url / og:image 与 OG 分享图里印的是错域名。
// 性质与「架构」那条一样：本地怎么跑都是绿的，只能靠断言钉住。
section('ship-image.sh：SITE_URL 来自环境，不写进仓库');

check(
  '代码里没有硬编码的 http(s) 默认域名',
  !/^\s*SITE_URL="https?:\/\//m.test(shipCode),
  'SITE_URL 又被赋成了固定地址 —— 域名属于部署环境，写进仓库就等于把镜像绑死在一个域名上'
);

check(
  '缺 SITE_URL 时明确报错退出（不静默用占位域名）',
  /缺少 SITE_URL[\s\S]{0,800}?\n\s*exit 2\n/.test(ship),
  '没有校验：解析不到就一路构建下去，产出里印的是错域名，比直接失败难发现得多'
);

check(
  '可回落到本机凭据文件 ~/.tibo-ingest.env（真值只存一处）',
  /\.tibo-ingest\.env/.test(ship),
  '没看到读本机凭据文件的逻辑，那样每次都得在命令行上手打域名'
);

check(
  '--site 仍可显式覆盖',
  /--site\)\s*SITE_URL="\$2"/.test(ship),
  '--site 参数没了，没法临时构建另一个域名的版本'
);

/* ============================== fetch-base-image.sh ============================== */

section('fetch-base-image.sh：绕开 daemon 拉不到 Docker Hub');

check(
  '代理默认用 host.docker.internal（127.0.0.1 在容器里指向自己）',
  /host\.docker\.internal/.test(fetch),
  '没看到 host.docker.internal'
);

check(
  '没有把代理写成 127.0.0.1（那样在容器内是自指，下载必失败或极慢）',
  !/127\.0\.0\.1:7890/.test(fetch),
  '出现了 127.0.0.1:7890'
);

check(
  '用容器内的 skopeo 下载（daemon 侧那条路配不上代理）',
  /skopeo copy/.test(fetch),
  '没看到 skopeo copy'
);

check(
  '落成带架构后缀的 tag（不覆盖本机原有的 arm64 那份）',
  /\$\{img\}-\$\{CPU\}/.test(fetch) || /\$img-\$CPU/.test(fetch),
  '没看到把 tag 拼成 <tag>-<cpu>'
);

/* ============================== 两个脚本共通 ============================== */

section('两个脚本共通：可执行、语法、/bin/sh 变量名陷阱');

for (const rel of [SHIP, FETCH]) {
  const st = stat(rel);
  check(`${rel} 有可执行位`, !!(st && st.mode & 0o111), '没有 x 位，得用 sh 显式调用');
}

for (const rel of [SHIP, FETCH]) {
  let ok = true;
  let msg = '';
  try {
    execFileSync('sh', ['-n', resolve(ROOT, rel)], { stdio: 'pipe' });
  } catch (e) {
    ok = false;
    msg = String(e.stderr || e.message).split('\n')[0];
  }
  check(`${rel} 通过 sh -n 语法检查`, ok, msg);
}

for (const rel of [SHIP, FETCH]) {
  const hits = riskyVarRefs(read(rel));
  check(
    `${rel} 没有「$var 紧跟中文」的写法`,
    hits.length === 0,
    hits.length ? `这些行要改成 \${var}：${hits.join('、')}` : ''
  );
}

/* ============================== 结果 ============================== */

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项${skipped ? `（另跳过 ${skipped} 项）` : ''}`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过${skipped ? `（跳过 ${skipped} 项）` : ''}`);
