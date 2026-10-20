import { analyzeTweet, detectProgram, contradictsConfirmedHistory } from './signals.mjs';

const DAY_MS = 86_400_000;
const TRUSTED_SOURCES = new Set(['timeline-browser', 'with-replies']);
const STATUS_LABELS = {
  confirmed: '已到账',
  pending: '待落地',
  updated: '日程更新',
  'elapsed-no-record': '暂无记录',
  future: '待观察',
};

function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcMidnight(date) {
  return Date.parse(`${date}T00:00:00.000Z`);
}

function utcLabel(date) {
  return date.slice(5).replace('-', '/');
}

function weekday(date) {
  return (new Date(`${date}T00:00:00.000Z`).getUTCDay() + 6) % 7;
}

function identityFromUrl(url, account) {
  if (typeof url !== 'string' || !url) return null;
  let pathname;
  try {
    pathname = new URL(url, 'https://x.com').pathname;
  } catch {
    return null;
  }
  const match = pathname.match(/\/([^/]+)\/status\/(\d+)/i) ?? pathname.match(/\/status\/(\d+)/i);
  if (!match) return null;
  return `${(match[2] ? match[1] : account).toLowerCase()}/${match[2] ?? match[1]}`;
}

function idIdentity(id, account) {
  return id == null || String(id).trim() === '' ? null : `${account}/${String(id)}`;
}

function sourceIdentities(item, account) {
  const identities = new Set();
  const id = idIdentity(item?.id, account);
  if (id) identities.add(id);
  for (const url of [item?.url, ...(Array.isArray(item?.confirmation_urls) ? item.confirmation_urls : [])]) {
    const identity = identityFromUrl(url, account);
    if (identity) identities.add(identity);
  }
  return identities;
}

function sameSource(a, b) {
  for (const identity of a) if (b.has(identity)) return true;
  return false;
}

function trustedTweet(tweet, account) {
  return tweet?.id != null && tweet.author_verified !== false &&
    String(tweet.account ?? '').replace(/^@/, '').toLowerCase() === account &&
    TRUSTED_SOURCES.has(tweet.foundVia) && timestamp(tweet.created_at) != null;
}

function eligibleTweets(tweets, account, now) {
  return (tweets ?? []).filter((tweet) => {
    const createdAt = timestamp(tweet?.created_at);
    return trustedTweet(tweet, account) && createdAt <= now;
  });
}

function matchEvidence(evidence, tweets, account) {
  const expectedId = evidence?.id == null ? null : String(evidence.id);
  const expectedUrlId = identityFromUrl(evidence?.url, account);
  return tweets.find((tweet) => {
    if (expectedId && String(tweet.id) !== expectedId) return false;
    if (expectedUrlId && !sameSource(sourceIdentities(tweet, account), new Set([expectedUrlId]))) return false;
    return Boolean(expectedId || expectedUrlId);
  }) ?? null;
}

function uniqueEvents(records, account, now) {
  const sorted = (records ?? [])
    .filter((record) => ['reset', 'credit'].includes(record?.type))
    .map((record) => ({ record, at: timestamp(record?.first_confirmed_at || record?.announced_at), sources: sourceIdentities(record, account) }))
    .filter((event) => event.at != null && event.at <= now)
    .sort((a, b) => a.at - b.at || String(a.record.id ?? '').localeCompare(String(b.record.id ?? '')));

  const events = [];
  for (const event of sorted) {
    const matches = events.filter((existing) => sameSource(existing.sources, event.sources));
    if (matches.length) {
      const duplicate = matches[0];
      for (const merged of [event, ...matches.slice(1)]) for (const source of merged.sources) duplicate.sources.add(source);
      for (const merged of matches.slice(1)) events.splice(events.indexOf(merged), 1);
      continue;
    }
    events.push(event);
  }
  return events;
}

function detailKey(item, account) {
  const urlSource = identityFromUrl(item?.url, account);
  return urlSource ?? idIdentity(item?.id, account) ?? `${item?.createdAt ?? item?.confirmedAt ?? ''}|${item?.text ?? ''}`;
}

