/*
 * 云小抄 PC（YunX Guide Overlay · Desktop）
 * 基于 云析 YunX（https://github.com/CYQawa/YunX）与 云小抄（Android）二次开发。
 * Copyright (C) 2026 CYQawa（原项目作者）
 *
 * 本文件是 AGPL-3.0 衍生作品，完整协议见项目根目录 LICENSE。
 *
 * 主进程负责四件事：
 *   1. 三个窗口（主界面 / 小抄悬浮窗 / 准星层）的创建、定位与生命周期；
 *   2. 两条自定义协议（guide:// 读攻略图，media:// 读用户导入的图与视频）；
 *   3. 全局快捷键、托盘、单实例；
 *   4. 把配置与运行状态同步给所有窗口。
 *
 * 桌面版没有 Android 那套 Service / WindowManager：悬浮层的「常驻」靠的是
 * 无边框透明置顶窗口 + skipTaskbar，进程跟着主程序一起活。
 */

'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, shell, screen, globalShortcut,
  protocol, net, nativeImage, Tray, Menu, session,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

const { Store } = require('./store');
const { log, safeHandle } = require('./log');
const guideLib = require('./guide');
const pan = require('./pan');
const { Downloader } = require('./downloader');
const { OrbManager, MAX_ORBS } = require('./orbs');
const { JsonIndex } = require('./sync/index');
const { DownloadQueue } = require('./sync/queue');

const APP_NAME = '云小抄 PC';
const IS_WIN = process.platform === 'win32';

// 云析 PC 端（官方桌面版）。解析 / 网盘 / 下载都在那边，本移植版只做小抄与准星。
const YUNX = {
  repo: 'https://github.com/tidain/YunX-Desktop',
  releases: 'https://github.com/tidain/YunX-Desktop/releases/latest',
  version: '1.3.4',
  setup: 'https://github.com/tidain/YunX-Desktop/releases/download/v1.3.4/YunX-Desktop-setup-1.3.4.exe',
  portable: 'https://github.com/tidain/YunX-Desktop/releases/download/v1.3.4/YunX-Desktop-v1.3.4-win64-portable.zip',
};

let store = null;
let mainWindow = null;
let guideWindow = null;
let crosshairWindow = null;
let loginWindow = null;
let tray = null;
let quitting = false;
let trayHinted = false;
let downloader = null;
let panIndex = null;
let panQueue = null;
/** 选择性下载：解析过的分享会话（id → {session,title,files,at}），30 分钟过期 */
const shareSessions = new Map();

/** 允许被 media:// 读取的文件。只登记用户明确选过的，不让页面读任意路径 */
const allowedMedia = new Set();
const crosshairSizeCache = new Map();

// ---------------------------------------------------------------------------
// 单实例
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
}

app.setAppUserModelId('com.yunx.guide.pc');

// ---------------------------------------------------------------------------
// 全局异常兜底（v1.4.0）
//
// 这一段的唯一目标：**任何单点异常都不许让整个程序消失**，且必须留下证据。
// 打包后没有控制台，用户只会说「没了」，所以日志是唯一的破案线索。
// ---------------------------------------------------------------------------
let crashCount = 0;
let degraded = false;

