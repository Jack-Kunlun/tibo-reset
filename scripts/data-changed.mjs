#!/usr/bin/env node
/**
 * 判断相对 git 基线，仓库数据里有没有**实质变化** —— 也就是 CI 该不该为它提交一次。
 *
 * 为什么不能用 `git diff --staged --quiet`：
 *   那是**字节级**判据。data/ 下有一批字段每轮必然不同、却与「数据有没有变」无关 ——
 *   stats.json 的 `generated_at`（采集运行时刻）、`stats.days_since_last`（由 now 推出来
 *   的天数）、signal.json 的 `generatedAt` 与时间窗边界。字节级判据把这些当成变化，
 *   于是**每一轮都提交一条垃圾历史**（这正是此前「48 条提交/天」的另一半来源）。
 *
 *   它同时掩盖真问题：翻 stats.json 的提交历史，20 次里有 12 次是同一句
 *   「实时采集失败：HTTP 403」。读起来像采集一直在坏，其实只是每轮都白试一次。
 *
 * 判据与 docs/data-source.md 的「实质变化」那节一致：
 *   · tweets.json 出现新推文 / 时间被纠正 / role 从 post 变 reply
 *   · resets.json 变化
 *   · stats.json 的 errors **内容**变化
 *
 *   ⚠ 重复的失败**不重复落档**：状态已经在仓库里了，下一轮从仓库检出时页面横幅照样
 *     挂得住。反过来，首次失败必须提交 —— 不然「线上挂着异常横幅」这件事在仓库里
 *     没有痕迹，下一轮检出就变成「数据陈旧但页面一切正常」，页面会说谎。
 *
 * 退出码：0 = 有实质变化（该提交）；1 = 只有时间戳在动（跳过提交）。
 *   ⚠ 脚本自己出错时返回 **0** —— 「多提交一次」远好过「该提交的没提交」，
 *     漏提交意味着数据丢档。错误照常打到 stderr，不会静默。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 每轮必然变化、但与「数据有没有变」无关的字段（点号路径）。
 *
 * 清单只放**确定的** now 派生字段。没列进来的一律参与比较 ——
 * 宁可多提交一次，也不要漏掉真变化。
 *
 * 三个字段的由来：
 *   · `generated_at`     采集**运行**时刻，失败轮照样推进（页面横幅的「本轮尝试」用它）
 *   · `last_full_at`     上次全量回溯时刻
 *   · `stats.days_since_last`  由 now 减去 last_at 得到，每轮都在涨
 */
export const VOLATILE = {
  'data/stats.json': ['generated_at', 'last_full_at', 'stats.days_since_last'],
  'data/signal.json': ['generatedAt', 'windowFrom', 'windowTo'],
  'data/tweets.json': ['updated_at'],
};

/**
 * 默认关心的路径。**必须与 workflow 里 `git add` 的目标一致** ——
 * 两处不一致时会出现「判据说有变化、但 staged 是空的」这种自相矛盾。
 * 带 `/` 的按前缀匹配，否则整路径相等。
 */
const DEFAULT_PATHS = ['data/', 'miniprogram/utils/scene.js'];

/* ----------------------- 比较（纯函数，可被测试直接喂） ----------------------- */

/** 抹掉一个点号路径指向的字段。中间段不存在时什么都不做。 */
function stripAt(obj, dotted) {
  const segs = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = cur?.[segs[i]];
    if (cur === null || typeof cur !== 'object') return;
  }
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) delete cur[segs[segs.length - 1]];
}

/** 递归排序对象键 —— 键的书写顺序不该算成差异。数组顺序保持不动（它有意义）。 */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  }
  return v;
}

/** 把 JSON 文本规范化：抹掉易变字段 + 排序键。 */
export function normalize(path, text) {
  const obj = JSON.parse(text);
  for (const dotted of VOLATILE[path] ?? []) stripAt(obj, dotted);
  return JSON.stringify(canon(obj));
}

/** 两份文本是否「实质相同」。非 JSON 逐字节比；解析失败一律算不同（保守）。 */
export function sameContent(path, baseText, workText) {
  if (baseText === workText) return true;
  if (!path.endsWith('.json')) return false;
  try {
    return normalize(path, baseText) === normalize(path, workText);
  } catch {
    return false;
  }
}

/**
 * 把改动分成「实质变化」与「只有时间戳在动」。
 *
 * @param {string[]} paths
 * @param {{readBase:(p:string)=>string|null, readWork:(p:string)=>string|null}} io
 */
export function findChanges(paths, io) {
  const substantive = [];
  const volatileOnly = [];
  for (const path of paths) {
    const base = io.readBase(path);
    const work = io.readWork(path);
    if (base === null || work === null) {
      substantive.push({
        path,
        why: base === null ? '基线里没有（新增文件）' : '工作区里没有（文件被删）',
      });
      continue;
    }
    if (sameContent(path, base, work)) volatileOnly.push(path);
    else substantive.push({ path, why: '内容有实质差异' });
  }
  return { substantive, volatileOnly };
}

/* ---------------------------------- CLI ---------------------------------- */

function statusPaths() {
  const out = execFileSync('git', ['status', '--porcelain=v1'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter((l) => l.length > 3)
    .map((l) => {
      let p = l.slice(3).trim();
      const arrow = p.indexOf(' -> '); // 重命名：取新路径
      if (arrow >= 0) p = p.slice(arrow + 4);
      return p.replace(/^"|"$/g, '');
    });
}

const inScope = (path, patterns) =>
  patterns.some((pat) => (pat.endsWith('/') ? path.startsWith(pat) : path === pat));

const readFromGit = (base) => (path) => {
  try {
    return execFileSync('git', ['show', `${base}:${path}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
};

const readFromWork = (path) => {
  const abs = resolve(ROOT, path);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
};

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const baseArg = process.argv.find((a) => a.startsWith('--base='));
    const base = baseArg ? baseArg.slice('--base='.length) : 'HEAD';
    const extra = process.argv.slice(2).filter((a) => !a.startsWith('--'));
    const patterns = extra.length ? extra : DEFAULT_PATHS;

    const changed = statusPaths().filter((p) => inScope(p, patterns));
    if (!changed.length) {
      console.log('· 关注范围内没有任何文件被改动 → 无实质变化，跳过提交');
      process.exit(1);
    }

    const { substantive, volatileOnly } = findChanges(changed, {
      readBase: readFromGit(base),
      readWork: readFromWork,
    });

    console.log(`· 与 ${base} 比较：关注范围内 ${changed.length} 个文件有改动`);
    for (const p of volatileOnly) console.log(`  · ${p} —— 只有时间戳在动，不算变化`);

    if (!substantive.length) {
      console.log('✗ 无实质变化 → 跳过提交（为时间戳生成提交只会污染历史）');
      process.exit(1);
    }

    for (const s of substantive) console.log(`  ✓ ${s.path} —— ${s.why}`);
    console.log(`✓ 有实质变化（${substantive.length} 项）→ 应当提交`);
    process.exit(0);
  } catch (err) {
    console.error(
      `⚠ 实质变化判据本身出错：${err.message}\n  为安全起见按「有变化」处理（漏提交等于数据丢档），照常提交。`
    );
    process.exit(0);
  }
}
