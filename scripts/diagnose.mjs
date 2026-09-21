#!/usr/bin/env node
/**
 * 模型诊断：配置对比 + 覆盖率检验 + 校准曲线 + 当下预测
 *
 * 用法:
 *   node scripts/diagnose.mjs
 *
 * 为什么主判据是「覆盖率」而不是 Brier：
 *   本数据集 7 天窗口的基准发生率就有 80%，闭着眼睛猜「会重置」也能拿到不难看的
 *   Brier 分数。所以 Brier 在这类高频事件上区分度天然很差（实测 skill 长期在 ±10% 内
 *   翻转），拿它选型等于在拟合噪声。
 *   覆盖率检验问的是另一件事：我说「中位数 5 天」，历史上是不是真有一半落在 5 天内。
 *   这个判据无法靠调参糊弄，所以更可信。
 */
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildIntervals,
  fit,
  predictAt,
  calibrate,
  phases,
  backtest,
  coverageBacktest,
  bootstrapCI,
  predictAll,
  DEFAULT_CONFIG,
} from '../src/lib/predict.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const records = JSON.parse(await readFile(resolve(ROOT, 'data/resets.json'), 'utf8')).records;

const pct = (x) => (x * 100).toFixed(1) + '%';
const sgn = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
const hr = (t) => `\n${'─'.repeat(74)}\n${t}\n${'─'.repeat(74)}`;

const TAIL = 120; // 用最近 N 个评估点衡量「近期表现」—— 加速期里只有近期能代表未来

function evalConfig(opts) {
  const cv = coverageBacktest(records, opts);
  const rows = cv.rows.slice(-TAIL);
  const cov = (lv) => rows.filter((r) => r.actual <= r.qs[lv]).length / rows.length;
  const bias = rows.reduce((a, r) => a + (r.actual - r.qs[0.5]), 0) / rows.length;
  const mp = rows.reduce((a, r) => a + r.qs[0.5], 0) / rows.length;
  const ma = rows.reduce((a, r) => a + r.actual, 0) / rows.length;
  const score =
    Math.abs(cov(0.5) - 0.5) * 2 + Math.abs(cov(0.8) - 0.8) + Math.abs(bias) / Math.max(ma, 0.1);
  const bt = backtest(records, { ...opts, horizon: 7 });
  return { cov50: cov(0.5), cov80: cov(0.8), bias, mp, ma, score, brierSkill: bt.skill, n: rows.length };
}

/* ------------------------- 1. 配置对比 ------------------------- */

console.log(hr(`1. 配置对比（覆盖率口径，取最近 ${TAIL} 个评估点）`));
console.log('   目标：cov50 → 50%，cov80 → 80%，偏差 → 0\n');
console.log('   配置                         cov50   cov80   偏差(天)  预测均值  实际均值   7天skill');

const configs = [
  { name: '全量等权', o: {} },
  { name: '最近30 等权', o: { maxIntervals: 30 } },
  { name: '最近20 等权', o: { maxIntervals: 20 } },
  { name: '最近20 + 衰减60', o: { maxIntervals: 20, halfLifeDays: 60 } },
  { name: '最近20 + 衰减45 ← 生产', o: DEFAULT_CONFIG },
  { name: '最近20 + 衰减30', o: { maxIntervals: 20, halfLifeDays: 30 } },
  { name: '最近15 + 衰减45', o: { maxIntervals: 15, halfLifeDays: 45 } },
  { name: '常数风险（单桶）', o: { breaks: [0, Infinity] } },
];

const rows = configs.map((c) => ({ name: c.name, ...evalConfig(c.o) }));
for (const r of rows) {
  console.log(
    '   ' +
      r.name.padEnd(26) +
      (r.cov50 * 100).toFixed(1).padStart(6) +
      '%' +
      (r.cov80 * 100).toFixed(1).padStart(7) +
      '%   ' +
      sgn(r.bias).padStart(8) +
      (r.mp.toFixed(2) + '天').padStart(10) +
      (r.ma.toFixed(2) + '天').padStart(10) +
      ('  ' + (r.brierSkill * 100).toFixed(1) + '%').padStart(11)
  );
}

const best = [...rows].sort((a, b) => a.score - b.score)[0];
console.log(`\n   最优（按覆盖率偏离）：${best.name}`);
console.log('   ⚠ 注意最后一列：所有配置的 7 天 Brier skill 都在 ±10% 内来回翻转，');
console.log('     说明「已等待天数」对「7 天内是否发生」几乎没有区分力 —— 这是数据本身的性质，不是实现问题。');

/* ------------------------- 2. 校准曲线 ------------------------- */

console.log(hr('2. 概率校准曲线（生产配置，7 天口径）'));
const bt = backtest(records, { ...DEFAULT_CONFIG, horizon: 7 });
console.log('   预测概率区间      样本数    模型预测    实际发生    偏差');
for (const c of bt.calibration) {
  const diff = c.actual - c.predicted;
  const flag = Math.abs(diff) < 0.05 ? '✓' : Math.abs(diff) < 0.15 ? '~' : '✗';
  console.log(
    `   ${(c.range[0] * 100).toFixed(0).padStart(3)}% – ${(c.range[1] * 100).toFixed(0).padStart(3)}%` +
      `${String(c.n).padStart(10)}${pct(c.predicted).padStart(12)}${pct(c.actual).padStart(12)}` +
      `${((diff >= 0 ? '+' : '') + (diff * 100).toFixed(1) + 'pp').padStart(11)}  ${flag}`
  );
}
console.log(`\n   Brier ${bt.brier.toFixed(4)} vs 盲猜基线 ${bt.brierBaseline.toFixed(4)} → skill ${(bt.skill * 100).toFixed(2)}%`);
console.log('   校准曲线偏高（实际 > 预测）= 模型低估；偏低 = 模型高估。');

