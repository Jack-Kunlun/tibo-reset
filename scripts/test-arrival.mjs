#!/usr/bin/env node
import assert from 'node:assert/strict';

import { deriveAnnouncementDelay } from '../src/lib/arrival.mjs';
import { derive } from '../src/lib/page.mjs';
import { predictAll } from '../src/lib/predict.mjs';
import { analyzeTweet } from '../src/lib/signals.mjs';

const ACCOUNT = 'thsottiaux';
const url = (id) => `https://x.com/${ACCOUNT}/status/${id}`;
const event = (id, at, extra = {}) => ({
  id,
  announced_at: at,
  type: 'reset',
  url: url(id),
  text: 'Reset all propagated.',
  ...extra,
});
const post = (id, at, text, extra = {}) => ({
  id,
  account: ACCOUNT,
  created_at: at,
  url: url(id),
  text,
  author_verified: true,
  foundVia: 'timeline-browser',
  ...extra,
});
const at = (iso) => Date.parse(iso);
const AS_OF = at('2026-10-02T14:00:00.000Z');

// 反例：选最新预告会得到 a-later，限制 24 小时会截短结果；把同一别名事件
// 的重复上游时间戳当成第二次落地，还会把 a-pending 错计成新样本。
// 正确行为必须保留更早的第一条预告、完整 35 小时耗时，并把别名事件只计一次。
const longDelayRecords = [
  event('100', '2026-10-01T00:00:00.000Z'),
  event('101', '2026-10-02T12:00:00.000Z', {
    confirmation_urls: [url('102')],
  }),
  event('102', '2026-10-02T13:00:00.000Z'),
  event('103', '2026-10-03T12:00:00.000Z'),
];
const longDelayTweets = [
  post('100', '2026-10-01T00:00:00.000Z', 'Reset all propagated.'),
  post('a-first', '2026-10-01T01:00:00.000Z', 'Day 1/ Reset'),
  post('a-later', '2026-10-01T02:00:00.000Z', 'Day 2/ Reset'),
  post('102', '2026-10-02T12:00:00.000Z', 'Reset all propagated.'),
  post('a-pending', '2026-10-02T12:30:00.000Z', 'Day 3/ Reset'),
  post('103', '2026-10-03T12:00:00.000Z', 'Reset all propagated.'),
];
const longDelay = deriveAnnouncementDelay(longDelayRecords, {
  tweets: longDelayTweets,
  account: ACCOUNT,
  asOf: AS_OF,
});
assert.equal(longDelay.sampleCount, 1, '同一落地事件只应生成一个历史样本，未来事件不应参与');
assert.equal(longDelay.samples[0].announcementId, 'a-first', '必须配对区间内第一条明确预告');
assert.equal(longDelay.samples[0].eventId, '101');
assert.equal(longDelay.samples[0].delayMs, 35 * 60 * 60 * 1000, '不得截断超过 24 小时的真实等待');
assert.equal(longDelay.medianMs, 35 * 60 * 60 * 1000);
assert.equal(longDelay.minMs, longDelay.maxMs);

// 明确的时间窗口必须包含完成时刻；不能跳过较早的不匹配预告，改用较晚一条凑样本。
const windowRecords = [
  event('window-base', '2026-10-01T00:00:00.000Z'),
  event('window-done', '2026-10-04T12:00:00.000Z'),
];
const windowTweets = [
  post('window-base', '2026-10-01T00:00:00.000Z', 'Reset all propagated.'),
  post('window-first', '2026-10-01T08:00:00.000Z', 'A reset is coming tomorrow.'),
  post('window-later', '2026-10-03T08:00:00.000Z', 'A reset is coming tomorrow.'),
  post('window-done', '2026-10-04T12:00:00.000Z', 'Reset all propagated.'),
];
assert.equal(analyzeTweet(windowTweets[1], { account: ACCOUNT }).level, 'explicit');
assert.equal(analyzeTweet(windowTweets[1], { account: ACCOUNT }).window.to, '2026-10-03T06:59:00.000Z');
assert.equal(deriveAnnouncementDelay(windowRecords, {
  tweets: windowTweets,
  account: ACCOUNT,
  asOf: at('2026-10-05T00:00:00.000Z'),
}), null, '未落入第一条预告窗口时不能用后续预告替换');

const validWindowRecords = [
  event('valid-base', '2026-10-03T00:00:00.000Z'),
  event('valid-done', '2026-10-04T12:00:00.000Z', { type: 'credit' }),
];
const validWindowTweets = [
  post('valid-base', '2026-10-03T00:00:00.000Z', 'Reset all propagated.'),
  post('valid-first', '2026-10-03T08:00:00.000Z', 'A reset is coming tomorrow.'),
  post('valid-done', '2026-10-04T12:00:00.000Z', 'Reset all propagated.'),
];
assert.equal(deriveAnnouncementDelay(validWindowRecords, {
  tweets: validWindowTweets,
  account: ACCOUNT,
  asOf: at('2026-10-05T00:00:00.000Z'),
}).sampleCount, 1, '落在明确预告窗口内的完成事件应计入');

