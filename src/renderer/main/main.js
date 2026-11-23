/*
 * 云小抄 PC · 主界面逻辑（AGPL-3.0）
 *
 * 这一层只管「画」和「转发」：所有落盘、窗口移动、全局快捷键都在主进程。
 * 页面里没有 Node 权限，拿不到 fs，也读不了任意路径。
 */

'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

let cfg = null;
let appInfo = null;
let currentTab = 'guide';
let draggingSlider = false;

const SPEED_FACTOR = [0.7, 1, 1.5, 2.3];
const HOLD_MS = [1000, 1800, 3000];

const SPEC = {
  fine: { size: 22, span: 4.0, lift: 0.16, gap: 0.5, pop: 0.04, round: 0.18, maxTiles: 620 },
  chunky: { size: 92, span: 3.4, lift: 0.34, gap: 1.2, pop: 0.10, round: 0.26, maxTiles: 620 },
};

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

function icon(name) {
  return `<svg><use href="#i-${name}"/></svg>`;
}

function applyTheme() {
  document.documentElement.dataset.theme = cfg.ui.theme || 'dark';
  document.documentElement.dataset.accent = cfg.ui.accent || 'violet';
}

function setSwitch(el, on) {
  el.setAttribute('aria-checked', on ? 'true' : 'false');
}

function paintRange(el) {
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const v = Number(el.value);
  const pct = ((v - min) / (max - min)) * 100;
  el.style.setProperty('--pct', pct + '%');
}

function factor() {
  return SPEED_FACTOR[cfg.motion.speed] || 1;
}

/** 轻量确认框，替代被 Electron 禁掉的 window.confirm */
function confirmBox(title, text, okLabel = '确定') {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal">
        <h4>${title}</h4>
        <p>${text || ''}</p>
        <div class="modal-actions">
          <button class="btn ghost" data-act="cancel">取消</button>
          <button class="btn primary" data-act="ok">${okLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('show'));
    const close = (v) => {
      mask.classList.remove('show');
      setTimeout(() => mask.remove(), 180);
      resolve(v);
    };
    mask.addEventListener('click', (e) => {
      if (e.target === mask) close(false);
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'ok') close(true);
      if (act === 'cancel') close(false);
    });
  });
}

function askText(title, value, hint = '') {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal">
        <h4>${title}</h4>
        <input class="modal-input" maxlength="24" value="${String(value || '').replace(/"/g, '&quot;')}" />
        <p class="modal-tip">${hint}</p>
        <div class="modal-actions">
          <button class="btn ghost" data-act="cancel">取消</button>
          <button class="btn primary" data-act="ok">保存</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    requestAnimationFrame(() => {
      mask.classList.add('show');
      const input = $('.modal-input', mask);
      input.focus();
      input.select();
    });
    const close = (v) => {
      mask.classList.remove('show');
      setTimeout(() => mask.remove(), 180);
      resolve(v);
    };
    const submit = () => {
      const v = $('.modal-input', mask).value.trim();
      if (v) close(v);
    };
    mask.addEventListener('click', (e) => {
      if (e.target === mask) close(null);
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'ok') submit();
      if (act === 'cancel') close(null);
    });
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') close(null);
    });
  });
}

/**
 * 多行输入（Cookie 很长，单行 input 装不下也看不全）。
 * 复用 askText 的弹层样式，只把 input 换成 textarea。
 */
function askCookie(title, hint) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal wide">
        <h4>${title}</h4>
        <textarea class="modal-input" rows="7" spellcheck="false"
          placeholder="__pus=...; __puus=...; 其余项一起带上也没关系"></textarea>
        <p class="modal-tip">${hint}</p>
        <div class="modal-actions">
          <button class="btn ghost" data-act="cancel">取消</button>
          <button class="btn primary" data-act="ok">验证并保存</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    requestAnimationFrame(() => {
      mask.classList.add('show');
      $('.modal-input', mask).focus();
    });
    const close = (v) => {
      mask.classList.remove('show');
      setTimeout(() => mask.remove(), 180);
      resolve(v);
    };
    const submit = () => {
      const v = $('.modal-input', mask).value.trim();
      if (!v) {
        toast('先把 Cookie 粘进来');
        return;
      }
      close(v);
    };
    mask.addEventListener('click', (e) => {
      if (e.target === mask) close(null);
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'ok') submit();
      if (act === 'cancel') close(null);
    });
    // 这里刻意不绑 Enter 提交：Cookie 里本来就有换行，Enter 留给换行用
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
    });
  });
}

// ---------------------------------------------------------------------------
// 碎格幕布（与 Android 版同一套公式）
// ---------------------------------------------------------------------------
const curtain = $('#curtain');
const cctx = curtain.getContext('2d');
let curtainRAF = 0;

function resizeCurtain() {
  const dpr = window.devicePixelRatio || 1;
  curtain.width = Math.floor(window.innerWidth * dpr);
  curtain.height = Math.floor(window.innerHeight * dpr);
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCurtain);

function curtainColor() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  return v || '#0b0c11';
}

function drawCurtain(progress, spec) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  cctx.clearRect(0, 0, W, H);
  if (progress >= 0.999) return;

  const color = curtainColor();
  if (progress <= 0.001) {
    cctx.fillStyle = color;
    cctx.fillRect(0, 0, W, H);
    return;
  }

  let cell = spec.size;
  let cols = Math.max(1, Math.ceil(W / cell));
  let rows = Math.max(1, Math.ceil(H / cell));
  while (cols * rows > spec.maxTiles) {
    cell *= 1.12;
    cols = Math.max(1, Math.ceil(W / cell));
    rows = Math.max(1, Math.ceil(H / cell));
  }
  cols = Math.min(48, Math.max(1, cols));
  rows = Math.min(96, Math.max(1, rows));

  const w = W / cols;
  const h = H / rows;
  const skew = 1.12;
  const units = (cols - 1) * skew + (rows - 1) + spec.span;

  const path = new Path2D();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const delay = c * skew + r;
      const local = Math.min(1, Math.max(0, (progress * units - delay) / spec.span));
      if (local >= 1) continue;
      const eased = local * local;
      const bounce = 1 + spec.pop * Math.sin(local * Math.PI);
      const shrink = (1 - eased) * bounce;
      const hw = (w * 0.5) * shrink;
      const hh = (h * 0.5) * shrink;
      if (hw < 0.6 || hh < 0.6) continue;
      const cx = (c + 0.5) * w;
      const cy = (r + 0.5) * h - h * spec.lift * eased;
      const rad = Math.min(hw, hh) * spec.round * eased;
      path.roundRect(cx - hw + spec.gap, cy - hh + spec.gap, (hw - spec.gap) * 2, (hh - spec.gap) * 2, rad);
    }
  }
  cctx.fillStyle = color;
  cctx.fill(path);
}

function playCurtain(spec, durationMs) {
  return new Promise((resolve) => {
    if (!cfg.motion.enabled || durationMs <= 0) {
      curtain.style.display = 'none';
      resolve();
      return;
    }
    cancelAnimationFrame(curtainRAF);
    resizeCurtain();
    curtain.style.display = 'block';
    drawCurtain(0, spec);
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / durationMs);
      drawCurtain(t, spec);
      if (t < 1) {
        curtainRAF = requestAnimationFrame(tick);
      } else {
        curtain.style.display = 'none';
        resolve();
      }
    };
    curtainRAF = requestAnimationFrame(tick);
  });
}

function zoomStage(ms) {
  const stage = $('.stage');
  stage.style.transition = 'none';
  stage.style.transform = 'scale(0.96)';
  void stage.offsetWidth;
  stage.style.transition = `transform ${ms}ms linear`;
  stage.style.transform = 'scale(1)';
  setTimeout(() => {
    stage.style.transition = '';
    stage.style.transform = '';
  }, ms + 60);
}

