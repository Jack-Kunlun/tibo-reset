/**
 * 数据存取层。
 *
 * 设计取舍：用 JSON 文件 + 内存缓存，不用数据库。
 * 理由：数据量极小（几十条记录），单实例部署，引入数据库只会增加部署摩擦。
 * 所有写入走原子 rename，避免读取方读到半截文件。
 * 读取按 mtime 失效缓存，这样外部（如 GitHub Actions）改动了数据也能被感知。
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createManualStore, projectManualData } from '../src/lib/manual-state.mjs';

export function createStore(dataDir, { account = 'thsottiaux' } = {}) {
  const cache = new Map();
  const manualStore = createManualStore(dataDir);

  async function readJson(name, fallback) {
    const path = resolve(dataDir, name);
    try {
      const info = await stat(path);
      const hit = cache.get(name);
      if (hit && hit.mtimeMs === info.mtimeMs) return hit.value;
      const value = JSON.parse(await readFile(path, 'utf8'));
      cache.set(name, { mtimeMs: info.mtimeMs, value });
      return value;
    } catch {
      return fallback;
    }
  }

  /** 数据文件是否在给定 mtime 之后被改动过（用于让预测缓存失效） */
  async function latestMtime() {
    let max = 0;
    for (const name of ['resets.json', 'tweets.json', 'stats.json', 'manual-state.json']) {
      try {
        const info = await stat(resolve(dataDir, name));
        max = Math.max(max, info.mtimeMs);
      } catch {
        /* 文件不存在则跳过 */
      }
    }
    return max;
  }

  async function getRawData() {
    const [resets, tweets, statsFile] = await Promise.all([
      readJson('resets.json', { records: [] }),
      readJson('tweets.json', { tweets: [] }),
      readJson('stats.json', { stats: null, generated_at: null }),
    ]);
    // 返回独立副本，避免派生逻辑意外改写后续请求复用的缓存数据。
    return {
      resets: JSON.parse(JSON.stringify(resets)),
      tweets: JSON.parse(JSON.stringify(tweets)),
      statsFile: JSON.parse(JSON.stringify(statsFile)),
    };
  }

  async function getData({ now = Date.now() } = {}) {
    const [raw, manual] = await Promise.all([getRawData(), manualStore.get()]);
    return projectManualData({ ...raw, manual, now, account });
  }

  return {
    getRawData,
    getData,
    manualStore,
    getManualState: manualStore.get,
    mutateManual: manualStore.mutate,
    getResets: async () => (await getData()).resets,
    getTweets: async () => (await getData()).tweets,
    getStats: async () => (await getData()).statsFile,
    latestMtime,
  };
}
