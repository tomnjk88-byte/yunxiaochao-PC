/*
 * 云小抄 PC · 本地攻略库
 * 基于 云析 YunX（https://github.com/CYQawa/YunX）与 云小抄（Android）二次开发。
 * AGPL-3.0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nativeImage } = require('electron');
const { log } = require('./log');

const glog = log.scope('guide');

/**
 * 本地攻略库。
 *
 * Android 版有三条来源：个人网盘 / 本地文件夹 / 别人的分享链接。桌面端原本只保留
 * 「本地文件夹」—— 现在网盘那两条走「一键下载」落到本地（见 downloader.js），
 * 这里仍然只读磁盘。
 */

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.jfif']);
const MAX_DEPTH = 4;
const MAX_IMAGES_PER_DIR = 2000;

/** 缩略图磁盘缓存目录，由 main.js 在 app ready 之后注入 */
let thumbDir = '';
/** 目录扫描缓存：同一个目录 1.5 秒内重复问（悬浮窗 + 主界面同时刷新）只扫一次 */
const dirCache = new Map();
const DIR_CACHE_MS = 1500;
const DIR_CACHE_MAX = 64;
/** 子文件夹的封面 / 图片数：比目录内容重得多，单独缓存久一点 */
const folderMetaCache = new Map();
const FOLDER_META_MS = 30000;
const FOLDER_META_MAX = 400;

function isImage(name) {
  return IMAGE_EXT.has(path.extname(name).toLowerCase());
}

/** 只允许访问 root 内的路径，挡住 .. 与绝对路径注入 */
function resolveInside(root, rel) {
  if (!root) return null;
  const base = path.resolve(root);
  const target = path.resolve(base, rel || '.');
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(withSep)) return null;
  return target;
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/**
 * 扫盘预算（v1.4.0）
 *
 * 同步 readdir 跑在主进程里，绑到一个几万文件的目录（很多人的素材库就是一坨平铺），
 * 一次扫描能把消息泵堵住几百毫秒，Windows 直接给标题栏画「未响应」。
 * 这里不追求统计准确到个位，只保证「绝不长时间占住主线程」：
 * 条目超过上限或时间超预算，就带着已经数到的结果返回。
 */
const SCAN_MAX_ENTRIES = 3000;
const SCAN_BUDGET_MS = 60;

function scanDir(dir, budget) {
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }
  if (Date.now() > budget.until) return [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    budget.entries += entries.length;
    return entries;
  } catch {
    return [];
  }
}

function scannedEnough(budget) {
  return budget.entries >= SCAN_MAX_ENTRIES || Date.now() > budget.until;
}