// 错作者、未核验作者、低可信采集来源和 hint 都不能充当预告；事件自身也须有可信原帖。
const rejectedRecords = [
  event('reject-base', '2026-10-01T00:00:00.000Z'),
  event('reject-done', '2026-10-02T12:00:00.000Z'),
];
const rejectedTweets = [
  post('reject-base', '2026-10-01T00:00:00.000Z', 'Reset all propagated.'),
  post('wrong-account', '2026-10-01T01:00:00.000Z', 'Day 1/ Reset', { account: 'someone-else' }),
  post('unverified', '2026-10-01T02:00:00.000Z', 'Day 2/ Reset', { author_verified: false }),
  post('legacy-source', '2026-10-01T03:00:00.000Z', 'Day 3/ Reset', { foundVia: 'timeline' }),
  post('hint-only', '2026-10-01T04:00:00.000Z', 'We should update usage limits tomorrow.'),
  post('reject-done', '2026-10-02T12:00:00.000Z', 'Reset all propagated.'),
];
assert.equal(analyzeTweet(rejectedTweets[4], { account: ACCOUNT }).level, 'hint');
assert.equal(deriveAnnouncementDelay(rejectedRecords, {
  tweets: rejectedTweets,
  account: ACCOUNT,
  asOf: AS_OF,
}), null);
assert.equal(deriveAnnouncementDelay(rejectedRecords, {
  tweets: [
    rejectedTweets[0],
    post('trusted-forecast', '2026-10-01T01:00:00.000Z', 'Day 1/ Reset'),
    post('reject-done', '2026-10-02T12:00:00.000Z', 'Reset all propagated.', { author_verified: false }),
  ],
  account: ACCOUNT,
  asOf: AS_OF,
}), null, '没有可信完成原帖的历史标签不能生成样本');

// 预测对象是唯一新增承载点；不传 tweets 的旧 CLI 调用保持原形。
const predictionRecords = [
  event('prediction-base', '2026-10-01T00:00:00.000Z'),
  event('prediction-done', '2026-10-02T12:00:00.000Z'),
];
const predictionTweets = [
  post('prediction-base', '2026-10-01T00:00:00.000Z', 'Reset all propagated.'),
  post('prediction-forecast', '2026-10-01T01:00:00.000Z', 'Day 1/ Reset'),
  post('prediction-done', '2026-10-02T12:00:00.000Z', 'Reset all propagated.'),
];
const prediction = predictAll(predictionRecords, {
  now: AS_OF,
  tweets: predictionTweets,
  account: ACCOUNT,
  iterations: 2,
});
assert.equal(prediction.announcementDelay.sampleCount, 1);
assert.equal(Object.hasOwn(predictAll(predictionRecords, { now: AS_OF, iterations: 2 }), 'announcementDelay'), false);

const page = derive({
  resets: { records: predictionRecords },
  tweets: { tweets: predictionTweets, updated_at: '2026-10-02T14:00:00.000Z' },
  statsFile: { generated_at: '2026-10-02T14:00:00.000Z', errors: [] },
  now: AS_OF,
  account: ACCOUNT,
});
assert.equal(page.prediction.announcementDelay.sampleCount, 1, 'derive 必须把原始 tweets 与 account 传给预测统计');

console.log('arrival: 预告后到账耗时与预测接线回归通过');

const badLabelRecords = [event('baseline', '2026-10-01T00:00:00Z'), event('still-coming', '2026-10-02T12:00:00Z')];
const badLabelTweets = [post('baseline', '2026-10-01T00:00:00Z', 'Reset all propagated.'),
  post('first-coming', '2026-10-01T01:00:00Z', 'A reset is coming.'),
  post('still-coming', '2026-10-02T12:00:00Z', 'A reset is coming.')];
assert.equal(deriveAnnouncementDelay(badLabelRecords, {tweets:badLabelTweets,now:AS_OF}), null, '原文明示预告的误标完成不能训练');
for (const text of ['The reset is in progress.', 'The reset is cancelled.', 'A reset is planned but not available yet.']) {
  assert.equal(deriveAnnouncementDelay(badLabelRecords,{tweets:[...badLabelTweets.slice(0,2),{...badLabelTweets[2],text}],now:AS_OF}),null,`进行中或否定完成不能训练：${text}`);
}
const firstConfirmed = deriveAnnouncementDelay([
  event('baseline', '2026-10-01T00:00:00Z'),
  event('done-first', '2026-10-02T01:00:00Z', {first_confirmed_at:'2026-10-01T23:00:00Z'}),
], {tweets:[badLabelTweets[0],post('early-forecast','2026-10-01T20:00:00Z','A reset is coming.'),post('done-first','2026-10-02T01:00:00Z','Reset all propagated.')],now:AS_OF});
assert.equal(firstConfirmed.medianMs, 3*3_600_000, '耗时取首次确认时刻');
assert.equal(deriveAnnouncementDelay([badLabelRecords[0], event('still-coming','2026-10-02T12:00:00Z',{first_confirmed_at:'2026-10-03T00:00:00Z'})], {tweets:badLabelTweets,now:AS_OF}),null,'未来首次确认不入样');
const bridged = deriveAnnouncementDelay([
  event('baseline','2026-10-01T00:00:00Z'),event('501','2026-10-02T12:00:00Z'),event('502','2026-10-02T13:00:00Z'),
  event('503','2026-10-02T13:30:00Z',{confirmation_urls:[url('501'),url('502')]}),
], {tweets:[badLabelTweets[0],badLabelTweets[1],post('501','2026-10-02T12:00:00Z','Reset all propagated.'),post('502','2026-10-02T13:00:00Z','Reset all propagated.')],now:AS_OF});
assert.equal(bridged.sampleCount,1,'晚到桥接来源必须合并此前两个别名组');
console.log('arrival: 误标、首次确认与传递别名反例通过');
