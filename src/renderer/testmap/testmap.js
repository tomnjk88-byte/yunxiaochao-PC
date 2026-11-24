/* 测试地图：滚轮缩放、拖动平移、点击计数（用来验证小抄的穿透是否生效） */
'use strict';

const stage = document.getElementById('stage');
const world = document.getElementById('world');
const zoomVal = document.getElementById('zoomVal');
const clickVal = document.getElementById('clickVal');
const flash = document.getElementById('flash');

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
let scale = 1;
let tx = 0;
let ty = 0;

function apply() {
  world.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  zoomVal.textContent = Math.round(scale * 100) + '%';
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function reset() {
  scale = 1;
  tx = 0;
  ty = 0;
  apply();
}

/* 滚轮缩放：以鼠标位置为中心，和游戏地图的手感一致 */
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = stage.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const next = clamp(scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), MIN_SCALE, MAX_SCALE);
  if (next === scale) return;
  // 保持光标下的世界坐标不动
  const wx = (px - tx) / scale;
  const wy = (py - ty) / scale;
  scale = next;
  tx = px - wx * scale;
  ty = py - wy * scale;
  apply();
}, { passive: false });

/* 拖动平移；位移小于 4px 视为点击 */
let drag = null;

stage.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  drag = { sx: e.clientX, sy: e.clientY, ox: tx, oy: ty, moved: 0 };
  stage.classList.add('dragging');
});

window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy;
  drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
  tx = drag.ox + dx;
  ty = drag.oy + dy;
  apply();
});

window.addEventListener('mouseup', (e) => {
  if (!drag) return;
  const wasClick = drag.moved < 4;
  drag = null;
  stage.classList.remove('dragging');
  if (!wasClick) return;

  // 点击计数：小抄穿透生效时，这里的数字会 +1
  const n = Number(clickVal.textContent) + 1;
  clickVal.textContent = String(n);

  const rect = stage.getBoundingClientRect();
  flash.style.left = (e.clientX - rect.left) + 'px';
  flash.style.top = (e.clientY - rect.top) + 'px';
  flash.classList.remove('on');
  void flash.offsetWidth;
  flash.classList.add('on');
});

document.getElementById('btnReset').addEventListener('click', (e) => {
  e.stopPropagation();
  reset();
});

apply();
