/*
 * 云小抄 PC · 预加载脚本
 * AGPL-3.0
 *
 * 只开一条窄通道：页面拿不到 require / ipcRenderer，只能用下面这些白名单方法。
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const send = (channel, ...args) => ipcRenderer.send(channel, ...args);

function subscribe(channel, cb) {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('yunx', {
  info: () => invoke('app:info'),

  cfg: {
    get: () => invoke('cfg:get'),
    patch: (partial) => invoke('cfg:patch', partial),
    set: (section, value) => invoke('cfg:set', section, value),
  },

  onState: (cb) => subscribe('state:changed', cb),

  win: {
    min: () => invoke('win:min'),
    max: () => invoke('win:max'),
    close: () => invoke('win:close'),
    quit: () => invoke('app:quit'),
    showMain: () => invoke('app:showMain'),
  },

  guide: {
    setVisible: (v) => invoke('guide:setVisible', v),
    setLocked: (v) => invoke('guide:setLocked', v),
    diag: () => invoke('guide:diag'),
    displayMode: () => invoke('guide:displayMode'),
    reset: () => invoke('guide:reset'),
    close: () => invoke('guide:close'),
    pickRoot: () => invoke('guide:pickRoot'),
    clearRoot: () => invoke('guide:clearRoot'),
    list: (rel) => invoke('guide:list', rel),
    overview: () => invoke('guide:overview'),
    openFolder: () => invoke('open:guideFolder'),
    setAlpha: (v) => invoke('guide:setAlpha', v),
    setWidth: (v) => invoke('guide:setWidth', v),
    setBall: (v) => invoke('guide:setBall', v),
    setForceTop: (v) => invoke('guide:setForceTop', v),
    onReload: (cb) => subscribe('guide:reload', cb),
    // 从悬浮球进来时，主进程告诉页面「直接打开这个目录的第一张图」
    onOpenAt: (cb) => subscribe('guide:openAt', cb),
    onBall: (cb) => subscribe('guide:ball', cb),
    onSize: (cb) => subscribe('guide:size', cb),
    // 锁定/智能穿透时，渲染进程收不到 JS 滚轮事件，
    // 主进程用原生的 wheel-scroll 兜底，通过这条通道发 deltaY 让页面翻页
    onWheel: (cb) => subscribe('guide:wheel', cb),
    dragStart: (p) => send('guide:dragStart', p),
    dragMove: (p) => send('guide:dragMove', p),
    dragEnd: () => send('guide:dragEnd'),
    resizeStart: (p) => send('guide:resizeStart', p),
    resizeMove: (p) => send('guide:resizeMove', p),
    resizeEnd: () => send('guide:resizeEnd'),
  },

  orb: {
    ready: (id) => send('orb:ready', id),
    click: (id) => send('orb:click', id),
    context: (id) => send('orb:context', id),
    dragStart: (p) => send('orb:dragStart', p),
    dragMove: (p) => send('orb:dragMove', p),
    dragEnd: (id) => send('orb:dragEnd', id),
    wheel: (p) => send('orb:wheel', p),
    onState: (cb) => subscribe('orb:state', cb),
    // 设置页用
    list: () => invoke('orb:list'),
    add: (rel) => invoke('orb:add', rel),
    remove: (id) => invoke('orb:remove', id),
    bind: (id, rel) => invoke('orb:bind', { id, rel }),
    rename: (id, label) => invoke('orb:rename', { id, label }),
    setScale: (id, scale) => invoke('orb:scale', { id, scale }),
    setVisible: (v) => invoke('orb:setVisible', v),
    setScaleAll: (v) => invoke('orb:setScaleAll', v),
  },

  crosshair: {
    setVisible: (v) => invoke('crosshair:setVisible', v),
    list: () => invoke('crosshair:list'),
    create: () => invoke('crosshair:new'),
    select: (id) => invoke('crosshair:select', id),
    rename: (id, name) => invoke('crosshair:rename', id, name),
    remove: (id) => invoke('crosshair:delete', id),
    pickImage: () => invoke('crosshair:pickImage'),
    clearImage: () => invoke('crosshair:clearImage'),
    update: (patch) => invoke('crosshair:update', patch),
    center: () => invoke('crosshair:center'),
    setAdjust: (v) => invoke('crosshair:setAdjust', v),
    setLocked: (v) => invoke('crosshair:setLocked', v),
    onProfile: (cb) => subscribe('crosshair:profile', cb),
    dragStart: (p) => send('crosshair:dragStart', p),
    dragMove: (p) => send('crosshair:dragMove', p),
    dragEnd: () => invoke('crosshair:dragEnd'),
  },

  splash: {
    pick: (kind) => invoke('splash:pick', kind),
    clear: () => invoke('splash:clear'),
    url: () => invoke('splash:url'),
    done: () => invoke('splash:done'),
  },

  pan: {
    parse: (text) => invoke('pan:parse', text),
    status: () => invoke('pan:status'),
    login: (platform) => invoke('pan:login', platform),
    saveCookie: (platform, cookie) => invoke('pan:saveCookie', { platform, cookie }),
    logout: (platform) => invoke('pan:logout', platform),
    browse: (platform, fid) => invoke('pan:browse', platform, fid),
    // v1.3.0 网盘文件管理
    ls: (payload) => invoke('pan:ls', payload),
    plan: (payload) => invoke('pan:plan', payload),
    start: (payload) => invoke('pan:start', payload),
    queueState: () => invoke('pan:queueState'),
    queueOp: (op, id) => invoke('pan:queueOp', { op, id }),
    dest: () => invoke('pan:dest'),
    pickDest: () => invoke('pan:pickDest'),
    openDest: (platform) => invoke('pan:openDest', platform),
    indexStats: (platform) => invoke('pan:indexStats', platform),
    onQueue: (cb) => subscribe('pan:queue', cb),
    onChanged: (cb) => subscribe('pan:changed', cb),
  },

  dl: {
    state: () => invoke('dl:state'),
    pickBase: () => invoke('dl:pickBase'),
    openBase: () => invoke('dl:openBase'),
    startShare: (opts) => invoke('dl:startShare', opts),
    previewShare: (opts) => invoke('dl:previewShare', opts),
    startPicked: (opts) => invoke('dl:startPicked', opts),
    startCloud: (opts) => invoke('dl:startCloud', opts),
    cancel: () => invoke('dl:cancel'),
    openDest: (dest) => invoke('dl:openDest', dest),
    useAsRoot: (dest) => invoke('dl:useAsRoot', dest),
    onState: (cb) => subscribe('download:state', cb),
  },

  hotkey: {
    set: (key, accel) => invoke('hotkey:set', key, accel),
    results: () => invoke('hotkey:results'),
  },

  ui: {
    replayEntrance: () => invoke('ui:replayEntrance'),
    onReplay: (cb) => subscribe('ui:replay', cb),
  },

  openExternal: (url) => invoke('open:external', url),
  openUserData: () => invoke('open:userData'),
});
