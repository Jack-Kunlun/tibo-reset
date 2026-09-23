/**
 * 接收 GitHub Actions 推来的采集产物 —— 境内服务侧的入口。
 *
 * 为什么是这个方向（境外中转、境内落地）：
 *   采集与服务的**出口性质**不同，中间隔着一个 GitHub 仓库 + Actions：
 *   采集必须从**住宅出口**发起（x.com 的 Cloudflare 拦的是机房 IP 段），
 *   而服务必须在**境内**（小程序要求后端域名已备案，境外域名备不了案）。
 *   谁主动连谁是有讲究的 —— 境内访问 github.com 虽然通，但长期链路一抖就会出现
 *   「页面是新的、API 是旧的」这种最难排查的静默不一致。反过来 GitHub runner
 *   连境内公网入口没有任何障碍。
 *
 * 幂等靠 generatedAt，而不是靠「第几次推送」：
 *   CI 重跑、手动触发、定时与手动撞车都会发生。判定标准只有一个 ——
 *   载荷比现有数据新才写入。旧载荷回 stale 并丢弃，不报错。
 *
 * 写入前必须校验形状：这份数据会直接决定线上页面显示什么，
 * 一条没有 announced_at 的记录就能让整个构建失败，而失败发生在境内服务察觉不到的地方。
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { saveJson } from '../src/lib/collect.mjs';

/** 几十条记录的载荷只有几十 KB，8MB 是宽裕到不合理都算不上的上限 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** 记录条数的合理性上限。超出说明载荷来自别的什么东西，不是本项目采集的 */
const MAX_RECORDS = 5000;

/** 读取请求体，带大小上限（防内存被一个请求吃光） */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error(`载荷超过 ${MAX_BODY_BYTES} 字节`);
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 校验载荷形状。返回错误描述，合法则返回 null。
 *
 * 刻意做得啰嗦：宁可拒收一份本来能用的数据（下一次采集就补上了），
 * 也不要让一份坏数据落盘 —— 后者会让线上页面在两次采集之间一直是坏的。
 */
function validate(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '载荷不是对象';

  const at = Date.parse(payload.generatedAt);
  if (!Number.isFinite(at)) return 'generatedAt 不是合法时间';

  const records = payload.resets?.records;
  if (!Array.isArray(records)) return 'resets.records 不是数组';
  // 少于 2 条则图表无法构建（buildChartData 会返回 null），收了也只会让页面构建失败
  if (records.length < 2) return `resets.records 只有 ${records.length} 条，不足以构建图表`;
  if (records.length > MAX_RECORDS) return `resets.records 有 ${records.length} 条，超过上限 ${MAX_RECORDS}`;
  for (const [i, r] of records.entries()) {
    if (!r || typeof r !== 'object') return `resets.records[${i}] 不是对象`;
    if (!Number.isFinite(Date.parse(r.announced_at))) {
      return `resets.records[${i}].announced_at 非法或缺失`;
    }
  }

  if (!Array.isArray(payload.tweets?.tweets)) return 'tweets.tweets 不是数组';
  if (!payload.stats || typeof payload.stats !== 'object') return 'stats 缺失';

  return null;
}

/**
 * 处理 `POST /api/ingest`。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ dataDir: string, token: string, send: Function, onAccepted?: Function }} ctx
 *        token 为空字符串时视为「未启用鉴权」（仅限本机调试）
 *        onAccepted 在数据成功落盘后调用（F9 订阅推送挂在这里）
 */
export async function handleIngest(req, res, { dataDir, token, send, onAccepted }) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  // 鉴权：这是唯一一个能从外部改写线上数据的入口，不能裸奔
  if (token) {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${token}`) {
      return send(res, 401, { error: 'unauthorized' });
    }
  } else {
    // 没配 token 就对外开了写入口 —— 必须显式拒绝，而不是「放行 + 打条日志」
    return send(res, 503, {
      error: 'ingest disabled',
      hint: '未配置 INGEST_TOKEN，写入口已关闭',
    });
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    return send(res, err.status ?? 400, { error: err.message });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return send(res, 400, { error: 'invalid json' });
  }

  const invalid = validate(payload);
  if (invalid) return send(res, 422, { error: 'invalid payload', detail: invalid });

  // 幂等判定：只接受更新的载荷
  const incomingAt = Date.parse(payload.generatedAt);
  const currentAt = await currentGeneratedAt(dataDir);

  if (currentAt !== null && incomingAt <= currentAt) {
    // 不是错误 —— CI 重跑就会走到这里。回 200 让工作流绿着走完。
    return send(res, 200, {
      status: 'stale',
      incoming: payload.generatedAt,
      current: new Date(currentAt).toISOString(),
      note: '载荷不比现有数据新，已丢弃',
    });
  }

  // 落盘。saveJson 走「临时文件 + rename」，服务读取方不会读到半截 JSON。
  // 同时也让 store 的 mtime 缓存自动失效 —— 不需要额外清缓存。
  await saveJson(resolve(dataDir, 'resets.json'), payload.resets);
  await saveJson(resolve(dataDir, 'tweets.json'), payload.tweets);
  await saveJson(resolve(dataDir, 'stats.json'), {
    ...payload.stats,
    // 权威时刻只保留一个：顶层 generatedAt。两份时间打架比没有时间更糟。
    generated_at: payload.generatedAt,
  });
  if (payload.signals) await saveJson(resolve(dataDir, 'signal.json'), payload.signals);

  send(res, 200, {
    status: 'accepted',
    generatedAt: payload.generatedAt,
    records: payload.resets.records.length,
    tweets: payload.tweets.tweets.length,
  });

  // 数据已落盘、已应答。订阅推送（F9）是后续动作，**不阻塞 CI**：
  // 推送失败不该让整轮采集在 CI 里变红，那会让人误以为数据没收到。
  if (onAccepted) {
    Promise.resolve()
      .then(() => onAccepted(payload))
      .catch((err) => console.error('[ingest] onAccepted 回调失败：', err.message));
  }
}

/** 现有数据的采集时刻（ISO 字符串的毫秒值），没有数据则返回 null */
async function currentGeneratedAt(dataDir) {
  try {
    const stats = JSON.parse(await readFile(resolve(dataDir, 'stats.json'), 'utf8'));
    const t = Date.parse(stats?.generated_at);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}