// ---------------------------------------------------------------------------
// 模块浮现
// ---------------------------------------------------------------------------
function replayRise(container) {
  if (!container) return;
  container.classList.remove('motion-rise');
  const mods = $$('.module', container);
  mods.forEach((el, i) => el.style.setProperty('--i', i));
  void container.offsetWidth;
  container.classList.add('motion-rise');
}

function clearRise(container) {
  if (container) container.classList.remove('motion-rise');
}

function playEntrance() {
  const m = cfg.motion;
  if (!m.enabled) {
    document.body.classList.add('no-motion');
    return;
  }
  document.body.classList.remove('no-motion');
  if (m.entrance === 0) {
    const ms = 900 / factor();
    zoomStage(ms * 0.66);
    playCurtain(SPEC.fine, ms);
  } else {
    replayRise($('.page.active'));
  }
}

// ---------------------------------------------------------------------------
// 开屏
// ---------------------------------------------------------------------------
function playSplash() {
  return new Promise(async (resolve) => {
    if (!cfg.splash.enabled) return resolve();
    const el = $('#splash');
    const media = $('#splashMedia');
    const builtin = $('#splashBuiltin');
    const bar = $('#splashBar');
    media.innerHTML = '';
    builtin.classList.remove('show');
    bar.style.transition = 'none';
    bar.style.width = '0';

    let url = '';
    try {
      url = await yunx.splash.url();
    } catch { /* 读不到就当没设过 */ }

    let total = HOLD_MS[cfg.splash.hold] || 1800;
    let video = null;

    if (url && cfg.splash.kind === 1) {
      video = document.createElement('video');
      video.src = url;
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.loop = false;
      media.appendChild(video);
      total = 15000;
    } else if (url) {
      const img = document.createElement('img');
      img.src = url;
      media.appendChild(img);
      total = (HOLD_MS[cfg.splash.hold] || 1800) + 600;
    } else {
      builtin.classList.add('show');
      total = 1500;
    }

    el.classList.add('show');
    el.classList.remove('out');

    let done = false;
    let raf = 0;
    let timer = 0;
    const start = performance.now();

    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      if (video) {
        try { video.pause(); } catch { /* 已经结束了 */ }
      }
      el.classList.add('out');
      setTimeout(() => {
        el.classList.remove('show', 'out');
        media.innerHTML = '';
        resolve();
      }, 280);
    };

    const loop = () => {
      const now = performance.now();
      const p = Math.min(1, (now - start) / total);
      bar.style.width = (p * 100).toFixed(2) + '%';
      if (p < 1) raf = requestAnimationFrame(loop);
      else finish();
    };
    requestAnimationFrame(loop);

    // 视频播完就结束，别让用户对着最后一帧等
    if (video) {
      video.addEventListener('ended', finish, { once: true });
      video.play().catch(() => { /* 自动播放被拦就按计时走 */ });
    }

    timer = setTimeout(finish, total + 100);
    el.onclick = finish;
  });
}

// ---------------------------------------------------------------------------
// 状态同步
// ---------------------------------------------------------------------------
function renderRuntime(rt) {
  if (!rt) return;
  $('#pillGuide').classList.toggle('on', !!rt.guideVisible);
  $('#pillCross').classList.toggle('on', !!rt.crosshairVisible);
  const any = rt.guideVisible || rt.crosshairVisible;
  const rs = $('#railStatus');
  rs.classList.toggle('on', any);
  $('span', rs).textContent = any
    ? [rt.guideVisible ? '小抄' : '', rt.crosshairVisible ? '准星' : ''].filter(Boolean).join(' + ') + ' 运行中'
    : '未运行';

  $('#guideStateText').textContent = rt.guideVisible ? '正在显示 · 热键随时收起' : '当前未运行';
  $('#crossStateText').textContent = rt.crosshairVisible ? '正在叠加 · 穿透模式' : '当前未运行';

  const gBtn = $('#btnGuideToggle');
  gBtn.textContent = rt.guideVisible ? '收 起 小 抄' : '开 启 小 抄';
  const cBtn = $('#btnCrossToggle');
  cBtn.textContent = rt.crosshairVisible ? '收 起 准 星' : '开 启 准 星';

  setSwitch($('#switchGuideLock'), !!cfg.guide.locked);
  setSwitch($('#switchGuideTop'), cfg.guide.forceTop !== false);
  $('#btnAdjust').classList.toggle('primary', !!rt.crosshairAdjust);
}

function renderAll() {
  applyTheme();
  renderGuide();
  renderCrosshair();
  renderLook();
  renderDownload();
  renderAbout();
}

// ---------------------------------------------------------------------------
// 小抄页
// ---------------------------------------------------------------------------
function renderGuide() {
  const g = cfg.guide;
  $('#folderName').textContent = g.root ? g.root.split(/[\\/]/).pop() : '还没选文件夹';
  $('#folderPath').textContent = g.root || '选一个装着分类子文件夹或图片的目录';
  $('#folderStat').textContent = '';

  $('#alphaRange').value = Math.round(g.alpha * 100);
  $('#alphaVal').textContent = Math.round(g.alpha * 100) + '%';
  paintRange($('#alphaRange'));

  $('#widthRange').value = g.w || 400;
  $('#widthVal').textContent = (g.w || 400) + ' px';
  paintRange($('#widthRange'));

  setSwitch($('#switchGuideLock'), !!g.locked);
  setSwitch($('#switchGuideTop'), g.forceTop !== false);

  renderHotkeys();
  refreshFolderInfo();
}

async function refreshFolderInfo() {
  if (!cfg.guide.root) {
    $('#topFolders').innerHTML = '';
    return;
  }
  try {
    const [ov, list] = await Promise.all([yunx.guide.overview(), yunx.guide.list('')]);
    if (ov && ov.ok) {
      $('#folderStat').textContent = `${ov.images} 张图 · ${ov.folders} 个文件夹`;
    }
    if (list && list.ok) {
      const chips = list.folders.slice(0, 8).map((f) => {
        const name = f.name.length > 10 ? f.name.slice(0, 10) + '…' : f.name;
        return `<div class="chip">${name}<b>${f.count}</b></div>`;
      });
      if (list.images.length) {
        chips.push(`<div class="chip">根目录散图<b>${list.images.length}</b></div>`);
      }
      $('#topFolders').innerHTML = chips.join('');
    }
  } catch { /* 目录被删了也不该把界面弄崩 */ }
}

const HOTKEYS = [
  { key: 'toggleGuide', label: '显示 / 收起小抄' },
  { key: 'toggleCrosshair', label: '显示 / 收起准星' },
  { key: 'nextCrosshair', label: '切换下一套准星' },
  { key: 'hideAll', label: '全部隐藏（急停）' },
];

let recordingKey = null;

function renderHotkeys() {
  const box = $('#hotkeyList');
  box.innerHTML = HOTKEYS.map((h) => `
    <div class="hotkey-item">
      <span>${h.label}</span>
      <button class="keycap" data-key="${h.key}">${cfg.hotkeys[h.key] || '未设置'}</button>
    </div>`).join('');

  $$('.keycap', box).forEach((btn) => {
    btn.addEventListener('click', () => {
      if (recordingKey === btn.dataset.key) {
        recordingKey = null;
        renderHotkeys();
        return;
      }
      recordingKey = btn.dataset.key;
      renderHotkeys();
      const target = $(`.keycap[data-key="${recordingKey}"]`);
      if (target) {
        target.classList.add('recording');
        target.textContent = '按下组合键…';
      }
    });
  });
}

function acceleratorFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  const code = e.code || '';
  let key = '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (code === 'Space') key = 'Space';
  else if (code === 'Escape') key = 'Esc';
  else if (/^(Arrow|Home|End|Page|Insert|Delete|Tab|Enter|Backspace)/.test(code)) key = code;
  if (!key) return '';
  return [...mods, key].join('+');
}

