# 小程序（微信）· 上手与截图终检

与网页端**共用同一套数据与模型代码**（`src/lib/`），差别只在渲染目标：
网页把 `scene.js` 的图元序列化成 SVG，小程序用 `utils/draw.js` 画到 canvas 2d。
几何只算一次，所以两端不会各画各的。

---

## 一、目录

```
miniprogram/
  app.js                入口：只做一件事 —— 预热数据（不阻塞首屏）
  app.json              页面注册与导航栏配色（宣纸白 #FAF8F4）
  config.js             ★ 上线前要改的运行时配置（域名 / 开关 / 模板 ID）
  data/snapshot.js      ★ 构建产物：离线首屏数据快照，勿手改
  utils/scene.js        ★ 构建产物：从 src/lib/scene.js 同步，勿手改
  utils/draw.js         图元 → canvas 2d（只负责「怎么画」，不做坐标计算）
  utils/view.js         数据 → 视图模型（纯函数、不碰 wx.*，可在 Node 里回归）
  utils/format.js       时间与数字格式化（刻意不用 Intl、不读设备时区）
  utils/api.js          快照 / 网络 / 本地缓存三合一
  utils/subscribe.js    F9：一次性订阅的客户端封装
  pages/index/          观测台首页（含 F9 提醒入口）
  pages/history/        重置历史
```

微信开发者工具导入**仓库根目录**即可，`project.config.json` 里已声明
`miniprogramRoot: "miniprogram/"`。

---

## 二、上手（四步）

1. 导入仓库根目录，把 `project.config.json` 的 `appid` 换成你自己的
   —— 当前是占位值 `touristappid`，用它无法上传。
2. `npm run build`。这一步会干两件小程序必须的事：
   - 写 `miniprogram/data/snapshot.js`（离线首屏数据）
   - 把 `src/lib/scene.js` 同步到 `miniprogram/utils/scene.js`（**不要手改后者**）
3. 改 `miniprogram/config.js`：`apiBase` 填实际域名、`enabled` 置 `true`。
4. 配微信后台的 `request` 合法域名（见第五节）。

---

## 三、为什么首屏不会白屏

数据有两个来源，页面**先出图再联网**：

| 来源 | 何时用 | 说明 |
|---|---|---|
| `data/snapshot.js` | 打开即用 | 构建期写死的快照，离线也可用。冷启动永远是完整的 |
| `GET /api/state` | 联网且 `enabled: true` | 拿到后覆盖快照；本地缓存 30 分钟，超时不再当新鲜数据用 |

`enabled` 默认 `false`，这是有意的：`request` 合法域名没配之前，微信会让所有请求
走 `fail` 回调 —— **静默失败，不弹错**，比白屏更难查。所以在域名配好之前不要打开它。

> 本地调试想连本机服务？把 `apiBase` 指向 `http://127.0.0.1:8787`，
> 并在开发者工具「详情 → 本地设置」里勾上**不校验合法域名**。
> 这只是本地开关，与 `project.config.json` 的 `urlCheck` 无关，也不会跟着上传。

---

## 四、F9 订阅消息（一个必须知道的限制）

微信的**长期订阅**只对政务 / 医疗 / 交通等特定类目开放，工具类目拿不到。
所以 F9 只能做成 **「一次授权 = 一次通知」**：推完一条，额度归零，
用户要再收到得重新进小程序点一次。

这不是没实现，是平台规则。因此：

- 页面文案必须写明这一点（`utils/subscribe.js` 里的 `SCOPE_HINT`）。
- `config.js` 的 `subscribeTemplateId` 为空字符串时，**整个提醒入口不显示** ——
  宁可没有入口，也不给一个点了没反应的按钮。
- 诱导用户连续授权是微信明确禁止的行为，不要绕。

---

## 五、上线前必须改的三处

| # | 位置 | 改成 |
|---|---|---|
| 1 | `project.config.json` → `appid` | 你自己的小程序 AppID |
| 2 | `miniprogram/config.js` → `apiBase` | 已备案的 https 域名（**境外域名备不了案**） |
| 3 | `miniprogram/config.js` → `enabled` | `true`（域名配好之后） |

