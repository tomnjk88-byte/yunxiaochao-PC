/*
 * 云小抄 PC（YunX Guide Overlay · Desktop）
 * 基于 云析 YunX（https://github.com/CYQawa/YunX）与 云小抄（Android）二次开发。
 * Copyright (C) 2026 CYQawa（原项目作者）
 *
 * 本文件是 AGPL-3.0 衍生作品，完整协议见项目根目录 LICENSE。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * 配置只存一个 JSON。
 *
 * 为什么不学 Android 拆一堆 SharedPreferences：桌面上没有「进程被杀 / 分屏重建」
 * 那套，单文件更好备份、更好排查，用户把 config.json 拷走就是整套设置。
 */
const DEFAULTS = {
  version: 2,
  window: { x: null, y: null, w: 1180, h: 800, maximized: false },
  ui: { theme: 'dark', accent: 'violet' },
  guide: {
    enabled: false,
    x: null,
    y: null,
    w: 400,
    h: 640,
    alpha: 1,
    locked: false,
    // v1.2.0：游戏模式。开启后主进程每 800ms 把窗口顶回最上层 ——
    // 专治「游戏 / 录屏 / 输入法把攻略盖住」。
    // v1.2.1：只做置顶，不再动 focusable（那会让窗口在 Windows 上点不动）。
    forceTop: true,
    root: '',
    columns: 2,
    ball: false,
    lastCategory: '',
    // v1.5.0：地图覆盖模式。小抄贴在地图上，半透明 + 智能穿透，
    // 并支持以锚点为中心的等比缩放（Alt+Shift+滚轮）。
    // 注意：这里只是「交互形态」，真正的自动跟随即需要标定，见 main.js。
    mapMode: false,
    scale: 1,
    anchorX: null,
    anchorY: null,
  },
  crosshair: {
    enabled: false,
    activeId: '',
    locked: true,
    adjust: false,
    profiles: [],
  },
  motion: { enabled: true, speed: 1, entrance: 0, switchStyle: 1 },
  splash: { enabled: true, kind: 0, path: '', name: '', hold: 1 },
  // 网盘登录态只存 Cookie；账号密码在官方网页里输，本地不落任何凭据
  pan: { quarkCookie: '', ucCookie: '' },
  download: { baseDir: '', panBase: '' },
  // v1.4.0：热键 A/B 按需求改成 Alt+X / Alt+Z
  hotkeys: {
    toggleGuide: 'Alt+X',
    toggleOrbs: 'Alt+Z',
    toggleCrosshair: 'Alt+E',
    hideAll: 'Alt+H',
    nextCrosshair: 'Alt+R',
  },

  // 悬浮球（v1.4.0）。上限 3 个，每个是一个独立的透明置顶小窗。
  orbs: {
    visible: true,
    list: [],
  },

  // 内置教程是否已读过（首次打开设置时自动展开）
  tutorial: { seen: false },
};

/** 深度合并，只认 DEFAULTS 里存在的键 —— 手改坏的 config 不会带进来奇怪字段 */
function merge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  for (const key of Object.keys(base)) {
    if (!(key in patch)) continue;
    const b = base[key];
    const p = patch[key];
    if (b && typeof b === 'object' && !Array.isArray(b)) out[key] = merge(b, p);
    else if (Array.isArray(b)) out[key] = Array.isArray(p) ? p : b;
    else if (typeof p === typeof b) out[key] = p;
    else if (b === null) out[key] = p;
  }
  return out;
}

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'config.json');
    this.data = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return merge(DEFAULTS, JSON.parse(raw));
    } catch {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  get() {
    return this.data;
  }

  /** 局部更新：merge 到当前数据，落盘，返回最新全量 */
  patch(partial) {
    this.data = merge(this.data, partial);
    this._save();
    return this.data;
  }

  /** 直接覆盖某一棵子树（准星列表这类数组需要整体替换） */
  set(section, value) {
    if (!(section in DEFAULTS)) return this.data;
    if (DEFAULTS[section] && typeof DEFAULTS[section] === 'object' && !Array.isArray(DEFAULTS[section])) {
      this.data[section] = merge(DEFAULTS[section], value);
    } else {
      this.data[section] = value;
    }
    this._save();
    return this.data;
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store] 写入失败', e);
    }
  }
}

module.exports = { Store, DEFAULTS };