process.on('uncaughtException', (err) => {
  degraded = true;
  crashCount++;
  log.error('crash', 'uncaughtException:', err);
  try {
    log.flushSync();
  } catch {
    /* 兜底路径里绝不允许二次抛 */
  }
  // 头 3 次只记录不退出：绝大多数是某个 IPC / 定时器里的单点错误，
  // 为它杀掉进程会把用户正在看的攻略一起弄没，体验更差。
  // 连续 3 次以上说明内部状态已经坏了，重启比硬撑安全。
  if (crashCount > 3) {
    try {
      dialog.showErrorBox('云小抄遇到反复错误', '详细日志已保存，程序将重启一次。\n可在「设置 → 关于」里导出诊断信息。');
    } catch {
      /* 无 GUI 环境忽略 */
    }
    app.relaunch();
    app.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  degraded = true;
  // Node 15+ 默认把未处理的 rejection 升级成 uncaughtException 直接退出，
  // 这里显式接住：异步链路（队列回调、定时器、协议 handler）出错只记账，不致命。
  log.error('crash', 'unhandledRejection:', reason);
});

app.on('render-process-gone', (_e, contents, details) => {
  log.error('crash', 'render-process-gone', details && details.reason, details && details.exitCode, contents && contents.getURL());
  // 主界面渲染进程崩了要能自愈，否则用户只剩一个托盘图标，以为程序没开
  if (mainWindow && !mainWindow.isDestroyed() && contents === mainWindow.webContents) {
    setTimeout(() => {
      try {
        mainWindow.reload();
      } catch (e) {
        log.error('crash', '重建主界面失败', e);
      }
    }, 800);
  }
});

app.on('child-process-gone', (_e, details) => {
  log.error('crash', 'child-process-gone', details && details.type, details && details.reason);
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'guide',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
  {
    scheme: 'media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
]);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
/**
 * 所有 IPC 注册统一走这里而不是 ipcMain.handle：
 * 异常在边界处就被转成 { ok:false, error }，不会变成渲染层的 rejected promise，
 * 也就不会演化成一条没人接的 unhandledRejection。
 */
const handle = (channel, fn) => safeHandle(ipcMain, channel, fn);

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

function preloadPath() {
  return path.join(__dirname, '..', 'preload', 'preload.js');
}

function pagePath(name) {
  return path.join(__dirname, '..', 'renderer', name);
}

function userFile(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

/** 广播配置与运行态。所有窗口都收，谁需要谁自己判断 */
function broadcast() {
  if (!store) return;
  const payload = {
    cfg: store.get(),
    ui: { v: ui.v, m: ui.m, b: ui.b, s: ui.s },
    runtime: {
      guideVisible: !!(guideWindow && guideWindow.isVisible()),
      crosshairVisible: !!(crosshairWindow && crosshairWindow.isVisible()),
      guideLocked: store.get().guide.locked,
      crosshairLocked: store.get().crosshair.locked,
      crosshairAdjust: store.get().crosshair.adjust,
      hotkeys: lastHotkeyResult,
    },
  };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('state:changed', payload);
  }
}

function sendTo(win, channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function clampToDisplay(bounds) {
  const disp = screen.getDisplayMatching({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
  }) || screen.getPrimaryDisplay();
  const wa = disp.workArea;
  const w = Math.min(bounds.width, wa.width);
  const h = Math.min(bounds.height, wa.height);
  let x = bounds.x;
  let y = bounds.y;
  if (x + w > wa.x + wa.width) x = wa.x + wa.width - w;
  if (y + h > wa.y + wa.height) y = wa.y + wa.height - h;
  if (x < wa.x) x = wa.x;
  if (y < wa.y) y = wa.y;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
function saveMainBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) {
    store.patch({ window: { maximized: true } });
    return;
  }
  const b = mainWindow.getBounds();
  store.patch({ window: { x: b.x, y: b.y, w: b.width, h: b.height, maximized: false } });
}

let mainBoundsTimer = null;
function saveMainBoundsDebounced() {
  clearTimeout(mainBoundsTimer);
  mainBoundsTimer = setTimeout(saveMainBounds, 400);
}

// ---------------------------------------------------------------------------
// 主窗口
// ---------------------------------------------------------------------------
function createMainWindow() {
  const cfg = store.get();
  const w = Math.max(cfg.window.w || 1180, 960);
  const h = Math.max(cfg.window.h || 800, 660);
  const bounds = cfg.window.x == null
    ? { width: w, height: h }
    : clampToDisplay({ x: cfg.window.x, y: cfg.window.y, width: w, height: h });

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 660,
    show: false,
    frame: false,
    backgroundColor: '#0d0e13',
    title: APP_NAME,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.loadFile(pagePath('main/index.html'));
  mainWindow.once('ready-to-show', () => {
    if (cfg.window.maximized) mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.on('resize', saveMainBoundsDebounced);
  mainWindow.on('move', saveMainBoundsDebounced);
  mainWindow.on('maximize', () => store.patch({ window: { maximized: true } }));
  mainWindow.on('unmaximize', () => store.patch({ window: { maximized: false } }));

  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    saveMainBounds();
    mainWindow.hide();
    if (!trayHinted) {
      trayHinted = true;
      notify('已缩到托盘', '小抄与准星仍在运行，右下角托盘图标可以叫回来');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// 小抄悬浮窗
// ---------------------------------------------------------------------------
function guideDefaultBounds() {
  const cfg = store.get().guide;
  const wa = screen.getPrimaryDisplay().workArea;
  const w = Math.min(cfg.w || 400, wa.width - 40);
  const h = Math.min(cfg.h || 640, wa.height - 40);
  const x = cfg.x == null ? wa.x + wa.width - w - 32 : cfg.x;
  const y = cfg.y == null ? wa.y + 48 : cfg.y;
  return clampToDisplay({ x, y, width: w, height: h });
}

function createGuideWindow() {
  if (guideWindow && !guideWindow.isDestroyed()) return guideWindow;
  const cfg = store.get().guide;
  const bounds = guideDefaultBounds();

  guideWindow = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // v1.2.1：这里必须是 true。
    // v1.2.0 为了「点小抄不让游戏失焦」把它设成 !forceTop，结果游戏模式（默认开）
    // 下窗口变成 Windows 的 WS_EX_NOACTIVATE —— 看得见，但 Chromium 不会把鼠标
    // 消息投递给页面，表现就是整个窗点不动、滚不动、hover 也没反应。
    // 能点 > 不抢焦点：不抢焦点改用 showInactive() 实现，不动 focusable。
    focusable: true,
    title: '小抄',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  guideWindow.setAlwaysOnTop(true, 'screen-saver');
  if (IS_WIN) guideWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  guideWindow.loadFile(pagePath('overlay/index.html'));
  guideWindow.setOpacity(Number(cfg.alpha) || 1);
  // v1.5.0：恢复上次的缩放。窗口尺寸已经是缩放后的大小，
  // 页面内容也必须用同样的 zoom，否则会变成「窗口变大、字没变」的假缩放。
  try {
    guideWindow.webContents.setZoomFactor(Math.max(0.6, Math.min(1.6, Number(cfg.scale) || 1)));
  } catch {
    /* 页面还没加载完时忽略，setZoomFactor 会在 load 后再生效 */
  }

  // 锁定/智能穿透下，鼠标事件（含滚轮）会被系统转发给下层游戏，
  // 渲染进程收不到 wheel。这里用主进程原生的 wheel-scroll 事件兜底，
  // 让用户在「小抄盖在游戏上、鼠标穿过去」时仍能滚轮翻页。
  guideWindow.webContents.on('wheel-scroll', (e, delta) => {
    if (Math.abs(delta) < 2) return;
    sendTo(guideWindow, 'guide:wheel', { deltaY: delta });
  });

  guideWindow.on('moved', () => {
    if (!guideWindow || guideWindow.isDestroyed()) return;
    clearTimeout(guideMoveTimer);
    guideMoveTimer = setTimeout(() => {
      if (!guideWindow || guideWindow.isDestroyed()) return;
      const b = guideWindow.getBounds();
      store.patch({ guide: { x: b.x, y: b.y } });
    }, 500);
  });

  guideWindow.on('closed', () => {
    guideWindow = null;
    broadcast();
  });

  return guideWindow;
}

function setGuideVisible(visible, opts = {}) {
  // 只表达意图，具体怎么落地交给状态机
  return reconcile(
    {
      v: visible ? 'shown' : 'hidden',
      m: visible ? (store.get().guide.locked ? 'passthrough' : 'interactive') : 'passthrough',
      s: visible ? 'expanded' : 'ball',
    },
    opts
  );
}

function toggleGuide() {
  // 热键 A：不管当前在什么状态，直接切「大图显 / 隐」。
  // 显的时候给 interactive —— 用户按热键就是为了操作，不是只想看一眼。
  if (ui.v === 'shown') return reconcile({ v: 'hidden', s: 'ball' });
  return reconcile({ v: 'shown', m: 'interactive', s: 'expanded' });
}

/** 热键 B：只切球，绝不动大图窗。全屏打游戏时按一下，屏幕上立刻干干净净 */
function toggleOrbs() {
  return reconcile({ b: ui.b === 'shown' ? 'hidden' : 'shown' });
}

function applyGuideLock() {
  reconcile({ m: store.get().guide.locked ? 'passthrough' : 'interactive' });
}

/**
 * 一键复位（v1.2.1）：小抄「看得见但点不动」时的兜底。
 *
 * 会把穿透、球态、置顶全部清掉，然后连同 BrowserWindow 一起重建 ——
 * 有些 Windows 主题 / 显卡驱动组合下窗口一旦被动过 focusable，
 * 单靠 setFocusable(true) 也回不来，只有重建才干净。
 */
function resetGuideWindow() {
  const cfg = store.get().guide;
  let pos = { x: cfg.x, y: cfg.y };
  if (guideWindow && !guideWindow.isDestroyed()) {
    const b = guideWindow.getBounds();
    pos = { x: b.x, y: b.y };
    guideWindow.destroy();
    guideWindow = null;
  }
  store.patch({
    guide: {
      locked: false,
      ball: false,
      enabled: true,
      x: pos.x,
      y: pos.y,
      w: Math.max(300, Number(cfg.w) || 400),
      h: Math.max(480, Number(cfg.h) || 640),
    },
  });
  const win = createGuideWindow();
  win.setFocusable(true);
  win.setIgnoreMouseEvents(false);
  win.showInactive();
  pinToTop(win);
  sendTo(win, 'guide:ball', false);
  broadcast();
  return true;
}

function guideSetWidth(width) {
  if (!guideWindow || guideWindow.isDestroyed()) return;
  const b = guideWindow.getBounds();
  const w = Math.max(300, Math.min(900, Math.round(width)));
  const h = Math.round(w * 1.6);
  const display = screen.getDisplayMatching(b);
  const maxH = display.workArea.height - 40;
  const next = clampToDisplay({ x: b.x, y: b.y, width: w, height: Math.min(h, maxH) });
  guideWindow.setBounds(next);
  try {
    guideWindow.webContents.setZoomFactor(1);
  } catch {
    /* 忽略 */
  }
  // 手动改宽度后，把缩放基准归位（100% = 当前大小），
  // 否则下一次 Alt+Shift+滚轮 会按旧比例跳一下
  store.patch({ guide: { w: next.width, h: next.height, x: next.x, y: next.y, scale: 1 } });
  broadcast();
}

// ---------------------------------------------------------------------------
// 地图覆盖模式（v1.5.0）
// ---------------------------------------------------------------------------
//
// 需求：玩家打开游戏地图时，把小抄盖在地图上，半透明、能点、能穿。
// 游戏内部的缩放比例无法直接读取，所以这一版先做「手动标定」形态：
//   · 一键进入覆盖形态：透明度降到 62%、保持置顶、智能穿透
//   · Alt+Shift+滚轮：以锚点为中心等比缩放（模拟跟随地图缩放）
//   · Alt+Shift+左键：把锚点设在鼠标位置
// 玩家实测手感 OK 后，再决定要不要上截图识别自动跟随。

function guideMapState() {
  const g = store.get().guide;
  return {
    on: !!g.mapMode,
    scale: Number(g.scale) || 1,
    alpha: Number(g.alpha) || 1,
    anchorX: g.anchorX == null ? null : Number(g.anchorX),
    anchorY: g.anchorY == null ? null : Number(g.anchorY),
  };
}

function pushMapState() {
  if (guideWindow && !guideWindow.isDestroyed()) sendTo(guideWindow, 'guide:mapState', guideMapState());
}

function guideSetMapMode(on) {
  const want = !!on;
  const patch = { mapMode: want };
  if (want) {
    // 覆盖模式的默认透明度：小抄看得清，下面的地图也看得清。
    // 用户已经手动调到 72% 以下就尊重用户，不再覆盖。
    const cur = Number(store.get().guide.alpha);
    if (!(cur > 0 && cur <= 0.72)) patch.alpha = 0.62;
    patch.forceTop = true;
  }
  store.patch({ guide: patch });
  if (guideWindow && !guideWindow.isDestroyed()) {
    if (patch.alpha) guideWindow.setOpacity(patch.alpha);
    if (want) pinToTop(guideWindow);
  }
  broadcast();
  pushMapState();
  return guideMapState();
}

function guideSetScale(target) {
  const win = guideWindow;
  if (!win || win.isDestroyed()) return guideMapState();
  const g = store.get().guide;
  const old = Math.max(0.3, Math.min(3, Number(g.scale) || 1));
  const next = Math.max(0.6, Math.min(1.6, Math.round((Number(target) || old) * 100) / 100));
  if (Math.abs(next - old) < 0.001) {
    pushMapState();
    return guideMapState();
  }
  const b = win.getBounds();
  const ratio = next / old;
  // 锚点是屏幕坐标；没标定过就用窗口中心，保证缩放时视觉重心不跑
  const ax = Number.isFinite(Number(g.anchorX)) ? Number(g.anchorX) : b.x + b.width / 2;
  const ay = Number.isFinite(Number(g.anchorY)) ? Number(g.anchorY) : b.y + b.height / 2;
  const width = Math.max(260, Math.min(1200, Math.round(b.width * ratio)));
  const height = Math.max(200, Math.min(1400, Math.round(b.height * ratio)));
  const x = Math.round(ax - (ax - b.x) * ratio);
  const y = Math.round(ay - (ay - b.y) * ratio);
  const bounds = clampToDisplay({ x, y, width, height });
  win.setBounds(bounds);
  // 窗口放大 ratio 倍、页面 zoom 也放大 ratio 倍 →
  // 屏幕上看到的是「整张小抄等比放大」，而不是窗口变大但字没变
  try {
    win.webContents.setZoomFactor(next);
  } catch {
    /* 忽略 */
  }
  store.patch({ guide: { scale: next, x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height } });
  sendTo(win, 'guide:size', { width: bounds.width, height: bounds.height });
  broadcast();
  pushMapState();
  return guideMapState();
}

function guideSetAnchor(x, y) {
  const win = guideWindow;
  let ax = Number(x);
  let ay = Number(y);
  if (!Number.isFinite(ax) || !Number.isFinite(ay)) {
    try {
      const p = screen.getCursorScreenPoint();
      ax = p.x;
      ay = p.y;
    } catch {
      /* 读不到光标就退回窗口中心 */
    }
  }
  if ((!Number.isFinite(ax) || !Number.isFinite(ay)) && win && !win.isDestroyed()) {
    const b = win.getBounds();
    ax = b.x + b.width / 2;
    ay = b.y + b.height / 2;
  }
  if (!Number.isFinite(ax) || !Number.isFinite(ay)) return guideMapState();
  store.patch({ guide: { anchorX: Math.round(ax), anchorY: Math.round(ay) } });
  broadcast();
  pushMapState();
  return guideMapState();
}

/** 收起成小球：窗口缩到 76×76，页面自己切圆形外观 */
function guideSetBall(on) {
  // 收成球 = 大图窗隐藏、球留在屏幕上；展开 = 反过来。

  // 球的窗口由 OrbManager 管，大图窗不再缩成 76×76 —— 那种做法在
  // 多球场景下没法表达「我收的是哪一个」。
  if (on) return reconcile({ s: 'ball', v: 'hidden' });
  return reconcile({ s: 'expanded', v: 'shown', m: 'interactive' });
}

// ---------------------------------------------------------------------------
// 置顶看门狗（游戏模式）
// ---------------------------------------------------------------------------
//
// Windows 上 `setAlwaysOnTop(true, 'screen-saver')` 只是把窗口放进 topmost 组，
// 组内谁在上面由「谁最后被提到前面」决定。游戏、录屏、输入法、甚至资源管理器
// 弹个框，都可能把我们的窗口挤到下面去 —— 用户看到的就是「攻略小抄被游戏盖住了」。
//
// 所以不能只设一次：主窗口不在前台时，每 800ms 重新 pin 一遍，
// `moveTop()` 会把窗口在 topmost 组里再提一次。开销可以忽略（一次系统调用）。

let topTimer = null;

/** 当前所有「应该浮在最上面」的窗口 */
function floatingWindows() {
  const list = [];
  if (orbManager) {
    for (const w of orbManager.windows()) {
      if (w && !w.isDestroyed() && w.isVisible()) list.push(w);
    }
  }
  if (guideWindow && !guideWindow.isDestroyed() && guideWindow.isVisible()) list.push(guideWindow);
  if (crosshairWindow && !crosshairWindow.isDestroyed() && crosshairWindow.isVisible()) {
    list.push(crosshairWindow);
  }
  return list;
}

function pinToTop(win) {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  try {
    win.setAlwaysOnTop(true, 'screen-saver');
    // moveTop：在 topmost 组内再提一次。Windows / Linux 有效，macOS 上无副作用
    win.moveTop();
  } catch {
    /* 窗口正在销毁时调用会抛，忽略 */
  }
}

function startTopWatch() {
  if (topTimer) return;
  topTimer = setInterval(() => {
    if (!store.get().guide.forceTop) return;
    // 不做「主窗口在前台就让位」—— 让位之后小抄会被主窗口盖住，
    // 而 forceTop 的全部意义就是「永远在最上面」。嫌挡事就 Alt+Q 收起来。
    for (const w of floatingWindows()) pinToTop(w);
  }, 800);
}

// ---------------------------------------------------------------------------
// 双模式显隐状态机（v1.4.0）
//
// 问题：以前「显示 / 隐藏 / 穿透 / 收成球」是四组散落的布尔，四个入口
// （热键 A、热键 B、点球、大图里的按钮）各改各的，必然出现
// 「看不见但吃点击」或者「看得见点不动」这种死状态。
//
// 现在收敛成四个正交维度 + 三条不变式 + 一个 reconcile() 出口。
// 所有 setIgnoreMouseEvents / show / hide 只允许出现在 reconcile 里。
// ---------------------------------------------------------------------------

/** 鼠标离开小抄窗口多久之后回到穿透。太短会「看着看着就点不动」，太长会挡住游戏 */
const IDLE_TO_PASS_MS = 2600;
const UI_WATCH_MS = 400;

const ui = { v: 'hidden', m: 'passthrough', b: 'shown', s: 'ball' };
let lastInsideAt = 0;
let uiWatchTimer = null;
let orbManager = null;

function uiSnapshot() {
  return { v: ui.v, m: ui.m, b: ui.b, s: ui.s };
}

/**
 * 唯一的状态出口。
 * @param {object} next 要改的维度
 * @param {{persist?:boolean}} opts persist=false 用于轮询引起的自动切换，避免疯狂写配置
 */
function reconcile(next = {}, opts = {}) {
  const before = ui.v + '|' + ui.m + '|' + ui.b + '|' + ui.s;
  Object.assign(ui, next);

  // 三条不变式：任何组合都必须满足，否则就是死状态
  if (ui.v === 'hidden') ui.m = 'passthrough'; // 看不见就绝不吃点击
  if (ui.m === 'interactive') ui.v = 'shown'; // 能点就必须看得见
  if (ui.b === 'hidden') ui.s = 'ball'; // 球藏了不能留展开态

  // 收成球的时候，如果用户还没配过球，补一个 ——
  // 否则按「收起」之后屏幕上什么都没有，看起来就是程序没了
  if (ui.s === 'ball' && orbManager && !orbManager.list().length) {
    try {
      orbManager.add(store.get().guide.lastCategory || '');
    } catch (e) {
      log.warn('ui', '自动补球失败', e && e.message);
    }
  }

  // ---- 大图窗 ----
  const win = guideWindow && !guideWindow.isDestroyed() ? guideWindow : null;
  if (ui.v === 'shown') {
    const w = createGuideWindow();
    if (!w.isVisible()) w.showInactive();
    pinToTop(w);
    const pass = ui.m === 'passthrough';
    if (w.__pass !== pass) {
      try {
        w.setIgnoreMouseEvents(pass, { forward: true });
        w.__pass = pass;
      } catch (e) {
        log.warn('ui', '设置穿透失败', e && e.message);
      }
    }
    lastInsideAt = Date.now();
  } else if (win) {
    if (win.isVisible()) win.hide();
    // 隐藏时把穿透标记清掉：否则下次呼出来第一个点击会穿到桌面
    if (win.__pass !== false) {
      try {
        win.setIgnoreMouseEvents(false);
        win.__pass = false;
      } catch {
        /* ignore */
      }
    }
  }

  // ---- 悬浮球 ----
  if (orbManager) orbManager.setVisible(ui.b === 'shown');

  // ---- 落盘（只存用户的意图，不存瞬时态）----
  if (opts.persist !== false) {
    const cfg = store.get();
    const patch = {};
    if (cfg.guide.enabled !== (ui.v === 'shown')) patch.enabled = ui.v === 'shown';
    if (cfg.guide.ball !== (ui.s === 'ball')) patch.ball = ui.s === 'ball';
    // locked 故意不在这里写：它是「用户要不要锁死穿透」的意图，
    // 不该被「隐藏时强制 passthrough」这个运行时动作覆盖掉。
    // 否则收一次再打开，窗口就变成穿透态，用户点半天没反应。
    // 改锁定只走 guide:setLocked 一条路。
    if (Object.keys(patch).length) store.patch({ guide: patch });
    if (cfg.orbs.visible !== (ui.b === 'shown')) store.patch({ orbs: { visible: ui.b === 'shown' } });
  }

  if (before !== ui.v + '|' + ui.m + '|' + ui.b + '|' + ui.s) {
    log.debug('ui', '状态 →', uiSnapshot());
  }
  broadcast();
  return uiSnapshot();
}

/**
 * 智能穿透看门狗：
 * 鼠标进窗口 → 立刻恢复可点；离开 2.6 秒 → 回到穿透。
 * 这样默认不挡游戏点击，但用户把鼠标挪回来就能直接滚轮翻页，不用再按一次热键。
 *
 * 注意：只有「未锁定」的智能穿透才由看门狗自动写进配置。
 * 锁定穿透（用户在界面手动锁死）是用户意图，看门狗绝不能把它解锁，
 * 否则会出现「点了锁定按钮、窗口却没真的锁上」的假象。
 */
function startUiWatch() {
  if (uiWatchTimer) return;
  uiWatchTimer = setInterval(() => {
    if (ui.v !== 'shown') return;
    const win = guideWindow;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    let p;
    try {
      p = screen.getCursorScreenPoint();
    } catch {
      return;
    }
    const b = win.getBounds();
    const inside = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
    // 锁死穿透：看门狗只负责「顶回最上层」，绝不改变它的可点性
    if (store.get().guide.locked) {
      pinToTop(win);
      return;
    }
    if (inside) {
      lastInsideAt = Date.now();
      if (ui.m !== 'interactive') reconcile({ m: 'interactive' }, { persist: false });
    } else if (ui.m === 'interactive' && Date.now() - lastInsideAt > IDLE_TO_PASS_MS) {
      reconcile({ m: 'passthrough' }, { persist: false });
    }
  }, UI_WATCH_MS);
}

/**
 * 锁定穿透（用户意图：鼠标永远穿过去）。
 * 只在「窗口确实处于不可点状态」时才清除配置里的 locked。
 *
 * 为什么必须带条件：窗口刚被隐藏、或还没被 reconcile 切到穿透时，
 * 窗口其实是可点的（interactive），此时不能清 locked —— 否则下一次
 * 智能看门狗把窗口切回穿透后会误以为用户「没锁」而重新变可点。
 * 只有真的 ignoreMouseEvents===true 时，清掉 locked 才是安全的。
 */
function clearLockedIfNotReallyLocked() {
  const win = guideWindow;
  const reallyLocked = !!(win && !win.isDestroyed() && win.webContents &&
    !win.webContents.isDestroyed() && !win.webContents.isIgnoredEvents());
  if (!reallyLocked) return;
  const cfg = store.get();
  if (cfg.guide && cfg.guide.locked) store.patch({ guide: { locked: false } });
  broadcast();
}

/** 从悬浮球 / 快捷入口打开某个分类，并直接看第一张 */
function openGuideAt(rel) {
  const win = createGuideWindow();
  const payload = { rel: rel || '' };
  reconcile({ v: 'shown', m: 'interactive', s: 'expanded' });
  const push = () => {
    try {
      sendTo(win, 'guide:openAt', payload);
    } catch (e) {
      log.warn('ui', '派发 openAt 失败', e && e.message);
    }
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', push);
  else push();
  return true;
}

/** 应用「游戏模式」开关：看门狗 + 立刻顶一次。绝不碰 focusable */
function applyGuideTopMode() {
  const on = !!store.get().guide.forceTop;
  if (guideWindow && !guideWindow.isDestroyed()) {
    // 万一被旧版本写成了不可聚焦（配置文件残留），这里强制修回来
    if (!guideWindow.isFocusable()) guideWindow.setFocusable(true);
    if (on) pinToTop(guideWindow);
  }
  if (on) startTopWatch();
  broadcast();
}

// ---------------------------------------------------------------------------
// 准星
// ---------------------------------------------------------------------------
function activeProfile(cfg = store.get()) {
  const list = cfg.crosshair.profiles || [];
  return list.find((p) => p.id === cfg.crosshair.activeId) || list[0] || null;
}

function imageRatio(file) {
  if (!file) return 1;
  if (crosshairSizeCache.has(file)) return crosshairSizeCache.get(file);
  try {
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return 1;
    const { width, height } = img.getSize();
    const r = height / Math.max(1, width);
    crosshairSizeCache.set(file, r);
    return r;
  } catch {
    return 1;
  }
}

/** 准星窗口尺寸：宽度由用户定，高度按图片比例。没有图时给一个 120×120 的空窗 */
function crosshairBoundsFor(profile) {
  const cfg = store.get().crosshair;
  const w = Math.max(32, Math.round(profile && profile.width ? profile.width : 120));
  if (!profile || !profile.image) {
    return { width: w, height: w };
  }
  const ratio = imageRatio(profile.image);
  const h = Math.max(24, Math.round(w * ratio));
  return { width: w, height: h };
}

function crosshairCenter(profile, size) {
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  // 锚点对准屏幕中心，而不是窗口中心 —— 用户设的瞄准点就是屏幕上的那一点
  const ax = profile ? profile.ax : 0.5;
  const ay = profile ? profile.ay : 0.5;
  const cx = wa.x + wa.width / 2;
  const cy = wa.y + wa.height / 2;
  return {
    x: Math.round(cx - size.width * ax),
    y: Math.round(cy - size.height * ay),
    width: size.width,
    height: size.height,
  };
}

function createCrosshairWindow() {
  if (crosshairWindow && !crosshairWindow.isDestroyed()) return crosshairWindow;
  const profile = activeProfile();
  const size = crosshairBoundsFor(profile);
  const pos = profile && profile.x != null
    ? clampToDisplay({ x: profile.x, y: profile.y, ...size })
    : crosshairCenter(profile, size);

  crosshairWindow = new BrowserWindow({
    ...pos,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // v1.2.1：同样不能靠 focusable:false 来「不抢焦点」。
    // 准星本来就 setIgnoreMouseEvents(true) 全穿透，鼠标根本碰不到它，不会抢焦点；
    // 但设为 false 之后，「调整准星」模式再把 setFocusable(true) 打开时，
    // Windows 上有概率恢复不了输入，拖动就失效了。
    focusable: true,
    acceptFirstMouse: true,
    title: '准星',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  crosshairWindow.setAlwaysOnTop(true, 'screen-saver');
  if (IS_WIN) crosshairWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  crosshairWindow.loadFile(pagePath('crosshair/index.html'));
  crosshairWindow.setIgnoreMouseEvents(true, { forward: true });

  crosshairWindow.on('closed', () => {
    crosshairWindow = null;
    broadcast();
  });

  return crosshairWindow;
}

/** 重新按当前那套算尺寸/位置，并保持「瞄准点」在屏幕上的位置不变 */
function applyCrosshairGeometry(keepAnchor) {
  if (!crosshairWindow || crosshairWindow.isDestroyed()) return;
  const profile = activeProfile();
  const old = crosshairWindow.getBounds();
  const oldProf = lastAppliedProfile;
  const size = crosshairBoundsFor(profile);

  let x = old.x;
  let y = old.y;
  if (keepAnchor && oldProf) {
    const anchorScreenX = old.x + old.width * (oldProf.ax ?? 0.5);
    const anchorScreenY = old.y + old.height * (oldProf.ay ?? 0.5);
    x = Math.round(anchorScreenX - size.width * (profile ? profile.ax : 0.5));
    y = Math.round(anchorScreenY - size.height * (profile ? profile.ay : 0.5));
  } else if (profile && profile.x != null) {
    x = profile.x;
    y = profile.y;
  }
  const next = clampToDisplay({ x, y, ...size });
  crosshairWindow.setBounds(next);
  lastAppliedProfile = profile ? { ax: profile.ax, ay: profile.ay } : null;
  persistCrosshairPos(next.x, next.y);
}

let lastAppliedProfile = null;
let guideMoveTimer = null;
let crosshairDrag = null;

function persistCrosshairPos(x, y) {
  const cfg = store.get();
  const p = activeProfile(cfg);
  if (!p) return;
  const list = cfg.crosshair.profiles.map((it) => (it.id === p.id ? { ...it, x, y } : it));
  store.set('crosshair', { ...cfg.crosshair, profiles: list });
}

function ensureDefaultProfile() {
  const cfg = store.get();
  if ((cfg.crosshair.profiles || []).length) return;
  const p = {
    id: 'p' + Date.now().toString(36),
    name: '默认准星',
    image: '',
    ax: 0.5,
    ay: 0.5,
    width: 220,
    alpha: 1,
    lines: true,
    x: null,
    y: null,
  };
  store.set('crosshair', { ...cfg.crosshair, profiles: [p], activeId: p.id });
}

function setCrosshairVisible(visible) {
  if (visible) {
    ensureDefaultProfile();
    const win = createCrosshairWindow();
    applyCrosshairGeometry(false);
    win.showInactive();
    pinToTop(win);
    const adjusting = store.get().crosshair.adjust;
    if (adjusting) {
      win.setFocusable(true);
      win.setIgnoreMouseEvents(false);
    } else {
      win.setIgnoreMouseEvents(true, { forward: true });
    }
    store.patch({ crosshair: { enabled: true } });
    sendTo(win, 'crosshair:profile', crosshairPayload());
  } else if (crosshairWindow && !crosshairWindow.isDestroyed()) {
    crosshairWindow.hide();
    store.patch({ crosshair: { enabled: false, adjust: false } });
  }
  broadcast();
}

function crosshairPayload() {
  const cfg = store.get();
  const p = activeProfile(cfg);
  const img = p && p.image && fs.existsSync(p.image) ? p.image : '';
  if (img) allowedMedia.add(path.resolve(img));
  return {
    profile: p || null,
    imageUrl: img ? mediaUrl(img) : '',
    alpha: p ? p.alpha : 1,
    ax: p ? p.ax : 0.5,
    ay: p ? p.ay : 0.5,
    lines: p ? p.lines : true,
    adjust: cfg.crosshair.adjust,
  };
}

function mediaUrl(file) {
  return 'media://file/' + b64(path.resolve(file));
}

function refreshCrosshairContent() {
  const win = createCrosshairWindow();
  applyCrosshairGeometry(true);
  sendTo(win, 'crosshair:profile', crosshairPayload());
  broadcast();
}

// ---------------------------------------------------------------------------
// 自定义协议
// ---------------------------------------------------------------------------
/**
 * 检测当前前台是不是「独占全屏」。
 *
 * 为什么需要这个：独占全屏（D3D exclusive fullscreen）下 Windows 会停掉桌面合成，
 * 任何外部叠加窗口都收不到鼠标消息 —— 这不是本程序的缺陷，是系统的显示模式限制。
 * 唯一可靠的解法是让游戏跑「无边框窗口 / 窗口化全屏」，所以这里只负责把状态说清楚，
 * 不让用户以为是小抄坏了。
 *
 * SHQueryUserNotificationState 是 Windows 自带的只读查询，不注入、不挂钩、不碰游戏进程。
 */
const PS_DISPLAY_MODE = [
'Add-Type -TypeDefinition @"',
'using System;',
'using System.Runtime.InteropServices;',
'public class Quns {',
'  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);',
'}',
'"@',
'$s = 0',
'$hr = [Quns]::SHQueryUserNotificationState([ref]$s)',
'Write-Output ("{0}|{1}" -f $hr, $s)',
].join('\n');

const QUNS_LABEL = {
2: { label: '有全屏程序在前台', full: true, exclusive: false },
3: { label: '游戏处于独占全屏', full: true, exclusive: true },
4: { label: '演示模式（投影 / 全屏演示）', full: true, exclusive: false },
5: { label: '正常窗口模式', full: false, exclusive: false },
6: { label: '系统免打扰时间', full: false, exclusive: false },
7: { label: '有应用在前台', full: false, exclusive: false },
};

function detectDisplayMode() {
return new Promise((resolve) => {
  if (!IS_WIN) {
    resolve({ ok: false, reason: 'not-win', label: '仅 Windows 可检测显示模式' });
    return;
  }
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_DISPLAY_MODE],
    { timeout: 6000, windowsHide: true },
    (err, stdout) => {
      if (err) {
        resolve({ ok: false, reason: 'exec', label: '检测失败（PowerShell 不可用）' });
        return;
      }
      const m = String(stdout).trim().match(/(-?\d+)\|(-?\d+)/);
      if (!m) {
        resolve({ ok: false, reason: 'parse', label: '检测失败（返回格式异常）' });
        return;
      }
      const state = Number(m[2]);
      const info = QUNS_LABEL[state] || { label: '未知状态', full: false, exclusive: false };
      resolve({
        ok: true,
        state,
        label: info.label,
        full: info.full,
        exclusive: info.exclusive,
        hint: info.exclusive
          ? '独占全屏下系统停止桌面合成，任何叠加窗口都收不到鼠标。把游戏的显示模式改成「无边框窗口 / 窗口化全屏」就能正常点击。'
          : info.full
            ? '当前有全屏程序在前台，叠加层可能被挡住或抢不到鼠标，同样建议用无边框窗口。'
            : '叠加层可以正常显示和接收点击。',
      });
    },
  );
});
}

function registerProtocols() {
  protocol.handle('guide', async (req) => {
    try {
      const u = new URL(req.url);
      const root = store.get().guide.root;
      const rel = unb64(decodeURIComponent(u.pathname.replace(/^\//, '')));
      const file = guideLib.resolveInside(root, rel);
      if (!file || !fs.existsSync(file)) return new Response('not found', { status: 404 });

      if (u.host === 'thumb') {
        const buf = await guideLib.thumbnailAsync(file, 420);
        if (!buf) return new Response('decode failed', { status: 415 });
        return new Response(buf, {
          headers: { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' },
        });
      }
      const res = await net.fetch(pathToFileURL(file).toString(), { headers: req.headers });
      return res;
    } catch (e) {
      return new Response('bad request: ' + e.message, { status: 400 });
    }
  });

  protocol.handle('media', async (req) => {
    try {
      const u = new URL(req.url);
      const file = unb64(decodeURIComponent(u.pathname.replace(/^\//, '')));
      const abs = path.resolve(file);
      if (!allowedMedia.has(abs)) return new Response('forbidden', { status: 403 });
      if (!fs.existsSync(abs)) return new Response('not found', { status: 404 });
      return await net.fetch(pathToFileURL(abs).toString(), { headers: req.headers });
    } catch (e) {
      return new Response('bad request: ' + e.message, { status: 400 });
    }
  });
}

// ---------------------------------------------------------------------------
// 全局快捷键
// ---------------------------------------------------------------------------
let lastHotkeyResult = {};

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const cfg = store.get().hotkeys;
  const actions = {
    // 热键 A：大图显 / 隐
    toggleGuide: () => toggleGuide(),
    // 热键 B：只显隐所有悬浮球，不碰大图
    toggleOrbs: () => toggleOrbs(),
    toggleCrosshair: () => setCrosshairVisible(!(crosshairWindow && crosshairWindow.isVisible())),
    hideAll: () => {
      // 一键清净：大图、球、准星全收，但不改用户的热键与配置
      reconcile({ v: 'hidden', b: 'hidden' });
      setCrosshairVisible(false);
    },
    nextCrosshair: () => cycleCrosshair(1),
  };
  const result = {};
  for (const [key, fn] of Object.entries(actions)) {
    const acc = cfg[key];
    if (!acc) {
      result[key] = 'empty';
      continue;
    }
    try {
      result[key] = globalShortcut.register(acc, fn) ? 'ok' : 'failed';
    } catch {
      result[key] = 'failed';
    }
  }
  lastHotkeyResult = result;
  // 兜底快捷键：固定 Alt+Shift+R，不进设置界面，纯急救用。
  // 万一小抄被某次异常留在「穿透 / 不可聚焦」状态，用户至少有一条活路。
  try {
    globalShortcut.register('Alt+Shift+R', () => resetGuideWindow());
  } catch {
    /* 被别的软件占用就跳过，托盘菜单里还有同样的入口 */
  }
  // v1.5.0：Alt+M 一键切「地图覆盖模式」，不进设置界面，玩家随手开合
  try {
    globalShortcut.register('Alt+M', () => guideSetMapMode(!store.get().guide.mapMode));
  } catch {
    /* 被占用就跳过，悬浮窗标题栏上也有按钮 */
  }
  broadcast();
  return result;
}

function cycleCrosshair(step) {
  const cfg = store.get();
  const list = cfg.crosshair.profiles || [];
  if (list.length < 2) return;
  const idx = Math.max(0, list.findIndex((p) => p.id === cfg.crosshair.activeId));
  const next = list[(idx + step + list.length) % list.length];
  store.patch({ crosshair: { activeId: next.id } });
  refreshCrosshairContent();
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------
function createTray() {
  try {
    let icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon.png'));
    if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip(APP_NAME);
    const rebuild = () => {
      const cfg = store.get();
      const menu = Menu.buildFromTemplate([
        { label: '打开主界面', click: () => showMain() },
        { type: 'separator' },
        {
          label: '小抄悬浮窗',
          type: 'checkbox',
          checked: !!(guideWindow && guideWindow.isVisible()),
          click: () => toggleGuide(),
        },
        {
          label: '准星',
          type: 'checkbox',
          checked: !!(crosshairWindow && crosshairWindow.isVisible()),
          click: () => setCrosshairVisible(!(crosshairWindow && crosshairWindow.isVisible())),
        },
        {
          label: '切换下一套准星',
          enabled: (cfg.crosshair.profiles || []).length > 1,
          click: () => cycleCrosshair(1),
        },
        { type: 'separator' },
        {
          label: '小抄点不动？重置悬浮窗',
          click: () => resetGuideWindow(),
        },
        { type: 'separator' },
        { label: '快捷键' + (cfg.hotkeys.toggleGuide ? '：' + cfg.hotkeys.toggleGuide : ''), enabled: false },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]);
      tray.setContextMenu(menu);
    };
    rebuild();
    tray.on('click', () => showMain());
    tray.on('right-click', rebuild);
    tray.on('double-click', () => showMain());
  } catch (e) {
    console.error('[tray] 创建失败', e);
  }
}

function notify(title, body) {
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) new Notification({ title, body, icon: path.join(__dirname, '..', '..', 'assets', 'icon.png') }).show();
  } catch { /* 通知失败不影响主流程 */ }
}

// ---------------------------------------------------------------------------
// 网盘登录与下载
// ---------------------------------------------------------------------------

/**
 * 把用户粘进来的 Cookie 文本收拾干净。
 * 见过的输入：整段 `Cookie: a=1; b=2`、F12 里按行复制的多行、带换行的复制。
 */
function normalizeCookieText(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^cookie\s*:\s*/i, '');
  s = s
    .split(/[\r\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join('; ');
  s = s.replace(/;\s*;/g, ';').replace(/^;\s*/, '').replace(/;\s*$/, '');
  return s;
}

/** Cookie 数组 → 请求头字符串。同名的保留后到的（域更具体的排在后面） */
function cookiesToHeader(cookies) {
  const map = new Map();
  for (const c of cookies) {
    if (c && c.name) map.set(c.name, c.value);
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
}

function cookiesForPlatform(platform, cookies) {
  const suffix = platform === 'quark' ? 'quark.cn' : 'uc.cn';
  return (cookies || []).filter((c) => {
    const d = String(c.domain || '').replace(/^\./, '');
    return d === suffix || d.endsWith('.' + suffix);
  });
}

/**
 * 登录窗口：直接开官方网页，扫码 / 短信 / 密码都交给他们自己。
 * 我们只轮询这个分区里的 Cookie，凑齐 __pus + __puus 就说明登录完成。
 */
function openPanLogin(platform) {
  const p = pan.PLATFORMS[platform];
  if (!p) return { ok: false, error: '未知平台' };
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.show();
    loginWindow.focus();
    return { ok: true, reused: true };
  }

  const partition = 'persist:pan-' + platform;
  // v1.2.2：登录窗必须够宽。
  // 夸克和 UC 的网页版都把「扫码登录」卡片钉死在页面右侧（夸克 x≈655 宽 320，
  // UC x≈797 宽 260 直接贴到 1060），窗口只有 560 宽时整块卡片落在视口外面 ——
  // 用户看到的只有左边那半屏推广文案，于是以为「这页面根本没有登录入口」。
  // 做法：按屏幕给到 1120 宽；屏幕不够就按比例缩放页面，保证 CSS 视口始终 >= 1100。
  const wa = screen.getPrimaryDisplay().workArea;
  const CSS_NEED = 1100;
  const winW = Math.min(1120, Math.round(wa.width * 0.92));
  const winH = Math.min(820, Math.round(wa.height * 0.88));
  const zoom = Math.min(1, (winW - 24) / CSS_NEED);
  loginWindow = new BrowserWindow({
    width: winW,
    height: winH,
    minWidth: Math.min(720, winW),
    minHeight: 560,
    center: true,
    title: '登录' + p.label + '网盘（登录成功后自动关闭）',
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    autoHideMenuBar: true,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      zoomFactor: zoom,
    },
  });

  const ses = session.fromPartition(partition);
  let verifying = false;
  let lastTry = 0;
  const timer = setInterval(async () => {
    if (!loginWindow || loginWindow.isDestroyed()) {
      clearInterval(timer);
      return;
    }
    if (verifying || Date.now() - lastTry < 2500) return;
    let cookies = [];
    try {
      cookies = await ses.cookies.get({});
    } catch {
      return;
    }
    const jar = cookiesToHeader(cookiesForPlatform(platform, cookies));
    // 只有 __pus 还不够：没登录时夸克也会下发匿名会话，必须真打一次网盘接口才算数
    if (!jar.includes('__pus=') || !jar.includes('__puus=')) return;

    lastTry = Date.now();
    verifying = true;
    let ok = false;
    try {
      ok = await pan.checkLogin({ platform, cookie: jar });
    } catch {
      ok = false;
    } finally {
      verifying = false;
    }
    if (!ok) return;

    clearInterval(timer);
    store.patch({ pan: { [platform + 'Cookie']: jar } });
    notify('已连接' + p.label + '网盘', '现在可以一键下载整份小抄了');
    sendTo(mainWindow, 'pan:changed', { platform, loggedIn: true });
    broadcast();
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
  }, 1200);

  loginWindow.on('closed', () => {
    clearInterval(timer);
    loginWindow = null;
    sendTo(mainWindow, 'pan:changed', { platform, loggedIn: false });
    broadcast();
  });

  // 第三方页面不允许自己弹窗（登录页偶尔会弹活动页，弹出来就是个空白小窗）
  loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  loginWindow.webContents.on('did-finish-load', () => {
    if (!loginWindow || loginWindow.isDestroyed()) return;
    // 兜一道缩放：有些情况下 webPreferences.zoomFactor 会被页面自己的 viewport 设置覆盖
    try {
      loginWindow.webContents.setZoomFactor(zoom);
    } catch {
      /* 忽略 */
    }
  });

  // 打不开就给个人话，而不是一片白
  loginWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 是主动中止（重定向），不算错
    const html = `<meta charset="utf-8"><body style="font-family:system-ui;padding:48px;color:#333;background:#f7f8fa">
      <h2 style="margin:0 0 12px">登录页没打开</h2>
      <p style="color:#666;line-height:1.7">${p.label}网盘的网页加载失败：${desc}（${code}）<br>
      先确认电脑能上网、没开全局代理拦截，然后关掉这个窗口重试。</p>
      <p style="color:#999;font-size:13px">实在打不开，可以直接在主界面「网盘一键下载」里点「粘贴 Cookie」。</p>
    </body>`;
    loginWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });

  loginWindow.loadURL(p.loginUrl);
  return { ok: true };
}

function defaultBaseDir() {
  const saved = store.get().download.baseDir;
  if (saved) return saved;
  return path.join(app.getPath('documents'), '云小抄');
}

/** 网盘下载的保存根。默认跟小抄同一个父目录，但落在子目录里互不干扰 */
function panBase() {
  const cfg = store.get().download;
  return cfg.panBase || cfg.baseDir || path.join(app.getPath('documents'), '云小抄', '网盘');
}

/**
 * 某个平台的落盘根 = 保存目录 / 夸克网盘。
 * 网盘里的目录结构原样在这个根下面复刻，所以「相对路径」在多次下载之间是稳定的 ——
 * 这正是不用文件名 / fileId 也能准确判断重复的基础。
 */
function panDest(platform) {
  const p = pan.PLATFORMS[platform];
  if (!p) return '';
  return path.join(panBase(), `${p.label}网盘`);
}

/** 把下载目录设为本地小抄：清缓存、重载悬浮窗、后台预热首屏 */
function activateGuideRoot(root) {
  if (!root) return { ok: false, error: '目录为空' };
  store.patch({ guide: { root, lastCategory: '' } });
  guideLib.clearThumbCache();
  broadcast();
  if (guideWindow && !guideWindow.isDestroyed()) sendTo(guideWindow, 'guide:reload', { root });
  guideLib.warmup(root);
  return { ok: true, root, info: guideLib.overview(root) };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function setupIpc() {
  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    userData: app.getPath('userData'),
    yunx: YUNX,
    appName: APP_NAME,
  }));

  handle('cfg:get', () => store.get());
  handle('cfg:patch', (_e, partial) => {
    const next = store.patch(partial || {});
    broadcast();
    return next;
  });
  handle('cfg:set', (_e, section, value) => {
    const next = store.set(section, value);
    broadcast();
    return next;
  });

  // 窗口按钮
  handle('win:min', () => mainWindow && mainWindow.minimize());
  handle('win:max', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  handle('win:close', () => mainWindow && mainWindow.close());
  handle('app:quit', () => {
    quitting = true;
    app.quit();
  });
  handle('app:showMain', () => showMain());

  handle('open:external', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//i.test(url)) return shell.openExternal(url);
    return false;
  });
  handle('open:userData', () => shell.openPath(app.getPath('userData')));
  handle('open:guideFolder', () => {
    const root = store.get().guide.root;
    if (root && fs.existsSync(root)) return shell.openPath(root);
    return 'not set';
  });

  // 小抄
  handle('guide:setVisible', (_e, v) => {
    setGuideVisible(!!v);
    return !!(guideWindow && guideWindow.isVisible());
  });
  handle('guide:setLocked', (_e, v) => {
    store.patch({ guide: { locked: !!v } });
    // 手动解锁时只有「窗口真的锁着（不可点）」才需要同步清掉配置里的 locked。
    // 可点状态下清 locked 是无害的（本来就 false）；不可点状态下清是必要的
    // （否则 reconcile 看到 locked=true 会继续把窗口钉死在穿透）。
    if (!v) clearLockedIfNotReallyLocked();
    applyGuideLock();
    return !!v;
  });
  handle('guide:displayMode', () => detectDisplayMode());
  handle('guide:diag', () => {
    const cfg = store.get().guide;
    if (!guideWindow || guideWindow.isDestroyed()) {
      return { open: false, focusable: null, locked: !!cfg.locked, visible: false };
    }
    let focusable = null;
    try {
      focusable = guideWindow.isFocusable();
    } catch {
      focusable = null;
    }
    return {
      open: true,
      focusable,
      locked: !!cfg.locked,
      ball: !!cfg.ball,
      visible: guideWindow.isVisible(),
      alwaysOnTop: guideWindow.isAlwaysOnTop(),
      forceTop: !!cfg.forceTop,
    };
  });
  handle('guide:reset', () => resetGuideWindow());
  handle('guide:close', () => {
    store.patch({ guide: { enabled: false, locked: false } });
    if (guideWindow && !guideWindow.isDestroyed()) {
      guideWindow.setIgnoreMouseEvents(false);
      guideWindow.hide();
    }
    broadcast();
  });
  handle('guide:pickRoot', async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, {
      title: '选择攻略文件夹（里面放分类文件夹或图片）',
      properties: ['openDirectory'],
      buttonLabel: '就用这个文件夹',
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    const root = r.filePaths[0];
    store.patch({ guide: { root, lastCategory: '' } });
    guideLib.clearThumbCache();
    const info = guideLib.overview(root);
    guideLib.warmup(root);
    broadcast();
    if (guideWindow && !guideWindow.isDestroyed()) sendTo(guideWindow, 'guide:reload', { root });
    return { ok: true, root, info };
  });
  handle('guide:clearRoot', () => {
    store.patch({ guide: { root: '' } });
    guideLib.clearThumbCache();
    broadcast();
    return { ok: true };
  });
  handle('guide:list', (_e, rel) => guideLib.listDir(store.get().guide.root, rel || ''));
  handle('guide:overview', () => guideLib.overview(store.get().guide.root));

  handle('guide:setWidth', (_e, w) => guideSetWidth(w));
  // v1.5.0 地图覆盖模式
  handle('guide:mapMode', (_e, on) => guideSetMapMode(!!on));
  handle('guide:mapState', () => guideMapState());
  handle('guide:scale', (_e, v) => guideSetScale(v));
  handle('guide:anchor', (_e, p) => guideSetAnchor(p && p.x, p && p.y));
  handle('guide:setAlpha', (_e, a) => {
    const v = Math.max(0.2, Math.min(1, Number(a) || 1));
    store.patch({ guide: { alpha: v } });
    if (guideWindow && !guideWindow.isDestroyed()) guideWindow.setOpacity(v);
    broadcast();
    return v;
  });
  handle('guide:setBall', (_e, on) => guideSetBall(!!on));
  // ---- 悬浮球管理（v1.4.0）----
  handle('orb:list', () => {
    if (!orbManager) return { ok: false, orbs: [], max: MAX_ORBS, folders: [] };
    let folders = [];
    try {
      const r = guideLib.listDir(store.get().guide.root, '');
      if (r && r.ok) folders = r.folders || [];
    } catch (e) {
      log.warn('orb', '读取分类失败', e && e.message);
    }
    // 带上窗口真实可见性：hide() 之后 isVisible() 才是唯一可信的来源，
    // 配置里的 orbs.visible 只是「用户意图」，两者可能因为异常而不一致
    const live = new Map(orbManager.windows().map((w) => [w.__orbId, w.isVisible()]));
    return {
      ok: true,
      orbs: orbManager.list().map((o) => ({ ...o, shown: live.get(o.id) !== false })),
      max: MAX_ORBS,
      visible: orbManager.isVisible(),
      folders,
      root: store.get().guide.root,
    };
  });
  handle('orb:add', (_e, rel) => (orbManager ? orbManager.add(typeof rel === 'string' ? rel : null) : { ok: false }));
  handle('orb:remove', (_e, id) => (orbManager ? orbManager.remove(String(id)) : { ok: false }));
  handle('orb:bind', (_e, p) => (orbManager ? orbManager.bind(String(p && p.id), String((p && p.rel) || '')) : { ok: false }));
  handle('orb:rename', (_e, p) => {
    if (!orbManager) return { ok: false };
    const label = String((p && p.label) || '').trim().slice(0, 12);
    if (!label) return { ok: false, error: '名字不能为空' };
    return orbManager.update(String(p.id), { label });
  });
  handle('orb:scale', (_e, p) => (orbManager ? orbManager.setScale(String(p && p.id), Number(p && p.scale)) : { ok: false }));
  handle('orb:setVisible', (_e, v) => {
    reconcile({ b: v ? 'shown' : 'hidden' });
    return { ok: true, visible: !!v };
  });
  handle('orb:setScaleAll', (_e, v) => {
    const s = Math.max(0.72, Math.min(1.5, Number(v) || 1));
    if (!orbManager) return { ok: false };
    for (const o of orbManager.list()) orbManager.setScale(o.id, s);
    return { ok: true, scale: s };
  });

  handle('guide:setForceTop', (_e, v) => {
    store.patch({ guide: { forceTop: !!v } });
    applyGuideTopMode();
    return !!v;
  });

  // 网盘登录
  handle('pan:parse', (_e, text) => pan.parseShare(text));
  handle('pan:status', () => {
    const cfg = store.get();
    return {
      quark: !!cfg.pan.quarkCookie,
      uc: !!cfg.pan.ucCookie,
      baseDir: defaultBaseDir(),
    };
  });
  handle('pan:login', (_e, platform) => openPanLogin(String(platform)));
  /**
   * 粘贴 Cookie 登录（v1.2.2）：登录页打不开时的唯一活路，也是云析桌面版的做法。
   * 不直接信任用户输入 —— 先真打一次网盘列表接口，通了才算登录成功。
   */
  handle('pan:saveCookie', async (_e, payload) => {
    const platform = String((payload && payload.platform) || '');
    if (!['quark', 'uc'].includes(platform)) return { ok: false, error: '未知平台' };
    const jar = normalizeCookieText(payload && payload.cookie);
    if (!jar.includes('__pus=') || !jar.includes('__puus=')) {
      return {
        ok: false,
        error: 'Cookie 里没找到 __pus / __puus。夸克和 UC 的登录态必须同时含这两项，可能只复制了一部分',
      };
    }
    let ok = false;
    try {
      ok = await pan.checkLogin({ platform, cookie: jar });
    } catch {
      ok = false;
    }
    if (!ok) {
      return { ok: false, error: '验证没通过：Cookie 可能已过期，或者复制的不是登录后的值' };
    }
    store.patch({ pan: { [platform + 'Cookie']: jar } });
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    notify('已连接' + pan.PLATFORMS[platform].label + '网盘', '现在可以一键下载整份小抄了');
    sendTo(mainWindow, 'pan:changed', { platform, loggedIn: true });
    broadcast();
    return { ok: true };
  });
  handle('pan:logout', (_e, platform) => {
    if (!['quark', 'uc'].includes(platform)) return { ok: false };
    store.patch({ pan: { [platform + 'Cookie']: '' } });
    try {
      session.fromPartition('persist:pan-' + platform).clearStorageData({});
    } catch {
      /* 清不掉也无所谓，下次登录会覆盖 */
    }
    broadcast();
    return { ok: true };
  });
  handle('pan:browse', async (_e, platform, fid) => {
    const p = pan.PLATFORMS[platform];
    if (!p) return { ok: false, error: '未知平台' };
    const cookie = store.get().pan[platform + 'Cookie'] || '';
    if (!cookie) return { ok: false, error: `还没登录${p.label}网盘` };
    try {
      const files = await pan.listCloud({ platform, cookie, fid: fid || '0' });
      return {
        ok: true,
        fid: fid || '0',
        folders: files.filter((f) => f.dir).map((f) => ({ fid: f.fid, name: f.name })),
        images: files.filter((f) => !f.dir && guideLib.isImage(f.name)).length,
        others: files.filter((f) => !f.dir && !guideLib.isImage(f.name)).length,
      };
    } catch (e) {
      return { ok: false, error: e.message || '读取目录失败' };
    }
  });

  // 一键下载
  handle('dl:state', () => (downloader ? downloader.snapshot() : null));
  handle('dl:pickBase', async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, {
      title: '小抄下载到哪儿',
      defaultPath: defaultBaseDir(),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '就放这里',
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    const dir = r.filePaths[0];
    store.patch({ download: { baseDir: dir } });
    broadcast();
    return { ok: true, dir };
  });
  handle('dl:openBase', () => {
    const dir = defaultBaseDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* 建不出来就让 openPath 报错 */
    }
    return shell.openPath(dir);
  });
  handle('dl:startShare', (_e, opts) => {
    if (!downloader) return { ok: false, error: '下载器还没准备好' };
    return downloader.startShare({ ...(opts || {}), baseDir: (opts && opts.baseDir) || defaultBaseDir() });
  });
  handle('dl:startCloud', (_e, opts) => {
    if (!downloader) return { ok: false, error: '下载器还没准备好' };
    return downloader.startCloud({ ...(opts || {}), baseDir: (opts && opts.baseDir) || defaultBaseDir() });
  });
  // 选择性下载：先解析成文件树给用户勾选，勾完再只下选中的
  handle('dl:previewShare', async (_e, opts) => {
    if (!downloader) return { ok: false, error: '下载器还没准备好' };
    const r = await downloader.listShareTree((opts && opts.link) || '', (opts && opts.pwd) || '');
    if (!r.ok) return r;
    const sid = 'sh' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    shareSessions.set(sid, { session: r.session, title: r.title, files: r.files, at: Date.now() });
    // 会话只活 30 分钟：stoken 过期后再拿它取直链会 401
    for (const [k, v] of shareSessions) {
      if (Date.now() - v.at > 30 * 60 * 1000) shareSessions.delete(k);
    }
    return { ok: true, sessionId: sid, title: r.title, tree: r.tree, count: r.count };
  });
  handle('dl:startPicked', (_e, opts) => {
    if (!downloader) return { ok: false, error: '下载器还没准备好' };
    const s = shareSessions.get((opts && opts.sessionId) || '');
    if (!s) return { ok: false, error: '选择已过期，重新粘贴链接解析一次' };
    return downloader.startSharePicked({
      session: s.session,
      title: s.title,
      files: s.files,
      picks: (opts && opts.picks) || [],
      baseDir: (opts && opts.baseDir) || defaultBaseDir(),
    });
  });
  handle('dl:cancel', () => (downloader ? downloader.cancel() : false));
  handle('dl:openDest', (_e, dest) => {
    const dir = dest || defaultBaseDir();
    if (!fs.existsSync(dir)) return 'not found';
    return shell.openPath(dir);
  });
  handle('dl:useAsRoot', (_e, dest) => activateGuideRoot(dest));

  // ------------------------------------------------------------------
  // 网盘文件管理（v1.3.0）
  // ------------------------------------------------------------------

  /** 列一层目录。rel 由界面维护（从网盘根累积），文件带上完整 cloudRel 供索引与判定用 */
  handle('pan:ls', async (_e, payload) => {
    const { platform, fid = '0', rel = '' } = payload || {};
    const p = pan.PLATFORMS[platform];
    if (!p) return { ok: false, error: '未知平台' };
    const cookie = store.get().pan[platform + 'Cookie'] || '';
    if (!cookie) return { ok: false, error: `还没登录${p.label}网盘`, needLogin: true };
    try {
      const files = await pan.listCloud({ platform, cookie, fid: fid || '0' });
      const prefix = String(rel || '').replace(/^\/+|\/+$/g, '');
      const items = files.map((f) => ({
        fid: f.fid,
        name: f.name,
        size: Number(f.size || 0),
        dir: !!f.dir,
        mtime: Number(f.mtime || 0),
        // 目录不给 cloudRel：目录本身不下载，只用来往下钻
        cloudRel: f.dir ? '' : prefix ? `${prefix}/${f.name}` : f.name,
      }));
      return { ok: true, rel: prefix, items, count: items.length };
    } catch (e) {
      return { ok: false, error: e.message || '读取目录失败' };
    }
  });

  /**
   * 递归展开「整目录选中」的目录（v1.4.0）。
   *
   * 界面上的勾选只记 rel，不预先把几万个文件拉进内存 —— 真到要下载时才走这里。
   * 三道闸：最多 60 个目录、2 万个文件、深度 8。超过就截断并明确告诉用户，
   * 绝不静默少下（少下比报错更难排查）。
   */
  async function expandDirs(platform, cookie, dirs) {
    const out = [];
    const budget = { dirs: 0, maxDirs: 60, truncated: false, failed: 0 };
    const walk = async (fid, rel, depth) => {
      if (budget.dirs >= budget.maxDirs || out.length >= 20000 || depth > 8) {
        budget.truncated = true;
        return;
      }
      budget.dirs++;
      let files = [];
      try {
        files = await pan.listCloud({ platform, cookie, fid: fid || '0' });
      } catch (e) {
        budget.failed++;
        log.warn('pan', '展开目录失败', rel, e && e.message);
        return;
      }
      for (const f of files) {
        const childRel = rel ? `${rel}/${f.name}` : f.name;
        if (f.dir) {
          await walk(f.fid, childRel, depth + 1);
        } else {
          out.push({
            fid: f.fid,
            name: f.name,
            size: Number(f.size || 0),
            mtime: Number(f.mtime || 0),
            cloudRel: childRel,
          });
        }
      }
    };
    for (const d of dirs || []) {
      if (!d || !d.rel) continue;
      await walk(d.fid, d.rel, 0);
    }
    return { items: out, truncated: budget.truncated, dirs: budget.dirs, failed: budget.failed };
  }

  /** 合并「单文件勾选」与「整目录勾选」，同一相对路径只留一份 */
  async function collectItems(platform, payload) {
    const { items, dirs } = payload || {};
    const base = (items || []).filter((x) => x && x.cloudRel);
    if (!dirs || !dirs.length) return { items: base, expanded: 0, truncated: false, failed: 0 };
    const cookie = store.get().pan[platform + 'Cookie'] || '';
    const ex = await expandDirs(platform, cookie, dirs);
    const seen = new Set();
    const merged = [];
    for (const it of base.concat(ex.items)) {
      if (seen.has(it.cloudRel)) continue;
      seen.add(it.cloudRel);
      merged.push(it);
    }
    return { items: merged, expanded: ex.items.length, truncated: ex.truncated, failed: ex.failed, dirs: ex.dirs };
  }

  /** 预检：算出「几个跳过 / 几个新增 / 几个更新 / 要下多少字节」，不产生任何下载 */
  handle('pan:plan', async (_e, payload) => {
    if (!panQueue) return { ok: false, error: '下载器还没准备好' };
    const { platform } = payload || {};
    const dest = panDest(platform);
    if (!dest) return { ok: false, error: '先选一个保存目录' };
    try {
      // 整目录勾选要在这一步才真正展开：界面只存了 rel，没存几万个文件
      const merged = await collectItems(platform, payload);
      if (!merged.items.length) {
        return { ok: false, error: merged.failed ? '目录读取失败，换个目录再试' : '这些目录里没有可下载的文件' };
      }
      const r = await panQueue.dryRun({
        platform,
        dest,
        rootId: `${platform}|${dest}`,
        items: merged.items,
      });
      return {
        ...r,
        dest,
        itemCount: merged.items.length,
        expanded: merged.expanded,
        truncated: !!merged.truncated,
        dirFailed: merged.failed,
      };
    } catch (e) {
      log.error('pan', '预检失败', e);
      return { ok: false, error: e.message || '预检失败' };
    }
  });

  /** 入队。真正开下在队列里，这里立刻返回，界面切到队列面板 */
  handle('pan:start', async (_e, payload) => {
    if (!panQueue) return { ok: false, error: '下载器还没准备好' };
    const { platform } = payload || {};
    const dest = panDest(platform);
    if (!dest) return { ok: false, error: '先选一个保存目录' };
    try {
      const merged = await collectItems(platform, payload);
      if (!merged.items.length) return { ok: false, error: '没有选中任何文件' };
      const r = panQueue.enqueue({
        platform,
        title: `${pan.PLATFORMS[platform].label}网盘`,
        dest,
        rootId: `${platform}|${dest}`,
        items: merged.items,
      });
      return { ...r, dest, count: merged.items.length, truncated: !!merged.truncated };
    } catch (e) {
      log.error('pan', '入队失败', e);
      return { ok: false, error: e.message || '入队失败' };
    }
  });

  handle('pan:queueState', () => (panQueue ? panQueue.snapshot() : { tasks: [], activeId: 0 }));

  handle('pan:queueOp', (_e, payload) => {
    if (!panQueue) return { ok: false, error: '下载器还没准备好' };
    const { op, id } = payload || {};
    const n = Number(id) || 0;
    switch (op) {
      case 'pause':
        return { ok: panQueue.pause(n) };
      case 'resume':
        return { ok: panQueue.resume(n) };
      case 'cancel':
        return { ok: panQueue.cancel(n) };
      case 'retry':
        return { ok: panQueue.retry(n) };
      case 'remove':
        return { ok: panQueue.remove(n) };
      case 'clear':
        return { ok: true, removed: panQueue.clearFinished() };
      default:
        return { ok: false, error: '未知操作' };
    }
  });

  /** 保存目录：网盘下载独立于小抄目录，避免把几千个文件塞进小抄根 */
  handle('pan:dest', () => ({ ok: true, dest: panBase(), root: panDest('quark') }));
  handle('pan:pickDest', async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, {
      title: '网盘文件保存到哪儿',
      defaultPath: panBase(),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '就放这里',
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    store.patch({ download: { panBase: r.filePaths[0] } });
    broadcast();
    return { ok: true, dest: r.filePaths[0] };
  });
  handle('pan:openDest', (_e, platform) => {
    const dir = panDest(platform);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* 让 openPath 报错 */
    }
    return shell.openPath(dir);
  });
  handle('pan:indexStats', (_e, platform) => {
    if (!panIndex) return { ok: false };
    const dest = panDest(platform);
    return { ok: true, stats: panIndex.stats(`${platform}|${dest}`), dest };
  });

  // 拖动 / 缩放（自己算，不依赖 CSS drag region，避免吞掉按钮点击）
  let dragState = null;
  ipcMain.on('guide:dragStart', (_e, p) => {
    if (!guideWindow || guideWindow.isDestroyed()) return;
    dragState = { kind: 'move', sx: p.screenX, sy: p.screenY, bounds: guideWindow.getBounds() };
  });
  ipcMain.on('guide:dragMove', (_e, p) => {
    if (!dragState || dragState.kind !== 'move' || !guideWindow || guideWindow.isDestroyed()) return;
    const dx = p.screenX - dragState.sx;
    const dy = p.screenY - dragState.sy;
    guideWindow.setBounds({
      x: Math.round(dragState.bounds.x + dx),
      y: Math.round(dragState.bounds.y + dy),
      width: dragState.bounds.width,
      height: dragState.bounds.height,
    });
  });
  ipcMain.on('guide:dragEnd', () => {
    if (guideWindow && !guideWindow.isDestroyed()) {
      const b = guideWindow.getBounds();
      store.patch({ guide: { x: b.x, y: b.y } });
    }
    dragState = null;
  });

  let resizeState = null;
  ipcMain.on('guide:resizeStart', (_e, p) => {
    if (!guideWindow || guideWindow.isDestroyed()) return;
    resizeState = { sx: p.screenX, sy: p.screenY, bounds: guideWindow.getBounds() };
  });
  ipcMain.on('guide:resizeMove', (_e, p) => {
    if (!resizeState || !guideWindow || guideWindow.isDestroyed()) return;
    const b = resizeState.bounds;
    const w = Math.max(300, Math.min(900, Math.round(b.width + (p.screenX - resizeState.sx))));
    const h = Math.max(260, Math.min(screen.getPrimaryDisplay().workArea.height - 40, Math.round(b.height + (p.screenY - resizeState.sy))));
    guideWindow.setBounds({ x: b.x, y: b.y, width: w, height: h });
    sendTo(guideWindow, 'guide:size', { width: w, height: h });
  });
  ipcMain.on('guide:resizeEnd', () => {
    if (guideWindow && !guideWindow.isDestroyed()) {
      const b = guideWindow.getBounds();
      try {
        guideWindow.webContents.setZoomFactor(1);
      } catch {
        /* 忽略 */
      }
      store.patch({ guide: { x: b.x, y: b.y, w: b.width, h: b.height, scale: 1 } });
      broadcast();
    }
    resizeState = null;
  });

  // 准星
  handle('crosshair:setVisible', (_e, v) => {
    setCrosshairVisible(!!v);
    return !!(crosshairWindow && crosshairWindow.isVisible());
  });
  handle('crosshair:list', () => {
    const cfg = store.get();
    const profiles = cfg.crosshair.profiles.map((p) => {
      let imageUrl = '';
      if (p.image && fs.existsSync(p.image)) {
        allowedMedia.add(path.resolve(p.image));
        imageUrl = mediaUrl(p.image);
      }
      return { ...p, imageUrl };
    });
    return { profiles, activeId: cfg.crosshair.activeId };
  });
  handle('crosshair:new', () => {
    const cfg = store.get();
    const list = cfg.crosshair.profiles.slice();
    if (list.length >= 24) return { ok: false, error: '最多 24 套，先删一套再新建' };
    const used = new Set(list.map((p) => p.name));
    let n = list.length + 1;
    while (used.has('准星 ' + n)) n++;
    const p = {
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: '准星 ' + n,
      image: '',
      ax: 0.5,
      ay: 0.5,
      width: 220,
      alpha: 1,
      lines: true,
      x: null,
      y: null,
    };
    list.push(p);
    store.set('crosshair', { ...cfg.crosshair, profiles: list, activeId: p.id });
    refreshCrosshairContent();
    return { ok: true, profile: p };
  });
  handle('crosshair:select', (_e, id) => {
    const cfg = store.get();
    if (!cfg.crosshair.profiles.some((p) => p.id === id)) return { ok: false };
    store.patch({ crosshair: { activeId: id } });
    refreshCrosshairContent();
    return { ok: true };
  });
  handle('crosshair:rename', (_e, id, name) => {
    const cfg = store.get();
    const clean = String(name || '').trim().slice(0, 24);
    if (!clean) return { ok: false };
    const list = cfg.crosshair.profiles.map((p) => (p.id === id ? { ...p, name: clean } : p));
    store.set('crosshair', { ...cfg.crosshair, profiles: list });
    broadcast();
    return { ok: true };
  });
  handle('crosshair:delete', (_e, id) => {
    const cfg = store.get();
    let list = cfg.crosshair.profiles.filter((p) => p.id !== id);
    if (!list.length) return { ok: false, error: '至少要留一套' };
    let activeId = cfg.crosshair.activeId;
    if (!list.some((p) => p.id === activeId)) activeId = list[0].id;
    store.set('crosshair', { ...cfg.crosshair, profiles: list, activeId });
    refreshCrosshairContent();
    return { ok: true };
  });
  handle('crosshair:pickImage', async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, {
      title: '选一张准星图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
      buttonLabel: '导入',
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    const src = r.filePaths[0];
    const dir = userFile('crosshair');
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(src).toLowerCase() || '.png';
    const dest = path.join(dir, 'crosshair-' + Date.now() + ext);
    try {
      fs.copyFileSync(src, dest);
    } catch (e) {
      return { ok: false, error: '复制失败：' + e.message };
    }
    crosshairSizeCache.delete(dest);
    const cfg = store.get();
    const p = activeProfile(cfg);
    if (!p) return { ok: false };
    // 宽高比例变了，先按锚点重算尺寸再落配置
    const list = cfg.crosshair.profiles.map((it) => (it.id === p.id ? { ...it, image: dest } : it));
    store.set('crosshair', { ...cfg.crosshair, profiles: list });
    refreshCrosshairContent();
    return { ok: true, path: dest };
  });
  handle('crosshair:clearImage', () => {
    const cfg = store.get();
    const p = activeProfile(cfg);
    if (!p) return { ok: false };
    const list = cfg.crosshair.profiles.map((it) => (it.id === p.id ? { ...it, image: '' } : it));
    store.set('crosshair', { ...cfg.crosshair, profiles: list });
    refreshCrosshairContent();
    return { ok: true };
  });
  handle('crosshair:update', (_e, patch) => {
    const cfg = store.get();
    const p = activeProfile(cfg);
    if (!p) return { ok: false };
    const next = { ...p };
    if (typeof patch.ax === 'number') next.ax = Math.max(0, Math.min(1, patch.ax));
    if (typeof patch.ay === 'number') next.ay = Math.max(0, Math.min(1, patch.ay));
    if (typeof patch.width === 'number') next.width = Math.max(32, Math.min(900, Math.round(patch.width)));
    if (typeof patch.alpha === 'number') next.alpha = Math.max(0.15, Math.min(1, patch.alpha));
    if (typeof patch.lines === 'boolean') next.lines = patch.lines;
    const list = cfg.crosshair.profiles.map((it) => (it.id === p.id ? next : it));
    store.set('crosshair', { ...cfg.crosshair, profiles: list });
    if (crosshairWindow && !crosshairWindow.isDestroyed()) {
      applyCrosshairGeometry(true);
      sendTo(crosshairWindow, 'crosshair:profile', crosshairPayload());
    }
    broadcast();
    return { ok: true, profile: next };
  });
  handle('crosshair:center', () => {
    if (!crosshairWindow || crosshairWindow.isDestroyed()) return { ok: false };
    const profile = activeProfile();
    const size = crosshairBoundsFor(profile);
    const b = crosshairCenter(profile, size);
    crosshairWindow.setBounds(b);
    persistCrosshairPos(b.x, b.y);
    broadcast();
    return { ok: true };
  });
  handle('crosshair:setAdjust', (_e, on) => {
    store.patch({ crosshair: { adjust: !!on } });
    if (crosshairWindow && !crosshairWindow.isDestroyed()) {
      // v1.2.1：不切 focusable。窗口在 Windows 上一旦被设成不可聚焦，
      // 再设回来有概率收不到输入，表现为「调整准星时拖不动」。只切鼠标穿透就够。
      crosshairWindow.setIgnoreMouseEvents(!on, { forward: true });
      if (on) crosshairWindow.show();
      sendTo(crosshairWindow, 'crosshair:profile', crosshairPayload());
    }
    broadcast();
    return !!on;
  });
  handle('crosshair:setLocked', (_e, v) => {
    store.patch({ crosshair: { locked: !!v } });
    broadcast();
    return !!v;
  });
  handle('crosshair:dragEnd', () => {
    if (crosshairWindow && !crosshairWindow.isDestroyed()) {
      const b = crosshairWindow.getBounds();
      persistCrosshairPos(b.x, b.y);
      broadcast();
    }
    crosshairDrag = null;
  });
  ipcMain.on('crosshair:dragStart', (_e, p) => {
    if (!crosshairWindow || crosshairWindow.isDestroyed()) return;
    crosshairDrag = { sx: p.screenX, sy: p.screenY, bounds: crosshairWindow.getBounds() };
  });
  ipcMain.on('crosshair:dragMove', (_e, p) => {
    if (!crosshairDrag || !crosshairWindow || crosshairWindow.isDestroyed()) return;
    const b = crosshairDrag.bounds;
    crosshairWindow.setBounds({
      x: Math.round(b.x + (p.screenX - crosshairDrag.sx)),
      y: Math.round(b.y + (p.screenY - crosshairDrag.sy)),
      width: b.width,
      height: b.height,
    });
  });

  // 开屏
  handle('splash:pick', async (_e, kind) => {
    const isVideo = Number(kind) === 1;
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, {
      title: isVideo ? '选一段开屏视频（建议 3–8 秒）' : '选一张开屏图片',
      properties: ['openFile'],
      filters: isVideo
        ? [{ name: '视频', extensions: ['mp4', 'webm', 'mov', 'm4v'] }]
        : [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
      buttonLabel: '用它',
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    const src = r.filePaths[0];
    const st = fs.statSync(src);
    const limit = isVideo ? 80 * 1024 * 1024 : 20 * 1024 * 1024;
    if (st.size > limit) {
      return { ok: false, error: isVideo ? '视频超过 80MB，换个小一点的' : '图片超过 20MB，先压一下' };
    }
    const dir = userFile('splash');
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(src).toLowerCase();
    const dest = path.join(dir, 'splash-' + Date.now() + ext);
    try {
      fs.copyFileSync(src, dest);
    } catch (e) {
      return { ok: false, error: '复制失败：' + e.message };
    }
    allowedMedia.add(path.resolve(dest));
    store.patch({ splash: { path: dest, name: path.basename(src), kind: isVideo ? 1 : 0 } });
    broadcast();
    return { ok: true, path: dest, name: path.basename(src), url: mediaUrl(dest) };
  });
  handle('splash:clear', () => {
    store.patch({ splash: { path: '', name: '' } });
    broadcast();
    return { ok: true };
  });
  handle('splash:url', () => {
    const p = store.get().splash.path;
    if (!p || !fs.existsSync(p)) return '';
    allowedMedia.add(path.resolve(p));
    return mediaUrl(p);
  });
  handle('splash:done', () => true);

  // 快捷键
  handle('hotkey:set', (_e, key, accel) => {
    const cfg = store.get();
    if (!(key in cfg.hotkeys)) return { ok: false };
    store.patch({ hotkeys: { [key]: String(accel || '') } });
    const res = registerHotkeys();
    return { ok: res[key] === 'ok', result: res[key] };
  });
  handle('hotkey:results', () => lastHotkeyResult);

  // 主题 / 动画改动后广播即可，渲染进程自己读 cfg
  handle('ui:replayEntrance', () => {
    sendTo(mainWindow, 'ui:replay', {});
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  store = new Store();

  // v1.4.0 配置迁移：旧版默认热键是 Alt+Q，新版按需求改成 Alt+X / Alt+Z。
  // 只在 version < 2 时动一次，用户自己改过的键位不会被反复覆盖。
  if (Number(store.get().version) < 2) {
    try {
      store.patch({ version: 2, hotkeys: { toggleGuide: 'Alt+X', toggleOrbs: 'Alt+Z' } });
      log.info('cfg', '已迁移到 v1.4.0 默认热键');
    } catch (e) {
      log.warn('cfg', '热键迁移失败', e && e.message);
    }
  }
  guideLib.init({ thumbDir: userFile('thumbs') });
  let lastDlStatus = '';
  let lastQueueNote = '';
  downloader = new Downloader({
    getCookie: (platform) => store.get().pan[platform + 'Cookie'] || '',
    onCookie: (platform, cookie) => store.patch({ pan: { [platform + 'Cookie']: cookie } }),
    onState: (s) => {
      sendTo(mainWindow, 'download:state', s);
      // 用户多半在下之前就去开游戏了，下完得能收到信儿
      if (s.status !== lastDlStatus) {
        if (s.status === 'done') notify('小抄下载完成', `${s.done} 张已存到 ${s.dest}`);
        else if (s.status === 'error') notify('小抄下载失败', s.message || '看看主界面');
        lastDlStatus = s.status;
      }
    },
  });
  // v1.3.0：网盘下载索引 + 队列
  // 索引是「防重复下载」的唯一依据，必须早于任何一次下载初始化
  panIndex = new JsonIndex(path.join(app.getPath('userData'), 'pan-index.json')).open();
  panQueue = new DownloadQueue({
    index: panIndex,
    getCookie: (platform) => store.get().pan[platform + 'Cookie'] || '',
    onCookie: (platform, cookie) => store.patch({ pan: { [platform + 'Cookie']: cookie } }),
    onChange: (snap) => {
      sendTo(mainWindow, 'pan:queue', snap);
      const t = snap.tasks.find((x) => x.id === snap.activeId);
      if (t && (t.status === 'done' || t.status === 'error') && lastQueueNote !== t.id + ':' + t.status) {
        lastQueueNote = t.id + ':' + t.status;
        if (t.status === 'done') notify('网盘下载完成', `${t.done} 个新文件，跳过 ${t.skipped} 个已有`);
        else if (t.failed > 0) notify('网盘下载有失败', `${t.failed} 个文件没下成，队列里可以重试`);
      }
    },
  });

  registerProtocols();
  setupIpc();
  createMainWindow();
  createTray();

  // ---- 悬浮球（v1.4.0）----
  orbManager = new OrbManager({
    store,
    guideLib,
    getRoot: () => store.get().guide.root,
    onOpen: (rel) => openGuideAt(rel),
    onChanged: () => broadcast(),
    preloadPath: preloadPath(),
    pagePath: pagePath('orb/index.html'),
  });
  orbManager.registerIpc();
  orbManager.visible = store.get().orbs.visible !== false;
  ui.b = orbManager.visible ? 'shown' : 'hidden';
  try {
    if (!store.get().orbs.list.length && store.get().guide.root) {
      // 首次启动先放一个球：用户不用先翻设置才知道有这功能
      orbManager.add(store.get().guide.lastCategory || '');
    } else {
      orbManager.sync();
    }
  } catch (e) {
    log.error('orb', '初始化悬浮球失败', e);
  }
  startUiWatch();

  registerHotkeys();

  // 上次退出时小抄/准星是开着的，就直接挂回去（和 Android 冷启动恢复一致）
  // 和手机版一致：永远至少有一套准星，进来就能直接导图
  ensureDefaultProfile();

  const cfg = store.get();
  // v1.2.0：游戏模式默认开，进程一起来就把置顶看门狗挂上
  if (cfg.guide.forceTop) startTopWatch();
  // v1.2.1：上次如果是「锁定穿透」状态下被杀进程，这里必须清掉。
  // 否则一启动就是穿透态，用户看到窗口却点不动，只能猜是不是坏了。
  // 注意：此时小抄窗口还没被创建（600ms 后才 setGuideVisible），
  // 所以用 clearLockedIfNotReallyLocked —— 窗口不存在时不会误判，
  // 真正需要清的情况是「配置里还残留 locked=true」。
  if (cfg.guide.locked && !cfg.guide.enabled) store.patch({ guide: { locked: false, ball: false } });
  if (cfg.guide.enabled) setTimeout(() => setGuideVisible(true, { write: false }), 600);

  // 缩略图缓存按「最近用过」留 5000 张 / 512MB，别让 C 盘越用越满
  setTimeout(() => guideLib.pruneThumbs(), 8000);
  // 先把首屏要用的缩略图生成好，下次打开悬浮窗直接读盘
  if (cfg.guide.root) setTimeout(() => guideLib.warmup(cfg.guide.root), 2500);
  if (cfg.crosshair.enabled && (cfg.crosshair.profiles || []).length) {
    setTimeout(() => setCrosshairVisible(true), 800);
  }
  if (cfg.crosshair.profiles && cfg.crosshair.profiles.length) {
    for (const p of cfg.crosshair.profiles) {
      if (p.image) allowedMedia.add(path.resolve(p.image));
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else showMain();
  });
});

app.on('before-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  saveMainBounds();
  // 索引是「下次别再下一遍」的依据，退出前必须落盘，不能攒在内存里
  if (panIndex) panIndex.close().catch(() => {});
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// 托盘常驻：关掉主界面不退出进程
app.on('window-all-closed', () => {
  if (!tray) app.quit();
});
