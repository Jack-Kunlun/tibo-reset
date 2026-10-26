import { analyzeTweet, detectProgram, contradictsConfirmedHistory, confirmedResetEvent } from './signals.mjs';
import { programPostCopy, programFollowup } from './program-copy.mjs';
import { attachTranslations, translationIndex } from './tweet-translations.mjs';

const DAY_MS = 86_400_000;
const TRUSTED_SOURCES = new Set(['timeline-browser', 'with-replies']);
const STATUS_LABELS = {
  confirmed: '已到账',
  observed: '实测到账',
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
  if (tweet?.manualDecision?.lead === true && tweet.foundVia === 'manual') return timestamp(tweet.created_at) != null;
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
    (event.record.manual || !contradictsConfirmedHistory(tweet, { account, tweets: context }))) ?? null;
}

function linkedProgramPost(tweet, posts, trusted, account, requireApi = false) {
  const seen = new Set([String(tweet.id)]);
  let node = tweet;
  for (let depth = 0; depth < 4; depth++) {
    if (node.author_verified !== true) return null;
    const ref = node.quotedTweet ?? (node.inReplyTo?.verified === true ? node.inReplyTo : null);
    if (!ref || String(ref.account ?? '').replace(/^@/, '').toLowerCase() !== account) return null;
    if (requireApi && (ref.verified !== true || ref.verificationSource !== 'tweet-detail-api')) return null;
    const clean = (text) => String(text ?? '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
    const matches = trusted.filter((parent) => parent.author_verified === true &&
      (ref.id ? String(parent.id) === String(ref.id) :
        parent.created_at === ref.created_at && clean(parent.text) === clean(ref.text)));
    if (matches.length !== 1) return null;
    const parent = matches[0];
    const age = timestamp(node.created_at) - timestamp(parent.created_at);
    if (seen.has(String(parent.id)) || age <= 0 || age > DAY_MS ||
        ref.created_at && timestamp(ref.created_at) !== timestamp(parent.created_at) ||
        ref.text && clean(ref.text) !== clean(parent.text)) return null;
    seen.add(String(parent.id));
    const post = posts.find((item) => String(item.tweet.id) === String(parent.id));
    if (post) return post;
    node = parent;
  }
  return null;
}

function assignUnlinkedProgramEvents({ events, posts, trusted, allTweets, account, programId }) {
  // 手动裁定只影响是否到账；匹配窗口仍读原文，不能把裁定后的 occurred 反推成预告。
  const originals = allTweets.filter((tweet) => tweet.author_verified === true &&
    String(tweet.account ?? '').replace(/^@/, '').toLowerCase() === account && TRUSTED_SOURCES.has(tweet.foundVia) &&
    tweet.manualDecision?.status !== 'ignored').map(({ manualDecision, ...tweet }) => tweet);
  const originalById = new Map();
  for (const tweet of originals) {
    const id = String(tweet.id);
    originalById.set(id, originalById.has(id) ? null : tweet);
  }
  const candidates = new Map();
  for (const tweet of trusted) {
    const original = originalById.get(String(tweet.id));
    if (!original) continue;
    const analysis = analyzeTweet(original, { account, tweets: originals });
    if (analysis.level !== 'explicit' || !analysis.window ||
        !['instant', 'day', 'evening'].includes(analysis.precision)) continue;
    const candidateRoot = posts.find((post) => String(post.tweet.id) === String(tweet.id) && !post.followup) ??
      linkedProgramPost(original, posts.filter((post) => !post.followup), originals, account, true);
    if (!candidateRoot) continue;
    const key = String(candidateRoot.tweet.id);
    const group = candidates.get(key) ?? { anchor: candidateRoot, promises: [] };
    group.promises.push({ tweet: original, window: analysis.window });
    candidates.set(key, group);
  }
  const directlyAssigned = new Set(posts.flatMap((post) => post.events));
  for (const event of events) {
    if (directlyAssigned.has(event) || event.record.programId) continue;
    const sourceTweets = trusted.filter((tweet) => tweet.author_verified === true && sameSource(event.sources, sourceIdentities(tweet, account)));
    // 日期相近本身不是归属。公开记录须有可信完成原帖；独立手工到账则由维护者明确确认。
    if (!event.record.manual && !sourceTweets.some((tweet) => confirmedResetEvent(tweet, { account, tweets: allTweets }))) continue;
    if (sourceTweets.some((tweet) => /\bDay\s*\d+(?:\.\d+|\s*\([^)]*\))?\s*\//i.test(tweet.text ?? ''))) continue;
    if (sourceTweets.some((tweet) => [tweet.quotedTweet, tweet.inReplyTo].some((ref) =>
      String(ref?.account ?? '').toLowerCase() === account))) continue;
    const matches = [...candidates.values()].filter(({ anchor, promises }) => {
      if (event.record.manual && events.some((other) => other !== event && other.record.manual &&
          other.record.programId === programId && other.record.programDay === anchor.day)) return false;
      // 只在同一承诺内合并同秒的人工确认与公开完成，其他承诺即使同刻也独立保留。
      if (posts.some((post) => String(post.followup?.anchorId ?? post.tweet.id) === String(anchor.tweet.id) &&
          post.events.some((other) => !other.record.manual &&
            (other.at < event.at || other.at === event.at && !event.record.manual)))) return false;
      // 自回复补充的具体截止点优先；不能在错过截止后退回主帖较宽的全天窗口。
      const latest = promises.filter(({ tweet }) => timestamp(tweet.created_at) <= event.at)
        .sort((a, b) => timestamp(b.tweet.created_at) - timestamp(a.tweet.created_at))[0];
      return latest && timestamp(latest.window.from) <= event.at && event.at <= timestamp(latest.window.to);
    });
    if (matches.length !== 1) continue;
    const { anchor } = matches[0];
    event.record = { ...event.record, programId, programDay: anchor.day,
      programAssignmentSource: 'announcement-window', programAnchorId: String(anchor.tweet.id) };
    event.assignmentSource = 'announcement-window';
    event.anchorId = String(anchor.tweet.id);
    if (!event.record.manual) {
      const tweet = sourceTweets[0];
      posts.push({ tweet, day: anchor.day, followup: { title: '后续确认额度重置已完成', anchorId: String(anchor.tweet.id) },
        sources: sourceIdentities(tweet, account), events: [event] });
    }
  }
}

function buildProgramPlan({ trusted, allTweets, events, account, program, dayOne, signals }) {
  const programId = String(program.id ?? dayOne.id ?? '');
  const observations = new Map((signals?.accountObservations ?? []).map((o) => [String(o.announcementId), o]));
  const overdueIds = new Set((signals?.overdueForecasts ?? []).flatMap((f) => (f.evidence ?? []).map((e) => String(e.id))));
  // 原帖编号是活动日序；补发、跨 UTC 日与子编号都不能被日期运算挪到另一天。
  const posts = [];
  const seen = new Set();
  for (const tweet of [...trusted].sort((a, b) => timestamp(a.created_at) - timestamp(b.created_at))) {
    const match = String(tweet.text ?? '').match(/\bDay\s*(\d+)(?:\.\d+|\s*\([^)]*\))?\s*\//i);
    const followup = match ? null : programFollowup(tweet, trusted);
    const day = Number(match?.[1] ?? followup?.day);
    if ((!match && !followup) || day < 1 || day > program.days || timestamp(tweet.created_at) < timestamp(dayOne.created_at) || seen.has(String(tweet.id))) continue;
    seen.add(String(tweet.id));
    posts.push({ tweet, day, followup, sources: sourceIdentities(tweet, account), events: [] });
  }
  // 新的完成帖可沿已核验引用/自我回复链归日，不要求继续人工维护历史编号映射。
  for (const tweet of trusted) {
    if (seen.has(String(tweet.id)) || !events.some((event) => sameSource(event.sources, sourceIdentities(tweet, account)))) continue;
    const anchor = linkedProgramPost(tweet, posts, trusted, account);
    if (!anchor) continue;
    seen.add(String(tweet.id));
    posts.push({ tweet, day: anchor.day, followup: { title: '后续确认额度重置已完成', anchorId: String(anchor.tweet.id) },
      sources: sourceIdentities(tweet, account), events: [] });
  }
  posts.sort((a, b) => timestamp(a.tweet.created_at) - timestamp(b.tweet.created_at));
  for (const event of events) {
    const eventProgramId = event.record.manual && event.record.programId != null
      ? String(event.record.programId) : null;
    const eventProgramDay = event.record.manual && Number.isInteger(event.record.programDay)
      ? event.record.programDay : null;
    // 手动归属是显式选择的活动日，不能被关联推文的其他 Day 编号挪走，也不能跨活动串入。
    if (eventProgramId && (eventProgramId !== programId || eventProgramDay < 1 || eventProgramDay > program.days)) continue;
    const matches = posts.filter((post) => sameSource(post.sources, event.sources) &&
      (!eventProgramDay || post.day === eventProgramDay) &&
      (event.record.manual || !contradictsConfirmedHistory(post.tweet, { account, tweets: allTweets })));
    const direct = sourceIdentities({ id: event.record.id, url: event.record.url }, account);
    const directMatches = matches.filter((post) => sameSource(post.sources, direct));
    const candidates = directMatches.length ? directMatches : matches;
    const primary = new Set(candidates.map((post) => post.day)).size === 1 ? candidates[0] : null;
    // 确认记录只按原帖身份关联，不把同一天的无关重置拼到活动日上。
    if (primary) {
      primary.events.push(event);
      event.anchorId = String(primary.followup?.anchorId ?? primary.tweet.id);
      if (event.record.manual && !event.record.programId) {
        const anchorId = String(primary.followup?.anchorId ?? primary.tweet.id);
        event.record = { ...event.record, programId, programDay: primary.day,
          programAssignmentSource: 'source', programAnchorId: anchorId };
        event.assignmentSource = 'source';
        event.anchorId = anchorId;
      }
    }
  }
  assignUnlinkedProgramEvents({ events, posts, trusted, allTweets, account, programId });
  posts.sort((a, b) => timestamp(a.tweet.created_at) - timestamp(b.tweet.created_at));
  const assignedManualProgramEvents = events.filter((event) => event.record.manual &&
    String(event.record.programId ?? '') === programId && Number.isInteger(event.record.programDay) &&
    event.record.programDay >= 1 && event.record.programDay <= program.days);
  const settledProgramDays = new Set(assignedManualProgramEvents.filter((event) => !event.record.programAssignmentSource)
    .map((event) => event.record.programDay));
  // 手动选定某活动日后，该日后续被采集到的公开到账别名归并为同一笔，避免日计划双计。
  for (const day of new Set(assignedManualProgramEvents.map((event) => event.record.programDay))) {
    for (const post of posts) {
      if (post.day !== day) continue;
      const manualEvents = assignedManualProgramEvents.filter((event) => event.record.programDay === day &&
        (!event.record.programAssignmentSource || event.record.programAnchorId === String(post.followup?.anchorId ?? post.tweet.id)));
      if (!manualEvents.length) continue;
      const isAssignedManualEvent = (event) => event.record.manual &&
        manualEvents.includes(event);
      for (const event of post.events) {
        if (!isAssignedManualEvent(event)) {
          event.suppressedByManualProgramDay = true;
          if (manualEvents.length === 1) event.coveredByManualEntryId = manualEvents[0].record.manualEntryId;
        }
      }
      post.events = post.events.filter(isAssignedManualEvent);
    }
  }
  const settledPosts = new Set(posts.filter((post) => post.events.length && post.followup?.anchorId)
    .map((post) => post.followup.anchorId));
  for (const event of assignedManualProgramEvents) if (event.record.programAnchorId) settledPosts.add(String(event.record.programAnchorId));
  const assignedEvents = posts.flatMap((post) => post.events);
  for (const post of posts) if (assignedEvents.some((event) => sameSource(event.sources, post.sources))) settledPosts.add(String(post.tweet.id));
  // 进度徽标只表示可信原帖推进到哪一天；人工归属只改变当天确认状态。
  const latestDay = Math.max(0, ...posts.map((post) => post.day));
  const rows = Array.from({ length: Number(program.days) }, (_, index) => {
    const day = index + 1;
    const dayPosts = posts.filter((post) => post.day === day);
    const entries = dayPosts.map(({ tweet, followup, events: confirmed }) => {
      const copy = programPostCopy(tweet);
      const analysis = analyzeTweet(tweet, { account, tweets: allTweets });
      const observation = !confirmed.length && !settledPosts.has(String(tweet.id)) ? observations.get(String(tweet.id)) : null;
      let kind = copy.kind;
      const programSettled = settledProgramDays.has(day);
      if (confirmed.length) kind = confirmed.some((event) => event.record.type === 'reset') ? 'reset' : 'credit';
      else if (analysis.level === 'explicit') kind = 'announcement';
      else if (analysis.level === 'occurred') kind = 'announcement';
      if (tweet.manualDecision?.status === 'ignored') kind = 'note';
      // 只撤下同一来源/会话已兑现的等待标记，保留当天其他尚未兑现的承诺。
      if ((settledPosts.has(String(tweet.id)) || programSettled) && ['announcement', 'reset-unconfirmed'].includes(kind)) kind = copy.kind === 'update' ? 'update' : 'note';
      return {
        id: String(tweet.id), url: tweet.url ?? null, text: tweet.text ?? '',
        awaitingVerification: !observation && !confirmed.length && !settledPosts.has(String(tweet.id)) && !programSettled && overdueIds.has(String(tweet.id)),
        isAccountObserved: Boolean(observation),
        ...(observation ? { observedAt: observation.observedAt, observationPrecision: observation.precision, sourceLabel: observation.sourceLabel } : {}),
        createdAt: tweet.created_at, day, kind, title: confirmed.length && followup ? followup.title : copy.title,
        isUpdate: copy.kind === 'update',
        confirmedAt: confirmed.length ? new Date(Math.min(...confirmed.map((event) => event.at))).toISOString() : null,
        resetCount: confirmed.filter((event) => event.record.type === 'reset').length,
        creditCount: confirmed.filter((event) => event.record.type === 'credit').length,
      };
    });
    const manualEventsShown = dayPosts.flatMap((post) => post.events)
      .filter((event) => event.record.manual && String(event.record.programId ?? '') === programId && event.record.programDay === day);
    const hasManualEventEntry = manualEventsShown.length > 0;
    const standaloneManualEvents = hasManualEventEntry ? [] : assignedManualProgramEvents.filter((event) => event.record.programDay === day);
    for (const event of standaloneManualEvents) {
      entries.push({
        id: String(event.record.manualEntryId ?? event.record.id), url: event.record.url ?? null,
        text: event.record.text ?? '手动确认重置已到账', title: event.record.text ?? '手动确认重置已到账',
        createdAt: new Date(event.at).toISOString(), confirmedAt: new Date(event.at).toISOString(),
        day, kind: event.record.type === 'credit' ? 'credit' : 'reset', isUpdate: false,
        awaitingVerification: false, isAccountObserved: false,
        resetCount: event.record.type === 'reset' ? 1 : 0,
        creditCount: event.record.type === 'credit' ? 1 : 0,
        manual: true,
        sourceLabel: '手动确认',
      });
    }
    const updateCount = entries.filter((entry) => entry.isUpdate).length;
    const resetCount = entries.reduce((total, entry) => total + entry.resetCount, 0);
    const creditCount = entries.reduce((total, entry) => total + entry.creditCount, 0);
    const confirmedCount = resetCount + creditCount;
    const observedCount = entries.filter((entry) => entry.isAccountObserved).length;
    let status, statusLabel;
    if (confirmedCount && updateCount) { status = 'mixed'; statusLabel = '更新与重置'; }
    else if (confirmedCount) { status = 'confirmed'; statusLabel = '确认重置'; }
    else if (observedCount) { status = 'observed'; statusLabel = '实测到账'; }
    else if (entries.some((entry) => entry.kind === 'announcement')) { status = 'pending'; statusLabel = entries.some((entry) => entry.awaitingVerification) ? '落地待核实' : updateCount ? '更新与重置预告' : '重置预告'; }
    else if (updateCount) { status = 'updated'; statusLabel = '发布更新'; }
    else if (entries.length) { status = 'noted'; statusLabel = '当日动态'; }
    else if (day <= latestDay) { status = 'missing'; statusLabel = '未见公告'; }
    else { status = 'future'; statusLabel = '待更新'; }
    return { day, status, statusLabel, updateCount, resetCount, creditCount, confirmedCount, observedCount,
      date: entries[0]?.createdAt ?? null, sourceUrl: entries.at(-1)?.url ?? null, entries };
  });
  return {
    title: `Tibo ${program.days} 天计划`, programId, days: Number(program.days), latestDay,
    reportedDays: new Set(posts.map((post) => post.day)).size,
    updatedDays: rows.filter((row) => row.updateCount).length,
    resetDays: rows.filter((row) => row.confirmedCount).length,
    sourceUrl: program.url ?? null,
    fromDate: utcDate(timestamp(dayOne.created_at)),
    toDate: utcDate(utcMidnight(utcDate(timestamp(dayOne.created_at))) + (Number(program.days) - 1) * DAY_MS),
    eventAssignments: events.flatMap((event) => {
      const days = new Set(posts.filter((post) => post.events.includes(event)).map((post) => post.day));
      const explicitDay = event.record.programId === programId ? event.record.programDay : null;
      if (explicitDay) days.add(explicitDay);
      if (days.size !== 1) return [];
      return [{ recordId: String(event.record.id), day: [...days][0],
        ...(event.record.manualEntryId ? { manualEntryId: event.record.manualEntryId } : {}),
        ...(event.anchorId || event.record.programAnchorId ? { anchorId: event.anchorId ?? event.record.programAnchorId } : {}),
        source: event.assignmentSource ?? event.record.programAssignmentSource ?? (event.record.manual && explicitDay ? 'manual' : 'source') }];
    }),
    eventAliases: events.filter((event) => event.coveredByManualEntryId).map((event) => ({
      recordId: String(event.record.id), manualEntryId: event.coveredByManualEntryId,
      urls: [...new Set([event.record.url, ...(event.record.confirmation_urls ?? [])].filter(Boolean))],
    })),
    rows,
  };
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
    .map(({ tweet, hit }) => ({ ...hit, id: String(tweet.id), announcedAt: tweet.created_at, url: tweet.url }))[0];
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
      observedCount: 0,
      resetCount: 0,
      creditCount: 0,
      datedCount: 0,
      pendingCount: 0,
      overdueCount: 0,
      updatedCount: 0,
      detailMap: new Map(),
    };
  });

  let confirmedCount = 0;
  let resetCount = 0;
  let creditCount = 0;
  const events = uniqueEvents(records, normalizedAccount, currentTime).filter((event) => {
    if (event.record.manual) return true;
    const matched = trusted.filter((tweet) => sameSource(event.sources, sourceIdentities(tweet, normalizedAccount)));
    return !matched.length || !matched.every((tweet) => contradictsConfirmedHistory(tweet, { account: normalizedAccount, tweets: allTweets }));
  });
  // 先按可信 Day/回复链完成活动计划归属，再将同一活动日的手动到账与公开完成合并。
  const plan = buildProgramPlan({ trusted, allTweets, events, account: normalizedAccount, program, dayOne, signals });
  const calendarEvents = events.filter((event) => !event.suppressedByManualProgramDay);
  for (const event of calendarEvents) {
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
      manual: Boolean(event.record.manual),
      timePrecision: event.record.manualAccountObservation ? 'approximate-minute' : 'minute',
      type: event.record.type,
      roles: ['confirmed'],
    }, normalizedAccount);
  }

  let observedCount = 0;
  for (const observation of signals?.accountObservations ?? []) {
    const tweet = trusted.find((t) => String(t.id) === String(observation.announcementId));
    const observedAt = timestamp(observation.observedAt);
    if (!tweet || observedAt == null || observedAt > currentTime) continue;
    const index = dateToIndex.get(utcDate(observedAt));
    if (index == null) continue;
    const cell = builders[index];
    cell.observedCount++; observedCount++;
    addDetail(cell, { id: String(tweet.id), url: tweet.url ?? null, text: tweet.text ?? '',
      createdAt: tweet.created_at, observedAt: observation.observedAt,
      observationPrecision: observation.precision, sourceLabel: observation.sourceLabel,
      roles: ['observed'] }, normalizedAccount);
  }

  let datedCount = 0;
  let pendingCount = 0;
  const seenForecasts = new Set();
  for (const forecast of [...(signals?.forecasts ?? []), ...(signals?.overdueForecasts ?? [])]) {
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
      if (forecast.status === 'overdue') cell.overdueCount++;
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
        awaitingVerification: forecast.status === 'overdue',
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
    else if (cell.observedCount) plain.status = 'observed';
    else if (cell.datedCount || cell.pendingCount) plain.status = 'pending';
    else if (cell.updatedCount) plain.status = 'updated';
    else if (utcMidnight(cell.date) + DAY_MS <= currentTime) plain.status = 'elapsed-no-record';
    else plain.status = 'future';
    plain.statusLabel = plain.status === 'pending' && cell.overdueCount === cell.datedCount + cell.pendingCount ? '落地待核实' : STATUS_LABELS[plain.status];
    plain.isToday = cell.date === today;
    plain.details = details;
    plain.sourceUrl = details.find((detail) => detail.roles.includes('confirmed'))?.url ??
      details.find((detail) => detail.roles.includes('observed'))?.url ??
      details.find((detail) => detail.roles.includes('forecast'))?.url ??
      details.find((detail) => detail.roles.includes('updated'))?.url ?? null;
    return plain;
  });

  return {
    title: `${days}天重置日历`,
    hasManual: records.some((record) => record.manual),
    zone: 'UTC',
    fromDate,
    toDate,
    days,
    progressDay,
    startWeekday,
    observedCount,
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
    plan,
  };
}

/**
 * 给日历结果**补上译文**（与信号层同一套机制）。
 *
 * 日历里的两条展示位都带原文：
 *   · `plan.rows[].entries[]` —— 28 天计划的每日条目；
 *   · `cells[].details[]` —— 月历里每一天的明细。
 * 两处都是**新造的对象**，不补就都没有译文。
 *
 * @param {object} calendar buildResetCalendar 的产物
 * @param {Array} tweets 原始推文数组（译文挂在上面）
 * @returns {object} 补过译文的新对象
 */
export function withCalendarTranslations(calendar, tweets) {
  const index = translationIndex(tweets);
  if (index.size === 0) return calendar;
  return attachTranslations(calendar, index);
}
