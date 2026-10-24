import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const translations = JSON.parse(readFileSync(new URL('./tweet-translations.json', import.meta.url), 'utf8'));

/** 原文发生编辑时停止展示旧译文；译文只用于阅读，不参与重置判断。 */
export function translationFor(item, cachedEntries = {}) {
  const id = String(item?.id ?? '').replace(/^.*\/status\//, '');
  const curated = translations[id];
  for (const copy of [curated, cachedEntries?.[id]]) {
    if (!copy || typeof item?.text !== 'string' || createHash('sha256').update(item.text).digest('hex') !== copy.sourceHash) continue;
    if (typeof copy.text !== 'string' || !copy.text.trim() || copy.text.length > 20_000) continue;
    if (copy !== curated && (copy.provider !== 'mymemory' || copy.language !== 'zh-CN')) continue;
    return { language: 'zh-CN', text: copy.text, sourceHash: copy.sourceHash,
      ...(copy !== curated ? { provider: 'mymemory' } : {}) };
  }
  return null;
}

/** API、快照与网页都在判定结束后补阅读译文，避免两端各持一套翻译。 */
export function withTweetTranslations(value, cachedEntries = {}) {
  if (Array.isArray(value)) return value.map((item) => withTweetTranslations(item, cachedEntries));
  if (!value || typeof value !== 'object') return value;
  const translated = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'translation')
    .map(([key, item]) => [key, withTweetTranslations(item, cachedEntries)]));
  const translation = translationFor(value, cachedEntries);
  if (translation) translated.translation = translation;
  return translated;
}
