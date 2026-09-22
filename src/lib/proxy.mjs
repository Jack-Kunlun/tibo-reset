/**
 * 出口代理的**实测**发现 —— 采集链路唯一的网络前提。
 *
 * 为什么不能直接用 `HTTPS_PROXY` 环境变量：
 * 在本机（WorkBuddy 沙箱内）它被设成**沙箱自己的**出口端口（实测 57119）。
 * 那个端口只服务于沙箱的网络策略，**不是通用代理** —— 拿它去连 x.com 会
 * 拿到 HTTP 000（实测 0 字节）。而用户真实的代理软件在 7890，curl 走它
 * 是 200 / 215KB。
 *
 * 这个坑的隐蔽之处在于它**时好时坏**：
 *   · 之前几轮采集「能跑」，是因为复用了用户手动以 7890 起的登录窗口 ——
 *     连接根本没过我们传的代理参数；
 *   · 一旦需要自己起 Chrome（无人值守），就拿着 57119 去连，静默拿到 0 条，
 *     而外层只报一句「浏览器收割到 0 条推文」，看不出是代理的错。
 *
 * 所以这里不看环境变量说什么，**逐个候选实测**：第一个能真正取回 x.com 的才算数。
 * 显式设置 `X_PROXY` 时跳过探测（给容器 / CI 一个确定性的开关）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

/**
 * 候选代理。顺序即优先级 —— 先试最常见的，命中就停。
 *
 * 环境变量里的值排在最后而不是最前：它是**沙箱注入**的，本机实测不可用，
 * 但换一台机器 / 换一个宿主它也可能就是对的，所以留着当兜底而不是当权威。
 */
const CANDIDATES = [
  'http://127.0.0.1:7890', // Clash / ClashX / Clash Verge 默认
  'http://127.0.0.1:7891', // Clash 混合端口
  'http://127.0.0.1:1087', // V2RayX / v2rayU
  'http://127.0.0.1:10809', // v2rayN (HTTP)
  'socks5h://127.0.0.1:1080', // 通用 SOCKS5
  'http://127.0.0.1:8888',
  'http://127.0.0.1:6152', // Surge
  'http://127.0.0.1:8118', // privoxy
];

/** 探测目标。x.com 本体 —— 只要它能过，后面的采集就能过。 */
const PROBE_TARGET = 'https://x.com/';

let cached; // undefined = 还没探测；null = 无可用代理（直连）

/**
 * 某个代理端口能否真正取回 x.com。
 *
 * 注意**不加 `-f`**：我们要的是「拿到了 HTTP 响应」这件事本身。
 * 403（Cloudflare 挑战）也证明代理是通的 —— 那是另一个问题，别在这里混为一谈。
 * 判据只看 curl 是否退出 0 且状态码不是 000。
 */
async function probe(proxyUrl, timeoutMs) {
  try {
    const { stdout } = await execFileP(
      'curl',
      [
        '-s',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '-x',
        proxyUrl,
        '-A',
        UA,
        '--max-time',
        String(Math.max(1, Math.ceil(timeoutMs / 1000))),
        PROBE_TARGET,
      ],
      { timeout: timeoutMs + 3000, encoding: 'utf8' }
    );
    const code = Number(String(stdout).trim());
    return Number.isFinite(code) && code > 0;
  } catch {
    return false;
  }
}

/**
 * 找出可用的出口代理。
 *
 * @param {{timeoutMs?:number, candidates?:string[], force?:boolean}} [opts]
 * @returns {Promise<string|null>} 代理 URL；null 表示直连（境外机器就是这种情形）
 */
export async function resolveProxy(opts = {}) {
  if (!opts.force && cached !== undefined) return cached;

  // 显式指定就当权威 —— 不再探测（容器 / CI 需要确定性）
  const explicit = process.env.X_PROXY;
  if (explicit) {
    cached = explicit === 'off' || explicit === 'none' ? null : explicit;
    return cached;
  }

  const timeoutMs = opts.timeoutMs ?? 6000;
  const list = opts.candidates ?? [
    ...CANDIDATES,
    ...[
      process.env.HTTPS_PROXY,
      process.env.https_proxy,
      process.env.HTTP_PROXY,
      process.env.http_proxy,
    ].filter(Boolean),
  ];

  // 去重后逐个试。第一个通的就定案 —— 不继续试，避免无谓的请求。
  for (const p of [...new Set(list)]) {
    if (await probe(p, timeoutMs)) {
      cached = p;
      return cached;
    }
  }
  cached = null; // 都不可用：当作直连（境外 runner 正是如此）
  return cached;
}

/** 清掉缓存。测试用 —— 也用于代理软件中途重启后强制重探。 */
export function resetProxyCache() {
  cached = undefined;
}
