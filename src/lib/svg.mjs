/**
 * 图元 → SVG。与 scene.js 配对，供**服务端**把图表渲染成内联 SVG。
 *
 * 为什么在服务端渲染、而不是让浏览器里的脚本现场画：
 * 内联 SVG 如果只是个空壳，那么在限制脚本执行的 WebView / 预览容器里，
 * 图表就是一片空白（踩过这个坑）。服务端渲染后，页面出厂即完整，
 * 脚本被禁用也照样显示。
 *
 * 消费者与 render.mjs 相同：构建期（scripts/build.mjs）与请求时（server/index.mjs）。
 */

const n = (v) => {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 100) / 100;
  return String(r);
};

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const dashAttr = (dash) => (dash ? ` stroke-dasharray="${n(dash[0])} ${n(dash[1])}"` : '');

/**
 * @returns {{defs:string, body:string}} 交给模板拼进 <svg>…</svg>
 */
export function renderSceneSvg(scene) {
  const defs = [];
  let gradSeq = 0;

  const body = scene.elements
    .map((e) => {
      if (e.k === 'line') {
        return (
          `<line x1="${n(e.x1)}" y1="${n(e.y1)}" x2="${n(e.x2)}" y2="${n(e.y2)}"` +
          ` stroke="${e.stroke ?? 'none'}" stroke-width="${n(e.w ?? 1)}"` +
          `${dashAttr(e.dash)}${e.op != null ? ` opacity="${n(e.op)}"` : ''}/>`
        );
      }

      if (e.k === 'circle') {
        return (
          `<circle cx="${n(e.cx)}" cy="${n(e.cy)}" r="${n(e.r)}"` +
          ` fill="${e.fill ?? 'none'}"` +
          `${e.stroke ? ` stroke="${e.stroke}" stroke-width="${n(e.w ?? 1)}"` : ''}` +
          `${e.op != null ? ` opacity="${n(e.op)}"` : ''}/>`
        );
      }

      if (e.k === 'poly') {
        const d = 'M ' + e.pts.map(([x, y]) => `${n(x)} ${n(y)}`).join(' L ');
        let fill = e.fill ?? 'none';
        if (e.grad) {
          const id = `g${gradSeq++}`;
          defs.push(
            `<linearGradient id="${id}" x1="0" y1="${n(e.grad.y0)}" x2="0" y2="${n(e.grad.y1)}"` +
              ` gradientUnits="userSpaceOnUse">` +
              `<stop offset="0%" stop-color="${e.grad.color}" stop-opacity="${n(e.grad.a0)}"/>` +
              `<stop offset="100%" stop-color="${e.grad.color}" stop-opacity="${n(e.grad.a1)}"/>` +
              `</linearGradient>`
          );
          fill = `url(#${id})`;
        }
        const closed = fill !== 'none' || e.grad;
        return (
          `<path d="${d}${closed ? ' Z' : ''}" fill="${fill}"` +
          `${e.stroke ? ` stroke="${e.stroke}" stroke-width="${n(e.w ?? 1)}"` : ''}` +
          `${e.lineJoin ? ` stroke-linejoin="${e.lineJoin}"` : ''}` +
          `${dashAttr(e.dash)}${e.op != null ? ` opacity="${n(e.op)}"` : ''}/>`
        );
      }

      if (e.k === 'text') {
        const size = e.size ?? 11;
        const family = e.mono
          ? 'ui-monospace,SFMono-Regular,Menlo,monospace'
          : '-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",sans-serif';
        return (
          `<text x="${n(e.x)}" y="${n(e.y)}" fill="${e.fill ?? '#1F1E1B'}"` +
          ` font-size="${n(size)}" font-family='${family}'` +
          `${e.anchor && e.anchor !== 'start' ? ` text-anchor="${e.anchor}"` : ''}` +
          `${e.weight ? ` font-weight="${e.weight}"` : ''}` +
          `${e.op != null ? ` opacity="${n(e.op)}"` : ''}>${esc(e.s)}</text>`
        );
      }

      return '';
    })
    .join('\n');

  return { defs: defs.join('\n'), body };
}

/**
 * 直接产出一段完整的 <svg>…</svg>。
 *
 * width/height 写死为属性，并且不依赖 height:auto ——
 * 靠 height:auto 反推高度时，部分 WebView 内核会把它算成 0，图表就消失了。
 */
export function sceneToSvgTag(scene, attrs = {}) {
  const { defs, body } = renderSceneSvg(scene);
  const id = attrs.id ? ` id="${attrs.id}"` : '';
  const role = attrs.role ? ` role="${attrs.role}"` : '';
  const aria = attrs.label ? ` aria-label="${esc(attrs.label)}"` : '';
  return (
    `<svg${id} width="${n(scene.width)}" height="${n(scene.height)}"` +
    ` viewBox="0 0 ${n(scene.width)} ${n(scene.height)}"${role}${aria}` +
    ` preserveAspectRatio="xMidYMid meet">` +
    `${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>`
  );
}
