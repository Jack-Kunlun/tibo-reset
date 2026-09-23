/**
 * 微信小程序服务端接口（只覆盖 F9 订阅消息要用到的那几个）。
 *
 * 为什么单独一个文件：本项目其余部分**一个外部请求都不发**（采集在本机的采集进程里做，
 * 服务自身只读数据、算预测、出 API）。
 * 把唯一的出网代码隔离在一处，一是让测试可以注入 fetch，二是让「谁会发网络请求」一眼可见。
 *
 * 三条必须守住的规矩（docs/tech-selection.md 6.2）：
 *
 *   1. **刷新 token 失败不清空旧 token**。清掉之后所有推送会同时失败 ——
 *      一次网络抖动被放大成一次全量故障。只要旧 token 还没到点就继续用。
 *   2. **openid 只能服务端用 code 换**。接受客户端传入的 openid 等于允许任何人
 *      伪造他人身份去订阅或退订。
 *   3. **43101（用户未授权 / 授权已消耗）是永久失败**，重试没有意义 ——
 *      该做的是把那条订阅删掉，而不是每轮推送都撞一次。
 */

const API = 'https://api.weixin.qq.com';

/** 提前 5 分钟视为过期，避免「取出来在路上就过期了」 */
const EARLY_REFRESH_MS = 5 * 60_000;

/** 默认有效期。微信实际会返回 expires_in，这只是拿不到时的兜底 */
const DEFAULT_TTL_SEC = 7200;

/**
 * 永久失败码：重试无用，应删除订阅。
 *   43101 用户拒绝接收 / 授权次数已用尽
 *   40003 openid 不合法（换绑、注销）
 */
const PERMANENT_CODES = new Set([43101, 40003]);

/** token 失效码：强制刷一次再重试一次 */
const STALE_TOKEN_CODES = new Set([40001, 42001]);

/**
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.appSecret
 * @param {Function} [opts.fetchImpl] 注入点，测试用
 * @param {Function} [opts.now]       注入点，测试用
 */
export function createWeChatClient({
  appId,
  appSecret,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const configured = Boolean(appId && appSecret);
  let token = { value: '', expiresAt: 0 };

  function assertConfigured() {
    if (!configured) {
      const err = new Error('未配置 WX_APPID / WX_SECRET，订阅消息能力不可用');
      err.permanent = true;
      throw err;
    }
  }

  async function getJson(url, init) {
    const res = await fetchImpl(url, init);
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      // 微信出错时可能返回 HTML（网关层），此时把原文带出来比「JSON 解析失败」有用得多
      throw new Error(`微信接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    return body;
  }

  /**
   * 取 access_token。
   * @param {boolean} force 跳过新鲜度判断，强制刷新（token 被判定失效时用）
   */
  async function getAccessToken(force = false) {
    assertConfigured();

    const fresh = token.value && now() < token.expiresAt - EARLY_REFRESH_MS;
    if (!force && fresh) return token.value;

    const url =
      `${API}/cgi-bin/token?grant_type=client_credential` +
      `&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`;

    try {
      const body = await getJson(url);
      if (!body.access_token) {
        throw new Error(`获取 access_token 失败：errcode=${body.errcode ?? '?'} ${body.errmsg ?? ''}`);
      }
      token = {
        value: body.access_token,
        expiresAt: now() + (Number(body.expires_in) || DEFAULT_TTL_SEC) * 1000,
      };
      return token.value;
    } catch (err) {
      // 刷新失败不清空旧 token —— 见文件头第 1 条
      if (token.value && now() < token.expiresAt) return token.value;
      throw err;
    }
  }

  /** 用 wx.login 的 code 换 openid。code 一次性，且必须服务端换 */
  async function codeToOpenid(code) {
    assertConfigured();
    if (!code || typeof code !== 'string') throw new Error('缺少 code');

    const url =
      `${API}/sns/jscode2session?appid=${encodeURIComponent(appId)}` +
      `&secret=${encodeURIComponent(appSecret)}` +
      `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;

    const body = await getJson(url);
    if (body.errcode) {
      throw new Error(`jscode2session 失败：errcode=${body.errcode} ${body.errmsg ?? ''}`);
    }
    if (!body.openid) throw new Error('jscode2session 未返回 openid');
    return body.openid;
  }

  /**
   * 发一条订阅消息。
   * 失败时抛出的 error 带 `errcode` 与 `permanent` 两个字段，供调用方决定是丢弃还是重试。
   */
  async function sendSubscribeMessage({ openid, templateId, page, data, miniprogramState }) {
    const attempt = async (force) => {
      const accessToken = await getAccessToken(force);
      return getJson(`${API}/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(accessToken)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          touser: openid,
          template_id: templateId,
          page: page || undefined,
          miniprogram_state: miniprogramState || undefined,
          lang: 'zh_CN',
          data,
        }),
      });
    };

    let body = await attempt(false);
    if (STALE_TOKEN_CODES.has(body.errcode)) body = await attempt(true);

    if (body.errcode) {
      const err = new Error(`subscribe/send 失败：errcode=${body.errcode} ${body.errmsg ?? ''}`);
      err.errcode = body.errcode;
      err.permanent = PERMANENT_CODES.has(body.errcode);
      throw err;
    }
    return body;
  }

  return {
    configured,
    getAccessToken,
    codeToOpenid,
    sendSubscribeMessage,
    /** 仅供测试观察缓存状态 */
    _token: () => ({ ...token }),
  };
}