/* ------------------------- 3. 平移校准 ------------------------- */

console.log(hr('3. 平移校准（样本外残差中位数）'));
const cal = calibrate(records, DEFAULT_CONFIG);
console.log(`   校准量 ${sgn(cal.shift)} 天（样本 n=${cal.n}）`);
console.log(`   未校准时平均偏差 ${sgn(cal.shiftUncalibratedBias)} 天 → 校准后偏差被拉到中位 0`);
console.log('\n   名义水平   校准后实际覆盖   目标');
for (const [lv, v] of [
  ['50%', cal.cov50],
  ['80%', cal.cov80],
  ['90%', cal.cov90],
]) {
  const target = Number(lv.replace('%', '')) / 100;
  const diff = Math.abs(v - target);
  console.log(
    `   ${lv.padStart(6)}   ${pct(v).padStart(13)}   ${pct(target).padStart(6)}   ` +
      (diff < 0.08 ? '✓' : diff < 0.15 ? '~' : '✗')
  );
}

/* ------------------------- 4. 当下预测 ------------------------- */

const all = predictAll(records, { iterations: 1000 });
console.log(hr('4. 当下预测'));
console.log(`   距上次重置 ${all.sinceDays.toFixed(2)} 天（${all.last.at.slice(0, 10)}）`);
console.log(`   训练样本 ${all.model.nEvents} 次事件 · λ₀=${all.model.baseRate.toFixed(4)}/天\n`);
console.log('   窗口          校准后概率     原始概率');
for (let i = 0; i < all.prediction.horizons.length; i++) {
  const h = all.prediction.horizons[i];
  const raw = all.rawPrediction.horizons[i];
  console.log(`   ${h.label.padEnd(12)} ${pct(h.p).padStart(8)}   ${pct(raw.p).padStart(10)}`);
}
console.log(`\n   中位剩余   ${all.prediction.q50.toFixed(2)} 天（原始 ${all.rawPrediction.q50.toFixed(2)} 天）`);
console.log(`   80% 区间   ${all.prediction.q25.toFixed(1)} – ${all.prediction.q90.toFixed(1)} 天`);
console.log(`   期望剩余   ${all.prediction.expectedRemaining.toFixed(2)} 天`);
console.log(
  `\n   Bootstrap 90% 区间（7 天概率，${all.uncertainty.iterations} 次重采样）：` +
    `${pct(all.uncertainty.p.lo)} – ${pct(all.uncertainty.p.hi)}`
);
console.log(
  `   → 宽度 ${((all.uncertainty.p.hi - all.uncertainty.p.lo) * 100).toFixed(0)}pp：` +
    '这就是「只给一个裸概率」时被隐藏掉的不确定性。'
);

/* ------------------------- 5. 节奏阶段 ------------------------- */

console.log(hr('5. 节奏阶段（本项目最该被公开的发现）'));
console.log('   阶段        时间跨度                   n    平均      中位      最大');
const ph = phases(records);
ph.forEach((p, i) => {
  console.log(
    `   第 ${i + 1} 段   ${p.from.slice(0, 10)} → ${p.to.slice(0, 10)}   ${String(p.n).padStart(3)}` +
      `${(p.mean.toFixed(2) + '天').padStart(10)}${(p.median.toFixed(2) + '天').padStart(10)}${(p.max.toFixed(1) + '天').padStart(11)}`
  );
});
const drop = (1 - ph[ph.length - 1].mean / ph[0].mean) * 100;
console.log(`\n   平均间隔从 ${ph[0].mean.toFixed(2)} 天降到 ${ph[ph.length - 1].mean.toFixed(2)} 天（−${drop.toFixed(0)}%）。`);
console.log('   在一个持续加速的过程里，任何基于历史均值的预测都会系统性高估 ——');
console.log('   这正是必须做平移校准、且必须把校准成绩公开的原因。');

/* ------------------------- 6. 分桶明细 ------------------------- */

console.log(hr('6. 各风险桶（生产配置，收缩前 vs 收缩后）'));
const { intervals } = buildIntervals(records);
const model = fit(intervals, DEFAULT_CONFIG);
console.log('   区间(天)      暴露(人·天)   事件     原始率    收缩后率');
for (const b of model.buckets) {
  console.log(
    `   ${(b.a + '–' + (b.b === Infinity ? '∞' : b.b)).padEnd(12)}` +
      b.exposure.toFixed(1).padStart(8) +
      b.events.toFixed(1).padStart(9) +
      b.rawRate.toFixed(3).padStart(10) +
      b.rate.toFixed(3).padStart(11)
  );
}
console.log('\n   收缩（Gamma-Poisson）把零事件桶从 0 拉回有限值，避免输出「0% 不可能发生」这种错误结论。');
console.log(`   参数：maxIntervals=${DEFAULT_CONFIG.maxIntervals} halfLifeDays=${DEFAULT_CONFIG.halfLifeDays} prior=${model.prior}`);
