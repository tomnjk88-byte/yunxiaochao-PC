/*
 * 云小抄 PC（YunX Guide Overlay · Desktop）
 * 基于 云析 YunX（https://github.com/CYQawa/YunX）与 云小抄（Android）二次开发。
 * Copyright (C) 2026 CYQawa（原项目作者）
 *
 * 本文件是 AGPL-3.0 衍生作品，完整协议见项目根目录 LICENSE。
 * 修改说明：新增文件。把小抄从网盘「搬」到本地磁盘：
 * 保留网盘里的目录结构、并发下载、已下过的同大小文件自动跳过，重复点只补新图。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const pan = require('./pan');
const { resolveInside, toFsPath } = require('./sync/paths');
const { log } = require('./log');

const dlog = log.scope('dl');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.jfif']);
const LANES = 3;
const MAX_FILES = 8000;
const MAX_DEPTH = 8;

function isImage(name) {
  return IMAGE_EXT.has(path.extname(String(name || '')).toLowerCase());
}

/** Windows 文件名净化：非法字符、结尾的点与空格、保留设备名 */
function safeName(name) {
  let s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  s = s.replace(/[. ]+$/g, '');
  if (!s) s = '未命名';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
  if (s.length > 100) {
    const ext = path.extname(s).slice(0, 10);
    s = s.slice(0, 100 - ext.length) + ext;
  }
  return s;
}

