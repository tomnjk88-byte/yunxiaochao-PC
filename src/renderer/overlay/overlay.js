/*
 * 云小抄 PC · 悬浮小抄窗（AGPL-3.0）
 *
 * 只做三件事：列目录、看图、把窗口的透明度/宽度/位置同步给主进程。
 * 所有文件访问都走 guide:// 协议，页面自己拿不到 fs。
 */

'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

let cfg = null;
let rel = '';
let listing = null;
let images = [];
let viewerIndex = 0;
let scale = 1;
let tx = 0;
let ty = 0;

const b64url = (str) => btoa(unescape(encodeURIComponent(str)))
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

const thumbUrl = (r) => 'guide://thumb/' + b64url(r);
const imageUrl = (r) => 'guide://img/' + b64url(r);

function toast(msg, ms = 2000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

function applyTheme() {
  document.documentElement.dataset.theme = (cfg.ui && cfg.ui.theme) || 'dark';
}

function paintRange(el) {
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const pct = ((Number(el.value) - min) / (max - min)) * 100;
  el.style.setProperty('--pct', pct + '%');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showState(title, text, withPick) {
  $('#state').classList.add('show');
  $('#stateTitle').textContent = title;
  $('#stateText').textContent = text;
  $('#btnPick').style.display = withPick ? '' : 'none';
}

function hideState() {
  $('#state').classList.remove('show');
}

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------
async function load(targetRel, opts = {}) {
  const r = await yunx.guide.list(targetRel || '');
  if (!r || !r.ok) {
    listing = null;
    images = [];
    $('#grid').innerHTML = '';
    $('#chips').innerHTML = '';
    if (!cfg.guide.root) {
      showState('还没选攻略文件夹',
        '把手机上的「本地小抄」文件夹拷到电脑，或者新建一个目录，里面按分类放图片。', true);
    } else {
      showState('读不到这个文件夹', r ? r.error : '文件夹可能被移走了', true);
    }
    return;
  }

  rel = r.rel || '';
  listing = r;
  images = r.images || [];
  cfg.guide.lastCategory = rel;
  yunx.cfg.patch({ guide: { lastCategory: rel } });

  $('#crumb').textContent = r.crumbs.length ? r.crumbs[r.crumbs.length - 1].name : '小抄';
  $('#btnBack').style.opacity = rel ? '1' : '0.35';

  renderChips(r.crumbs);
  renderGrid(r);

  if (!r.folders.length && !r.images.length) {
    showState('这里还没有图片', '往这个文件夹里放几张 png / jpg，回来点刷新就能看到。', false);
  } else {
    hideState();
  }

  if (opts.scrollTop !== false) $('.grid').scrollTop = 0;
}

function renderChips(crumbs) {
  const box = $('#chips');
  box.innerHTML = crumbs.map((c, i) => {
    const on = i === crumbs.length - 1;
    return `<button class="chip ${on ? 'on' : ''}" data-rel="${escapeHtml(c.rel)}">${escapeHtml(c.name)}</button>`;
  }).join('');
  $$('.chip', box).forEach((b) => {
    b.onclick = () => load(b.dataset.rel);
  });
}

/**
 * 一个分类里可能有上千张图。一次性把全部卡片塞进 DOM，打开分类会明显顿一下，
 * 而且浏览器会把视口附近几百张缩略图一起排队请求，主进程那边就顶住了。
 * 改成：先渲染 3 屏，剩下的在空闲帧里分批补；视口外的卡片交给 CSS 的
 * content-visibility 跳过布局。
 */
const GRID_FIRST = 60;
const GRID_BATCH = 60;
let gridToken = 0;

function imageCard(img, i) {
  return `
      <div class="card" data-index="${i}">
        <img src="${thumbUrl(img.rel)}" loading="lazy" decoding="async" alt="">
        <div class="cap">${escapeHtml(img.name)}</div>
      </div>`;
}

function renderGrid(r) {
  const token = ++gridToken;
  const grid = $('#grid');
  const parts = [];
  for (const f of r.folders) {
    const cover = f.cover ? `<img src="${thumbUrl(f.cover)}" loading="lazy" decoding="async" alt="">` : '<div class="noimg">▤</div>';
    parts.push(`
      <div class="card folder" data-folder="${escapeHtml(f.rel)}">
        ${cover}
        <div class="badge">${f.count || 0}</div>
        <div class="cap">${escapeHtml(f.name)}</div>
      </div>`);
  }
  const head = Math.min(r.images.length, GRID_FIRST);
  for (let i = 0; i < head; i++) parts.push(imageCard(r.images[i], i));
  grid.innerHTML = parts.join('');
  if (r.images.length <= GRID_FIRST) return;

  let at = GRID_FIRST;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn(), 50));
  const more = () => {
    if (token !== gridToken || at >= r.images.length) return;
    const end = Math.min(at + GRID_BATCH, r.images.length);
    const frag = [];
    for (let i = at; i < end; i++) frag.push(imageCard(r.images[i], i));
    grid.insertAdjacentHTML('beforeend', frag.join(''));
    at = end;
    if (at < r.images.length) idle(more, { timeout: 500 });
  };
  idle(more, { timeout: 500 });
}

