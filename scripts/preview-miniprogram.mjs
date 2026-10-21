#!/usr/bin/env node
/**
 * 小程序开发预览：用真实 WXML、WXSS 和视图模型生成可交互的本地 HTML。
 *
 * 预览运行在普通浏览器里，没有微信宿主。只调用页面的 apply/setData 来铺本地数据，
 * 浏览器事件只改本地 UI state；生命周期、登录、授权、订阅和服务请求都不运行。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChartData } from '../src/lib/chart-data.js';
import { predictAll } from '../src/lib/predict.mjs';
import { detectSignals, latestEventMs } from '../src/lib/signals.mjs';
import { buildResetCalendar } from '../src/lib/reset-calendar.mjs';
import { createDashboardPage } from '../miniprogram/utils/dashboard.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MINI_ROOT = resolve(ROOT, 'miniprogram');
const readJson = async (path) => JSON.parse(await readFile(resolve(ROOT, path), 'utf8'));
const RPX = 0.5; // 按 375px 预览宽度把微信设计像素换成 CSS 像素

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function wxssToCss(source) {
  return source.replace(/(-?(?:\d+\.?\d*|\.\d+))rpx\b/g, (_, value) => {
    const pixels = Math.round(Number(value) * RPX * 100) / 100;
    return pixels + 'px';
  });
}

async function loadWxss(path, seen = new Set()) {
  const absolute = resolve(path);
  const localKey = relative(MINI_ROOT, absolute);
  if (localKey.startsWith('..' + sep) || localKey === '..' || seen.has(absolute)) return '';
  seen.add(absolute);

  let source;
  try {
    source = await readFile(absolute, 'utf8');
  } catch {
    return '';
  }

  const imports = /@import\s+(?:url\(\s*)?(['"])(.*?)\1\s*\)?\s*;/g;
  let cursor = 0;
  let css = '';
  let match;
  while ((match = imports.exec(source))) {
    css += source.slice(cursor, match.index);
    cursor = imports.lastIndex;
    const specifier = match[2].trim();
    if (/^(?:https?:)?\/\//i.test(specifier) || specifier.startsWith('data:')) continue;
    const imported = resolve(dirname(absolute), specifier);
    css += await loadWxss(imported, seen);
  }
  css += source.slice(cursor);
  return css;
}

function createWxmlRuntime() {
  const VOID_TAGS = new Set(['img', 'image', 'input', 'textarea', 'br', 'hr', 'meta', 'link']);
  const TAGS = {
    view: 'div',
    text: 'span',
    image: 'img',
    button: 'button',
    'scroll-view': 'div',
    canvas: 'canvas',
    block: null,
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]);
  }

  function findTagEnd(source, start) {
    let quote = '';
    for (let index = start + 1; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (character === quote && source[index - 1] !== '\\') quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        return index;
      }
    }
    return -1;
  }

  function parseAttributes(source) {
    const attributes = Object.create(null);
    let index = 0;
    while (index < source.length) {
      while (/\s/.test(source[index] || '')) index += 1;
      if (index >= source.length || source[index] === '/') break;
      const start = index;
      while (index < source.length && !/[\s=/>]/.test(source[index])) index += 1;
      const name = source.slice(start, index);
      if (!name) { index += 1; continue; }
      while (/\s/.test(source[index] || '')) index += 1;
      let value = '';
      if (source[index] === '=') {
        index += 1;
        while (/\s/.test(source[index] || '')) index += 1;
        const quote = source[index];
        if (quote === '"' || quote === "'") {
          index += 1;
          const valueStart = index;
          while (index < source.length && (source[index] !== quote || source[index - 1] === '\\')) index += 1;
          value = source.slice(valueStart, index);
          if (source[index] === quote) index += 1;
        } else {
          const valueStart = index;
          while (index < source.length && !/[\s>]/.test(source[index])) index += 1;
          value = source.slice(valueStart, index);
        }
      }
      attributes[name] = value;
    }
    return attributes;
  }

  function parse(source) {
    const root = { type: 'root', children: [] };
    const stack = [root];
    let cursor = 0;

    while (cursor < source.length) {
      if (source.startsWith('<!--', cursor)) {
        const end = source.indexOf('-->', cursor + 4);
        cursor = end < 0 ? source.length : end + 3;
        continue;
      }
      if (source[cursor] !== '<') {
        const next = source.indexOf('<', cursor);
        const end = next < 0 ? source.length : next;
        stack[stack.length - 1].children.push({ type: 'text', value: source.slice(cursor, end) });
        cursor = end;
        continue;
      }

      const end = findTagEnd(source, cursor);
      if (end < 0) throw new Error('WXML 标签未闭合，偏移 ' + cursor);
      const token = source.slice(cursor, end + 1);
      cursor = end + 1;
      if (/^<!|^<\?/.test(token)) continue;

      const closing = /^<\s*\//.test(token);
      const body = token.slice(1, -1).trim().replace(/^\/\s*/, '');
      if (closing) {
        const name = body.split(/\s/)[0];
        const current = stack.pop();
        if (!current || current.type !== 'element' || current.tag !== name) {
          throw new Error('WXML 标签闭合不匹配：' + name);
        }
        continue;
      }

      const selfClosing = /\/\s*>$/.test(token);
      const tagMatch = body.match(/^([^\s/>]+)([\s\S]*)$/);
      if (!tagMatch) continue;
      const node = {
        type: 'element',
        tag: tagMatch[1],
        attrs: parseAttributes(tagMatch[2].replace(/\/\s*$/, '')),
        children: [],
      };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
    }

    if (stack.length !== 1) {
      throw new Error('WXML 缺少闭合标签：' + stack[stack.length - 1].tag);
    }
    return root;
  }

  function evaluate(expression, scope) {
    try {
      return Function('scope', 'with (scope) { return (' + expression.trim() + '); }')(scope);
    } catch (error) {
      if (error instanceof TypeError && /Cannot read properties of (?:null|undefined)/.test(error.message)) {
        const safeExpression = expression.replace(/(?<!\?)\.([A-Za-z_$][\w$]*)/g, '?.$1');
        if (safeExpression !== expression) {
          try {
            return Function('scope', 'with (scope) { return (' + safeExpression.trim() + '); }')(scope);
          } catch (safeError) {
            error = safeError;
          }
        }
      }
      throw new Error('无法计算 WXML 表达式「' + expression.trim() + '」：' + error.message);
    }
  }

  function interpolate(value, scope) {
    const source = String(value ?? '');
    const exact = source.match(/^\s*\{\{([^{}]*)\}\}\s*$/);
    if (exact) return evaluate(exact[1], scope);
    return source.replace(/\{\{([\s\S]*?)\}\}/g, (_, expression) => {
      const result = evaluate(expression, scope);
      return result === null || result === undefined ? '' : String(result);
    });
  }

  function truthy(value, scope) {
    if (value === undefined) return false;
    return Boolean(interpolate(value, scope));
  }

  function renderChildren(children, scope, options) {
    let output = '';
    for (let index = 0; index < children.length; index += 1) {
      const node = children[index];
      const isConditional = node.type === 'element' &&
        Object.prototype.hasOwnProperty.call(node.attrs, 'wx:if') &&
        !Object.prototype.hasOwnProperty.call(node.attrs, 'wx:for');

      if (!isConditional) {
        output += renderNode(node, scope, options);
        continue;
      }

      const group = [];
      let cursor = index;
      while (cursor < children.length) {
        const candidate = children[cursor];
        if (candidate.type === 'text' && !candidate.value.trim()) {
          cursor += 1;
          continue;
        }
        const hasIf = candidate.type === 'element' && Object.prototype.hasOwnProperty.call(candidate.attrs, 'wx:if');
        const hasElif = candidate.type === 'element' && Object.prototype.hasOwnProperty.call(candidate.attrs, 'wx:elif');
        const hasElse = candidate.type === 'element' && Object.prototype.hasOwnProperty.call(candidate.attrs, 'wx:else');
        const startsChain = group.length === 0 && hasIf && !hasElif && !hasElse;
        const continuesChain = group.length > 0 && !group.some((member) =>
          Object.prototype.hasOwnProperty.call(member.attrs, 'wx:else')) && !hasIf && (hasElif || hasElse);
        if ((startsChain || continuesChain) && !Object.prototype.hasOwnProperty.call(candidate.attrs, 'wx:for')) {
          group.push(candidate);
          cursor += 1;
          continue;
        }
        break;
      }

      let selected = null;
      for (const candidate of group) {
        if (Object.prototype.hasOwnProperty.call(candidate.attrs, 'wx:if') && truthy(candidate.attrs['wx:if'], scope)) {
          selected = candidate;
          break;
        }
        if (Object.prototype.hasOwnProperty.call(candidate.attrs, 'wx:elif') && truthy(candidate.attrs['wx:elif'], scope)) {
          selected = candidate;
          break;
        }
        if (Object.prototype.hasOwnProperty.call(candidate.attrs, 'wx:else')) {
          selected = candidate;
          break;
        }
      }
      if (selected) output += renderElement(selected, scope, options, true);
      index = Math.max(index, cursor - 1);
    }
    return output;
  }

  function renderNode(node, scope, options) {
    if (node.type === 'text') return escapeHtml(interpolate(node.value, scope));
    if (node.type === 'root') return renderChildren(node.children, scope, options);
    return renderElement(node, scope, options, false);
  }

  function renderElement(node, parentScope, options, fromConditionalGroup) {
    const attrs = node.attrs;
    const loopValue = attrs['wx:for'];
    if (loopValue !== undefined) {
      const list = interpolate(loopValue, parentScope);
      const values = Array.isArray(list) ? list : list && typeof list === 'object' ? Object.values(list) : [];
      const itemName = attrs['wx:for-item'] || 'item';
      const indexName = attrs['wx:for-index'] || 'index';
      return values.map((item, index) => {
        const scope = Object.create(parentScope);
        scope[itemName] = item;
        scope[indexName] = index;
        return renderElementBody(node, scope, options, fromConditionalGroup);
      }).join('');
    }
    return renderElementBody(node, parentScope, options, fromConditionalGroup);
  }

  function renderElementBody(node, scope, options, fromConditionalGroup) {
    const attrs = node.attrs;
    if (!fromConditionalGroup && Object.prototype.hasOwnProperty.call(attrs, 'wx:if') &&
      !truthy(attrs['wx:if'], scope)) return '';
    if (!fromConditionalGroup && Object.prototype.hasOwnProperty.call(attrs, 'wx:elif') &&
      !Object.prototype.hasOwnProperty.call(attrs, 'wx:if')) return '';
    if (!fromConditionalGroup && Object.prototype.hasOwnProperty.call(attrs, 'wx:else') &&
      !Object.prototype.hasOwnProperty.call(attrs, 'wx:if') &&
      !Object.prototype.hasOwnProperty.call(attrs, 'wx:elif')) return '';

    const tag = node.tag.toLowerCase();
    const htmlTag = Object.prototype.hasOwnProperty.call(TAGS, tag) ? TAGS[tag] : tag;
    if (!htmlTag) return renderChildren(node.children, scope, options);

    let outputAttrs = '';
    const events = [];
    for (const [name, rawValue] of Object.entries(attrs)) {
      if (name.startsWith('wx:') || name === 'key' || name === 'for') continue;
      if (/^(?:bind|catch)(?:tap|touchstart|touchend|longpress)$/.test(name)) {
        events.push({
          name,
          handler: String(interpolate(rawValue, scope) ?? ''),
          catches: name.startsWith('catch'),
        });
        continue;
      }

      const value = interpolate(rawValue, scope);
      if (name === 'src' && tag === 'image') {
        const source = String(value ?? '');
        const resolved = options.assets[source] || (source.startsWith('data:image/') ? source : '');
        if (resolved) outputAttrs += ' src="' + escapeHtml(resolved) + '"';
        continue;
      }
      if (name === 'mode' && tag === 'image') {
        outputAttrs += ' data-mode="' + escapeHtml(value) + '"';
        continue;
      }
      if ((name === 'scroll-y' || name === 'scroll-x') && tag === 'scroll-view') {
        if (value) {
          const direction = name === 'scroll-y' ? 'y' : 'x';
          outputAttrs += ' data-scroll="' + direction + '"';
        }
        continue;
      }
      if (name === 'type' && tag === 'canvas') {
        outputAttrs += ' data-type="' + escapeHtml(value) + '"';
        continue;
      }
      if (name === 'loading' && tag === 'button') {
        if (value) outputAttrs += ' aria-busy="true"';
        continue;
      }
      if (name === 'disabled') {
        if (value) outputAttrs += ' disabled=""';
        continue;
      }
      if (name === 'hidden') {
        if (value) outputAttrs += ' hidden=""';
        continue;
      }
      if (!/^[a-zA-Z_:][a-zA-Z0-9_:.-]*$/.test(name)) continue;
      if (value === undefined || value === null) continue;
      outputAttrs += ' ' + name + '="' + escapeHtml(value) + '"';
    }

    if (events.length) {
      for (const event of events) {
        const eventType = event.name.startsWith('catch') ? event.name.slice(5) : event.name.slice(4);
        outputAttrs += ' data-preview-' + eventType + '="' + escapeHtml(event.handler) + '"';
        if (event.catches) outputAttrs += ' data-preview-catch-' + eventType + '="true"';
      }
    }

    if (tag === 'scroll-view' && !Object.prototype.hasOwnProperty.call(attrs, 'style')) {
      outputAttrs += ' style="overflow-y:auto"';
    } else if (tag === 'scroll-view' && attrs['scroll-y'] !== undefined) {
      const style = String(interpolate(attrs.style || '', scope));
      if (!/overflow(?:-y)?\s*:/.test(style)) outputAttrs += ' style="' + escapeHtml(style + ';overflow-y:auto') + '"';
    }

    if (htmlTag === 'img') {
      if (!Object.prototype.hasOwnProperty.call(attrs, 'alt')) outputAttrs += ' alt=""';
      return '<img' + outputAttrs + '>';
    }
    if (VOID_TAGS.has(htmlTag)) return '<' + htmlTag + outputAttrs + '>';
    return '<' + htmlTag + outputAttrs + '>' +
      renderChildren(node.children, scope, options) +
      '</' + htmlTag + '>';
  }

  function render(source, data, options = {}) {
    const scope = Object.assign(Object.create(null), data || {});
    return renderNode(parse(source), scope, { assets: options.assets || Object.create(null) });
  }

  return { render };
}