/** 文件夹封面：自己先找一张，找不到再看一层子目录 */
function pickCover(dir, depth = 0, budget = { entries: 0, until: Date.now() + SCAN_BUDGET_MS }) {
  const entries = scanDir(dir, budget);
  if (!entries.length) return null;
  const files = entries
    .filter((e) => e.isFile() && isImage(e.name) && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  if (files.length) return path.join(dir, files[0]);
  if (depth >= 1) return null;
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  for (const d of dirs) {
    const hit = pickCover(path.join(dir, d.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

function countImages(dir, depth = 0, budget = { entries: 0, until: Date.now() + SCAN_BUDGET_MS }) {
  let n = 0;
  const entries = scanDir(dir, budget);
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isFile() && isImage(e.name)) n += 1;
    else if (e.isDirectory() && depth < 2) n += countImages(path.join(dir, e.name), depth + 1, budget);
    if (n >= 999) return 999;
    if (scannedEnough(budget)) return n;
  }
  return n;
}

function listDir(root, rel = '') {
  const dir = resolveInside(root, rel);
  if (!dir) return { ok: false, error: '攻略文件夹未设置' };
  const st = safeStat(dir);
  if (!st || !st.isDirectory()) return { ok: false, error: '文件夹不存在' };

  // 悬浮窗打开、主界面统计、切分类会连着问同一个目录 —— 只认这一次磁盘扫描
  const cacheKey = path.resolve(root) + '|' + (rel || '');
  const cached = dirCache.get(cacheKey);
  if (cached && cached.stamp === st.mtimeMs && Date.now() - cached.at < DIR_CACHE_MS) {
    return cached.data;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { ok: false, error: '读不到这个文件夹：' + e.message };
  }

  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
    .map((e) => {
      const child = path.join(dir, e.name);
      const meta = folderMeta(child);
      return {
        name: e.name,
        rel: path.relative(path.resolve(root), child).split(path.sep).join('/'),
        count: meta.count,
        cover: meta.cover
          ? path.relative(path.resolve(root), meta.cover).split(path.sep).join('/')
          : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  const images = entries
    .filter((e) => e.isFile() && isImage(e.name) && !e.name.startsWith('.'))
    .map((e) => {
      const full = path.join(dir, e.name);
      const s = safeStat(full);
      return {
        name: e.name,
        rel: path.relative(path.resolve(root), full).split(path.sep).join('/'),
        size: s ? s.size : 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    .slice(0, MAX_IMAGES_PER_DIR);

  // 面包屑：从根到当前
  const crumbs = [{ name: '小抄', rel: '' }];
  if (rel) {
    let acc = '';
    for (const part of rel.split('/').filter(Boolean)) {
      acc = acc ? acc + '/' + part : part;
      crumbs.push({ name: part, rel: acc });
    }
  }

  const data = {
    ok: true,
    rel,
    crumbs,
    folders,
    images,
    rootName: path.basename(path.resolve(root)),
  };

  dirCache.set(cacheKey, { stamp: st.mtimeMs, at: Date.now(), data });
  if (dirCache.size > DIR_CACHE_MAX) dirCache.delete(dirCache.keys().next().value);
  return data;
}

/** 子文件夹的封面和图片数：递归数目录比列一层贵，单独缓存，30 秒内不重复数 */
function folderMeta(dir) {
  const st = safeStat(dir);
  const stamp = st ? st.mtimeMs : 0;
  const hit = folderMetaCache.get(dir);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < FOLDER_META_MS) return hit;
  // 两个函数共用一份预算：先数数，预算还有富余才去挑封面
  const budget = { entries: 0, until: Date.now() + SCAN_BUDGET_MS };
  const count = countImages(dir, 0, budget);
  const cover = scannedEnough(budget) ? null : pickCover(dir, 0, budget);
  const meta = { stamp, at: Date.now(), cover, count };
  folderMetaCache.set(dir, meta);
  if (folderMetaCache.size > FOLDER_META_MAX) folderMetaCache.delete(folderMetaCache.keys().next().value);
  return meta;
}

/** 全库统计 + 顶层分类，给主界面用。大库全量走一遍要几百毫秒，缓存 15 秒 */
let overviewCache = null;

function overview(root) {
  if (!root) return { ok: false, images: 0, folders: 0 };
  const st = safeStat(root);
  if (!st || !st.isDirectory()) return { ok: false, images: 0, folders: 0 };
  const key = path.resolve(root);
  if (
    overviewCache &&
    overviewCache.key === key &&
    overviewCache.stamp === st.mtimeMs &&
    Date.now() - overviewCache.at < 15000
  ) {
    return overviewCache.data;
  }
  let images = 0;
  let folders = 0;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isFile() && isImage(e.name)) images++;
      else if (e.isDirectory()) {
        folders++;
        if (depth < MAX_DEPTH) walk(path.join(dir, e.name), depth + 1);
      }
    }
  };
  walk(root, 1);
  const data = { ok: true, images, folders, rootName: path.basename(key) };
  overviewCache = { key, stamp: st.mtimeMs, at: Date.now(), data };
  return data;
}

/**
 * 缩略图。原生解码 + 缩放，比在页面里塞原图省一个数量级的内存：
 * 一张 4000×6000 的攻略长图，原图 30MB，缩到 360 宽只要几十 KB。
 *
 * 两级缓存：
 *  - 内存 LRU 管「这次滑动」；
 *  - 磁盘缓存管「下次启动」—— 之前只缓存内存，关掉程序再打开，几百张图要重新解码一遍，
 *    这就是「每次打开小抄都要等」的主要原因。文件名带上 mtime 和 size，换图自动失效。
 */
const thumbCache = new Map();
const THUMB_CACHE_MAX = 320;

/**
 * 缩略图是主进程里最重的活：一张 1440×2560 的攻略图，解码 + 缩放 + 编码实测 32ms。
 * 一屏 20 张连着做 = 主进程冻结 620ms，这期间悬浮窗拖不动、按钮点不动，
 * 就是用户说的「使用过程中不流畅」。
 *
 * 三条路一起用：
 *  1. Windows / macOS 走 nativeImage.createThumbnailFromPath —— 系统缩略图接口，
 *     异步、在工作线程里做，主进程完全不等（Linux 没有这个接口，自动走第 3 条）；
 *  2. 缓存命中走磁盘异步读，不占主线程；
 *  3. 兜底同步解码，但排进串行队列，每张做完用 setImmediate 让出事件循环，
 *     于是 620ms 的连续冻结变成 20 个 32ms 的短任务，中间能正常响应拖动和点击。
 */
const thumbInflight = new Map();
let thumbChain = Promise.resolve();

function queueThumb(job) {
  const run = thumbChain.then(job);
  // 用 setTimeout(0) 而不是 setImmediate：后者只在 check 阶段兜一圈，
  // 同一轮里挂着的其它 immediate 会连着跑，鼠标/窗口事件仍可能被挤掉。
  // 进 timers 阶段才真正把控制权还给事件循环。
  thumbChain = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 0)));
  return run;
}

function rememberThumb(key, buf) {
  thumbCache.set(key, buf);
  if (thumbCache.size > THUMB_CACHE_MAX) {
    thumbCache.delete(thumbCache.keys().next().value);
  }
}

function init(opts = {}) {
  thumbDir = opts.thumbDir || '';
  if (thumbDir) {
    try {
      fs.mkdirSync(thumbDir, { recursive: true });
    } catch {
      thumbDir = '';
    }
  }
}

function thumbKey(file, width) {
  const st = safeStat(file);
  const stamp = `${file}|${st ? Math.round(st.mtimeMs) : 0}|${st ? st.size : 0}|${width}`;
  return crypto.createHash('sha1').update(stamp).digest('hex');
}

/** 真正把一张原图变成缩略图 byte。这条只会在串行队列里被调，不并发。 */
async function makeThumb(file, width) {
  // 1) 系统缩略图：Windows（WIC）/ macOS（QuickLook）都是工作线程里缩，主进程不等
  if (process.platform !== 'linux' && typeof nativeImage.createThumbnailFromPath === 'function') {
    try {
      const box = { width, height: Math.round(width * 1.45) };
      let img = await nativeImage.createThumbnailFromPath(file, box);
      if (img && !img.isEmpty()) {
        const s = img.getSize();
        if (s.width > box.width || s.height > box.height) {
          img =
            s.width / box.width > s.height / box.height
              ? img.resize({ width: box.width, quality: 'good' })
              : img.resize({ height: box.height, quality: 'good' });
        }
        return img.toJPEG(82);
      }
    } catch {
      /* 系统不认这个格式（webp / avif 等），往下走同步解码 */
    }
  }

  // 2) 兜底：主线程同步解码。已由 queueThumb 串行化，但大图单张就能吃掉 300ms，
  //    所以设一道硬闸：超过 12MB 直接放弃，让页面去请求原图（guide://img 是零拷贝的）。
  try {
    const st = fs.statSync(file);
    if (st.size > 12 * 1024 * 1024) {
      glog.warn('缩略图跳过（文件过大）', file, st.size);
      return null;
    }
  } catch {
    return null;
  }
  let img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return null;
  const { width: w, height: h } = img.getSize();
  if (w > width || h > width * 2) {
    img = img.resize({ width: Math.min(width, w), quality: 'good' });
  }
  return img.toJPEG(82);
}

/**
 * 异步取缩略图：内存 → 磁盘 → 队列生成，同一张图并发请求只做一次。
 * 协议处理里必须用这个，同步版会把主进程冻住。
 */
async function thumbnailAsync(file, width = 360) {
  const key = thumbKey(file, width);
  const hit = thumbCache.get(key);
  if (hit) {
    thumbCache.delete(key);
    thumbCache.set(key, hit); // LRU 触碰
    return hit;
  }

  const pend = thumbInflight.get(key);
  if (pend) return pend;

  const job = (async () => {
    if (thumbDir) {
      try {
        const buf = await fs.promises.readFile(path.join(thumbDir, key + '.jpg'));
        if (buf.length > 0) {
          touchThumb(key);
          rememberThumb(key, buf);
          return buf;
        }
      } catch {
        /* 没缓存就现做 */
      }
    }

    const buf = await queueThumb(() => makeThumb(file, width));
    if (!buf) return null;
    rememberThumb(key, buf);
    if (thumbDir) {
      fs.promises.writeFile(path.join(thumbDir, key + '.jpg'), buf).catch(() => {});
    }
    return buf;
  })();

  thumbInflight.set(key, job);
  try {
    return await job;
  } finally {
    thumbInflight.delete(key);
  }
}

/** 同步版：预热等场景偶尔用，页面请求一律走 thumbnailAsync */
function thumbnail(file, width = 360) {
  const key = thumbKey(file, width);
  const hit = thumbCache.get(key);
  if (hit) {
    thumbCache.delete(key);
    thumbCache.set(key, hit);
    return hit;
  }
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return null;
  const { width: w, height: h } = img.getSize();
  const out =
    w > width || h > width * 2
      ? img.resize({ width: Math.min(width, w), quality: 'good' }).toJPEG(82)
      : img.toJPEG(82);
  rememberThumb(key, out);
  if (thumbDir) fs.promises.writeFile(path.join(thumbDir, key + '.jpg'), out).catch(() => {});
  return out;
}

/** 读缓存时顺手更新访问时间，清理时按「最近用过的」留 */
const touched = new Set();
function touchThumb(key) {
  if (touched.has(key)) return;
  touched.add(key);
  if (touched.size > 2000) touched.clear();
  const now = new Date();
  fs.promises.utimes(path.join(thumbDir, key + '.jpg'), now, now).catch(() => {});
}

/**
 * 清磁盘缓存：按访问时间留最近 5000 张 / 512MB。
 * 攻略图换得很勤的用户可能攒下几个 G，只增不减迟早把 C 盘塞满。
 */
async function pruneThumbs(maxBytes = 512 * 1024 * 1024, maxFiles = 5000) {
  if (!thumbDir) return;
  let names;
  try {
    names = await fs.promises.readdir(thumbDir);
  } catch {
    return;
  }
  const files = [];
  let total = 0;
  for (const name of names) {
    if (!name.endsWith('.jpg')) continue;
    const full = path.join(thumbDir, name);
    try {
      const st = await fs.promises.stat(full);
      files.push({ full, at: st.mtimeMs, size: st.size });
      total += st.size;
    } catch {
      /* 并发删掉了 */
    }
  }
  if (files.length <= maxFiles && total <= maxBytes) return;
  files.sort((a, b) => a.at - b.at);
  let count = files.length;
  for (const f of files) {
    if (count <= maxFiles && total <= maxBytes) break;
    try {
      await fs.promises.unlink(f.full);
      total -= f.size;
      count--;
    } catch {
      /* ignore */
    }
  }
}

/**
 * 预热：选好文件夹 / 下载完之后，在后台把首屏要用的缩略图先生成一遍。
 * 用户真正打开悬浮窗时就是直接读磁盘，不再看到一排灰格子。
 */
let warming = false;
function warmup(root, rel = '') {
  if (!root || warming) return;
  const listing = listDir(root, rel);
  if (!listing.ok) return;
  warming = true;
  const jobs = [];
  for (const f of listing.folders) {
    if (f.cover) jobs.push(path.join(root, ...f.cover.split('/')));
  }
  for (const img of listing.images.slice(0, 60)) {
    jobs.push(path.join(root, ...img.rel.split('/')));
  }
  let i = 0;
  let done = 0;
  const step = () => {
    if (i >= jobs.length) {
      warming = false;
      return;
    }
    const file = jobs[i++];
    // 宽度必须和 guide://thumb 用的一致，否则预热出来的缓存命中不了。
    // 走异步版：系统缩略图接口在工作线程，兜底解码也在队列里让出事件循环，
    // 用户这时正在拖窗口也不会顿。
    thumbnailAsync(file, 420)
      .catch(() => {
        /* 坏图跳过 */
      })
      .then(() => {
        done++;
        // 前 12 张快一点，用户马上就会看到；后面放慢，避免和操作抢 CPU
        setTimeout(step, done < 12 ? 16 : 40);
      });
  };
  setTimeout(step, 120);
}

function clearThumbCache() {
  thumbCache.clear();
  dirCache.clear();
  folderMetaCache.clear();
}

module.exports = {
  init,
  listDir,
  overview,
  thumbnail,
  thumbnailAsync,
  warmup,
  pruneThumbs,
  resolveInside,
  clearThumbCache,
  isImage,
};
