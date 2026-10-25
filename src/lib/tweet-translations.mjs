/**
 * 推文译文的数据层。
 *
 * ⭐ 为什么译文**挂在推文对象上**，而不是单独一个缓存文件：
 *
 * D-080 走过一遍失败。那版把译文放在 `data/translation-cache.json`，
 * 而 `POST /api/ingest` 的载荷契约只认 `resets / tweets / stats / signals / og`
 * —— 译文文件**根本不在契约里**，于是「本机译出来了，推不上去」，
 * 链路上多了一个断点，而断点的表现是**静默失败**（推成功、线上没变）。
 *
 * 译文若作为推文的一个字段（`tweet.translation`），就跟着 `tweets.tweets[]`
 * 一起进载荷 —— **不需要动 ingest 契约**，也就不存在新的断点。
 * 契约只管「形状对不对」，不管推文里多带什么字段。
 *
 * ⭐ 译文与原文**用 sha256 绑定**：
 *
 * 原文被编辑（作者改了帖、或采集侧补全了正文）后，旧译文就是**错的**。
 * 若只按推文 id 匹配，会把一份已经对不上的译文继续挂在页面上 ——
 * 那比没有译文更糟（读者会以为译文是原文的意思）。
 * 所以每条译文记下它翻译时那段原文的 sha256；读取时对不上就**当作没有译文**。
 *
 * 这条规则是**自动**的，不需要谁记得去清理：原文一变，哈希一变，译文失效。
 *
 * 译文**只用于阅读**，不参与任何判定（重置识别、窗口计算、计数）。
 * 数据层与展示层都不得因为译文的存在与否改变结论。
 */

import { createHash } from 'node:crypto';

/** 译文最长字数上限（与 D-080 一致）：正文最多 640 字符，译文不该比原文长太多 */
const MAX_TRANSLATION_LENGTH = 20_000;

/**
 * 原文的指纹。空串返回 null（没有原文就没有可绑定的译文）。
 *
 * 用 sha256 而不是 md5：这里要防的是「原文被悄悄改了还挂着旧译文」，
 * 不是对抗攻击，但既然要防，就用不会撞的口径。
 *
 * @param {unknown} text
 * @returns {string|null} 十六进制摘要，或 null
 */
export function sourceHash(text) {
  if (typeof text !== 'string' || !text) return null;
  // 归一化空白：采集侧同一段正文里的换行/连续空格会飘，
  // 不归一化就会把「只是空白变了」误判成「原文被编辑」→ 译文无故失效。
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * 一条译文是否可用。
 *
 * 三个条件缺一不可：
 *   ① 有非空译文文本；
 *   ② 长度不超限（超限的译文多半是模型跑飞了）；
 *   ③ **sha256 与当前原文对得上** —— 这是「原文被编辑后旧译文自动失效」的闸门。
 *
 * @param {object} item 推文对象（要含 text 与 translation）
 * @returns {boolean}
 */
export function hasValidTranslation(item) {
  const t = item?.translation;
  if (!t || typeof t !== 'object') return false;
  if (typeof t.text !== 'string' || !t.text.trim()) return false;
  if (t.text.length > MAX_TRANSLATION_LENGTH) return false;
  const expected = sourceHash(item.text);
  if (!expected) return false;
  return t.sourceHash === expected;
}

/**
 * 取出一条推文的译文（无效时返回 null）。
 *
 * @param {object} item
 * @returns {{text:string, sourceHash:string, language:string, provider?:string}|null}
 */
export function translationFor(item) {
  if (!hasValidTranslation(item)) return null;
  const t = item.translation;
  const out = { text: t.text.trim(), sourceHash: t.sourceHash, language: t.language ?? 'zh-CN' };
  // provider 只在明确标注时才带出去：没标就是「人工/agent 译文」，
  // 不标比标一个可能过时的机器翻译商更有意义。
  if (typeof t.provider === 'string' && t.provider.trim()) out.provider = t.provider.trim();
  return out;
}

/**
 * 给推文数组补译文 —— **只补，不改**。
 *
 * 刻意不删任何原字段：无译文就是无译文，不该留下一个空的 `translation: null`
 * 让下游以为「有译文但被过滤了」。
 *
 * @param {Array} tweets
 * @returns {Array} 新数组（元素为原对象或补了 translation 的副本）
 */
export function withTranslations(tweets) {
  if (!Array.isArray(tweets)) return tweets;
  return tweets.map((tweet) => {
    const t = translationFor(tweet);
    return t ? { ...tweet, translation: t } : tweet;
  });
}

/**
 * 把译文挂到**任意结构**里的推文上（信号证据、预告、计划条目…）。
 *
 * 为什么需要它：推文在数据层被加工成很多种形状（证据条目、预告条目、
 * 计划条目），加工时新造的对象**不带**原文那条推文上的附加字段。
 * 与其在每个加工点都记得补一遍译文（漏一处就是一处静默不一致），
 * 不如在**渲染前**统一扫一遍。
 *
 * 判据是「这个对象有 text，且它的 text 能匹配上某条译文的原文」——
 * 用**文本哈希**而不是推文 id 匹配，因为证据条目有时拿不到 id。
 *
 * @param {any} value 任意结构
 * @param {Map<string,object>} byText 原文 → 译文条目
 * @returns {any} 新结构
 */
export function attachTranslations(value, byText) {
  if (!byText || byText.size === 0) return value;
  if (Array.isArray(value)) return value.map((item) => attachTranslations(item, byText));
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = attachTranslations(item, byText);
  }

  // 本对象自己带原文 → 看能不能配上译文
  if (typeof value.text === 'string' && value.text.trim()) {
    const entry = byText.get(normalizeText(value.text));
    if (entry && (!value.translation || !hasValidTranslation({ ...value, translation: entry }))) {
      out.translation = { text: entry.text, sourceHash: entry.sourceHash, language: entry.language ?? 'zh-CN' };
    }
  }
  return out;
}