/* ------------------------------ 本地数据 ------------------------------ */

const [resets, tweets, stats, appConfig] = await Promise.all([
  readJson('data/resets.json'),
  readJson('data/tweets.json'),
  readJson('data/stats.json'),
  readJson('miniprogram/app.json'),
]);
const now = Date.now();
const DEMO_SIGNAL = process.argv.includes('--demo-signal');
const DEMO_REMINDER = process.argv.includes('--demo-reminder');
const demoTweet = {
  id: 'demo-signal',
  text: 'We will reset all usage limits next Tuesday.',
  created_at: new Date(now - 5 * 3600_000).toISOString(),
  kind: 'other',
  account: 'thsottiaux',
};
const tweetPool = DEMO_SIGNAL ? [demoTweet, ...tweets.tweets] : tweets.tweets;
const account = 'thsottiaux';
const chart = buildChartData(resets.records, now);
const prediction = predictAll(resets.records, { now, tweets: tweets.tweets, account });
const signals = detectSignals(tweetPool, {
  now,
  account,
  lastResetAt: latestEventMs(resets.records),
});
signals.calendar = buildResetCalendar({ records: resets.records, tweets: tweetPool, signals, now, account });
const state = {
  chart,
  prediction,
  signals,
  generatedAt: stats.generated_at || tweets.updated_at || new Date(now).toISOString(),
  dataUpdatedAt: tweets.updated_at || stats.generated_at || new Date(now).toISOString(),
  account,
};

