#!/usr/bin/env node
/**
 * 「数据不新鲜」这件事有没有被页面说出来。
 *
 * 守的是一类**静默陈旧**：本项目的发布链不保证数据新鲜（采集在本机，机器睡了就没人采），
 * 页面会在数据陈旧的情况下照常上线。只要「不新鲜」这件事没被显示出来，用户看到的就是
 * 一个一切正常、实则数据停滞的页面 —— 这正是本架构最想避免的情况。
 *
 * 两道提示，互斥：
 *   1. 「数据采集异常」 —— `stats.json` 的 `errors` 非空，即**采集真的失败了**
 *   2. 「数据未更新」   —— 数据超过两个采集周期没**成功**更新，即**采集根本没发生**
 *      2026-09-22 之前这件事由 CI 每 30 分钟一轮的定时体检发现；定时移除后改由页面
 *      自己算（D-023）。所以这一道现在是唯一的一道，断言必须守得住。
 *
 * 校验六件事：
 *   1. 没有异常时**不输出任何东西**（不能给干净页面添噪声）
 *   2. 有异常时输出提示，条目逐条列出，空值被过滤
 *   3. 文案只承诺它确实知道的事：错误文本转义、时间按北京时间、非法时间宁可不渲染
 *   4. 两道提示在 `renderAll` 里都接进了页面，且**互斥**
 *   5. 陈旧判据：锚点是 `tweets.json` 的 `updated_at`、阈值由本机周期**推导**
 *   6. workflow 里 CI **不再采集**（采集只在本机），但提交判据仍不是字节级
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChartData } from '../src/lib/chart-data.js';
import { predictAll } from '../src/lib/predict.mjs';
import { detectSignals } from '../src/lib/signals.mjs';
import {
  renderAll,
  renderCollectWarning,
  renderFreshness,
  LOCAL_COLLECT_INTERVAL_MINUTES,
  STALE_AFTER_MINUTES,
} from '../src/lib/render.mjs';

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
const LIVE_MS = Date.parse(LIVE);
const MIN = 60_000;

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

section('renderAll 把两道提示接进页面');

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
check('不传 collect 选项 → FRESHNESS 也为空串', noOpts.FRESHNESS === '');

const withErr = renderAll(model, prediction, signals, {
  collect: { errors: ['实时采集失败：HTTP 403'], attemptedAt: AT, lastLiveAt: LIVE },
});
check('传了采集错误 → COLLECT_WARNING 有内容', withErr.COLLECT_WARNING.includes('class="cwarn"'));
check(
  '有采集错误时**不再**叠加一条「数据未更新」（同一件事不铺两条）',
  withErr.FRESHNESS === ''
);

const withFresh = renderAll(model, prediction, signals, {
  collect: { errors: [], attemptedAt: AT, lastLiveAt: LIVE },
});
check('没有采集错误 → FRESHNESS 输出承载元素', withFresh.FRESHNESS.includes('id="cstale"'));
check('没有采集错误时 COLLECT_WARNING 是空串', withFresh.COLLECT_WARNING === '');

/* ==================== 5. 陈旧提示：判据与呈现 ==================== */

section('数据未更新：锚点、阈值、呈现');

check('没有 info → 空串', renderFreshness(undefined, now) === '');
check(
  '没有 lastLiveAt（首次部署）→ 空串，不报一个无从判断的「陈旧」',
  renderFreshness({ errors: [] }, now) === ''
);
check(
  'lastLiveAt 是垃圾值 → 空串（不硬编一个假时刻）',
  renderFreshness({ errors: [], lastLiveAt: 'garbage' }, now) === ''
);
check(
  '有采集错误时与「数据采集异常」互斥 → 空串',
  renderFreshness({ errors: ['x'], lastLiveAt: LIVE }, now) === ''
);

const justFresh = renderFreshness({ errors: [], lastLiveAt: LIVE }, LIVE_MS + (STALE_AFTER_MINUTES - 1) * MIN);
check('未超阈值 → 容器带 hidden（页面保持干净）', justFresh.includes('hidden') && justFresh.includes('id="cstale"'));

const stale = renderFreshness({ errors: [], lastLiveAt: LIVE }, LIVE_MS + (STALE_AFTER_MINUTES + 1) * MIN);
check('超阈值 → 不给 hidden（脚本被禁用也看得见）', stale.includes('id="cstale"') && !stale.includes('hidden'));
check('标题是「数据未更新」', stale.includes('数据未更新'));
check('时刻按北京时间渲染（08:17Z → 16:17）', stale.includes('最近一次成功采集是 2026.09.20 16:17 北京'));
check(
  '说清了「可能滞后」而不是「数据是新的」',
  /可能已滞后/.test(stale) && !/数据已?同步|最新/.test(stale)
);
check(
  '不带模型术语、不提采集架构（本机 / CI / 定时任务都不该出现在页面上）',
  !/本机|CI|定时任务|采集器|runner/.test(stale)
);
check(
  '「距今多久」由客户端填（服务端不写死一个会立刻过期的读数）',
  stale.includes('id="cstale-age"') && !stale.includes('距今')
);
check(
  '容器带上判据所需的数据（data-at / data-stale-after）',
  stale.includes(`data-at="${LIVE}"`) && stale.includes(`data-stale-after="${STALE_AFTER_MINUTES}"`)
);

