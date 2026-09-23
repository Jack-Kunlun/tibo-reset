#!/usr/bin/env node
/**
 * 只生成小程序首屏快照（`miniprogram/data/snapshot.js`），**不碰 `dist/`、
 * 不碰 `miniprogram/utils/scene.js`**。
 *
 * 为什么需要它、而不是直接跑 `scripts/build.mjs`：两条约束夹出来的 ——
 *
 *   1. 快照**不入库**，而 `miniprogram/utils/api.js` 在**模块顶层** import 它，
 *      所以任何要加载小程序代码的入口（`npm test`、`npm run preview:mp`、
 *      微信开发者工具）都得先有它；
 *   2. `npm run test` 必须跑在完整构建**之前** —— 否则 test-shared 要比对的
 *      `miniprogram/utils/scene.js` 刚被构建覆盖，那条检查恒真、等于没有
 *      （`.github/workflows/collect.yml` 的「校验」一步有注释）。
 *
 * 所以只能给快照一条独立的、轻量的生成路径。它是 `npm test` 的前置
 * （`package.json` 的 `pretest`），也可以单独跑：
 *
 *   node scripts/build-snapshot.mjs
 *   BUILD_NOW=2026-09-23T02:00:00Z node scripts/build-snapshot.mjs
 *
 * ⚠ 它**不校验** dist 与页面 —— 只是把这一份产物补上。完整构建仍走
 * `node scripts/build.mjs`（`npm run build`）。
 */
import { buildSnapshot, resolveBuildNow, writeSnapshot, SNAPSHOT_REL } from '../src/lib/snapshot.mjs';

const ACCOUNT = process.env.SOURCE_ACCOUNT ?? 'thsottiaux';
const now = resolveBuildNow(process.env.BUILD_NOW);

if (process.env.BUILD_NOW) {
  console.log(`▸ 构建时刻已固定为 ${new Date(now).toISOString()}（BUILD_NOW）`);
}

const bytes = await writeSnapshot(await buildSnapshot({ account: ACCOUNT, now }));
console.log(
  `✓ ${SNAPSHOT_REL}  ${(bytes / 1024).toFixed(1)} KB  含预测与信号（仅此一份产物，未重建 dist）`
);
