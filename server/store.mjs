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

export function createStore(dataDir) {
  const cache = new Map();

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
    for (const name of ['resets.json', 'tweets.json', 'stats.json']) {
      try {
        const info = await stat(resolve(dataDir, name));
        max = Math.max(max, info.mtimeMs);
      } catch {
        /* 文件不存在则跳过 */
      }
    }
    return max;
  }

  return {
    getResets: () => readJson('resets.json', { records: [] }),
    getTweets: () => readJson('tweets.json', { tweets: [] }),
    getStats: () => readJson('stats.json', { stats: null, generated_at: null }),
    latestMtime,
  };
}