window.addEventListener('keydown', async (e) => {
  if (!recordingKey) return;
  if (e.key === 'Escape') {
    recordingKey = null;
    renderHotkeys();
    return;
  }
  const acc = acceleratorFromEvent(e);
  if (!acc) return;
  e.preventDefault();
  e.stopPropagation();
  // 至少带一个修饰键，否则打字就会触发
  if (!/(Ctrl|Alt|Shift|Super)\+/.test(acc) && !/^F\d/.test(acc)) {
    toast('至少要带 Ctrl / Alt / Shift 之一');
    return;
  }
  const key = recordingKey;
  recordingKey = null;
  const res = await yunx.hotkey.set(key, acc);
  if (res && res.ok) toast('已改绑：' + acc);
  else toast('这个组合被别的程序占用了，换一个');
  renderHotkeys();
});

// ---------------------------------------------------------------------------
// 准星页
// ---------------------------------------------------------------------------
let profileCache = [];
let lastCrossSig = '';

function crossSig(c) {
  return JSON.stringify((c.profiles || []).map((p) => [p.id, p.name, p.image]))
    + '|' + (c.activeId || '');
}

async function renderCrosshair() {
  const data = await yunx.crosshair.list();
  profileCache = data.profiles || [];
  const active = profileCache.find((p) => p.id === data.activeId) || profileCache[0];

  const strip = $('#profileStrip');
  strip.innerHTML = profileCache.map((p) => `
    <div class="profile-card ${p.id === (active && active.id) ? 'active' : ''}" data-id="${p.id}">
      <div class="thumb">${p.imageUrl ? `<img src="${p.imageUrl}" alt="">` : icon('image')}</div>
      <div class="name">${escapeHtml(p.name)}</div>
    </div>`).join('') + `<div class="profile-card new" id="cardNew">${icon('plus')}<div class="name">新建</div></div>`;

  $$('.profile-card[data-id]', strip).forEach((card) => {
    card.addEventListener('click', async () => {
      await yunx.crosshair.select(card.dataset.id);
      renderCrosshair();
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      profileMenu(card.dataset.id);
    });
  });
  $('#cardNew').addEventListener('click', async () => {
    const r = await yunx.crosshair.create();
    if (r && r.ok) renderCrosshair();
    else toast((r && r.error) || '新建失败');
  });

  if (!active) {
    $('#previewImg').removeAttribute('src');
    $('#previewWrap').classList.remove('has-image');
    $('#previewEmpty').style.display = '';
    lastCrossSig = crossSig(cfg.crosshair);
    return;
  }

  const wrap = $('#previewWrap');
  const img = $('#previewImg');
  if (active.imageUrl) {
    img.src = active.imageUrl;
    wrap.classList.add('has-image');
    $('#previewEmpty').style.display = 'none';
  } else {
    img.removeAttribute('src');
    wrap.classList.remove('has-image');
    $('#previewEmpty').style.display = '';
  }
  positionAnchor(active.ax, active.ay);

  $('#crossWidth').value = active.width || 220;
  $('#crossWidthVal').textContent = (active.width || 220) + ' px';
  paintRange($('#crossWidth'));
  $('#crossAlpha').value = Math.round((active.alpha ?? 1) * 100);
  $('#crossAlphaVal').textContent = Math.round((active.alpha ?? 1) * 100) + '%';
  paintRange($('#crossAlpha'));
  setSwitch($('#switchLines'), !!active.lines);
  $('#btnAdjust').classList.toggle('primary', !!cfg.crosshair.adjust);
  lastCrossSig = crossSig(cfg.crosshair);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function positionAnchor(ax, ay) {
  const img = $('#previewImg');
  const wrap = $('#previewWrap');
  const dot = $('#anchorDot');
  if (!img.src || !img.naturalWidth) {
    dot.style.display = 'none';
    return;
  }
  const wr = wrap.getBoundingClientRect();
  const ir = img.getBoundingClientRect();
  const x = ir.left - wr.left + ir.width * ax;
  const y = ir.top - wr.top + ir.height * ay;
  dot.style.left = x + 'px';
  dot.style.top = y + 'px';
  dot.style.display = 'block';
}

async function profileMenu(id) {
  const p = profileCache.find((x) => x.id === id);
  if (!p) return;
  const act = await menuBox(p.name, [
    { key: 'rename', label: '重命名' },
    { key: 'delete', label: '删除这一套', danger: true },
  ]);
  if (act === 'rename') {
    const name = await askText('重命名准星', p.name, '最多 24 个字');
    if (name) {
      await yunx.crosshair.rename(id, name);
      renderCrosshair();
    }
    return;
  }
  if (act === 'delete') {
    if (profileCache.length <= 1) {
      toast('至少要留一套');
      return;
    }
    const del = await confirmBox('删除「' + escapeHtml(p.name) + '」？', '图片文件不会删，只从列表里移除。', '删除');
    if (del) {
      const r = await yunx.crosshair.remove(id);
      if (r && r.ok) renderCrosshair();
      else toast((r && r.error) || '删除失败');
    }
  }
}

function menuBox(title, items) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal menu">
        <h4>${escapeHtml(title)}</h4>
        ${items.map((it) => `<button class="menu-item ${it.danger ? 'danger' : ''}" data-act="${it.key}">${it.label}</button>`).join('')}
        <button class="menu-item cancel" data-act="__cancel">取消</button>
      </div>`;
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('show'));
    const close = (v) => {
      mask.classList.remove('show');
      setTimeout(() => mask.remove(), 180);
      resolve(v);
    };
    mask.addEventListener('click', (e) => {
      if (e.target === mask) return close(null);
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      close(act === '__cancel' ? null : act);
    });
  });
}

// ---------------------------------------------------------------------------
// 外观页
// ---------------------------------------------------------------------------
function renderLook() {
  const m = cfg.motion;
  setSwitch($('#switchMotion'), !!m.enabled);
  bindSeg('#segEntrance', m.entrance, (v) => patchMotion({ entrance: v }));
  bindSeg('#segSwitch', m.switchStyle, (v) => patchMotion({ switchStyle: v }));
  bindSeg('#segSpeed', m.speed, (v) => patchMotion({ speed: v }));
  bindSeg('#segHold', cfg.splash.hold, (v) => {
    cfg.splash.hold = v;
    yunx.cfg.patch({ splash: { hold: v } });
    updateSplashText();
  });
  bindSeg('#segTheme', cfg.ui.theme, (v) => {
    cfg.ui.theme = v;
    applyTheme();
    yunx.cfg.patch({ ui: { theme: v } });
  });

  setSwitch($('#switchSplash'), !!cfg.splash.enabled);
  updateSplashText();

  const accents = [
    ['violet', '#8b7cff', '紫'],
    ['blue', '#4c9dff', '蓝'],
    ['mint', '#35d0a5', '青'],
    ['amber', '#ffb02e', '琥珀'],
  ];
  playDemo();
  $('#accentRow').innerHTML = accents.map(([k, c, n]) => `
    <button class="accent ${cfg.ui.accent === k ? 'on' : ''}" data-accent="${k}" title="${n}" style="color:${c}"></button>`).join('');
  $$('#accentRow .accent').forEach((b) => {
    b.addEventListener('click', () => {
      cfg.ui.accent = b.dataset.accent;
      applyTheme();
      yunx.cfg.patch({ ui: { accent: cfg.ui.accent } });
      renderLook();
    });
  });
}

function playDemo() {
  const box = $('#motionDemo');
  if (!box) return;
  box.style.setProperty('--spd', String(factor()));
  box.classList.remove('run');
  $$('.demo-tile', box).forEach((t, i) => t.style.setProperty('--i', i));
  void box.offsetWidth;
  if (cfg.motion.enabled) box.classList.add('run');
}

function patchMotion(partial) {
  Object.assign(cfg.motion, partial);
  yunx.cfg.patch({ motion: partial });
  renderLook();
  // 立刻演示一次，用户不用切页去猜效果
  const page = $('.page.active');
  if (cfg.motion.enabled && cfg.motion.switchStyle === 1 && partial.switchStyle !== undefined) replayRise(page);
}

function bindSeg(sel, value, onPick) {
  $$(sel + ' button').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.v) === Number(value) || b.dataset.v === String(value));
    b.onclick = () => onPick(isNaN(Number(b.dataset.v)) ? b.dataset.v : Number(b.dataset.v));
  });
}

function updateSplashText() {
  const s = cfg.splash;
  const thumb = $('#splashThumb');
  const name = $('#splashName');
  const meta = $('#splashMeta');
  if (s.path) {
    name.textContent = s.name || '自定义开屏';
    if (s.kind === 1) {
      meta.textContent = '视频 · 最长 15 秒 · 静音播放';
      thumb.innerHTML = '<span>视频</span>';
      yunx.splash.url().then((u) => {
        if (u) thumb.innerHTML = `<video src="${u}" muted></video>`;
      });
    } else {
      meta.textContent = `图片 · 停留 ${(HOLD_MS[s.hold] / 1000).toFixed(1).replace('.0', '')} 秒`;
      yunx.splash.url().then((u) => {
        thumb.innerHTML = u ? `<img src="${u}" alt="">` : '<span>内置</span>';
      });
    }
  } else {
    name.textContent = '内置开屏（图标 + 名字）';
    meta.textContent = '图片停留 1.8 秒 · 视频最长 15 秒';
    thumb.innerHTML = '<span>内置</span>';
  }
}

// ---------------------------------------------------------------------------
// 云析页 / 关于
// ---------------------------------------------------------------------------
function renderDownload() {
  if (!appInfo) return;
  const y = appInfo.yunx;
  $('#yunxMeta').textContent = `最新版 v${y.version} · Windows 10 / 11`;
  const btnSetup = $('#btnYunxSetup');
  btnSetup.onclick = () => open(y.setup);
  $$('[data-open]').forEach((b) => {
    b.onclick = () => open(b.dataset.open === 'setup' ? y.setup : y.portable);
  });
  $('#btnYunxReleases').onclick = () => open(y.releases);
  $('#btnYunxCopy').onclick = async () => {
    await navigator.clipboard.writeText(y.setup);
    toast('安装版链接已复制');
  };
  $$('[data-href]').forEach((b) => {
    b.onclick = () => open(b.dataset.href);
  });
  $('#btnUserData').onclick = () => yunx.openUserData();
}

function open(url) {
  yunx.openExternal(url);
}

function renderAbout() {
  if (!appInfo) return;
  $('#aboutVersion').textContent = `v${appInfo.version} · 功能对齐 Android v2.4.0 · Electron ${appInfo.electron}`;
}

// ---------------------------------------------------------------------------
// 页签
// ---------------------------------------------------------------------------
const TITLES = {
  guide: ['小抄', '攻略悬浮窗 · 图片来源 · 小抄外观'],
  crosshair: ['准星', '自由导入图片 · 自定义瞄准点与位置'],
  pan: ['网盘', '目录结构 1:1 复刻 · 跨目录多选 · 已下载自动跳过'],
  look: ['外观', '碎格 / 浮现 · 自定义开屏 · 主题'],
  download: ['云析 PC', '官方桌面端 · 解析下载 · 网盘'],
  about: ['关于', '来源 · 协议 · 移植对照'],
};

function switchTab(tab) {
  if (tab === currentTab) return;
  const m = cfg.motion;
  currentTab = tab;

  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const [t, s] = TITLES[tab];
  $('#pageTitle').textContent = t;
  $('#pageSub').textContent = s;

  const prev = $('.page.active');
  if (prev) clearRise(prev);
  $$('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === tab));
  const page = $(`.page[data-page="${tab}"]`);
  // 网盘页自己管滚动（三栏各自滚），整页滚会把队列推出屏幕
  $('.content').classList.toggle('no-scroll', tab === 'pan');
  $('.content').scrollTop = 0;
  if (tab === 'pan' && window.panPageShown) window.panPageShown();
  if (tab === 'download') renderOrbs();

  if (!m.enabled) return;
  if (m.switchStyle === 0) {
    playCurtain(SPEC.chunky, 560 / factor());
  } else {
    replayRise(page);
  }
}

// ---------------------------------------------------------------------------
// 悬浮球管理（v1.4.0）
// ---------------------------------------------------------------------------

const b64u = (str) => btoa(unescape(encodeURIComponent(str))).replace(/=+$/, '');

async function renderOrbs() {
  const box = $('#orbList');
  if (!box) return;
  const r = await yunx.orb.list().catch(() => null);
  if (!r || !r.ok) {
    box.innerHTML = '<div class="orb-empty">读取失败了，重启一下程序试试</div>';
    return;
  }

  const folderOf = (rel) => (r.folders || []).find((x) => x.rel === rel) || {};
  const coverOf = (rel) => {
    const f = folderOf(rel);
    return f.cover ? `guide://thumb/${b64u(f.cover)}` : '';
  };

  const addBtn = $('#btnOrbAdd');
  if (addBtn) {
    const full = r.orbs.length >= r.max;
    addBtn.disabled = full;
    addBtn.textContent = full ? `已满 ${r.max} 个` : '加一个';
    addBtn.title = full ? '每个球都是独立透明窗口，超过 3 个会掉帧' : '';
  }

  if (!r.orbs.length) {
    box.innerHTML = '<div class="orb-empty">还没有悬浮球。点右上角「加一个」，它会绑到一个分类上。</div>';
    return;
  }

  box.innerHTML = r.orbs
    .map((o) => {
      const cv = coverOf(o.rel);
      const opts = (r.folders || [])
        .map((f) => `<option value="${escapeHtml(f.rel)}"${f.rel === o.rel ? ' selected' : ''}>${escapeHtml(f.name)}</option>`)
        .join('');
      return `
        <div class="orb-item">
          <div class="orb-dot">${cv ? `<img src="${cv}" alt="">` : escapeHtml(String(o.label || '抄').slice(0, 1))}</div>
          <div class="orb-meta">
            <b>${escapeHtml(o.label || '未命名')}</b>
            <span>${o.rel ? escapeHtml(o.rel) : '小抄根目录'}${
              folderOf(o.rel).count ? ` · ${folderOf(o.rel).count} 张` : ''
            } · ${o.shown === false ? '已隐藏' : '显示中'}</span>
          </div>
          <div class="orb-ops">
            <select class="mini-select" data-bind="${escapeHtml(o.id)}">${opts}</select>
            <button class="mini-btn danger" data-del="${escapeHtml(o.id)}">删除</button>
          </div>
        </div>`;
    })
    .join('');

  box.querySelectorAll('[data-bind]').forEach((sel) => {
    sel.onchange = async () => {
      const res = await yunx.orb.bind(sel.dataset.bind, sel.value).catch(() => null);
      if (res && res.ok) {
        toast('换绑好了，球上的封面马上跟着变');
        renderOrbs();
      } else toast((res && res.error) || '换绑失败');
    };
  });

  box.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = async () => {
      await yunx.orb.remove(btn.dataset.del).catch(() => null);
      renderOrbs();
      toast('已删除这个球');
    };
  });
}

