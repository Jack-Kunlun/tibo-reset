#!/usr/bin/env node
/**
 * 采集异常的外显校验。
 *
 * 守的是一类**静默陈旧**：发布链已被改成「采集失败不阻断发布」
 * （见 .github/workflows/collect.yml），页面会在数据陈旧的情况下照常上线。
 * 只要「失败」这件事没有被显示出来，用户看到的就是一个一切正常、实则数据停滞的页面
 * —— 这正是本架构最想避免的情况。
 *
 * 校验四件事：
 *   1. 没有异常时**不输出任何东西**（不能给干净页面添噪声）
 *   2. 有异常时输出提示，条目逐条列出，空值被过滤
 *   3. 文案只承诺它确实知道的事：错误文本转义、时间按北京时间、
 *      非法时间宁可不渲染也不硬编
 *   4. workflow 里采集与构建是两个 step，且采集失败有显式告警
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChartData } from '../src/lib/chart-data.js';
import { predictAll } from '../src/lib/predict.mjs';
import { detectSignals } from '../src/lib/signals.mjs';
import { renderAll, renderCollectWarning } from './render.mjs';

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

const AT = '2026-09-21T09:30:00.000Z'; // → 北京时间 2026.09.21 17:30
const LIVE = '2026-09-20T08:17:14.320Z'; // → 北京时间 2026.09.20 16:17

/* ==================== 1. 没有异常时什么都不输出 ==================== */

section('没有异常时页面保持干净');

check('errors 为 undefined → 空串', renderCollectWarning(undefined) === '');
check('errors 为空数组 → 空串', renderCollectWarning({ errors: [] }) === '');
check(
  'errors 全是空值 → 空串（不能渲染出一个空壳横幅）',
  renderCollectWarning({ errors: ['', null, undefined] }) === ''
);
check(
  'errors 不是数组（脏数据）→ 空串且不抛',
  renderCollectWarning({ errors: 'HTTP 403' }) === ''
);

/* ======================== 2. 有异常时的输出 ======================== */

section('有异常时逐条列出');

const one = renderCollectWarning({ errors: ['实时采集失败：HTTP 403'], attemptedAt: AT, lastLiveAt: LIVE });

check('出现提示容器', one.includes('class="cwarn"'));
check('标题是「数据采集异常」', one.includes('数据采集异常'));
check('说明里点明数据来自仓库既有数据', one.includes('页面数字来自仓库中已有的数据'));
check('错误条目被列出', one.includes('<li>实时采集失败：HTTP 403</li>'));
check(
  '说清了「可能滞后」而不是「数据是新的」',
  one.includes('可能滞后') && !/数据已?同步|最新/.test(one)
);
check('尝试时间按北京时间渲染（09:30Z → 17:30）', one.includes('2026.09.21 17:30'));
check(
  '推文数据最后更新时间单列（取 tweets.json 的 updated_at）',
  one.includes('推文数据最后更新于 2026.09.20 16:17')
);

const many = renderCollectWarning({ errors: ['a', '', 'b'] });
check('多条错误全部列出', many.includes('<li>a</li>') && many.includes('<li>b</li>'));
check('空串条目被过滤掉', (many.match(/<li>/g) ?? []).length === 2);

/* ========================= 3. 只承诺知道的事 ========================= */

section('措辞与转义边界');

const evil = renderCollectWarning({ errors: ['<script>alert(1)</script>', 'a & b > c'] });
check('尖括号被转义', evil.includes('&lt;script&gt;') && !evil.includes('<script>alert(1)'));
check('& 与 > 被转义', evil.includes('a &amp; b &gt; c'));

const badTime = renderCollectWarning({ errors: ['x'], attemptedAt: 'not-a-date', lastLiveAt: 'garbage' });
check(
  '非法时间宁可不渲染「本轮尝试」，也不硬编出一个假时间',
  badTime.includes('class="cwarn"') && !badTime.includes('本轮尝试')
);
check('非法 lastLiveAt → 不提「推文数据最后更新于」', !badTime.includes('推文数据最后更新于'));
check('缺时间不影响错误条目照常列出', badTime.includes('<li>x</li>'));

/* ==================== 4. renderAll 里的接线 ==================== */

section('renderAll 把提示接进页面');

const read = async (p) => JSON.parse(await readFile(resolve(ROOT, p), 'utf8'));
const [resets, statsFile] = await Promise.all([read('data/resets.json'), read('data/stats.json')]);
const now = Date.now();
const model = {
  ...buildChartData(resets.records, now),
  generatedAt: statsFile.generated_at ?? new Date(now).toISOString(),
};
const prediction = predictAll(resets.records, { now });
const signals = detectSignals([], { now, account: 'thsottiaux' });

const noOpts = renderAll(model, prediction, signals);
check('不传 collect 选项 → COLLECT_WARNING 为空串（原型页等调用方不受影响）', noOpts.COLLECT_WARNING === '');

const withErr = renderAll(model, prediction, signals, {
  collect: { errors: ['实时采集失败：HTTP 403'], attemptedAt: AT, lastLiveAt: LIVE },
});
check('传了采集错误 → COLLECT_WARNING 有内容', withErr.COLLECT_WARNING.includes('class="cwarn"'));

/* ==================== 5. workflow：降级但不静默 ==================== */

section('发布链：采集失败不得阻断发布');

const yml = await readFile(resolve(ROOT, '.github/workflows/collect.yml'), 'utf8');

// job 里的 step 缩进是 6 空格。按它切分再按 name 定位。
const steps = yml.split(/\n(?= {6}- )/).filter((s) => /^ {6}- /.test(s));
const stepOf = (name) => steps.find((s) => s.startsWith(`      - name: ${name}\n`)) ?? null;

const collectStep = stepOf('采集');
const buildStep = stepOf('构建页面');

check('「采集」是一个独立的 step', !!collectStep);
check(
  '「采集」step 标了 continue-on-error: true（失败只降级、不掐链）',
  !!collectStep && /continue-on-error:\s*true/.test(collectStep)
);
check(
  '「构建页面」是另一个独立 step，且只跑 build',
  !!buildStep && /node scripts\/build\.mjs/.test(buildStep) && !/collect\.mjs/.test(buildStep)
);
check(
  '没有任何 step 把 collect 与 build 塞进同一个 run 块（bash -e 会掐断后面那条）',
  !steps.some((s) => /collect\.mjs/.test(s) && /build\.mjs/.test(s))
);
check(
  '采集失败时有显式告警（::warning + step summary），不把报错只留在日志里',
  steps.some((s) => /steps\.collect\.outcome\s*==\s*'failure'/.test(s) && /::warning/.test(s))
);
check(
  '「构建页面」step 仍把 SITE_URL 传进去',
  !!buildStep && /SITE_URL:\s*\$\{\{\s*vars\.SITE_URL\s*\}\}/.test(buildStep)
);

/* ======================== 结果 ======================== */

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