$('#grid').addEventListener('click', (e) => {
  const folder = e.target.closest('[data-folder]');
  if (folder) {
    load(folder.dataset.folder);
    return;
  }
  const img = e.target.closest('[data-index]');
  if (img) openViewer(Number(img.dataset.index));
});

$('#grid').addEventListener('error', () => {}, true);

// ---------------------------------------------------------------------------
// 大图
// ---------------------------------------------------------------------------
function openViewer(i) {
  if (!images.length) return;
  viewerIndex = Math.max(0, Math.min(images.length - 1, i));
  const it = images[viewerIndex];
  $('#viewerImg').src = imageUrl(it.rel);
  $('#viewerName').textContent = it.name;
  $('#viewerIdx').textContent = `${viewerIndex + 1} / ${images.length}`;
  resetZoom();
  $('#viewer').classList.add('show');
}

function closeViewer() {
  $('#viewer').classList.remove('show');
  $('#viewerImg').removeAttribute('src');
  resetZoom();
}

function resetZoom() {
  scale = 1; tx = 0; ty = 0;
  applyTransform();
  $('#btnZoom').textContent = '1×';
}

function applyTransform() {
  const img = $('#viewerImg');
  img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  $('#btnZoom').textContent = scale > 1.01 ? scale.toFixed(1) + '×' : '1×';
}

function zoomAt(delta, cx, cy) {
  const next = Math.max(1, Math.min(5, scale * delta));
  if (Math.abs(next - scale) < 0.001) return;
  const stage = $('#viewerStage');
  const r = stage.getBoundingClientRect();
  const ox = cx - (r.left + r.width / 2);
  const oy = cy - (r.top + r.height / 2);
  const k = next / scale;
  tx = ox - (ox - tx) * k;
  ty = oy - (oy - ty) * k;
  scale = next;
  if (scale <= 1.001) { tx = 0; ty = 0; }
  applyTransform();
}

/**
 * 滚轮三种用法（v1.4.0）：
 *   普通滚轮   → 上一张 / 下一张（用户要的「快速翻页」）
 *   Ctrl+滚轮  → 图片缩放（原来的行为，挪到组合键上）
 *   Alt+滚轮   → 窗口透明度，交给全局处理器
 * 翻页要节流：一次物理滚动会连发好几帧 wheel，不拦就是连翻七八张。
 */
let wheelLockAt = 0;
$('#viewerStage').addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.altKey) return;
  if (e.ctrlKey) {
    zoomAt(e.deltaY < 0 ? 1.14 : 1 / 1.14, e.clientX, e.clientY);
    return;
  }
  const now = Date.now();
  if (now - wheelLockAt < 190) return;
  wheelLockAt = now;
  if (e.deltaY < 0) $('#btnPrev').click();
  else if (e.deltaY > 0) $('#btnNext').click();
}, { passive: false });

$('#viewerStage').addEventListener('dblclick', (e) => {
  e.preventDefault();
  const img = $('#viewerImg');
  if (scale > 1.01) {
    resetZoom();
  } else {
    scale = 2.2;
    tx = 0; ty = 0;
    applyTransform();
  }
});

let panning = null;
$('#viewerStage').addEventListener('pointerdown', (e) => {
  if (scale <= 1.01) return;
  panning = { x: e.clientX, y: e.clientY, tx, ty };
  $('#viewerStage').setPointerCapture(e.pointerId);
});
$('#viewerStage').addEventListener('pointermove', (e) => {
  if (!panning) return;
  tx = panning.tx + (e.clientX - panning.x);
  ty = panning.ty + (e.clientY - panning.y);
  applyTransform();
});
$('#viewerStage').addEventListener('pointerup', () => { panning = null; });
$('#viewerStage').addEventListener('click', (e) => {
  if (e.target === $('#viewerStage') && scale <= 1.01) closeViewer();
});