微信后台侧：把 `apiBase` 的域名加进「开发管理 → 开发设置 → 服务器域名 → request 合法域名」。
同理，`subscribeTemplateId` 需要先在后台建好订阅消息模板再填。

---

## 六、本机能做的校验（不需要开发者工具）

```bash
node scripts/test-miniprogram.mjs   # 96 项：图元坐标不越界、字号不低于可读下限、F9 链路、视觉模型
npm run preview:mp                  # 生成 dist/miniprogram-preview.html
npm run preview:mp -- --demo-signal # 同上，但注入一条合成预告，点亮「信号明确态」
node --check miniprogram/pages/index/index.js    # 逐文件语法检查
```

`npm run preview:mp` 把**真实的 WXSS** 和**真实的 `utils/draw.js`** 搬进一个 375px 宽的
网页里跑一遍（750rpx = 375px，即 1rpx = 0.5px）。它不是小程序运行时，**不能替代真机验证** ——
作用是在上传前用最低成本发现「布局崩了 / 图画到画布外 / 字号小到看不见」这类问题。

---

## 七、终检清单（在微信开发者工具里逐项过）

| # | 检查 | 期望 |
|---|---|---|
| 1 | 首页冷启动（关掉网络 / `enabled:false`） | 数字与图表完整，不是空白或占位骨架 |
| 2 | 两张图（生存曲线 / 间隔点阵） | 线条与文字都在画布内，没有裁切 |
| 3 | 图内最小字号 | 能看清，不能是贴在一起的一团 |
| 4 | 信号区 | 真实快照当前是**线索态**（`level: hint`，只有额度意图、没有时间窗口），所以首页不应出现醒目告警样式 —— 只有拿到时间窗口升级为 `explicit` 才醒目 |
| 5 | 首页 → 重置历史 | 能跳、能返回，历史条数与网页端一致 |
| 6 | F9 提醒入口 | `subscribeTemplateId` 为空时不显示；填了能弹授权 |
| 7 | F9 授权流程 | 授权后回到首页显示「已开启（一次）」；**拒绝后不能还显示已开启** |
| 8 | 预警文案 | 含双时区换算，且不出现版本痕迹与模型元叙述（见 `AGENTS.md` 的红线） |
| 9 | 真机预览（iOS + 安卓各一台） | 与开发者工具一致 —— 尤其安卓的虚线、字体回退 |
| 10 | 信号**明确态**的视觉 | 真实数据长期触发不到这条路径。跑 `npm run preview:mp -- --demo-signal` 看一眼：大字星期、秒级倒计时、朱砂晕染、呼吸光斑是否都在 |

第 9 条是唯一无法在 Mac 上替代的一项，也是这张清单存在的理由。

---

## 八、视觉动效

页面有五组常驻动效，全部是纯 WXSS（`@keyframes` + `transform` / `opacity`），
没有用 `wx.createAnimation`，也没有引入任何组件库：

| 动效 | 位置 | 作用 |
|---|---|---|
| `rise` | 首屏各区块，按 0.02–0.32s 依次浮现 | 让静止的首屏有「依次到位」的顺序感 |
| `halo` | 信号横幅左上角光斑 + 徽章活点 | 让「有信号」这件事持续可见 |
| `idleScan` | 无信号时的灰点 | 说明「还在扫」，而不是「没数据」 |
| `breathe` | 等待偏久时的判定胶囊 | 把结论持续推到眼前。常规区间**不**呼吸 —— 一直闪就成了噪音 |
| `grow` | 等待进度尺的填充条 | 从 0 长出来，比直接显示一个静态百分比更有「时间在走」的意味 |

⚠ **全部依赖 CSS 动画。** 若某个机型不执行动画，`animation-fill-mode: both`
会让元素停在起始态（`opacity: 0`，即不可见）。终检第 9 条的真机检查必须覆盖这一项。

设计上刻意**没有**换成深色底或加高饱和色块 —— 那会和整站的水墨宣纸基调打架。
「不素」是靠**晕染、大字、动效**做出来的，不是靠换配色。