function addDetail(cell, detail, account) {
  const key = detailKey(detail, account);
  let current = cell.detailMap.get(key);
  if (!current) {
    current = { ...detail, roles: [] };
    cell.detailMap.set(key, current);
  }
  for (const role of detail.roles ?? []) {
    if (!current.roles.includes(role)) current.roles.push(role);
  }
  for (const [name, value] of Object.entries(detail)) {
    if (name !== 'roles' && value !== undefined && (current[name] == null || name === 'text' && !current[name])) {
      current[name] = value;
    }
  }
  return current;
}

function sourceTweetForEvent(event, tweets, account, context) {
  return tweets.find((tweet) => sameSource(event.sources, sourceIdentities(tweet, account)) &&
    !contradictsConfirmedHistory(tweet, { account, tweets: context })) ?? null;
}

/**
 * 预告、完成与日程帖常跨日发布，按真实 UTC 日期落格，不凭 Day N 猜完成归属。
 */
export function buildResetCalendar({ records = [], tweets = [], signals, now = Date.now(), account = 'thsottiaux' } = {}) {
  const currentTime = timestamp(now);
  const normalizedAccount = String(account ?? 'thsottiaux').replace(/^@/, '').toLowerCase();
  const allTweets = (tweets ?? []).filter((tweet) => timestamp(tweet?.created_at) != null && timestamp(tweet.created_at) <= currentTime);
  const trusted = eligibleTweets(allTweets, normalizedAccount, currentTime);
  // 日历保留历史事实，不跟随按洛杉矶时间到期的未来规则一同消失。
  const program = signals?.program ?? trusted.map((tweet) => ({ tweet, hit: detectProgram(tweet.text) }))
    .filter((item) => item.hit).sort((a, b) => timestamp(b.tweet.created_at) - timestamp(a.tweet.created_at))
    .map(({ tweet, hit }) => ({ ...hit, announcedAt: tweet.created_at, url: tweet.url }))[0];
  const days = Number(program?.days);
  const programAnnouncedAt = timestamp(program?.announcedAt);
  if (currentTime == null || !Number.isInteger(days) || days < 1 || days > 62 || programAnnouncedAt == null) return null;

  const dayOne = trusted
    .filter((tweet) => timestamp(tweet.created_at) >= programAnnouncedAt && /\bDay\s*1\s*\//i.test(tweet.text ?? ''))
    .sort((a, b) => timestamp(a.created_at) - timestamp(b.created_at) || String(a.id).localeCompare(String(b.id)))[0];
  if (!dayOne) return null;

  const fromDate = utcDate(timestamp(dayOne.created_at));
  const toDate = utcDate(utcMidnight(fromDate) + (days - 1) * DAY_MS);
  const startWeekday = weekday(fromDate);
  const dateToIndex = new Map();
  const builders = Array.from({ length: days }, (_, index) => {
    const date = utcDate(utcMidnight(fromDate) + index * DAY_MS);
    dateToIndex.set(date, index);
    return {
      date,
      label: utcLabel(date),
      weekday: weekday(date),
      status: null,
      statusLabel: null,
      confirmedCount: 0,
      resetCount: 0,
      creditCount: 0,
      datedCount: 0,
      pendingCount: 0,
      updatedCount: 0,
      detailMap: new Map(),
    };
  });

  let confirmedCount = 0;
  let resetCount = 0;
  let creditCount = 0;
  for (const event of uniqueEvents(records, normalizedAccount, currentTime)) {
    const matched = trusted.filter((tweet) => sameSource(event.sources, sourceIdentities(tweet, normalizedAccount)));
    if (matched.length && matched.every((tweet) => contradictsConfirmedHistory(tweet, { account: normalizedAccount, tweets: allTweets }))) continue;
    const index = dateToIndex.get(utcDate(event.at));
    if (index == null) continue;
    const cell = builders[index];
    cell.confirmedCount++;
    cell[event.record.type === 'credit' ? 'creditCount' : 'resetCount']++;
    confirmedCount++;
    if (event.record.type === 'credit') creditCount++;
    else resetCount++;
    const sourceTweet = sourceTweetForEvent(event, trusted, normalizedAccount, allTweets);
    addDetail(cell, {
      id: event.record.id == null ? sourceTweet?.id ?? null : String(event.record.id),
      url: event.record.url ?? sourceTweet?.url ?? null,
      text: sourceTweet?.text ?? event.record.text ?? '',
      createdAt: sourceTweet?.created_at ?? event.record.announced_at,
      confirmedAt: new Date(event.at).toISOString(),
      type: event.record.type,
      roles: ['confirmed'],
    }, normalizedAccount);
  }

  let datedCount = 0;
  let pendingCount = 0;
  const seenForecasts = new Set();
  for (const forecast of signals?.forecasts ?? []) {
    if (forecast?.level !== 'explicit') continue;
    const forecastType = forecast.window ? 'dated' : forecast.timing === 'pending' ? 'pending' : null;
    if (!forecastType) continue;
    for (const evidence of forecast.evidence ?? []) {
      const tweet = matchEvidence(evidence, trusted, normalizedAccount);
      if (!tweet) continue;
      const analysis = analyzeTweet(tweet, { account: normalizedAccount, tweets: allTweets });
      if (analysis.level !== 'explicit') continue;
      const id = String(tweet.id);
      const deDupeKey = `${forecastType}/${id}`;
      if (seenForecasts.has(deDupeKey)) continue;
      seenForecasts.add(deDupeKey);
      const createdAt = timestamp(tweet.created_at);
      const index = dateToIndex.get(utcDate(createdAt));
      if (index == null) continue;
      const cell = builders[index];
      if (forecastType === 'dated') {
        cell.datedCount++;
        datedCount++;
      } else {
        cell.pendingCount++;
        pendingCount++;
      }
      addDetail(cell, {
        id,
        url: tweet.url ?? evidence.url ?? null,
        text: tweet.text ?? evidence.text ?? '',
        createdAt: new Date(createdAt).toISOString(),
        forecastType,
        window: analysis.window ? { from: analysis.window.from, to: analysis.window.to } : null,
        roles: ['forecast'],
      }, normalizedAccount);
    }
  }

  let updatedCount = 0;
  const dayPost = /\bDay\s*(\d+)\s*\//i;
  for (const tweet of trusted) {
    const match = String(tweet.text ?? '').match(dayPost);
    if (!match) continue;
    const createdAt = timestamp(tweet.created_at);
    const index = dateToIndex.get(utcDate(createdAt));
    if (index == null) continue;
    const cell = builders[index];
    const key = detailKey(tweet, normalizedAccount);
    const alreadyUpdated = cell.detailMap.get(key)?.roles.includes('updated');
    if (!alreadyUpdated) {
      cell.updatedCount++;
      updatedCount++;
    }
    addDetail(cell, {
      id: String(tweet.id),
      url: tweet.url ?? null,
      text: tweet.text ?? '',
      createdAt: new Date(createdAt).toISOString(),
      dayNumber: Number(match[1]),
      roles: ['updated'],
    }, normalizedAccount);
  }

  const today = utcDate(currentTime);
  const todayIndex = dateToIndex.get(today);
  const progressDay = todayIndex == null ? (today < fromDate ? 0 : days) : todayIndex + 1;
  const cells = builders.map((cell) => {
    const { detailMap, ...plain } = cell;
    const details = [...detailMap.values()].sort((a, b) =>
      timestamp(a.confirmedAt ?? a.createdAt) - timestamp(b.confirmedAt ?? b.createdAt) ||
      String(a.id ?? '').localeCompare(String(b.id ?? '')));
    if (cell.confirmedCount) plain.status = 'confirmed';
    else if (cell.datedCount || cell.pendingCount) plain.status = 'pending';
    else if (cell.updatedCount) plain.status = 'updated';
    else if (utcMidnight(cell.date) + DAY_MS <= currentTime) plain.status = 'elapsed-no-record';
    else plain.status = 'future';
    plain.statusLabel = STATUS_LABELS[plain.status];
    plain.isToday = cell.date === today;
    plain.details = details;
    plain.sourceUrl = details.find((detail) => detail.roles.includes('confirmed'))?.url ??
      details.find((detail) => detail.roles.includes('forecast'))?.url ??
      details.find((detail) => detail.roles.includes('updated'))?.url ?? null;
    return plain;
  });

  return {
    title: `${days}天重置日历`,
    zone: 'UTC',
    fromDate,
    toDate,
    days,
    progressDay,
    startWeekday,
    confirmedCount,
    resetCount,
    creditCount,
    datedCount,
    pendingCount,
    updatedCount,
    weeks: Array.from({ length: Math.ceil(days / 7) }, (_, index) => cells.slice(index * 7, (index + 1) * 7)),
    cells,
    sourceUrl: dayOne.url ?? null,
    programUrl: program.url ?? null,
  };
}
