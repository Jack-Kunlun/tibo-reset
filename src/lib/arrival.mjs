import { analyzeTweet, contradictsConfirmedHistory } from './signals.mjs';

const TRUSTED_SOURCES = new Set(['timeline-browser', 'with-replies']);
const DEFAULT_ACCOUNT = 'thsottiaux';

function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

function statusIdentity(value, account) {
  if (typeof value !== 'string' || !value) return null;
  let pathname;
  try {
    pathname = new URL(value, 'https://x.com').pathname;
  } catch {
    return null;
  }
  const match = pathname.match(/\/([^/]+)\/status\/(\d+)/i) ??
    pathname.match(/\/status\/(\d+)/i);
  if (!match) return null;
  return `${(match[2] ? match[1] : account).toLowerCase()}/${match[2] ?? match[1]}`;
}

function idIdentity(id, account) {
  return id == null || String(id).trim() === '' ? null : `${account}/${String(id)}`;
}

function recordSources(record, account) {
  const sources = new Set();
  const id = idIdentity(record?.id, account);
  if (id) sources.add(id);
  for (const url of [record?.url, ...(Array.isArray(record?.confirmation_urls) ? record.confirmation_urls : [])]) {
    const identity = statusIdentity(url, account);
    if (identity) sources.add(identity);
  }
  return sources;
}

function tweetSources(tweet, account) {
  const sources = new Set();
  const id = idIdentity(tweet?.id, account);
  if (id) sources.add(id);
  const identity = statusIdentity(tweet?.url, account);
  if (identity) sources.add(identity);
  return sources;
}

function intersects(a, b) {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

function trustedTweet(tweet, account) {
  return tweet?.id != null && tweet.author_verified === true &&
    String(tweet.account ?? '').replace(/^@/, '').toLowerCase() === account &&
    TRUSTED_SOURCES.has(tweet.foundVia);
}

function eventId(record, account) {
  if (record?.id != null) return String(record.id);
  for (const source of recordSources(record, account)) {
    const id = source.slice(source.lastIndexOf('/') + 1);
    if (id) return id;
  }
  return null;
}

function uniqueEvents(records, account, asOf) {
  const sorted = (records ?? [])
    .filter((record) => ['reset', 'credit'].includes(record?.type))
    .map((record) => ({ record, at: timestamp(record?.first_confirmed_at || record?.announced_at), sources: recordSources(record, account) }))
    .filter((event) => event.at != null && event.at <= asOf)
    .sort((a, b) => a.at - b.at || String(a.record.id ?? '').localeCompare(String(b.record.id ?? '')));

  const events = [];
  for (const event of sorted) {
    const matches = events.filter((existing) => intersects(existing.sources, event.sources));
    if (matches.length) {
      const same = matches[0];
      for (const merged of [event, ...matches.slice(1)]) for (const source of merged.sources) same.sources.add(source);
      for (const merged of matches.slice(1)) events.splice(events.indexOf(merged), 1);
      continue;
    }
    events.push(event);
  }
  return events;
}

/**
 * 以可信作者原帖配对既有完成记录与此前的第一条明确预告，统计预告到确认的耗时。
 * 这里的重置记录仅作为历史标签；本函数不创建或修改任何事件。
 */
export function deriveAnnouncementDelay(records = [], opts = {}) {
  if (!Array.isArray(opts.tweets)) return null;
  const account = String(opts.account ?? DEFAULT_ACCOUNT).replace(/^@/, '').toLowerCase();
  const asOf = timestamp(opts.asOf ?? opts.now ?? Date.now());
  if (asOf == null) return null;

  const visibleTweets = opts.tweets.filter((tweet) => {
    const createdAt = timestamp(tweet?.created_at);
    return createdAt != null && createdAt <= asOf;
  });
  const trusted = visibleTweets
    .filter((tweet) => trustedTweet(tweet, account))
    .sort((a, b) => timestamp(a.created_at) - timestamp(b.created_at) ||
      String(a.id ?? '').localeCompare(String(b.id ?? '')));
  // 旧确认基线可保留，但可信原文明示仍在预告时，不能把上游误记当完成标签。
  const events = uniqueEvents(records, account, asOf).filter((event) => {
    const matched = trusted.filter((tweet) => intersects(event.sources, tweetSources(tweet, account)));
    return !matched.length || matched.some((tweet) => !contradictsConfirmedHistory(tweet, { account, tweets: visibleTweets }));
  });
  const samples = [];

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const confirmedTweet = trusted.find((tweet) => intersects(event.sources, tweetSources(tweet, account)) &&
      !contradictsConfirmedHistory(tweet, { account, tweets: visibleTweets }));
    if (!confirmedTweet) continue;

    const previousConfirmation = events[index - 1]?.at ?? -Infinity;
    const firstAnnouncement = trusted.find((tweet) => {
      const createdAt = timestamp(tweet.created_at);
      if (createdAt <= previousConfirmation || createdAt >= event.at) return false;
      return analyzeTweet(tweet, { account, tweets: visibleTweets }).level === 'explicit';
    });
    if (!firstAnnouncement) continue;

    const announcedAt = timestamp(firstAnnouncement.created_at);
    const analysis = analyzeTweet(firstAnnouncement, { account, tweets: visibleTweets });
    if (analysis.window) {
      const from = timestamp(analysis.window.from);
      const to = timestamp(analysis.window.to);
      if (from == null || to == null || event.at < from || event.at > to) continue;
    }

    samples.push({
      announcementId: String(firstAnnouncement.id),
      announcedAt: new Date(announcedAt).toISOString(),
      eventId: eventId(event.record, account),
      confirmedAt: new Date(event.at).toISOString(),
      delayMs: event.at - announcedAt,
    });
  }

  if (!samples.length) return null;
  const delays = samples.map((sample) => sample.delayMs).sort((a, b) => a - b);
  const middle = Math.floor(delays.length / 2);
  const medianMs = delays.length % 2
    ? delays[middle]
    : (delays[middle - 1] + delays[middle]) / 2;
  return {
    method: 'first-announcement-to-confirmation',
    sampleCount: samples.length,
    samples,
    medianMs,
    minMs: delays[0],
    maxMs: delays.at(-1),
  };
}
