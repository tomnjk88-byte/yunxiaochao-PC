'use strict';

/**
 * 多悬浮球（v1.4.0）
 *
 * 为什么每个球一个独立的 BrowserWindow，而不是一个铺满屏幕的透明层：
 *   透明层要能点到球，就得整层接收鼠标；但整层接收鼠标 = 盖住游戏。
 *   靠 setIgnoreMouseEvents(true, {forward:true}) + 动态切换在 Windows 上会闪，
 *   而且 forward 只转发 mousemove，点击仍有丢失。独立小窗最稳：
 *   窗口 66×66 只覆盖球本身，其余区域天然不拦截。
 *
 * 上限 3 个：每个无边框透明窗都是一层 DWM 合成，超过 3 个在低端机上开始掉帧，
 * 而实际使用场景也就是「当前在打的那张图 + 备用两张」。
 */

const { BrowserWindow, Menu, dialog, screen, ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');

const { log } = require('./log');
const olog = log.scope('orb');

const MAX_ORBS = 3;
const BASE = 80; // 窗口边长：球体 54 + 描边与投影留白
const IS_WIN = process.platform === 'win32';

function clampToWorkArea(x, y, w = BASE, h = BASE) {
  let disp;
  try {
    disp = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  } catch {
    disp = screen.getPrimaryDisplay();
  }
  const wa = disp.workArea;
  return {
    x: Math.min(Math.max(Math.round(x), wa.x), wa.x + wa.width - w),
    y: Math.min(Math.max(Math.round(y), wa.y), wa.y + wa.height - h),
    width: w,
    height: h,
  };
}

class OrbManager {
  /**
   * @param {object} deps
   * @param {object} deps.store      配置仓库
   * @param {() => string} deps.getRoot  攻略根目录
   * @param {(rel:string) => void} deps.onOpen 点球要打开哪个目录
   * @param {() => void} deps.onChanged  配置变了通知界面刷新
   * @param {string} deps.preloadPath
   * @param {string} deps.pagePath
   */
  constructor(deps) {
    this.store = deps.store;
    this.guideLib = deps.guideLib;
    this.getRoot = deps.getRoot;
    this.onOpen = deps.onOpen || (() => {});
    this.onChanged = deps.onChanged || (() => {});
    this.preloadPath = deps.preloadPath;
    this.pagePath = deps.pagePath;
    /** @type {Map<string, BrowserWindow>} */
    this.wins = new Map();
    this.visible = true;
    this.drag = null;
    this.seq = 0;
  }

  /** 给置顶看门狗用：球也是置顶窗，也一样会被游戏/输入法挤下去 */
  windows() {
    return Array.from(this.wins.values()).filter((w) => w && !w.isDestroyed());
  }

  list() {
    const cfg = this.store.get().orbs;
    return (cfg && Array.isArray(cfg.list)) ? cfg.list : [];
  }

  isVisible() {
    return this.visible;
  }

  /** 配置 → 窗口。多退少补，位置变了也顺手同步 */
  sync() {
    const list = this.list().slice(0, MAX_ORBS);
    const alive = new Set(list.map((o) => o.id));

    for (const [id, win] of this.wins) {
      if (!alive.has(id)) {
        try {
          win.destroy();
        } catch {
          /* 已销毁 */
        }
        this.wins.delete(id);
      }
    }

    for (const orb of list) {
      let win = this.wins.get(orb.id);
      if (!win || win.isDestroyed()) {
        win = this.createWindow(orb);
        this.wins.set(orb.id, win);
      }
      this.applyBounds(orb.id, orb);
      this.pushState(orb.id);
    }

    this.applyVisible();
    return this.wins.size;
  }

  createWindow(orb) {
    const b = this.boundsOf(orb);
    const win = new BrowserWindow({
      ...b,
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
      // 必须 true：false 在 Windows 上会走 WS_EX_NOACTIVATE，
      // Chromium 不投递鼠标消息，球看得见但点不动（v1.2.1 踩过同一个坑）
      focusable: true,
      title: '小抄悬浮球',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    if (IS_WIN) {
      try {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      } catch {
        /* 老系统不支持就算了 */
      }
    }

    // 记住归属，诊断时能反查「这个窗口是哪个球」
    win.__orbId = orb.id;
    win.loadFile(this.pagePath, { query: { id: orb.id } });

    win.on('closed', () => {
      this.wins.delete(orb.id);
    });

    // 拖出屏幕外就再也抓不回来了 —— 每次移动结束都把落点夹回工作区
    win.on('moved', () => {
      if (this.drag && this.drag.id === orb.id) return;
      const bb = win.getBounds();
      const c = clampToWorkArea(bb.x, bb.y);
      if (c.x !== bb.x || c.y !== bb.y) win.setBounds(c);
      this.savePos(orb.id, c.x, c.y);
    });

    return win;
  }

  boundsOf(orb) {
    const cfg = this.store.get().orbs || {};
    if (typeof orb.x === 'number' && typeof orb.y === 'number') {
      return clampToWorkArea(orb.x, orb.y);
    }
    // 第一次出现：从右下角往左上排，避开默认在右上角的小抄窗
    const wa = screen.getPrimaryDisplay().workArea;
    const idx = Math.max(0, this.list().findIndex((o) => o.id === orb.id));
    const x = wa.x + wa.width - BASE - 24;
    const y = wa.y + wa.height - BASE - 24 - idx * (BASE + 10);
    return clampToWorkArea(x, y);
  }

  applyBounds(id, orb) {
    const win = this.wins.get(id);
    if (!win || win.isDestroyed()) return;
    const b = this.boundsOf(orb);
    const cur = win.getBounds();
    if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) {
      win.setBounds(b);
    }
  }

  savePos(id, x, y) {
    const list = this.list().map((o) => (o.id === id ? { ...o, x, y } : o));
    this.store.patch({ orbs: { list } });
  }

  /** 把球该显示什么推给渲染层：名字、封面、计数、缩放 */
  pushState(id) {
    const win = this.wins.get(id);
    if (!win || win.isDestroyed()) return;
    const orb = this.list().find((o) => o.id === id);
    if (!orb) return;
    const meta = this.metaOf(orb);
    this.send(win, 'orb:state', { orb, cover: meta.cover, count: meta.count, visible: this.visible });
  }

  metaOf(orb) {
    try {
      const r = this.guideLib.listDir(this.getRoot(), orb.rel || '');
      if (!r || !r.ok) return { cover: '', count: 0 };
      const first = (r.images || [])[0];
      if (first) return { cover: first.rel, count: (r.images || []).length };
      const f = (r.folders || [])[0];
      if (f && f.cover) return { cover: f.cover, count: 0 };
    } catch (e) {
      // 目录被删、权限没了都正常，球退化成空态即可，绝不能因此崩
      olog.warn('取封面失败', orb && orb.rel, e && e.message);
    }
    return { cover: '', count: 0 };
  }

  send(win, channel, payload) {
    try {
      win.webContents.send(channel, payload);
    } catch {
      /* 窗口正在销毁 */
    }
  }

  pushAll() {
    for (const id of this.wins.keys()) this.pushState(id);
  }

  applyVisible() {
    for (const win of this.wins.values()) {
      if (!win || win.isDestroyed()) continue;
      if (this.visible) {
        // showInactive：不抢游戏焦点。球只是「点一下看攻略」，没必要激活整个程序
        win.showInactive();
        win.setAlwaysOnTop(true, 'screen-saver');
      } else {
        win.hide();
      }
    }
  }

  setVisible(v) {
    this.visible = !!v;
    this.applyVisible();
    this.pushAll();
    return this.visible;
  }

  toggleVisible() {
    return this.setVisible(!this.visible);
  }

  /** 新增一个球。超过上限返回 { ok:false }，界面据此提示而不是静默失败 */
  add(rel) {
    const cur = this.list();
    if (cur.length >= MAX_ORBS) {
      return { ok: false, error: `最多 ${MAX_ORBS} 个悬浮球（每个都是独立透明窗口，再多会掉帧）` };
    }
    const id = 'o' + Date.now().toString(36) + (++this.seq);
    const root = this.getRoot();
    let target = rel;
    if (target == null) {
      // 默认绑到第一个分类，没有分类就绑根目录
      target = '';
      try {
        const r = this.guideLib.listDir(root, '');
        if (r && r.ok && r.folders && r.folders.length) target = r.folders[0].rel;
      } catch {
        /* 用根目录 */
      }
    }
    const label = target ? path.posix.basename(target) : '小抄';
    const list = cur.concat([{ id, label, rel: target, x: null, y: null, scale: 1, alpha: 1 }]);
    this.store.patch({ orbs: { list } });
    this.sync();
    this.onChanged();
    olog.info('新增悬浮球', id, target);
    return { ok: true, id, rel: target };
  }

  update(id, patch) {
    const list = this.list().map((o) => (o.id === id ? { ...o, ...patch } : o));
    this.store.patch({ orbs: { list } });
    const orb = list.find((o) => o.id === id);
    if (orb) this.applyBounds(id, orb);
    this.pushState(id);
    this.onChanged();
    return { ok: true };
  }

  /** 换绑：rel 为空表示绑到攻略根目录 */
  bind(id, rel) {
    const list = this.list().map((o) =>
      o.id === id ? { ...o, rel: rel || '', label: rel ? path.posix.basename(rel) : '小抄' } : o
    );
    this.store.patch({ orbs: { list } });
    this.pushState(id);
    this.onChanged();
    olog.info('换绑悬浮球', id, '→', rel);
    return { ok: true };
  }

  remove(id) {
    const list = this.list().filter((o) => o.id !== id);
    this.store.patch({ orbs: { list } });
    const win = this.wins.get(id);
    if (win && !win.isDestroyed()) win.destroy();
    this.wins.delete(id);
    this.onChanged();
    return { ok: true, left: list.length };
  }

  setScale(id, scale) {
    const s = Math.max(0.72, Math.min(1.5, Number(scale) || 1));
    return this.update(id, { scale: s });
  }

  destroyAll() {
    for (const win of this.wins.values()) {
      try {
        win.destroy();
      } catch {
        /* ignore */
      }
    }
    this.wins.clear();
  }

  // ------------------------------------------------------------------
  // 右键菜单
  // ------------------------------------------------------------------

  buildMenu(id) {
    const orb = this.list().find((o) => o.id === id);
    if (!orb) return null;
    const root = this.getRoot();

    // 换绑子菜单：列出攻略根下的分类目录，当前项打勾
    const subs = [];
    try {
      const r = this.guideLib.listDir(root, '');
      if (r && r.ok) {
        for (const f of (r.folders || []).slice(0, 24)) {
          subs.push({
            label: f.name + (f.count ? `  (${f.count})` : ''),
            type: 'checkbox',
            checked: orb.rel === f.rel,
            click: () => this.bind(id, f.rel),
          });
        }
      }
    } catch (e) {
      olog.warn('读分类失败', e && e.message);
    }
    if (!subs.length) subs.push({ label: '（攻略目录里还没有分类文件夹）', enabled: false });
    subs.push({ type: 'separator' });
    subs.push({ label: '绑到小抄根目录', type: 'checkbox', checked: !orb.rel, click: () => this.bind(id, '') });
    subs.push({
      label: '选其它文件夹…',
      click: async () => {
        const r = await dialog.showOpenDialog({ title: '这个球显示哪个文件夹', properties: ['openDirectory'] });
        if (r.canceled || !r.filePaths[0]) return;
        const abs = r.filePaths[0];
        const rootAbs = path.resolve(root || '');
        const relPath = path.relative(rootAbs, path.resolve(abs));
        if (!root || relPath.startsWith('..') || path.isAbsolute(relPath)) {
          // 允许绑外部目录，但要明确告诉用户「这不在攻略目录里，换分类不会影响它」
          dialog.showMessageBox({
            type: 'info',
            message: '这个文件夹不在小抄目录里',
            detail: '已经直接绑到它了。注意：它不会出现在「设置 → 攻略目录」的分类里，但点球照样能看图。',
            buttons: ['知道了'],
          });
          this.bind(id, abs);
          return;
        }
        this.bind(id, relPath.split(path.sep).join('/'));
      },
    });

    return Menu.buildFromTemplate([
      { label: orb.label || '悬浮球', enabled: false },
      { type: 'separator' },
      { label: '换绑到', submenu: subs },
      {
        label: '大小',
        submenu: [
          { label: '小', type: 'radio', checked: Math.abs((orb.scale || 1) - 0.8) < 0.05, click: () => this.setScale(id, 0.8) },
          { label: '中', type: 'radio', checked: Math.abs((orb.scale || 1) - 1) < 0.05, click: () => this.setScale(id, 1) },
          { label: '大', type: 'radio', checked: Math.abs((orb.scale || 1) - 1.25) < 0.05, click: () => this.setScale(id, 1.25) },
        ],
      },
      {
        label: '重命名…',
        click: () => {
          // Electron 没有原生输入框，用一个小窗口太重；直接让用户在设置页改
          this.onChanged();
          app.focus({ steal: true });
        },
      },
      { type: 'separator' },
      { label: '再放一个悬浮球', enabled: this.list().length < MAX_ORBS, click: () => this.add() },
      { label: '删除这个悬浮球', click: () => this.remove(id) },
      { type: 'separator' },
      { label: `隐藏所有悬浮球（${this.store.get().hotkeys.toggleOrbs || 'Alt+Z'}）`, click: () => this.setVisible(false) },
    ]);
  }

  // ------------------------------------------------------------------
  // IPC
  // ------------------------------------------------------------------

  registerIpc() {
    ipcMain.on('orb:context', (e, id) => {
      const win = this.wins.get(id) || BrowserWindow.fromWebContents(e.sender);
      const menu = this.buildMenu(id);
      if (menu && win && !win.isDestroyed()) menu.popup({ window: win });
    });

    ipcMain.on('orb:click', (_e, id) => {
      const orb = this.list().find((o) => o.id === id);
      if (!orb) return;
      try {
        this.onOpen(orb.rel || '');
      } catch (e) {
        olog.error('打开悬浮球失败', e);
      }
    });

    ipcMain.on('orb:dragStart', (_e, p) => {
      const win = this.wins.get(p && p.id);
      if (!win || win.isDestroyed()) return;
      this.drag = { id: p.id, sx: p.screenX, sy: p.screenY, bounds: win.getBounds() };
    });

    ipcMain.on('orb:dragMove', (_e, p) => {
      if (!this.drag || this.drag.id !== (p && p.id)) return;
      const win = this.wins.get(p.id);
      if (!win || win.isDestroyed()) return;
      win.setBounds({
        x: Math.round(this.drag.bounds.x + (p.screenX - this.drag.sx)),
        y: Math.round(this.drag.bounds.y + (p.screenY - this.drag.sy)),
        width: this.drag.bounds.width,
        height: this.drag.bounds.height,
      });
    });

    ipcMain.on('orb:dragEnd', (_e, id) => {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      const win = this.wins.get(id || d.id);
      if (!win || win.isDestroyed()) return;
      // 拖到屏幕外也夹回来，不然球就永久消失了
      const b = win.getBounds();
      const c = clampToWorkArea(b.x, b.y);
      win.setBounds(c);
      this.savePos(id || d.id, c.x, c.y);
    });

    ipcMain.on('orb:ready', (_e, id) => {
      this.pushState(id);
    });

    // 拖拽时球要跟手，但每帧都写 config 会疯狂刷盘 —— 只在 dragEnd 落一次
    ipcMain.on('orb:wheel', (_e, p) => {
      if (!p || !p.id) return;
      const orb = this.list().find((o) => o.id === p.id);
      if (!orb) return;
      const next = (orb.scale || 1) + (p.delta > 0 ? -0.06 : 0.06);
      this.setScale(p.id, Math.round(next * 100) / 100);
    });
  }
}

module.exports = { OrbManager, MAX_ORBS, clampToWorkArea };