$('#btnPrev').onclick = () => {
  if (viewerIndex <= 0) return;
  openViewer(viewerIndex - 1);
};
$('#btnNext').onclick = () => {
  if (viewerIndex >= images.length - 1) return;
  openViewer(viewerIndex + 1);
};
$('#btnVClose').onclick = closeViewer;
$('#btnZoom').onclick = () => {
  if (scale > 1.01) resetZoom();
  else { scale = 2.2; applyTransform(); }
};

/**
 * Alt+滚轮 = 透明度，Ctrl+滚轮 = 窗口大小。
 * 挂在 window 上而不是某个容器：用户在网格、大图、标题栏上滚都应该生效。
 */
function nudgeAlpha(delta) {
  const cur = Number(cfg.guide.alpha);
  const next = Math.max(0.25, Math.min(1, Math.round(((Number.isFinite(cur) ? cur : 1) + delta) * 100) / 100));
  if (next === cur) return;
  cfg.guide.alpha = next;
  yunx.guide.setAlpha(next);
  toast(`透明度 ${Math.round(next * 100)}%`, 900);
}

function nudgeWidth(delta) {
  const cur = Number(cfg.guide.w) || 400;
  const next = Math.max(300, Math.min(900, Math.round(cur + delta)));
  if (next === cur) return;
  cfg.guide.w = next;
  yunx.guide.setWidth(next);
  toast(`大小 ${next}px`, 900);
}

window.addEventListener('wheel', (e) => {
  if (!e.altKey && !e.ctrlKey) return;
  e.preventDefault();
  const step = e.deltaY < 0 ? 1 : -1;
  if (e.altKey) nudgeAlpha(step * 0.05);
  else nudgeWidth(step * 40);
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (!$('#viewer').classList.contains('show')) return;
  if (e.key === 'Escape') closeViewer();
  if (e.key === 'ArrowLeft') $('#btnPrev').click();
  if (e.key === 'ArrowRight') $('#btnNext').click();
  if (e.key === '0') resetZoom();
});

// ---------------------------------------------------------------------------
// 窗口交互
// ---------------------------------------------------------------------------
function bindDrag(el, { clickToExpand = false } = {}) {
  let down = null;
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button') && !clickToExpand) return;
    down = { x: e.screenX, y: e.screenY, moved: false };
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!down) return;
    if (!down.moved) {
      if (Math.abs(e.screenX - down.x) < 3 && Math.abs(e.screenY - down.y) < 3) return;
      down.moved = true;
      yunx.guide.dragStart({ screenX: down.x, screenY: down.y });
    }
    yunx.guide.dragMove({ screenX: e.screenX, screenY: e.screenY });
  });
  window.addEventListener('mouseup', () => {
    if (!down) return;
    const moved = down.moved;
    down = null;
    if (moved) yunx.guide.dragEnd();
    else if (clickToExpand) yunx.guide.setBall(false);
  });
}

bindDrag($('#bar'));
bindDrag($('#ball'), { clickToExpand: true });

// 右下角缩放
let resizing = null;
$('#resize').addEventListener('mousedown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  resizing = { x: e.screenX, y: e.screenY };
  yunx.guide.resizeStart({ screenX: e.screenX, screenY: e.screenY });
});
window.addEventListener('mousemove', (e) => {
  if (!resizing) return;
  yunx.guide.resizeMove({ screenX: e.screenX, screenY: e.screenY });
});
window.addEventListener('mouseup', () => {
  if (!resizing) return;
  resizing = null;
  yunx.guide.resizeEnd();
});

$('#btnBack').onclick = () => {
  if (!rel) return;
  const parts = rel.split('/');
  parts.pop();
  load(parts.join('/'));
};
$('#btnRefresh').onclick = () => {
  load(rel);
  toast('已刷新');
};
$('#btnClose').onclick = () => {
  closeViewer();
  yunx.guide.close();
};
$('#btnBall').onclick = () => yunx.guide.setBall(true);
$('#btnPick').onclick = async () => {
  const r = await yunx.guide.pickRoot();
  if (r && r.ok) {
    cfg.guide.root = r.root;
    load('');
  }
};