/** 异步 stat：4000 个文件同步 stat 会让主进程卡住几百毫秒，界面上就是一次「未响应」 */
async function statSize(file) {
  try {
    const st = await fs.promises.stat(file);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}

/**
 * 一个下载任务。
 *
 * 状态只留一份，变化时整体广播 —— 界面永远不用自己算进度，
 * 也就不会出现「进度条走完了但还在下」这种对不上的情况。
 */
class Downloader {
  constructor({ getCookie, onCookie, onState }) {
    this.getCookie = getCookie || (() => '');
    this.onCookie = onCookie || (() => {});
    this.onState = onState || (() => {});
    this.seq = 0;
    this.job = null;
    this.ctrl = null;
    this.timer = null;
    this.state = this.idleState();
  }

  idleState() {
    return {
      id: 0,
      status: 'idle',
      kind: '',
      title: '',
      dest: '',
      total: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      current: '',
      message: '',
      errors: [],
      startedAt: 0,
      endedAt: 0,
    };
  }

  snapshot() {
    return { ...this.state };
  }

  emit(force = false) {
    if (force) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.onState(this.snapshot());
      return;
    }
    // 每张图都发一次 IPC 会把渲染进程的动画拖卡，200ms 一次足够顺滑
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onState(this.snapshot());
    }, 200);
  }

  patch(partial, force = false) {
    Object.assign(this.state, partial);
    this.emit(force);
  }

  cancel() {
    if (!this.isBusy()) return false;
    // 先落状态再 abort：正在跑的那几张会以 AbortError 结束，不会把 endedAt 又改回去
    this.patch({ status: 'canceled', current: '', message: '已取消', endedAt: Date.now() }, true);
    if (this.ctrl) this.ctrl.abort();
    return true;
  }

  /**
   * 从分享链接下载。
   * @param {{link:string,pwd?:string,baseDir:string,title?:string}} opts
   */
  async startShare(opts) {
    if (this.isBusy()) return { ok: false, error: '已经有一个下载任务在跑' };
    const parsed = pan.parseShare(opts.link);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const id = ++this.seq;
    this.ctrl = new AbortController();
    this.patch(
      {
        id,
        status: 'listing',
        kind: 'share',
        title: opts.title || '',
        dest: opts.baseDir || '',
        total: 0,
        done: 0,
        failed: 0,
        skipped: 0,
        current: '',
        message: '正在读取分享目录…',
        startedAt: Date.now(),
        endedAt: 0,
      },
      true
    );

    this.run(id, async () => {
      const session = await pan.openShare({
        platform: parsed.platform,
        shareId: parsed.shareId,
        pwd: opts.pwd || parsed.pwd,
        cookie: '',
      });

      // 每次下到「基础目录 / 分享标题」，同一个分享再下一次就是原地补图
      const folder = safeName(session.title || opts.title || '分享小抄');
      const dest = path.join(path.resolve(opts.baseDir), folder);
      this.patch({ title: folder, dest, message: '正在列目录…' }, true);

      const items = [];
      await this.walkShare(session, '0', '', items, 0);
      await this.downloadItems(id, items, dest, session);
    });

    return { ok: true, id };
  }

  /**
   * 只列目录、不下载：给「选择性下载」准备完整文件树。
   *
   * 与 walkShare 的区别：这里不按扩展名过滤。用户要先看到分享里到底有什么，
   * 再决定下哪些；只显示图片会让「这个文件为什么没出现在列表里」没法解释。
   */
  async listShareTree(link, pwd) {
    const parsed = pan.parseShare(link);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const session = await pan.openShare({
      platform: parsed.platform,
      shareId: parsed.shareId,
      pwd: pwd || parsed.pwd,
      cookie: '',
    });
    const files = new Map();
    let count = 0;

    const walk = async (dirFid, relDir, depth) => {
      if (depth > MAX_DEPTH) return [];
      const list = await pan.listShare(session, dirFid);
      const out = [];
      for (const f of list) {
        if (count >= MAX_FILES) break;
        const rel = path.posix.join(relDir, safeName(f.name));
        if (f.dir) {
          const children = await walk(f.fid, rel, depth + 1);
          out.push({ fid: f.fid, name: f.name, dir: true, size: 0, path: rel, children });
        } else {
          count++;
          out.push({ fid: f.fid, name: f.name, dir: false, size: f.size, path: rel });
          files.set(f.fid, { name: f.name, rel, size: f.size, fid: f.fid, fidToken: f.fidToken });
        }
      }
      return out;
    };

    const tree = await walk('0', '', 0);
    return {
      ok: true,
      session,
      title: String(session.title || '').trim() || '分享小抄',
      platform: parsed.platform,
      tree,
      files,
      count,
    };
  }

  /**
   * 下载用户勾选的文件（ids 是文件 fid，不含目录）。
   * @param {{session:object,title:string,files:Map<string,object>,baseDir:string,picks:string[]}} opts
   */
  async startSharePicked(opts) {
    if (this.isBusy()) return { ok: false, error: '已经有一个下载任务在跑' };
    const picks = Array.isArray(opts.picks) ? opts.picks : [];
    const files = opts.files || new Map();
    const items = picks.map((fid) => files.get(fid)).filter(Boolean);
    if (!items.length) return { ok: false, error: '没有选中任何文件' };

    const id = ++this.seq;
    this.ctrl = new AbortController();
    const dest = path.join(path.resolve(opts.baseDir), safeName(opts.title || '分享小抄'));
    this.patch(
      {
        id,
        status: 'listing',
        kind: 'share',
        title: opts.title || '',
        dest,
        total: items.length,
        done: 0,
        failed: 0,
        skipped: 0,
        current: '',
        message: `已选 ${items.length} 个文件，正在准备…`,
        startedAt: Date.now(),
        endedAt: 0,
      },
      true
    );

    this.run(id, async () => {
      await this.downloadItems(id, items, dest, opts.session);
    });

    return { ok: true, id };
  }

  /**
   * 从「我的网盘」某个目录下载。
   * @param {{platform:string,fid:string,baseDir:string,title?:string}} opts
   */
  async startCloud(opts) {
    if (this.isBusy()) return { ok: false, error: '已经有一个下载任务在跑' };
    const cookie = this.getCookie(opts.platform);
    if (!cookie) return { ok: false, error: `还没登录${pan.PLATFORMS[opts.platform].label}网盘` };

    const id = ++this.seq;
    const dest = path.join(path.resolve(opts.baseDir), safeName(opts.title || '我的小抄'));
    this.ctrl = new AbortController();
    this.patch(
      {
        id,
        status: 'listing',
        kind: 'cloud',
        title: opts.title || '我的小抄',
        dest,
        total: 0,
        done: 0,
        failed: 0,
        skipped: 0,
        current: '',
        message: '正在读取网盘目录…',
        startedAt: Date.now(),
        endedAt: 0,
      },
      true
    );

    this.run(id, async () => {
      const items = [];
      await this.walkCloud(opts.platform, cookie, opts.fid || '0', '', items, 0);
      await this.downloadItems(id, items, dest, { platform: opts.platform, cookie, cloud: true });
    });

    return { ok: true, id };
  }

  isBusy() {
    return ['listing', 'downloading'].includes(this.state.status);
  }

  async run(id, fn) {
    try {
      await fn();
      if (this.state.id !== id) return;
      const st = this.state;
      if (st.status === 'canceled') return;
      const parts = [];
      if (st.done > 0) parts.push(`下载 ${st.done} 张`);
      if (st.skipped > 0) parts.push(`跳过 ${st.skipped} 张已有`);
      if (st.failed > 0) parts.push(`失败 ${st.failed} 张`);
      this.patch(
        {
          status: st.failed > 0 && st.done === 0 ? 'error' : 'done',
          current: '',
          endedAt: Date.now(),
          message: parts.length ? parts.join('，') : '这个目录里没有图片',
        },
        true
      );
    } catch (e) {
      if (this.state.id !== id) return;
      if (e && e.name === 'AbortError') {
        this.patch({ status: 'canceled', current: '', endedAt: Date.now(), message: '已取消' }, true);
        return;
      }
      this.patch(
        {
          status: 'error',
          current: '',
          endedAt: Date.now(),
          message: (e && e.message) || '下载失败',
        },
        true
      );
    } finally {
      if (this.state.id === id) this.ctrl = null;
    }
  }

  // ------------------------------------------------------------------
  // 列举
  // ------------------------------------------------------------------

  async walkShare(session, dirFid, relDir, out, depth) {
    if (out.length >= MAX_FILES) return;
    if (depth > MAX_DEPTH) return;
    const files = await pan.listShare(session, dirFid);
    this.patch({ message: `正在列目录：已找到 ${out.length} 张` });
    const used = new Set(out.map((x) => x.rel.toLowerCase()));
    for (const f of files) {
      if (this.state.status === 'canceled') return;
      if (f.dir) {
        const sub = path.posix.join(relDir, safeName(f.name));
        await this.walkShare(session, f.fid, sub, out, depth + 1);
        continue;
      }
      if (!isImage(f.name)) continue;
      let rel = path.posix.join(relDir, safeName(f.name));
      let n = 2;
      while (used.has(rel.toLowerCase())) {
        const ext = path.posix.extname(rel);
        rel = path.posix.join(relDir, `${path.posix.basename(rel, ext)} (${n++})${ext}`);
      }
      used.add(rel.toLowerCase());
      out.push({ name: f.name, rel, size: f.size, fid: f.fid, fidToken: f.fidToken });
      if (out.length >= MAX_FILES) return;
    }
  }

  async walkCloud(platform, cookie, fid, relDir, out, depth) {
    if (out.length >= MAX_FILES) return;
    if (depth > MAX_DEPTH) return;
    const files = await pan.listCloud({ platform, cookie, fid });
    this.patch({ message: `正在列目录：已找到 ${out.length} 张` });
    const used = new Set(out.map((x) => x.rel.toLowerCase()));
    for (const f of files) {
      if (this.state.status === 'canceled') return;
      if (f.dir) {
        const sub = path.posix.join(relDir, safeName(f.name));
        await this.walkCloud(platform, cookie, f.fid, sub, out, depth + 1);
        continue;
      }
      if (!isImage(f.name)) continue;
      let rel = path.posix.join(relDir, safeName(f.name));
      let n = 2;
      while (used.has(rel.toLowerCase())) {
        const ext = path.posix.extname(rel);
        rel = path.posix.join(relDir, `${path.posix.basename(rel, ext)} (${n++})${ext}`);
      }
      used.add(rel.toLowerCase());
      out.push({ name: f.name, rel, size: f.size, fid: f.fid });
      if (out.length >= MAX_FILES) return;
    }
  }

  // ------------------------------------------------------------------
  // 下载
  // ------------------------------------------------------------------

  async downloadItems(id, items, destRoot, session) {
    if (this.state.id !== id) return;
    if (!items.length) {
      this.patch({ total: 0, status: 'done', endedAt: Date.now(), message: '这个目录里没有图片' }, true);
      return;
    }

    const root = path.resolve(destRoot);
    await fs.promises.mkdir(root, { recursive: true });

    // 先把已经存在的同大小文件挑出来，进度条从第一秒就是真实分母。
    // 落盘路径一律过 resolveInside：rel 是网盘返回的，分享链接还是别人给的，
    // 里面出现 `..` 就代表能写到保存目录外面去 —— 这里必须挡住，而不是 try 掉了事。
    let skipped = 0;
    const todo = [];
    const errors = [];
    const bad = [];
    for (const it of items) {
      let target;
      try {
        target = resolveInside(root, it.rel, { mode: 'sanitize' });
      } catch (e) {
        bad.push({ rel: it.rel, reason: e.message });
        continue;
      }
      const size = await statSize(toFsPath(target.abs));
      if (size >= 0 && (it.size <= 0 || size === it.size)) skipped++;
      else todo.push(Object.assign({}, it, { abs: target.abs, localRel: target.localRel }));
    }
    if (bad.length) {
      dlog.warn('有文件无法安全落盘，已跳过', bad.length, bad.slice(0, 5));
      errors.push({ rel: bad[0].rel, reason: bad[0].reason, count: bad.length });
    }

    this.patch(
      {
        total: items.length,
        skipped,
        done: 0,
        failed: bad.length,
        errors: errors.slice(),
        dest: root,
        status: 'downloading',
        message: '开始下载…',
      },
      true
    );

    let cursor = 0;
    let done = 0;
    let failed = bad.length;
    const lane = async () => {
      while (true) {
        if (this.state.status === 'canceled') return;
        const idx = cursor++;
        if (idx >= todo.length) return;
        const it = todo[idx];
        const abs = it.abs;
        this.patch({ current: it.rel });
        let ok = false;
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
          try {
            if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
            const link = session.cloud
              ? await pan.cloudLink({ platform: session.platform, fid: it.fid, cookie: session.cookie })
              : await pan.shareLink(session, it);
            // 只有服务端真的下发了新的 __puus 才写盘，否则每张图都要改一次 config
            if (session.cloud && link.cookie && link.cookie !== session.cookie) {
              session.cookie = link.cookie;
              this.onCookie(session.platform, link.cookie);
            }
            await this.fetchToFile(link.url, link.headers, abs, this.ctrl.signal);
            ok = true;
          } catch (e) {
            if (e && e.name === 'AbortError') return;
            if (attempt === 1) {
              failed++;
              // 失败原因要落到界面上：只显示「失败 3 个」用户没法自救
              if (errors.length < 20) errors.push({ rel: it.rel, reason: (e && e.message) || '未知错误' });
              dlog.warn('下载失败', it.rel, e && e.message);
            }
          }
        }
        if (ok) done++;
        this.patch({ done, failed, errors: errors.slice() });
      }
    };

    await Promise.all(Array.from({ length: Math.min(LANES, todo.length) }, () => lane()));
  }

  /** 流式写盘：先写 .part，校验字节数后再改名，断网不会留下半张图 */
  async fetchToFile(url, headers, destPath, signal) {
    const res = await fetch(url, { headers, signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
    if (!res.body) throw new Error('服务器返回空内容');

    const expect = Number(res.headers.get('content-length') || 0);
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    const tmp = destPath + '.part';

    let written = 0;
    const source = Readable.fromWeb(res.body);
    const tap = async function* (stream) {
      for await (const chunk of stream) {
        written += chunk.length;
        yield chunk;
      }
    };

    try {
      await pipeline(source, tap, fs.createWriteStream(tmp));
      if (expect > 0 && written !== expect) throw new Error(`内容不完整（${written}/${expect} 字节）`);
      if (written === 0) throw new Error('下载到 0 字节');
      await fs.promises.rename(tmp, destPath);
    } catch (e) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }
}

module.exports = { Downloader, isImage, safeName };