function applyPatch(target, patch) {
  for (const [path, value] of Object.entries(patch || {})) {
    const segments = path.split('.');
    let cursor = target;
    for (const segment of segments.slice(0, -1)) {
      if (!cursor[segment] || typeof cursor[segment] !== 'object') cursor[segment] = {};
      cursor = cursor[segment];
    }
    cursor[segments[segments.length - 1]] = value;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createPreviewPage(view) {
  const definition = createDashboardPage(view);
  const page = {
    ...definition,
    data: clone(definition.data),
    setData(patch, callback) {
      applyPatch(this.data, patch);
      if (typeof callback === 'function') callback();
    },
  };

  // 只运行无外部副作用的 apply：它复用小程序真实的数据到视图模型映射。
  page.apply({ state, degraded: false });
  page.setData({ pageVisible: true, motionEnabled: true, singlePage: false });

  if (view === 'observe' && DEMO_REMINDER) {
    page.setData({
      reminderBatch: true,
      reminderAction: { label: '开启重置提醒', disabled: false, loading: false },
      announcementRemind: { show: true, selected: true, label: '开启预告提醒', state: 'idle', feedback: '', tone: '' },
      landedRemind: { show: true, selected: true, label: '开启落地提醒', state: 'idle', feedback: '', tone: '' },
    });
  }

  const calendarSelections = {};
  const initialDate = page.data.selectedDate;
  for (const cell of page.data.calendar?.cells || []) {
    page.onSelectCalendarDay({ currentTarget: { dataset: { date: cell.date } } });
    calendarSelections[cell.date] = clone(page.data.selectedDay);
  }
  if (initialDate) page.onSelectCalendarDay({ currentTarget: { dataset: { date: initialDate } } });

  return { data: page.data, calendarSelections };
}

const viewSpecs = [
  { view: 'observe', page: 'pages/index/index' },
  { view: 'records', page: 'pages/history/index' },
  { view: 'analysis', page: 'pages/analysis/index' },
];
const pages = {};
for (const spec of viewSpecs) {
  const base = resolve(MINI_ROOT, spec.page + '.wxml');
  const source = await readFile(base, 'utf8');
  pages[spec.view] = {
    ...createPreviewPage(spec.view),
    template: source,
    pagePath: spec.page,
    assets: {},
  };
}

async function imageData(source, pagePath = '') {
  if (!source || source.includes('{{') || /^(?:https?:)?\/\//i.test(source)) return '';
  if (source.startsWith('data:image/')) return source;
  const rooted = source.startsWith('/');
  const cleaned = source.startsWith('/') ? source.slice(1) : source;
  const base = pagePath && !rooted ? resolve(dirname(resolve(MINI_ROOT, pagePath + '.wxml')), cleaned) : resolve(MINI_ROOT, cleaned);
  const absolute = resolve(base);
  const relativePath = relative(MINI_ROOT, absolute);
  if (relativePath.startsWith('..' + sep) || relativePath === '..') return '';
  const bytes = await readFile(absolute);
  const mime = extname(absolute).toLowerCase() === '.svg' ? 'image/svg+xml'
    : extname(absolute).toLowerCase() === '.jpg' || extname(absolute).toLowerCase() === '.jpeg' ? 'image/jpeg'
      : 'image/png';
  return 'data:' + mime + ';base64,' + bytes.toString('base64');
}

for (const page of Object.values(pages)) {
  const matches = page.template.matchAll(/\bsrc\s*=\s*(["'])(.*?)\1/g);
  for (const match of matches) {
    const source = match[2];
    if (!source.includes('{{')) page.assets[source] = await imageData(source, page.pagePath);
  }
}

const tabs = await Promise.all((appConfig.tabBar?.list || []).map(async (item) => {
  const view = item.pagePath.includes('/history/') ? 'records'
    : item.pagePath.includes('/analysis/') ? 'analysis' : 'observe';
  return {
    ...item,
    view,
    icon: await imageData(item.iconPath),
    selectedIcon: await imageData(item.selectedIconPath),
  };
}));

const seenWxss = new Set();
const cssParts = [await loadWxss(resolve(MINI_ROOT, 'app.wxss'), seenWxss)];
for (const spec of viewSpecs) {
  cssParts.push(await loadWxss(resolve(MINI_ROOT, spec.page + '.wxss'), seenWxss));
}
const appCss = wxssToCss(cssParts.join('\n'));
const renderWxml = createWxmlRuntime();
const initialMarkup = {};
for (const [view, page] of Object.entries(pages)) {
  initialMarkup[view] = renderWxml.render(page.template, page.data, { assets: page.assets });
  const visibleText = initialMarkup[view].replace(/<[^>]*>/g, ' ');
  if (/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/.test(visibleText)) {
    throw new Error('预览模板把机器时间串显示给用户：' + view);
  }
  if (view === 'observe' && !visibleText.includes('查看预测依据')) {
    throw new Error('观测页预览缺少「查看预测依据」入口');
  }
  if (view === 'records' && page.data.selectedDay) {
    const selectedDay = page.data.selectedDay;
    const firstDetail = selectedDay.details?.[0];
    const detailVisible = firstDetail
      ? visibleText.includes(firstDetail.time) && visibleText.includes(firstDetail.title)
      : visibleText.includes('暂无已确认重置');
    if (!initialMarkup[view].includes('tr-selected-date') ||
      !visibleText.includes(selectedDay.label) || !detailVisible) {
      throw new Error('记录页预览缺少选中日期明细');
    }
  }
}

const extraCss = [
  'html,body{margin:0;min-height:100%;background:#070A12}',
  'body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft Yahei",sans-serif;padding:24px 0 0}',
  '.preview-design-scope{width:375px;max-width:100vw;margin:0 auto;padding:0!important}',
  '.preview-phone{width:100%;max-width:100%;min-height:100vh;margin:0;padding:0;border:0;border-radius:0;overflow:visible;box-shadow:none;position:relative}',
  '.preview-page{display:block;min-height:100vh;padding-bottom:66px;background:#090D19;color:#F2F0FC}',
  '.preview-capsule{position:absolute;z-index:20;top:26px;right:10px}',
  '.preview-page [data-scroll="y"]{overflow-y:auto;-webkit-overflow-scrolling:touch}',
  '.preview-tabbar{position:fixed!important;z-index:30;left:50%;bottom:0;transform:translateX(-50%);width:min(100vw,375px);box-sizing:border-box;background:#101728}',
  '.preview-tab{cursor:pointer}',
  '.preview-tab img{display:block;object-fit:contain}',
  '.preview-page image{object-fit:contain}',
  '.preview-page button{cursor:pointer}',
  '.preview-page button:disabled{cursor:default}',
  '.preview-page canvas{display:block}',
  '.preview-page .chart{width:100%}',
  '.preview-page .chart-hist{height:156px}',
  '.preview-page .chart-survival{height:156px}',
  '.preview-page .chart-strip{height:128px}',
  '.preview-page .tr-chart-card{min-height:138px}',
  '.preview-page[hidden],.preview-page [hidden]{display:none!important}',
  '.preview-tab[aria-selected="true"]{color:#C8B6FF}',
  '.preview-demo-notice{position:fixed;z-index:60;top:8px;left:50%;transform:translateX(-50%);width:max-content;max-width:calc(100vw - 24px);box-sizing:border-box;padding:7px 12px;border:1px solid rgba(255,224,166,.65);border-radius:999px;background:#ffe0a6;color:#30220b;font-size:12px;font-weight:700;line-height:1.2;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:none}',
].join('');

const pageJson = {};
for (const [view, page] of Object.entries(pages)) {
  pageJson[view] = page;
}
const tabHtml = tabs.map((tab, index) => {
  const active = index === 0;
  return '<button type="button" role="tab" aria-selected="' + active + '" class="tr-tab preview-tab' + (active ? ' is-selected' : '') +
    '" data-preview-view="' + tab.view + '" aria-label="' + tab.text + '">' +
    '<img class="tr-icon" src="' + tab.icon + '" data-icon="' + tab.icon + '" data-selected-icon="' + tab.selectedIcon + '" alt="" aria-hidden="true">' +
    '<span>' + tab.text + '</span></button>';
}).join('');

const runtimeFactorySource = '(' + createWxmlRuntime.toString() + ')';
const browserScript = [
  "import { rhythmScene, survivalScene, stripScene, histogramScene } from '../src/lib/scene.js';",
  "import { drawScene } from '../miniprogram/utils/draw.js';",
  'const bundles = JSON.parse(document.getElementById("preview-data").textContent);',
  'const chart = JSON.parse(document.getElementById("chart-data").textContent);',
  'const runtime = ' + runtimeFactorySource + '();',
  'const root = document.getElementById("preview-page-root");',
  'const tabs = [...document.querySelectorAll(".preview-tab")];',
  'const instances = Object.fromEntries(Object.entries(bundles).map(([view, bundle]) => [view, { data: bundle.data, setData(patch, callback) { applyPatch(this.data, patch); if (view === currentView) renderCurrent(); if (typeof callback === "function") callback(); } }]));',
  'let currentView = "observe";',
  'function applyPatch(target, patch) { for (const [path, value] of Object.entries(patch || {})) { const parts = path.split("."); let cursor = target; for (const part of parts.slice(0, -1)) { if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {}; cursor = cursor[part]; } cursor[parts[parts.length - 1]] = value; } }',
  'function esc(value) { return String(value ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c])); }',
  'function renderCurrent() { const bundle = bundles[currentView], page = instances[currentView]; root.innerHTML = "<page class=\\"preview-page\\">" + runtime.render(bundle.template, page.data, { assets: bundle.assets }) + "</page>"; requestAnimationFrame(paintCurrent); }',
  'function selectView(view) { if (!instances[view]) return; currentView = view; tabs.forEach((tab) => { const selected = tab.dataset.previewView === view; tab.setAttribute("aria-selected", String(selected)); tab.classList.toggle("is-selected", selected); const image = tab.querySelector("img"); image.src = selected ? image.dataset.selectedIcon : image.dataset.icon; }); renderCurrent(); }',
  'function eventFor(node) { const dataset = {}; for (const [key, value] of Object.entries(node.dataset)) if (!key.startsWith("preview")) dataset[key] = value; return { currentTarget: { dataset } }; }',
  'function setData(patch) { instances[currentView].setData(patch); }',
  'function handle(name, event) { const data = instances[currentView].data, dataset = event.currentTarget.dataset;',
  '  if (name === "onToggleAnalysis") { const key = dataset.section; if (Object.prototype.hasOwnProperty.call(data.analysisOpen || {}, key)) setData({ ["analysisOpen." + key]: !data.analysisOpen[key] }); return; }',
  '  if (name === "onToggleSignalDetails") { if (data.signal && data.signal.show) setData({ signalDetailsOpen: !data.signalDetailsOpen }); return; }',
  '  if (name === "onToggleProgram") { const opening = !data.programOpen; setData({ programOpen: opening, ...(opening ? {} : { programHeight: 0 }) }); if (opening) requestAnimationFrame(() => { const reveal = root.querySelector(".prog-reveal"); if (reveal && reveal.scrollHeight) setData({ programHeight: Math.ceil(reveal.scrollHeight) }); }); return; }',
  '  if (name === "onSelectCalendarDay") { const date = dataset.date, selected = bundles[currentView].calendarSelections[date]; if (selected) setData({ selectedDate: date, selectedDay: selected }); return; }',
  '  if (name === "onToggleRecord") { const key = dataset.key; if ((data.allRecords || []).some((row) => row.key === key)) setData({ expandedRecord: data.expandedRecord === key ? "" : key }); return; }',
  '  if (name === "onToggleDetails") { setData({ detailsOpen: !data.detailsOpen }); return; }',
  '  if (name === "onToggleMoreRecords") { setData({ moreRecordsOpen: !data.moreRecordsOpen }); return; }',
  '  if (name === "onOpenAnalysis") { selectView("analysis"); return; }',
  '  if (name === "onIdleTap") { const target = root.querySelector("#elapsed"); if (target) target.scrollIntoView({ behavior: "smooth", block: "center" }); return; }',
  '  if (name === "onSelectReminder" && ' + DEMO_REMINDER + ') { const kind = dataset.kind, key = kind === "announcement" ? "announcementRemind" : "landedRemind", reminder = data[key]; if (!reminder || reminder.state === "on") return; const selected = !reminder.selected, count = Number(kind === "announcement" ? selected : data.announcementRemind.selected) + Number(kind === "landed" ? selected : data.landedRemind.selected); setData({ [key + ".selected"]: selected, "reminderAction.label": count > 1 ? "开启重置提醒" : count ? "开启所选提醒" : "请选择提醒类型", "reminderAction.disabled": count === 0 }); return; }',
  '  if (name === "onEnableReminders" && ' + DEMO_REMINDER + ') { const chosen = ["announcementRemind", "landedRemind"].filter((key) => data[key]?.selected && data[key].state === "idle"); if (!chosen.length) return; for (const key of chosen) setData({ [key + ".state"]: "on", [key + ".label"]: "已开启", [key + ".feedback"]: "仅本地演示，未调用微信授权。", [key + ".tone"]: "warn" }); setData({ "reminderAction.label": "已开启所选提醒", "reminderAction.disabled": true }); return; }',
  '  // 复制、真实授权和微信接口在预览中故意没有宿主实现，避免触发真实服务。',
  '  if (name === "onCopySource" || name === "onCopyCalendarSource" || name === "onToggleReminder" || name === "onHeroTouch" || name === "onStopTap") return;',
  '}',
  'root.addEventListener("click", (click) => { const chain = []; let node = click.target instanceof Element ? click.target : null; while (node && node !== root) { const handler = node.dataset.previewTap || node.dataset.previewLongpress; if (handler) chain.push({ node, handler, catches: node.dataset.previewCatchTap === "true" }); node = node.parentElement; } for (const entry of chain) { handle(entry.handler, eventFor(entry.node)); if (entry.catches) break; } });',
  'tabs.forEach((tab) => tab.addEventListener("click", () => selectView(tab.dataset.previewView)));',
  'function paint(selector, make, layout) { const canvas = root.querySelector(selector); if (!canvas) return; const rect = canvas.getBoundingClientRect(), width = Math.round(rect.width), height = Math.round(rect.height); if (!width || !height) return; const dpr = window.devicePixelRatio || 2; canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); const context = canvas.getContext("2d"); if (!context) return; context.scale(dpr, dpr); const scene = make(chart, { width, height, ...(layout ? { layout } : {}) }); drawScene(context, scene, dpr, "night"); }',
  'function paintCurrent() { if (currentView !== "analysis") return; paint("#hist", histogramScene, "compact"); paint("#survival", survivalScene, "compact"); paint("#strip", stripScene, "compact"); }',
  'renderCurrent();',
].join('\n');
const checkedBrowserScript = browserScript.replace(/^import[^\n]*\n/gm, '');
new Function(checkedBrowserScript);

const demoNotice = DEMO_REMINDER
  ? '<div class="preview-demo-notice">本地布局预览 · 提醒按钮仅演示</div>'
  : '';
const html = '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<title>小程序三 Tab 预览 · 等 TIBO 按按钮</title><style>' + appCss + extraCss + '</style></head><body>' +
  demoNotice + '<main class="design preview-design-scope"><div class="tr-phone preview-phone">' +
  '<div class="tr-capsule preview-capsule" aria-hidden="true"><text>•••</text><text>◉</text></div>' +
  '<div id="preview-page-root"><page class="preview-page">' + initialMarkup.observe + '</page></div></div>' +
  '<nav class="tr-tabbar preview-tabbar" role="tablist" aria-label="小程序页面">' + tabHtml + '</nav></main>' +
  '<script type="application/json" id="preview-data">' + safeJson(pageJson) + '</script>' +
  '<script type="application/json" id="chart-data">' + safeJson(chart) + '</script>' +
  '<script type="module">' + browserScript + '</script></body></html>';

await mkdir(resolve(ROOT, 'dist'), { recursive: true });
await writeFile(resolve(ROOT, 'dist/miniprogram-preview.html'), html, 'utf8');
console.log('✓ dist/miniprogram-preview.html  ' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB');
console.log('  用静态服务器打开（ES module 不能走 file://）：');
console.log('    python3 -m http.server 8801  然后访问 http://127.0.0.1:8801/dist/miniprogram-preview.html');