// v1.2.3：锁定穿透会立刻让整个窗口点不动，误触之后没有任何视觉线索。
// 改成 3 秒倒计时，期间再点一次即可撤销；倒计时结束才真正穿透。
let lockTimer = 0;
$('#btnLock').onclick = async () => {
  if (lockTimer) {
    clearTimeout(lockTimer);
    lockTimer = 0;
    $('#btnLock').classList.remove('on');
    toast('已取消锁定，窗口仍可点击', 1800);
    return;
  }
  $('#btnLock').classList.add('on');
  toast('3 秒后锁定穿透，再点一次 ⛓ 可取消', 2600);
  lockTimer = setTimeout(async () => {
    lockTimer = 0;
    await yunx.guide.setLocked(true);
    toast('已锁定穿透（只读）· 按 Alt+Q 收起再打开即可解锁', 3600);
  }, 3000);
};

$('#alpha').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('#alphaVal').textContent = v + '%';
  paintRange(e.target);
  yunx.guide.setAlpha(v / 100);
});
$('#width').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('#widthVal').textContent = v;
  paintRange(e.target);
});
$('#width').addEventListener('change', (e) => {
  yunx.guide.setWidth(Number(e.target.value));
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#viewer').classList.contains('show')) closeViewer();
});

yunx.guide.onBall((on) => {
  document.body.classList.toggle('ball-mode', !!on);
});

yunx.guide.onReload(() => load(''));

// 主进程改了透明度/宽度（比如从主界面调），这里跟着走
yunx.onState(({ cfg: next }) => {
  cfg = next;
  applyTheme();
  const a = Math.round((next.guide.alpha || 1) * 100);
  if (document.activeElement !== $('#alpha')) {
    $('#alpha').value = a;
    $('#alphaVal').textContent = a + '%';
    paintRange($('#alpha'));
  }
  if (document.activeElement !== $('#width')) {
    $('#width').value = next.guide.w || 400;
    $('#widthVal').textContent = next.guide.w || 400;
    paintRange($('#width'));
  }
  if (next.guide.ball) document.body.classList.add('ball-mode');
  else document.body.classList.remove('ball-mode');
  // 锁定状态在按钮上要有痕迹，否则用户不知道「点不动」是自己锁的
  if (!lockTimer) $('#btnLock').classList.toggle('on', !!next.guide.locked);
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
/** 从悬浮球进来：主进程说「打开这个分类」，我们直接翻到第一张，不停在网格上 */
if (window.yunx && window.yunx.guide.onOpenAt) {
  window.yunx.guide.onOpenAt(async (p) => {
    try {
      await load((p && p.rel) || '');
      if (images.length) openViewer(0);
      else toast('这个分类里还没有图片', 1600);
    } catch (e) {
      toast('打开失败：' + ((e && e.message) || '未知错误'), 2200);
    }
  });
}

/**
 * 锁定/智能穿透下，鼠标（含滚轮）被系统转发给下层游戏，渲染进程的 JS
 * wheel 事件收不到。主进程用原生的 wheel-scroll 兜底、通过这条通道发来，
 * 让用户在「小抄盖在游戏上、鼠标穿过去」时仍能滚轮翻页。
 * 只有普通翻页（不夹 Alt/Ctrl）；Ctrl/Alt 的调节仍走 window wheel。
 */
if (window.yunx && window.yunx.guide.onWheel) {
  window.yunx.guide.onWheel((p) => {
    const d = Number(p && p.deltaY) || 0;
    if (Math.abs(d) < 2) return;
    if (cur) page(d > 0 ? -1 : 1);
  });
}

(async function boot() {
  cfg = await yunx.cfg.get();
  applyTheme();

  const a = Math.round((cfg.guide.alpha || 1) * 100);
  $('#alpha').value = a;
  $('#alphaVal').textContent = a + '%';
  paintRange($('#alpha'));

  const w = cfg.guide.w || 400;
  $('#width').value = w;
  $('#widthVal').textContent = w;
  paintRange($('#width'));

  if (cfg.guide.ball) document.body.classList.add('ball-mode');

  if (!cfg.guide.root) {
    showState('还没选攻略文件夹',
      '把手机上的「本地小抄」文件夹拷到电脑，或者新建一个目录，里面按分类放图片。', true);
    return;
  }
  await load(cfg.guide.lastCategory || '');
})();
