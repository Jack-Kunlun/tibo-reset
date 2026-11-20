#!/usr/bin/env node
/** 将已确认的 11 月 13 日储备重置卡更正为发券类型；默认只预览。 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BANKED_RESET_CORRECTION = Object.freeze({
  entryId: '60f081ed-c1c3-451d-877c-fdf599ebaf65',
  tweetId: '2120999993079451919',
  title: '储备重置卡已到账（banked reset）',
  sourceUrl: 'https://x.com/thsottiaux/status/2120999993079451919',
  from: 'reset',
  to: 'credit',
});

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function apiUrl(baseUrl) {
  let base;
  try { base = new URL(baseUrl); }
  catch { throw new Error('--url 必须是网页的 http(s) 根地址'); }
  requireCondition(['http:', 'https:'].includes(base.protocol), '--url 只支持 http(s)');
  requireCondition(!base.username && !base.password && !base.search && !base.hash,
    '--url 不能包含凭据、查询参数或片段');
  return new URL('/api/manage', base);
}

async function jsonResponse(response, label) {
  let body;
  try { body = await response.json(); }
  catch { throw new Error(`${label} 返回了无效 JSON（HTTP ${response.status}）`); }
  if (!response.ok) {
    const suffix = Number.isSafeInteger(body?.revision) ? `；当前 revision=${body.revision}` : '';
    throw new Error(`${label} 失败（HTTP ${response.status}）${body?.error ? `：${body.error}` : ''}${suffix}`);
  }
  return body;
}

function targetEntry(entries, target) {
  requireCondition(Array.isArray(entries), '管理接口没有返回 entries');
  const matches = entries.filter((entry) => entry.id === target.entryId || String(entry.tweetId ?? '') === target.tweetId);
  requireCondition(matches.length === 1, `目标账本必须且只能有一条匹配记录（当前 ${matches.length} 条）`);
  const entry = matches[0];
  requireCondition(entry.id === target.entryId && String(entry.tweetId ?? '') === target.tweetId,
    '目标 entryId 与 tweetId 不在同一条账本记录中');
  requireCondition(entry.status === 'landed', `目标状态不是 landed（当前 ${entry.status}）`);
  requireCondition(entry.title === target.title && entry.sourceUrl === target.sourceUrl,
    '目标标题或原帖地址与预期不一致');
  requireCondition(['reset', 'credit'].includes(entry.eventType), '目标 eventType 无效');
  return entry;
}

function editableEntry(entry, target) {
  const result = { ...entry, eventType: target.to };
  delete result.createdAt;
  delete result.updatedAt;
  return result;
}

/** 可注入 fetch 以便在隔离的本机管理接口上演练。 */
export async function correctBankedReset({ baseUrl, apply = false, fetchImpl = fetch, target = BANKED_RESET_CORRECTION }) {
  requireCondition(typeof baseUrl === 'string' && baseUrl.trim(), '必须显式提供 --url 网页根地址');
  const endpoint = apiUrl(baseUrl.trim());
  const before = await jsonResponse(await fetchImpl(endpoint, { headers: { accept: 'application/json' } }),
    '读取手动账本');
  requireCondition(Number.isSafeInteger(before.revision) && before.revision >= 0, '管理接口 revision 无效');
  const entry = targetEntry(before.entries, target);

  if (entry.eventType === target.to) return { status: 'already-correct', revision: before.revision, entry };
  requireCondition(entry.eventType === target.from, `拒绝覆盖意外类型：预期 ${target.from}，实际 ${entry.eventType}`);

  const update = editableEntry(entry, target);
  if (!apply) return { status: 'dry-run', revision: before.revision, before: entry, update };

  const result = await jsonResponse(await fetchImpl(endpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ revision: before.revision, action: 'save', entry: update }),
  }), '保存账本更正');
  requireCondition(result.entry?.id === target.entryId && result.entry?.eventType === target.to &&
    String(result.entry?.tweetId ?? '') === target.tweetId, '保存结果与目标不符');
  return { status: 'updated', revision: result.revision, entry: result.entry };
}

function parseArgs(args) {
  const options = { apply: false, baseUrl: null };
  for (const arg of args) {
    if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--url=')) options.baseUrl = arg.slice('--url='.length);
    else throw new Error(`未知参数：${arg}`);
  }
  requireCondition(options.baseUrl, '用法：node scripts/correct-banked-reset.mjs --url=https://网页域名 [--apply]');
  return options;
}

function invokedDirectly() {
  return Boolean(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url);
}

if (invokedDirectly()) {
  try {
    const result = await correctBankedReset(parseArgs(process.argv.slice(2)));
    if (result.status === 'dry-run') {
      console.log(JSON.stringify({ status: result.status, revision: result.revision,
        entryId: result.before.id, tweetId: result.before.tweetId,
        from: result.before.eventType, to: result.update.eventType }, null, 2));
      console.log('预览模式未写入。确认无误后，显式追加 --apply 执行更正。');
    } else if (result.status === 'already-correct') {
      console.log('账本已经是发券类型，无需更改。');
    } else {
      console.log(JSON.stringify({ status: result.status, revision: result.revision,
        entryId: result.entry.id, tweetId: result.entry.tweetId,
        from: BANKED_RESET_CORRECTION.from, to: result.entry.eventType }, null, 2));
    }
  } catch (error) {
    console.error(`更正失败：${error.message}`);
    process.exitCode = 1;
  }
}