function bindOrbUI() {
  const add = $('#btnOrbAdd');
  if (!add) return;
  add.onclick = async () => {
    const r = await yunx.orb.add().catch(() => null);
    if (!r || !r.ok) {
      toast((r && r.error) || '加不了，先选一个攻略文件夹');
      return;
    }
    renderOrbs();
    toast('加好了，右键球可以随时换绑');
  };
  renderOrbs();
}

// ---------------------------------------------------------------------------
// 绑定
// ---------------------------------------------------------------------------
function bindEvents() {
  $$('.nav-item').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  $('#btnMin').onclick = () => yunx.win.min();
  $('#btnMax').onclick = () => yunx.win.max();
  $('#btnClose').onclick = () => yunx.win.close();
  $('#btnQuit').onclick = async () => {
    const ok = await confirmBox('退出云小抄？', '小抄和准星会一起关掉，下次启动再回来。', '退出');
    if (ok) yunx.win.quit();
  };

  $('.content').addEventListener('scroll', (e) => {
    $('#topbar').classList.toggle('scrolled', e.target.scrollTop > 4);
  });

  // 小抄
  $('#btnGuideToggle').onclick = async () => {
    const on = !runtimeSnap.guideVisible;
    const real = await yunx.guide.setVisible(on);
    runtimeSnap.guideVisible = !!real;
    renderRuntime(runtimeSnap);
  };
  $('#btnGuidePick').onclick = async () => {
    const r = await yunx.guide.pickRoot();
    if (r && r.ok) {
      cfg.guide.root = r.root;
      toast('攻略文件夹已更新');
      renderAll();
    }
  };
  $('#btnGuideOpen').onclick = async () => {
    const r = await yunx.guide.openFolder();
    if (r === 'not set') toast('先选一个文件夹');
  };
  $('#switchGuideLock').onclick = async () => {
    const v = !cfg.guide.locked;
    cfg.guide.locked = v;
    setSwitch($('#switchGuideLock'), v);
    await yunx.guide.setLocked(v);
    toast(v ? '已锁定：鼠标会直接穿过小抄' : '已解锁：可以点小抄了');
  };
  // v1.2.0：游戏模式。开了之后主进程每 800ms 把它顶回最上层
  $('#switchGuideTop').onclick = async () => {
    const v = !cfg.guide.forceTop;
    cfg.guide.forceTop = v;
    setSwitch($('#switchGuideTop'), v);
    await yunx.guide.setForceTop(v);
    toast(v ? '游戏模式已开：小抄会一直浮在游戏上面' : '游戏模式已关：窗口按普通顺序排列');
    renderGuideDiag();
    refreshDisplayMode();
  };

  // 窗口自检：把「能不能点」直接写在界面上，省得用户猜
  async function renderGuideDiag() {
    const el = $('#guideDiag');
    if (!el) return;
    let d = null;
    try {
      d = await yunx.guide.diag();
    } catch {
      return;
    }
    if (!d || !d.open) {
      el.textContent = '当前状态：小抄没有打开（按 Alt+Q 呼出）';
      el.style.color = '';
      return;
    }
    if (d.focusable === false) {
      el.textContent = '⚠ 窗口处于「不可点击」状态。按 Alt+Shift+R 或右键托盘 → 重置悬浮窗';
      el.style.color = '#ff7a7a';
      return;
    }
    if (d.locked) {
      el.textContent = '当前状态：锁定穿透中 —— 鼠标会直接穿过去，窗口里的按钮点不到。按 Alt+Q 收起再呼出即可解锁';
      el.style.color = '#ffb454';
      return;
    }
    if (d.ball) {
      el.textContent = '当前状态：已收成小球，点一下小球展开';
      el.style.color = '';
      return;
    }
    el.textContent = '当前状态：可正常点击' + (d.alwaysOnTop ? ' · 已置顶' : ' · 未置顶');
    el.style.color = '';
  }
  window.__renderGuideDiag = renderGuideDiag;
  renderGuideDiag();
  setInterval(renderGuideDiag, 2500);

  // 显示模式：独占全屏是「叠加层点不了」的系统级原因，和窗口参数无关，必须单独说清楚
  async function refreshDisplayMode() {
    const dot = $('#dmDot');
    const txt = $('#dmText');
    const hint = $('#dmHint');
    if (!dot || !txt) return;
    txt.textContent = '正在检测显示模式…';
    dot.className = 'dm-dot';
    hint.style.display = 'none';
    let r = null;
    try {
      r = await yunx.guide.displayMode();
    } catch {
      txt.textContent = '检测失败';
      return;
    }
    if (!r || !r.ok) {
      txt.textContent = (r && r.label) || '检测失败';
      return;
    }
    dot.className = 'dm-dot ' + (r.exclusive ? 'bad' : r.full ? 'warn' : 'ok');
    txt.textContent = r.label;
    if (r.full) {
      hint.textContent = r.hint;
      hint.style.display = 'block';
    }
  }
  $('#btnDmCheck').onclick = refreshDisplayMode;
  refreshDisplayMode();
  let alphaTimer = 0;
  $('#alphaRange').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('#alphaVal').textContent = v + '%';
    paintRange(e.target);
    // 拖动时最多每 120ms 写一次盘，松手立刻补一次
    clearTimeout(alphaTimer);
    alphaTimer = setTimeout(() => yunx.guide.setAlpha(v / 100), 120);
  });
  $('#alphaRange').addEventListener('change', (e) => {
    clearTimeout(alphaTimer);
    yunx.guide.setAlpha(Number(e.target.value) / 100);
  });
  $('#widthRange').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('#widthVal').textContent = v + ' px';
    paintRange(e.target);
  });
  $('#widthRange').addEventListener('change', (e) => {
    yunx.guide.setWidth(Number(e.target.value));
  });

  // ---------------- 网盘一键下载 ----------------
  let dlSnap = null;
  let panStat = { quark: false, uc: false, baseDir: '' };
  let panTab = 'quark';
  let panStack = [{ fid: '0', name: '我的网盘' }];

  const openModal = (id) => $('#' + id).classList.add('show');
  const closeModal = (id) => $('#' + id).classList.remove('show');

  async function refreshPanMeta() {
    try {
      panStat = await yunx.pan.status();
    } catch {
      return;
    }
    const dir = panStat.baseDir || '—';
    $('#dlDest').textContent = dir;
    $('#shareDest').textContent = dir;
  }

  function renderDl(s) {
    if (!s) return;
    dlSnap = s;
    const busy = s.status === 'listing' || s.status === 'downloading';
    $('#dlProgress').hidden = !busy;
    $('#dlDone').hidden = s.status !== 'done';
    $('#dlError').hidden = s.status !== 'error';

    if (busy) {
      const settled = s.done + s.failed + s.skipped;
      const pct = s.total ? Math.round((settled / s.total) * 100) : 0;
      const bar = $('#dlBar');
      bar.classList.toggle('indeterminate', s.status === 'listing');
      bar.style.width = s.status === 'listing' ? '100%' : pct + '%';
      $('#dlCount').textContent = s.total
        ? `${settled} / ${s.total}${s.skipped ? `（跳过 ${s.skipped}）` : ''}`
        : '读取目录…';
      $('#dlPct').textContent = s.status === 'listing' ? '' : pct + '%';
      $('#dlCurrent').textContent = s.current || s.message || '';
    }
    if (s.status === 'done') {
      $('#dlDoneTitle').textContent = s.message || '下载完成';
      $('#dlDonePath').textContent = s.dest || '';
      $('#dlDonePath').title = s.dest || '';
    }
    if (s.status === 'error') {
      $('#dlError').textContent = s.message || '下载失败';
    }
  }

  $('#btnDlOpenBase').onclick = () => yunx.dl.openBase();
  $('#btnDlOpen').onclick = () => {
    if (dlSnap && dlSnap.dest) yunx.dl.openDest(dlSnap.dest);
    else yunx.dl.openBase();
  };
  $('#btnDlUse').onclick = async () => {
    if (!dlSnap || !dlSnap.dest) return;
    const r = await yunx.dl.useAsRoot(dlSnap.dest);
    if (r && r.ok) {
      toast('已设为本地小抄，按 Alt+Q 就能看');
      renderAll();
    } else {
      toast((r && r.error) || '设置失败');
    }
  };
  $('#btnDlCancel').onclick = () => yunx.dl.cancel();

  // 分享链接
  $('#btnDlShare').onclick = async () => {
    await refreshPanMeta();
    $('#shareHint').textContent = '';
    openModal('shareModal');
    setTimeout(() => $('#shareText').focus(), 60);
  };
  $('#btnSharePick').onclick = async () => {
    const r = await yunx.dl.pickBase();
    if (r && r.ok) {
      panStat.baseDir = r.dir;
      $('#shareDest').textContent = r.dir;
      $('#dlDest').textContent = r.dir;
    }
  };
  // 分享链接：整份直接下，不弹选择框（v1.2.6，对应「不用一个一个选」）
  $('#btnShareAll').onclick = async () => {
    const text = $('#shareText').value.trim();
    if (!text) {
      $('#shareHint').textContent = '先粘贴链接或分享文案';
      return;
    }
    const parsed = await yunx.pan.parse(text);
    if (!parsed || !parsed.ok) {
      $('#shareHint').textContent = (parsed && parsed.error) || '链接不对';
      return;
    }
    const btn = $('#btnShareAll');
    btn.disabled = true;
    btn.textContent = '正在开始…';
    $('#shareHint').textContent = '正在读取分享目录并排队，可以先去开游戏';
    let r = null;
    try {
      r = await yunx.dl.startShare({
        link: text,
        pwd: $('#sharePwd').value.trim(),
        baseDir: panStat.baseDir || '',
      });
    } finally {
      btn.disabled = false;
      btn.textContent = '全部下载';
    }
    if (r && r.ok) {
      closeModal('shareModal');
      $('#shareHint').textContent = '';
      toast('整份开始下载');
    } else {
      $('#shareHint').textContent = (r && r.error) || '没有开始下载';
    }
  };

  // 分享链接：先读文件树，再让用户勾选（v1.2.5 选择性下载）
  $('#btnShareGo').onclick = async () => {
    const text = $('#shareText').value.trim();
    if (!text) {
      $('#shareHint').textContent = '先粘贴链接或分享文案';
      return;
    }
    const parsed = await yunx.pan.parse(text);
    if (!parsed || !parsed.ok) {
      $('#shareHint').textContent = (parsed && parsed.error) || '链接不对';
      return;
    }
    const go = $('#btnShareGo');
    go.disabled = true;
    go.textContent = '正在读取…';
    $('#shareHint').textContent = '正在读分享目录，分类多的话要等十几秒';
    let r = null;
    try {
      r = await yunx.dl.previewShare({ link: text, pwd: $('#sharePwd').value.trim() });
    } finally {
      go.disabled = false;
      go.textContent = '读取文件列表';
    }
    if (!r || !r.ok) {
      $('#shareHint').textContent = (r && r.error) || '读取失败';
      return;
    }
    $('#shareHint').textContent = '';
    closeModal('shareModal');
    openPicker(r);
  };

  // ------------------------------------------------------------------
  // 选择性下载：文件树 + 勾选
  // ------------------------------------------------------------------
  const IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif|jfif)$/i;
  let pick = null;

  function fmtSize(n) {
    if (!n) return '0 B';
    const unit = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < unit.length - 1) {
      v /= 1024;
      i++;
    }
    return (i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + unit[i];
  }

  function eachFile(nodes, fn) {
    for (const n of nodes) {
      if (n.dir) eachFile(n.children || [], fn);
      else fn(n);
    }
  }

  function setAll(node, v) {
    node.checked = v;
    if (node.dir) for (const c of node.children || []) setAll(c, v);
  }

  /** 预算每个目录的体量与文件数，避免渲染时对同一棵子树反复递归 */
  function indexTree(nodes) {
    let count = 0;
    let bytes = 0;
    for (const n of nodes) {
      if (n.dir) {
        const sub = indexTree(n.children || []);
        n._count = sub.count;
        n._bytes = sub.bytes;
        count += sub.count;
        bytes += sub.bytes;
      } else {
        n._count = 1;
        n._bytes = n.size || 0;
        count += 1;
        bytes += n.size || 0;
      }
    }
    return { count, bytes };
  }

  /**
   * 勾选状态回写：自底向上一次遍历，顺带算出选中数量和字节数。
   * 旧写法每个目录都把自己的子树重数一遍，两千个文件就是两百万次循环，
   * 点一下勾选框要卡半秒 —— 这也是「用起来不流畅」的一部分。
   */
  function syncUI(nodes) {
    let all = 0;
    let on = 0;
    let bytes = 0;
    for (const n of nodes) {
      if (n.dir) {
        const sub = syncUI(n.children || []);
        if (n._box) {
          n._box.checked = sub.all > 0 && sub.on === sub.all;
          n._box.indeterminate = sub.on > 0 && sub.on < sub.all;
        }
        all += sub.all;
        on += sub.on;
        bytes += sub.bytes;
      } else {
        if (n._box) n._box.checked = !!n.checked;
        all += 1;
        if (n.checked) {
          on += 1;
          bytes += n.size || 0;
        }
      }
    }
    return { all, on, bytes };
  }

  /** 刷统计；顺带把 DOM 勾选态对齐（所以调用它就不必再单独调 syncUI） */
  function refreshPickStat() {
    if (!pick) return;
    const s = syncUI(pick.tree);
    $('#pickStat').textContent = `已选 ${s.on} 个 · ${fmtSize(s.bytes)}`;
    const go = $('#pickGo');
    go.disabled = s.on === 0;
    go.textContent = s.on ? `下载选中的 ${s.on} 个` : '下载选中的 0 个';
  }

  function renderTree(nodes, host, depth) {
    for (const n of nodes) {
      const row = document.createElement('div');
      row.className = 'pt-row';
      row.style.paddingLeft = 6 + depth * 16 + 'px';

      const arrow = document.createElement('button');
      arrow.className = 'pt-arrow' + (n.dir ? '' : ' leaf');
      arrow.textContent = '▸';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'pt-check';
      box.checked = !!n.checked;

      const name = document.createElement('span');
      name.className = 'pt-name' + (n.dir ? ' dir' : '');
      name.textContent = n.name;
      name.title = n.path;

      const size = document.createElement('span');
      size.className = 'pt-size';
      if (n.dir) {
        size.textContent = n._count ? `${n._count} 项 · ${fmtSize(n._bytes)}` : '空目录';
      } else {
        size.textContent = fmtSize(n.size);
      }

      row.append(arrow, box, name, size);
      n._box = box;

      if (n.dir) {
        // v1.2.6：目录行直接给「下这个」。群里反馈最多的就是「不想一个一个勾」，
        // 看到哪个分类就直接下，不用展开也不用勾。
        const quick = document.createElement('button');
        quick.className = 'pt-quick';
        quick.textContent = '下这个';
        quick.title = `只下这个目录里的 ${n._count || 0} 个文件，立即开始`;
        quick.onclick = (e) => {
          e.stopPropagation();
          eachFile(pick.tree, (f) => {
            f.checked = false;
          });
          setAll(n, true);
          refreshPickStat();
          $('#pickGo').click();
        };
        row.append(quick);

        const kids = document.createElement('div');
        kids.className = 'pt-children';
        kids.hidden = true;
        host.appendChild(row);
        host.appendChild(kids);
        const toggle = () => {
          const opening = kids.hidden;
          if (opening && !kids.childElementCount) renderTree(n.children || [], kids, depth + 1);
          kids.hidden = !opening;
          arrow.classList.toggle('open', opening);
        };
        arrow.onclick = toggle;
        name.onclick = toggle;
      } else {
        host.appendChild(row);
      }

      box.onchange = () => {
        setAll(n, box.checked);
        refreshPickStat();
      };
    }
  }

  function openPicker(r) {
    pick = { sessionId: r.sessionId, title: r.title || '分享小抄', tree: r.tree || [], dest: panStat.baseDir || '' };
    eachFile(pick.tree, (f) => {
      f.checked = true;
    });
    const total = indexTree(pick.tree);
    $('#pickTitle').textContent = pick.title;
    $('#pickSub').textContent = total.count ? `${total.count} 个文件 · ${fmtSize(total.bytes)}` : '这个分享里没有文件';
    $('#pickDest').textContent = pick.dest || '未设置';
    $('#pickExpand').textContent = '展开全部';
    const tree = $('#pickTree');
    tree.innerHTML = '';
    if (!pick.tree.length) {
      tree.innerHTML = '<div class="picker-empty">这个分享是空的</div>';
    } else {
      // v1.2.6：不再自动展开所有分类。分类多的时候一次铺上千行 DOM 会明显顿，
      // 现在每行右边写着「几项 · 多大」，不展开也知道里面有没有东西。
      renderTree(pick.tree, tree, 0);
    }
    refreshPickStat();
    $('#pickModal').classList.add('show');
  }

  let expandAllOn = false;
  $('#pickExpand').onclick = () => {
    expandAllOn = !expandAllOn;
    $('#pickExpand').textContent = expandAllOn ? '收起全部' : '展开全部';
    if (!expandAllOn) {
      $$('#pickTree .pt-arrow.open').forEach((a) => a.click());
      return;
    }
    // 一次只展开一个目录，展开一个就让出事件循环：几百个分类也不会卡死
    let n = 0;
    const step = () => {
      const next = $$('#pickTree .pt-arrow:not(.leaf):not(.open)')[0];
      if (!next) return;
      if (++n > 400) {
        toast('展开得够多了，剩下的按需点开更快');
        return;
      }
      next.click();
      setTimeout(step, 0);
    };
    step();
  };

  $('#pickAll').onclick = () => {
    eachFile(pick.tree, (f) => {
      f.checked = true;
    });
    refreshPickStat();
  };
  $('#pickNone').onclick = () => {
    eachFile(pick.tree, (f) => {
      f.checked = false;
    });
    refreshPickStat();
  };
  $('#pickImages').onclick = () => {
    eachFile(pick.tree, (f) => {
      f.checked = IMG_RE.test(f.name);
    });
    refreshPickStat();
  };
  $('#pickDir').onclick = async () => {
    const r = await yunx.dl.pickBase();
    if (r && r.ok) {
      pick.dest = r.dir;
      panStat.baseDir = r.dir;
      $('#pickDest').textContent = r.dir;
      $('#shareDest').textContent = r.dir;
      $('#dlDest').textContent = r.dir;
    }
  };
  $('#pickGo').onclick = async () => {
    const picks = [];
    eachFile(pick.tree, (f) => {
      if (f.checked) picks.push(f.fid);
    });
    if (!picks.length) return;
    const go = $('#pickGo');
    go.disabled = true;
    const r = await yunx.dl.startPicked({ sessionId: pick.sessionId, picks, baseDir: pick.dest });
    go.disabled = false;
    if (r && r.ok) {
      $('#pickModal').classList.remove('show');
      toast('开始下载，可以先去开游戏');
    } else {
      toast((r && r.error) || '没有开始下载');
    }
  };

  // 我的网盘
  async function renderPanModal() {
    await refreshPanMeta();
    $$('#panTabs button').forEach((b) => b.classList.toggle('on', b.dataset.pan === panTab));
    const logged = !!panStat[panTab];
    $('#panLoginBox').hidden = logged;
    $('#panBrowseBox').hidden = !logged;
    $('#btnCloudGo').disabled = !logged;
    $('#panHint').textContent = '';
    if (logged) await loadPanDir(panStack[panStack.length - 1].fid);
  }

  async function loadPanDir(fid) {
    $('#panList').innerHTML = '<div class="pan-loading">读取中…</div>';
    const r = await yunx.pan.browse(panTab, fid);
    if (!r || !r.ok) {
      $('#panList').innerHTML = '';
      $('#btnCloudGo').disabled = true;
      $('#panHint').textContent = (r && r.error) || '读取目录失败';
      return;
    }
    $('#btnCloudGo').disabled = false;
    $('#panImages').textContent = r.images;
    renderPanCrumbs();
    // 一眼能看出哪个是放小抄的：名字里带「小抄 / 攻略」的排到最前
    const hot = (n) => (/小抄|攻略|guide/i.test(n) ? 1 : 0);
    const folders = r.folders.slice().sort((a, b) => hot(b.name) - hot(a.name));
    const rows = folders.map(
      (f) =>
        `<button class="pan-row${hot(f.name) ? ' hot' : ''}" data-fid="${escapeHtml(f.fid)}" data-name="${escapeHtml(f.name)}">` +
        `<svg><use href="#i-folder"/></svg><span>${escapeHtml(f.name)}</span><i>›</i></button>`
    );
    $('#panList').innerHTML =
      rows.join('') || '<div class="pan-empty">这里没有子文件夹，整目录的图片会直接下</div>';
    updateCloudGoLabel();
    $$('#panList .pan-row').forEach((btn) => {
      btn.onclick = () => {
        panStack.push({ fid: btn.dataset.fid, name: btn.dataset.name });
        loadPanDir(btn.dataset.fid);
      };
    });
  }

  function updateCloudGoLabel() {
    $('#btnCloudGo').textContent = panStack.length === 1 ? '下载整个网盘' : '下载这个目录';
  }

  function renderPanCrumbs() {
    $('#panCrumbs').innerHTML = panStack
      .map((c, i) => `<button data-i="${i}">${escapeHtml(c.name)}</button>`)
      .join('<i>/</i>');
    $$('#panCrumbs button').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.i);
        panStack = panStack.slice(0, i + 1);
        loadPanDir(panStack[i].fid);
      };
    });
  }

  $('#btnDlCloud').onclick = () => {
    panStack = [{ fid: '0', name: '我的网盘' }];
    openModal('cloudModal');
    renderPanModal();
  };
  $$('#panTabs button').forEach((b) => {
    b.onclick = () => {
      panTab = b.dataset.pan;
      panStack = [{ fid: '0', name: '我的网盘' }];
      renderPanModal();
    };
  });
  $('#btnPanLogin').onclick = async () => {
    await yunx.pan.login(panTab);
    $('#panHint').textContent = '登录窗口已打开，扫码成功后会自动回来…';
  };
  // 粘贴 Cookie：登录页打不开 / 一直白屏时的兜底
  $('#btnPanPaste').onclick = async () => {
    const label = panTab === 'uc' ? 'UC' : '夸克';
    const cookie = await askCookie(
      `粘贴${label}网盘 Cookie`,
      `在浏览器里登录${label}网盘，按 F12 → Application（应用）→ Cookies → 选 ${
        panTab === 'uc' ? 'drive.uc.cn' : 'pan.quark.cn'
      }，把 __pus 和 __puus 所在的那一整段复制过来。换行、多余的 "Cookie:" 前缀都不影响，粘贴后会自动整理。`
    );
    if (!cookie) return;
    $('#panHint').textContent = '正在验证 Cookie…';
    const r = await yunx.pan.saveCookie(panTab, cookie);
    if (r && r.ok) {
      toast('登录成功');
      await renderPanModal();
    } else {
      $('#panHint').textContent = (r && r.error) || '验证失败';
    }
  };
  $('#btnCloudGo').onclick = async () => {
    const cur = panStack[panStack.length - 1];
    if (panStack.length === 1) {
      const ok = await confirmBox(
        '整个网盘都下？',
        '会把根目录下所有图片连同子文件夹一起下载。如果网盘里还有别的东西，建议先进到放小抄的文件夹再下。',
        '还是下'
      );
      if (!ok) return;
    }
    closeModal('cloudModal');
    const r = await yunx.dl.startCloud({ platform: panTab, fid: cur.fid, title: cur.name });
    if (r && !r.ok) toast(r.error || '没有开始下载');
    else toast('开始下载，可以先去开游戏');
  };

  $$('.modal-mask').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m) m.classList.remove('show');
    });
  });
  $$('[data-close]').forEach((b) => {
    b.onclick = () => closeModal(b.dataset.close);
  });

  yunx.dl.onState((s) => renderDl(s));
  yunx.pan.onChanged(async () => {
    await refreshPanMeta();
    if ($('#cloudModal').classList.contains('show')) renderPanModal();
  });
  refreshPanMeta();
  yunx.dl.state().then((s) => s && renderDl(s));

  // 准星
  $('#btnCrossToggle').onclick = async () => {
    const on = !runtimeSnap.crosshairVisible;
    const real = await yunx.crosshair.setVisible(on);
    runtimeSnap.crosshairVisible = !!real;
    renderRuntime(runtimeSnap);
  };
  $('#btnPickImage').onclick = async () => {
    const r = await yunx.crosshair.pickImage();
    if (r && r.ok) {
      toast('图片已导入');
      renderCrosshair();
    } else if (r && r.error) {
      toast(r.error);
    }
  };
  $('#btnClearImage').onclick = async () => {
    await yunx.crosshair.clearImage();
    renderCrosshair();
  };
  $('#previewWrap').addEventListener('click', async (e) => {
    const img = $('#previewImg');
    if (!img.src) return;
    const r = img.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    const ax = (e.clientX - r.left) / r.width;
    const ay = (e.clientY - r.top) / r.height;
    positionAnchor(ax, ay);
    await yunx.crosshair.update({ ax, ay });
  });
  $('#crossWidth').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('#crossWidthVal').textContent = v + ' px';
    paintRange(e.target);
    draggingSlider = true;
    clearTimeout(window.__cwT);
    window.__cwT = setTimeout(async () => {
      await yunx.crosshair.update({ width: v });
      draggingSlider = false;
    }, 90);
  });
  $('#crossAlpha').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('#crossAlphaVal').textContent = v + '%';
    paintRange(e.target);
    draggingSlider = true;
    clearTimeout(window.__caT);
    window.__caT = setTimeout(async () => {
      await yunx.crosshair.update({ alpha: v / 100 });
      draggingSlider = false;
    }, 90);
  });
  $('#switchLines').onclick = async () => {
    const v = $('#switchLines').getAttribute('aria-checked') !== 'true';
    setSwitch($('#switchLines'), v);
    await yunx.crosshair.update({ lines: v });
  };
  $('#btnAdjust').onclick = async () => {
    const v = !cfg.crosshair.adjust;
    cfg.crosshair.adjust = v;
    await yunx.crosshair.setAdjust(v);
    $('#btnAdjust').classList.toggle('primary', v);
    toast(v ? '拖动准星放到位置，放好后点「调整位置」收工' : '已锁定位置，恢复穿透');
  };
  $('#btnCenter').onclick = async () => {
    await yunx.crosshair.center();
    toast('已对准屏幕中心');
  };

  // 外观
  $('#switchMotion').onclick = () => {
    const v = !cfg.motion.enabled;
    cfg.motion.enabled = v;
    setSwitch($('#switchMotion'), v);
    yunx.cfg.patch({ motion: { enabled: v } });
    toast(v ? '动画已开' : '动画已关');
  };
  $('#btnReplay').onclick = () => {
    if (!cfg.motion.enabled) {
      toast('动画现在是关的');
      return;
    }
    const page = $('.page.active');
    playDemo();
    if (cfg.motion.entrance === 0) {
      const ms = 900 / factor();
      zoomStage(ms * 0.66);
      playCurtain(SPEC.fine, ms);
    } else {
      replayRise(page);
    }
  };
  $('#switchSplash').onclick = () => {
    const v = !cfg.splash.enabled;
    cfg.splash.enabled = v;
    setSwitch($('#switchSplash'), v);
    yunx.cfg.patch({ splash: { enabled: v } });
  };
  $('#btnSplashImage').onclick = async () => {
    const r = await yunx.splash.pick(0);
    if (r && r.ok) {
      cfg.splash = { ...cfg.splash, kind: 0, path: r.path, name: r.name };
      updateSplashText();
      toast('开屏图片已换');
      playSplash();
    } else if (r && r.error) toast(r.error);
  };
  $('#btnSplashVideo').onclick = async () => {
    const r = await yunx.splash.pick(1);
    if (r && r.ok) {
      cfg.splash = { ...cfg.splash, kind: 1, path: r.path, name: r.name };
      updateSplashText();
      toast('开屏视频已换，最长播 15 秒');
      playSplash();
    } else if (r && r.error) toast(r.error);
  };
  $('#btnSplashClear').onclick = async () => {
    await yunx.splash.clear();
    cfg.splash = { ...cfg.splash, kind: 0, path: '', name: '' };
    updateSplashText();
    toast('已换回内置开屏');
  };

  // 预览图尺寸变化时重新贴锚点
  $('#previewImg').addEventListener('load', () => {
    const a = profileCache.find((p) => p.id === (cfg.crosshair.activeId || (profileCache[0] || {}).id)) || profileCache[0];
    if (a) positionAnchor(a.ax, a.ay);
  });
  window.addEventListener('resize', () => {
    const a = profileCache.find((p) => p.id === cfg.crosshair.activeId) || profileCache[0];
    if (a) positionAnchor(a.ax, a.ay);
  });
}

