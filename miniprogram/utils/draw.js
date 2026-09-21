/**
 * 图元 → canvas 2d。
 *
 * 场景（scene）由 src/lib/scene.js 生成，网页端把它序列化成 SVG，
 * 小程序端用这里的函数画到 canvas 2d。**几何只算一次**，两端不会漂移。
 *
 * ⚠ 本文件只负责「怎么画」，不参与任何坐标计算。
 *   如果这里出现了 + 天数、× 宽度 之类的算式，说明逻辑放错了层。
 */

/** #RRGGBB + 透明度 → rgba() */
export function rgba(hex, a) {
  if (a == null || a >= 1) return hex;
  const s = String(hex).replace('#', '');
  const full = s.length === 3 ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2] : s;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

const FONT = '"PingFang SC","Hiragino Sans GB","Noto Sans SC",sans-serif';
const MONO = '"SF Mono",Menlo,Consolas,monospace';

/* 降级路径：部分安卓 WebView 画不出虚线（setLineDash 被忽略），
   这种情况下退化成实线，而不是画出错位的虚线段。 */
function canDash(ctx) {
  return typeof ctx.setLineDash === 'function';
}

/**
 * 把一个场景画到 canvas 2d 上下文。
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} scene { width, height, elements }
 * @param {number} dpr  设备像素比（调用方已按 dpr 放大画布并 scale）
 */
export function drawScene(ctx, scene, dpr = 1) {
  ctx.clearRect(0, 0, scene.width, scene.height);
  ctx.lineCap = 'butt';
  ctx.textBaseline = 'alphabetic';

  for (const e of scene.elements) {
    ctx.save();
    if (e.op != null) ctx.globalAlpha = e.op;

    if (e.k === 'line') {
      ctx.beginPath();
      ctx.strokeStyle = e.stroke || '#000';
      ctx.lineWidth = e.w || 1;
      if (canDash(ctx)) ctx.setLineDash(e.dash || []);
      ctx.moveTo(e.x1, e.y1);
      ctx.lineTo(e.x2, e.y2);
      ctx.stroke();
    } else if (e.k === 'circle') {
      ctx.beginPath();
      ctx.arc(e.cx, e.cy, Math.max(0, e.r), 0, Math.PI * 2);
      if (e.fill) {
        ctx.fillStyle = e.fill;
        ctx.fill();
      }
      if (e.stroke) {
        ctx.strokeStyle = e.stroke;
        ctx.lineWidth = e.w || 1;
        if (canDash(ctx)) ctx.setLineDash(e.dash || []);
        ctx.stroke();
      }
    } else if (e.k === 'poly') {
      if (!e.pts || !e.pts.length) {
        ctx.restore();
        continue;
      }
      ctx.beginPath();
      for (let i = 0; i < e.pts.length; i++) {
        const p = e.pts[i];
        if (i === 0) ctx.moveTo(p[0], p[1]);
        else ctx.lineTo(p[0], p[1]);
      }
      if (e.grad) {
        // 面积渐变：从 grad.y0（顶部，a0）到 grad.y1（底部，a1）
        const g = ctx.createLinearGradient(0, e.grad.y0, 0, e.grad.y1);
        g.addColorStop(0, rgba(e.grad.color, e.grad.a0));
        g.addColorStop(1, rgba(e.grad.color, e.grad.a1));
        ctx.fillStyle = g;
        ctx.fill();
      } else if (e.fill) {
        ctx.fillStyle = e.fill;
        ctx.fill();
      }
      if (e.stroke) {
        ctx.strokeStyle = e.stroke;
        ctx.lineWidth = e.w || 1;
        ctx.lineJoin = e.lineJoin || 'miter';
        if (canDash(ctx)) ctx.setLineDash(e.dash || []);
        ctx.stroke();
      }
    } else if (e.k === 'text') {
      const size = e.size || 11;
      ctx.font = `${e.weight ? e.weight + ' ' : ''}${size}px ${e.mono ? MONO : FONT}`;
      ctx.fillStyle = e.fill || '#000';
      ctx.textAlign = e.anchor === 'middle' ? 'center' : e.anchor === 'end' ? 'right' : 'left';
      // 坐标 y 按文字基线理解，与 SVG 的默认 baseline 对齐方式一致
      ctx.fillText(e.s, e.x, e.y);
    }

    ctx.restore();
  }
}

/**
 * 在页面里把一张 canvas 准备好：查节点、按 dpr 放大、缩放上下文。
 * @param {object} page 页面实例（用于 createSelectorQuery().in）
 * @param {string} selector 形如 '#survival'
 */
export function setupCanvas(page, selector) {
  return new Promise((resolve) => {
    wx.createSelectorQuery()
      .in(page)
      .select(selector)
      .fields({ node: true, size: true })
      .exec((res) => {
        const info = res && res[0];
        if (!info || !info.node) {
          resolve(null); // canvas 2d 不可用（基础库过低）时静默跳过，不阻断页面
          return;
        }
        let dpr = 2;
        try {
          const sys = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
          dpr = sys.pixelRatio || 2;
        } catch (e) {
          /* 取不到就用 2 */
        }
        const node = info.node;
        const w = info.width;
        const h = info.height;
        node.width = Math.round(w * dpr);
        node.height = Math.round(h * dpr);
        const ctx = node.getContext('2d');
        ctx.scale(dpr, dpr);
        resolve({ node, ctx, width: w, height: h, dpr });
      });
  });
}
