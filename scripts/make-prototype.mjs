#!/usr/bin/env node
/**
 * 原型生成脚本（M1 评审用，不是产品构建链的一部分）。
 *
 * 为什么需要它：真实数据快照里当前**没有明确重置信号**，信号区一直处于冷状态，
 * 评审者无法判断「有明确预告时」这个最关键、风险最高的形态到底长什么样。
 *
 * 因此这里用**构造样例推文**驱动同一套渲染逻辑，产出信号醒目态的原型页。
 * 硬约束：
 *   1) 样例推文只存在于本脚本内存里，**不写入 data/**，不污染产品数据；
 *   2) 原型页顶部必须有一条醒目的「演示数据」声明，避免被误当成真实预告；
 *   3) 复用 scripts/render.mjs，不另写一套渲染 —— 否则原型与产品会漂移。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChartData } from '../src/lib/chart-data.js';
import { predictAll } from '../src/lib/predict.mjs';
import { detectSignals } from '../src/lib/signals.mjs';
import { renderAll } from './render.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = async (p) => JSON.parse(await readFile(resolve(ROOT, p), 'utf8'));

const [resets, tweets, statsFile, template] = await Promise.all([
  read('data/resets.json'),
  read('data/tweets.json'),
  read('data/stats.json'),
  readFile(resolve(ROOT, 'src/index.html'), 'utf8'),
]);

const now = Date.now();

/**
 * 构造样例。刻意避开会造成并列的时间表达（例如同时出现 tomorrow 与某个星期几），
 * 让「时间窗口」这一栏的评审结果不被选取规则的细节干扰。
 * 同时保留一条反例：讲发布延期但含 next week 的推文，必须不报成信号。
 */
const DEMO = [
  {
    id: '9100000000000000001',
    account: 'thsottiaux',
    kind: 'reset',
    created_at: new Date(now - 2 * 3600e3).toISOString(),
    text: "Quick heads up: I'm going to reset everyone's usage limits tomorrow. Have a good one.",
  },
];

const cases = [
  {
    file: 'signal-explicit.html',
    title: '信号原型 · 明确预告',
    note: '构造样例：含「reset + 明天」的明确预告，展示信号区醒目态与双时区换算。',
    tweets: [...DEMO, ...tweets.tweets],
  },
  {
    file: 'signal-hint.html',
    title: '信号原型 · 仅线索（不作为信号展示）',
    note:
      '构造样例：只有额度意图、没有可解析的未来时间。此状态**不得**升级为重置信号，' +
      '正确表现是信号区保持冷状态、不制造焦虑。',
    tweets: [
      {
        id: '9100000000000000002',
        account: 'thsottiaux',
        kind: 'other',
        created_at: new Date(now - 5 * 3600e3).toISOString(),
        text: 'We have been thinking a lot about how usage limits should work for heavy users.',
      },
      ...tweets.tweets,
    ],
  },
];

const chartData = buildChartData(resets.records, now);
if (!chartData) throw new Error('记录不足，无法构建原型');

const prediction = predictAll(resets.records, { now });

await mkdir(resolve(ROOT, 'prototype'), { recursive: true });

const banner = (title, note) => `
<div style="background:#B3563C;color:#fff;padding:12px 18px;font:13px/1.6 -apple-system,'PingFang SC',sans-serif;
     display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;position:sticky;top:0;z-index:99">
  <b style="letter-spacing:.04em">原型演示页 · 非真实数据</b>
  <span style="opacity:.92">${title} —— ${note}</span>
  <span style="opacity:.72;margin-left:auto">M1 评审用 · 由 scripts/make-prototype.mjs 生成</span>
</div>`;

for (const c of cases) {
  const signals = detectSignals(c.tweets, { now, account: 'thsottiaux' });
  const model = { ...chartData, generatedAt: statsFile.generated_at ?? new Date(now).toISOString() };
  const parts = renderAll(model, prediction, signals);

  let html = template;
  for (const [key, value] of Object.entries(parts)) {
    const token = `<!--__${key.toUpperCase()}__-->`;
    if (!html.includes(token)) throw new Error(`模板缺少占位符 ${token}`);
    html = html.replace(token, () => value);
  }
  const leftover = html.match(/<!--__[A-Z_]+__-->/g);
  if (leftover) throw new Error(`存在未替换的占位符：${leftover.join(', ')}`);

  // 顶部声明插入在 <body> 之后
  html = html.replace('<body>', `<body>${banner(c.title, c.note)}`);

  const out = resolve(ROOT, 'prototype', c.file);
  await writeFile(out, html, 'utf8');

  const top = signals.signals[0] ?? signals.hints[0];
  console.log(
    `✓ prototype/${c.file}  信号=${signals.level}  时间窗口=${
      top?.window ? top.window.sourceZone : '—'
    }`
  );
}