// 主进程每次开关都会广播运行态，这里缓存一份给按钮做取反
let runtimeSnap = { guideVisible: false, crosshairVisible: false, crosshairAdjust: false };

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
(async function boot() {
  appInfo = await yunx.info();
  cfg = await yunx.cfg.get();
  applyTheme();
  resizeCurtain();
  bindEvents();
  renderAll();
  bindOrbUI();
  if (window.initPanPage) await window.initPanPage();

  yunx.onState(({ cfg: next, runtime }) => {
    const prevMotion = cfg ? JSON.stringify(cfg.motion) : '';
    const prevRoot = cfg ? cfg.guide.root : '';
    cfg = next;
    runtimeSnap = runtime || runtimeSnap;
    applyTheme();
    renderRuntime(runtimeSnap);
    // 下载完成点「设为本地小抄」时根目录是从主进程改的，这里要跟着刷新
    if (next.guide.root !== prevRoot) renderGuide();
    if (crossSig(next.crosshair) !== lastCrossSig) renderCrosshair();
    if (JSON.stringify(next.motion) !== prevMotion) renderLook();
    if (!draggingSlider) {
      // 别在用户拖滑杆时把值拽回去
      if (document.activeElement !== $('#alphaRange')) {
        $('#alphaRange').value = Math.round(next.guide.alpha * 100);
        $('#alphaVal').textContent = Math.round(next.guide.alpha * 100) + '%';
        paintRange($('#alphaRange'));
      }
      if (document.activeElement !== $('#widthRange')) {
        $('#widthRange').value = next.guide.w || 400;
        $('#widthVal').textContent = (next.guide.w || 400) + ' px';
        paintRange($('#widthRange'));
      }
    }
  });

  setTimeout(async () => {
    const r = await yunx.hotkey.results().catch(() => null);
    if (r) {
      const bad = Object.entries(r).filter(([, v]) => v === 'failed').map(([k]) => k);
      if (bad.length) toast('有快捷键被占用，去「小抄」页换一个', 3200);
    }
  }, 1600);

  await playSplash();
  playEntrance();
})();
