/*
 * 云小抄 PC · 准星层（AGPL-3.0）
 *
 * 十字线的比例完全照搬 Android 版 CrosshairView：
 *   gap 0.09 / arm 0.28 / dot 0.045 / 线宽 0.006，按窗口短边算。
 * 这样同一张图在手机和电脑上看起来是同一个准星。
 */

'use strict';

const $ = (s) => document.querySelector(s);

const wrap = $('#wrap');
const img = $('#img');
const cv = $('#cv');

let state = { ax: 0.5, ay: 0.5, lines: true, alpha: 1 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (w <= 0 || h <= 0) return;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (!state.lines) return;
  const cx = state.ax * w;
  const cy = state.ay * h;
  const base = Math.min(w, h);
  const gap = clamp(base * 0.09, 2, 8);
  const arm = clamp(base * 0.28, 6, 22);
  const dot = clamp(base * 0.045, 1.4, 3.2);
  const lw = clamp(base * 0.006, 1, 2.4);

  ctx.strokeStyle = '#ff3b30';
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(cx - gap - arm, cy);
  ctx.lineTo(cx - gap, cy);
  ctx.moveTo(cx + gap, cy);
  ctx.lineTo(cx + gap + arm, cy);
  ctx.moveTo(cx, cy - gap - arm);
  ctx.lineTo(cx, cy - gap);
  ctx.moveTo(cx, cy + gap);
  ctx.lineTo(cx, cy + gap + arm);
  ctx.stroke();

  // 白圈衬底，深色图上也看得清
  ctx.beginPath();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.47)';
  ctx.arc(cx, cy, dot + 1.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.fillStyle = '#ff3b30';
  ctx.arc(cx, cy, dot, 0, Math.PI * 2);
  ctx.fill();
}

function apply(data) {
  if (!data) return;
  state.ax = typeof data.ax === 'number' ? data.ax : 0.5;
  state.ay = typeof data.ay === 'number' ? data.ay : 0.5;
  state.lines = !!data.lines;
  state.alpha = typeof data.alpha === 'number' ? data.alpha : 1;

  wrap.style.opacity = String(state.alpha);
  document.body.classList.toggle('adjust', !!data.adjust);
  document.body.classList.toggle('no-image', !data.imageUrl);

  if (data.imageUrl) {
    if (img.getAttribute('src') !== data.imageUrl) img.src = data.imageUrl;
  } else {
    img.removeAttribute('src');
  }
  draw();
}

img.addEventListener('load', draw);

// 窗口被主进程改尺寸时，canvas 跟着重画
const ro = new ResizeObserver(() => draw());
ro.observe(document.documentElement);

// ---------------------------------------------------------------------------
// 调整模式：整窗拖动
// ---------------------------------------------------------------------------
let drag = null;
wrap.addEventListener('mousedown', (e) => {
  if (!document.body.classList.contains('adjust')) return;
  if (e.button !== 0) return;
  drag = { x: e.screenX, y: e.screenY, moved: false };
  yunx.crosshair.dragStart({ screenX: e.screenX, screenY: e.screenY });
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  drag.moved = true;
  yunx.crosshair.dragMove({ screenX: e.screenX, screenY: e.screenY });
});
window.addEventListener('mouseup', () => {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  yunx.crosshair.dragEnd();
  if (!moved) {
    // 单击不做事，避免误触把位置弹回中心
  }
});

// 调整模式下双击回到屏幕中心，和手机上的「一键居中」一致
wrap.addEventListener('dblclick', () => {
  if (document.body.classList.contains('adjust')) yunx.crosshair.center();
});

yunx.crosshair.onProfile(apply);

(async function boot() {
  const r = await yunx.crosshair.list();
  const active = (r.profiles || []).find((p) => p.id === r.activeId) || (r.profiles || [])[0];
  if (!active) return;
  const url = active.imageUrl || '';
  apply({
    ax: active.ax,
    ay: active.ay,
    lines: active.lines,
    alpha: active.alpha,
    imageUrl: url,
    adjust: false,
  });
})();