/**
 * 原文归一化（与 sourceHash 同一口径） */
function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 清掉**已失效**的译文（原文被编辑过 → 哈希对不上）。
 *
 * ⭐ 为什么需要这一步，而不能只靠「读取时判无效」：
 *
 * 译文是挂在推文对象上的**持久字段**，随 `tweets` 载荷一起推到线上。
 * 采集再次采到同一条推文、而作者恰好改了正文时，合并后的推文**正文是新的**、
 * `translation` 字段**还是旧的** —— 那个字段此刻是**过期资产**。
 *
 * 留着它有两个具体的坏处：
 *   ① 对外 API（`/api/state` 的 `tweets` 数组）原样吐出推文对象 ⇒
 *      下游看到「这条推文有译文」，而那条译文说的已经不是这句话了；
 *   ② 任何直接读 `tweet.translation.text` 的代码会拿到过期译文 ——
 *      展示层现在恰好都走 `translationIndex`（只收有效译文）所以没出事，
 *      但那是**巧合**，不是保证。
 *
 * 所以：**有效性由 sha256 说了算，对不上就把字段删掉**，
 * 让「推文对象上有 translation 字段」这句话本身成为可靠信号。
 *
 * 只删 `translation` 这一个字段，**不动其它任何字段** —— 采集侧的正文学段、
 * `text_full` 标记、核验过的引用关系都不受影响。
 *
 * @param {Array} tweets
 * @returns {Array} 新数组（元素为原对象或去掉失效译文的副本）
 */
export function pruneStaleTranslations(tweets) {
  if (!Array.isArray(tweets)) return tweets;
  let pruned = 0;
  const next = tweets.map((tweet) => {
    if (!tweet || typeof tweet !== 'object' || !tweet.translation) return tweet;
    if (hasValidTranslation(tweet)) return tweet;
    pruned++;
    const { translation, ...rest } = tweet;
    return rest;
  });
  if (pruned) return next;
  return tweets;
}

/**
 * 从推文数组建「原文 → 译文」索引。
 *
 * 用**原文文本**做键，而不是推文 id：信号证据、预告条目这些派生结构
 * 有的带 id、有的只有 text；按文本匹配才能全覆盖。
 * 代价是同一段原文若出现在两条推文上，只有一份译文 —— 但那本来就是同一句话，
 * 译文也该是同一份。
 *
 * @param {Array} tweets
 * @returns {Map<string,object>}
 */
export function translationIndex(tweets) {
  const map = new Map();
  for (const tweet of Array.isArray(tweets) ? tweets : []) {
    const t = translationFor(tweet);
    if (!t) continue;
    map.set(normalizeText(tweet.text), t);
  }
  return map;
}

/**
 * 有效译文内容的稳定指纹，用于缓存失效与客户端刷新。
 *
 * 条数相同不代表内容没变；同一条推文的译文被修订后也必须触发刷新。
 * 这里只纳入 translationIndex 实际接受的有效译文，并按归一化原文排序，
 * 避免不改变有效索引内容的采集数组重排造成无意义的指纹变化。
 *
 * @param {Array} tweets
 * @returns {string|0} 有译文时返回 SHA-256 十六进制摘要；无译文时返回 0
 */
export function translationFingerprint(tweets) {
  const index = translationIndex(tweets);
  if (index.size === 0) return 0;

  const canonical = [...index.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([original, translation]) => [
      original,
      translation.sourceHash,
      translation.text,
      translation.language,
      translation.provider ?? null,
    ]);

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * 给图表数据（历史记录）补译文。
 *
 * 历史记录来自 `data/resets.json`（上游镜像），它的 `text` 与推文正文
 * **大多数条目并不逐字相同** —— 上游会给同一条公告写出自己的摘要。
 * 所以这里按**归一化原文文本**匹配，匹配不上就不挂：
 *
 *   上游摘要与原文不同 ⇒ 那条摘要没有对应的译文 ⇒ 不显示，而不是显示一条
 *   与摘要对不上的译文（读者会以为译文说的就是这句摘要）。
 *
 * 判据仍是 sha256：只有原文逐字对得上才挂译文，原文被编辑后自动失效。
 *
 * @param {object|null} chart buildChartData 的产物
 * @param {Array} tweets
 * @returns {object|null}
 */
export function withChartTranslations(chart, tweets) {
  if (!chart || typeof chart !== 'object') return chart;
  const index = translationIndex(tweets);
  if (index.size === 0) return chart;
  return attachTranslations(chart, index);
}
