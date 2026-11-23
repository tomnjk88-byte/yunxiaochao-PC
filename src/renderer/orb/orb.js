'use strict';

/**
 * 悬浮球渲染层（v1.4.0）
 *
 * 这个页面只做四件事：显示封面、拖、点、右键。
 * 所有状态都由主进程推下来（orb:state），页面自己不留真相 ——
 * 球被换绑、改名、换大小之后，界面不会和配置对不上。
 */

const id = new URLSearchParams(location.search).get('id') || '';

const ball = document.getElementById('ball');
const cover = document.getElementById('cover');
const glyph = document.getElementById('glyph');
const count = document.getElementById('count');

const thumbUrl = (rel) => 'guide://thumb/' + btoa(unescape(encodeURIComponent(rel))).replace(/=+$/, '');

let state = null;

function applyState(s) {
  if (!s || !s.orb) return;
  state = s;
  const orb = s.orb;
  const scale = Number(orb.scale) || 1;
  ball.style.setProperty('--s', String(scale));

  const label = String(orb.label || '小抄');
  document.title = label;
  glyph.textContent = label.slice(0, 1);

  if (s.cover) {
    const url = thumbUrl(s.cover);
    if (cover.getAttribute('src') !== url) cover.src = url;
    ball.classList.remove('empty');
  } else {
    cover.removeAttribute('src');
    ball.classList.add('empty');
  }

  // 数量超过 99 就不精确显示了，角标位置放不下，意义也不大
  count.textContent = s.count > 99 ? '99+' : s.count > 1 ? String(s.count) : '';
  document.body.classList.toggle('hidden', s.visible === false);
}

cover.addEventListener('error', () => {
  // 封面被删 / 格式不支持：退回文字态，不要留一个碎图标
  cover.removeAttribute('src');
  ball.classList.add('empty');
});

if (window.yunx && window.yunx.orb) {
  window.yunx.orb.onState(applyState);
  window.yunx.orb.ready(id);
}

// ---------------------------------------------------------------------------
// 拖拽 / 点击
// 用 screenX/screenY 而不是 movementX：多屏 + 不同 DPI 缩放下 movement 会累积漂移
// ---------------------------------------------------------------------------
let down = null;
let moved = false;

ball.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  down = { x: e.screenX, y: e.screenY };
  moved = false;
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!down) return;
  if (!moved) {
    if (Math.abs(e.screenX - down.x) < 3 && Math.abs(e.screenY - down.y) < 3) return;
    moved = true;
    document.body.classList.add('dragging');
    window.yunx.orb.dragStart({ id, screenX: down.x, screenY: down.y });
  }
  window.yunx.orb.dragMove({ id, screenX: e.screenX, screenY: e.screenY });
});

window.addEventListener('mouseup', (e) => {
  if (!down) return;
  const wasMoved = moved;
  down = null;
  moved = false;
  document.body.classList.remove('dragging');
  if (wasMoved) {
    window.yunx.orb.dragEnd(id);
    return;
  }
  if (e.button === 0) window.yunx.orb.click(id);
});

ball.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.yunx.orb.context(id);
});

// Alt + 滚轮改大小。普通滚轮不拦，让系统行为照常
ball.addEventListener(
  'wheel',
  (e) => {
    if (!e.altKey) return;
    e.preventDefault();
    window.yunx.orb.wheel({ id, delta: e.deltaY });
  },
  { passive: false }
);

// 双击 = 打开设置里的悬浮球页，方便找不到配置入口的人
ball.addEventListener('dblclick', () => {
  window.yunx.win.showMain();
});