// 时钟超前或数据时刻在未来（跨机时差）时，age 是负数 —— 不该被当成陈旧
const future = renderFreshness({ errors: [], lastLiveAt: LIVE }, LIVE_MS - 60 * MIN);
check('数据时刻在未来（时钟偏差）→ 不报陈旧', future.includes('hidden'));

/* ============ 6. 判据必须由周期推导，不是第二个手写数字 ============ */

section('陈旧阈值由本机周期推导');

check(
  '本机周期是个正数常量（仓库里的单一真值来源）',
  Number.isFinite(LOCAL_COLLECT_INTERVAL_MINUTES) && LOCAL_COLLECT_INTERVAL_MINUTES > 0,
  `实际 ${LOCAL_COLLECT_INTERVAL_MINUTES}`
);
check(
  '陈旧阈值 = 两个本机周期（连续漏掉一整轮才提示）',
  STALE_AFTER_MINUTES === LOCAL_COLLECT_INTERVAL_MINUTES * 2,
  `实际 ${STALE_AFTER_MINUTES} vs ${LOCAL_COLLECT_INTERVAL_MINUTES} × 2`
);

// 行为断言挡不住「两个常量各自写死成恰好 2 倍」，所以再锁一次推导关系本身。
const renderSrc = await readFile(resolve(ROOT, 'src/lib/render.mjs'), 'utf8');
check(
  '阈值在源码里是**引用**周期算出来的，不是字面量（否则「改一处」会退化成两处）',
  /STALE_AFTER_MINUTES\s*=\s*LOCAL_COLLECT_INTERVAL_MINUTES\b/.test(renderSrc)
);

/* ==================== 7. workflow：CI 不再采集，也不再碰数据 ==================== */

section('发布链：CI 只在代码变更时构建，数据更新不触发它');

const yml = await readFile(resolve(ROOT, '.github/workflows/collect.yml'), 'utf8');
// 所有断言都先剥掉纯注释行：注释里**刻意**写着这些被禁掉的写法（用来说明为什么禁），
// 不剥掉就等于把「解释为什么禁止」断言成违规。
const ymlCode = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

check(
  'CI 里不再有任何采集（collect.mjs 不该出现在 workflow 里）',
  !/collect\.mjs/.test(ymlCode),
  '出现即说明「CI 不采集」这条被改回去了 —— 而 runner 必被 Cloudflare 403'
);
check(
  '定时器已移除（不再是「每 30 分钟空转一轮」）',
  !/^\s*schedule:/m.test(ymlCode) && !/cron:/.test(ymlCode)
);
check('按运行时不再出现 --max-age（那套阈值只在 CI 采集时才有意义）', !/--max-age/.test(ymlCode));
check('手动触发仍在（Pages 需要重发时用）', /^\s*workflow_dispatch:/m.test(ymlCode));

// 下面几条合起来构成 D-025 的核心：数据由本机直推后端，**CI 与数据彻底解耦**。
// 这里最容易出的错是「只排除了 data/**、漏掉构建产物」—— 本机采集后会把
// miniprogram/data/snapshot.js 与 miniprogram/utils/scene.js 一起提交，
// 漏掉任何一个，都等于「每采一次触发一次重建」，整个决定被悄悄撤回。
const pathLines = [...ymlCode.matchAll(/^\s*- '([^']+)'/gm)].map((m) => m[1]);

check(
  'push 触发不再盯着 data/**（数据更新不该触发构建）',
  !pathLines.some((p) => p === 'data' || p.startsWith('data/')),
  `paths 里出现 data 就等于把「数据变化触发构建」改回来了：${pathLines.join(' ')}`
);
check(
  'push 触发排除了构建产物 miniprogram/data/** 与 utils/scene.js',
  pathLines.includes('!miniprogram/data/**') && pathLines.includes('!miniprogram/utils/scene.js'),
  `当前 paths：${pathLines.join(' ')}`
);
check(
  'CI 不再转发数据（没有任何 ingest 相关代码）',
  !/ingest/i.test(ymlCode),
  '数据改由本机 scripts/push-ingest.mjs 直推；CI 再转发就多一条会断的链'
);
check(
  'CI 不再提交任何东西（没有 git add / commit / push）',
  !/git\s+(add|commit|push)/.test(ymlCode),
  '本机才是数据的提交方；CI 一提交就回到「每轮一条垃圾提交」'
);
check(
  'workflow 权限收到只读（contents: read）',
  /contents:\s*read/.test(ymlCode),
  '既然不再提交，就不该留着写权限'
);

// job 里的 step 缩进是 6 空格。按它切分再按 name 定位。
const steps = ymlCode.split(/\n(?= {6}- )/).filter((s) => /^ {6}- /.test(s));

const buildStep = steps.find((s) => s.startsWith('      - name: 构建页面\n')) ?? null;
check('「构建页面」step 存在且只跑 build', !!buildStep && /node scripts\/build\.mjs/.test(buildStep));
check(
  '「构建页面」step 仍把 SITE_URL 传进去',
  !!buildStep && /SITE_URL:\s*\$\{\{\s*vars\.SITE_URL\s*\}\}/.test(buildStep)
);
check(
  '没有 step 把采集与构建塞进同一个 run 块',
  !steps.some((s) => /collect\.mjs/.test(s) && /build\.mjs/.test(s))
);

/* ======================== 结果 ======================== */

console.log(`\n${'─'.repeat(52)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  for (const f of failures) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
