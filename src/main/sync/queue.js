/*
 * 云小抄 PC（YunX Guide Overlay · Desktop）
 * 基于 云析 YunX（https://github.com/CYQawa/YunX）与 云小抄（Android）二次开发。
 * Copyright (C) 2026 CYQawa（原项目作者）
 *
 * 本文件是 AGPL-3.0 衍生作品，完整协议见项目根目录 LICENSE。
 * 修改说明：新增。下载队列 —— 多任务排队、任务内多车道、暂停/继续/取消/重试、实时速度。
 */

'use strict';

/**
 * 为什么是「任务串行、任务内并发」而不是「全部任务一起并发」：
 *   夸克 / UC 对同一账号的并发连接数敏感，几十个任务一起跑百分之百触发风控（403 / 限速）。
 *   串行执行 + 每个任务 3 条车道，是实测最快且不容易死的组合。
 *
 * 为什么「先规划再下载」：
 *   进度条的分母从第一秒就是真的；跳过多少、更新多少、要下多少字节在开始前就知道；
 *   用户点「开始」之前能看到「这 1200 个文件里 1180 个已经下过」。
 */

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const { buildPlan, REASON_TEXT, ACTION } = require('./plan');
const { commitDownload } = require('./dedup');
const { toFsPath } = require('./paths');
const pan = require('../pan');

const LANES = 3;
const SPEED_WINDOW_MS = 2500;

function now() {
  return Date.now();
}

function fmtTask(t) {
  return {
    id: t.id,
    platform: t.platform,
    title: t.title,
    dest: t.dest,
    status: t.status,
    total: t.total,
    done: t.done,
    skipped: t.skipped,
    failed: t.failed,
    adopt: t.adopt,
    bytesTotal: t.bytesTotal,
    bytesDone: t.bytesDone,
    speed: t.speed,
    current: t.current,
    message: t.message,
    planned: t.planned,
    counts: t.counts,
    collisions: t.collisions ? t.collisions.length : 0,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
  };
}

class DownloadQueue {
  /**
   * @param {{index:object, getCookie:Function, onCookie:Function, onChange:Function}} deps
   */
  constructor({ index, getCookie, onCookie, onChange, lanes = LANES }) {
    this.index = index;
    this.getCookie = getCookie || (() => '');
    this.onCookie = onCookie || (() => {});
    this.onChange = onChange || (() => {});
    this.lanes = lanes;
    this.tasks = [];
    this.seq = 0;
    this.running = null;
    this.timer = null;
    this.samples = []; // [{t, bytes}] 全局速度采样
  }

  // ------------------------------------------------------------------
  // 对外
  // ------------------------------------------------------------------

  /**
   * 入队。任务真正开始是在 pump 里，这个函数立刻返回，界面可以先显示「排队中」。
   * @param {{platform:string,title:string,dest:string,rootId:string,items:Array,session?:object}} spec
   */
  enqueue(spec) {
    const id = ++this.seq;
    const task = {
      id,
      platform: spec.platform,
      title: spec.title || '网盘文件',
      dest: spec.dest,
      rootId: spec.rootId,
      items: spec.items.map((it) => ({ ...it, absPath: '', state: 'todo' })),
      session: spec.session || null,
      status: 'queued',
      total: spec.items.length,
      done: 0,
      skipped: 0,
      failed: 0,
      adopt: 0,
      bytesTotal: 0,
      bytesDone: 0,
      speed: 0,
      current: '',
      message: '排队中…',
      planned: false,
      counts: null,
      collisions: [],
      createdAt: now(),
      startedAt: 0,
      endedAt: 0,
      ctrl: null,
      taskSamples: [],
    };
    this.tasks.push(task);
    this.emit();
    this.pump();
    return { ok: true, id, queued: true };
  }

  /** 只做计划、不入队：界面点「开始」之前预检用 */
  async dryRun({ platform, dest, rootId, items, session }) {
    const session2 = session || this.makeSession(platform);
    if (!session2) return { ok: false, error: '还没登录这个网盘' };
    const plan = await buildPlan(items, {
      root: dest,
      index: this.index,
      rootId,
      mode: 'sanitize',
      platform: 'win32',
      concurrency: 24,
    });
    const samples = plan.items
      .filter((d) => d.action === ACTION.SKIP)
      .slice(0, 6)
      .map((d) => ({ rel: d.cloudRel, why: REASON_TEXT[d.reason] || d.reason }));
    return {
      ok: true,
      counts: plan.counts,
      perReason: tally(plan.items),
      collisions: plan.collisions.slice(0, 20),
      samples,
    };
  }

  list() {
    return this.tasks.map(fmtTask);
  }

  snapshot() {
    const active = this.tasks.find((t) => t.id === (this.running && this.running.id));
    return {
      tasks: this.list(),
      activeId: active ? active.id : 0,
      speed: active ? active.speed : 0,
      busy: !!this.running,
    };
  }

  pause(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return false;
    if (t.status === 'downloading' || t.status === 'planning') {
      t.status = 'pausing';
      t.message = '正在暂停…';
      if (t.ctrl) t.ctrl.abort();
      this.emit(true);
      return true;
    }
    if (t.status === 'queued') {
      t.status = 'paused';
      t.message = '已暂停（还没开始）';
      this.emit(true);
      return true;
    }
    return false;
  }

  resume(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || !['paused', 'error', 'canceled'].includes(t.status)) return false;
    const wasError = t.status === 'error';
    // 只把没下完的放回队列，已经落盘的绝不重下
    for (const it of t.items) {
      if (it.state === 'failed') it.state = 'todo';
    }
    if (wasError) t.failed = 0;
    t.status = 'queued';
    t.message = '排队中…';
    t.endedAt = 0;
    this.emit(true);
    this.pump();
    return true;
  }

  cancel(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return false;
    if (['done', 'canceled'].includes(t.status)) return false;
    t.status = 'canceled';
    t.message = '已取消';
    t.endedAt = now();
    if (t.ctrl) t.ctrl.abort();
    this.emit(true);
    this.pump();
    return true;
  }

  /** 重试：只把失败的项放回队列，已下好的不重复下 */
  retry(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return false;
    const left = t.items.filter((it) => it.state === 'failed' || it.state === 'todo');
    if (!left.length) return false;
    for (const it of left) it.state = 'todo';
    t.failed = 0;
    t.total = t.done + left.length;
    t.bytesTotal = left.reduce((s, it) => s + (it.size || 0), 0);
    t.bytesDone = 0;
    t.status = 'queued';
    t.message = `重试 ${left.length} 个未完成文件`;
    t.endedAt = 0;
    this.emit(true);
    this.pump();
    return true;
  }

  remove(id) {
    const i = this.tasks.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const t = this.tasks[i];
    if (t.status === 'downloading' || t.status === 'planning' || t.status === 'pausing') return false;
    this.tasks.splice(i, 1);
    this.emit(true);
    return true;
  }

  clearFinished() {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) =>
      ['downloading', 'planning', 'pausing', 'queued', 'paused'].includes(t.status)
    );
    this.emit(true);
    return before - this.tasks.length;
  }

  // ------------------------------------------------------------------
  // 调度
  // ------------------------------------------------------------------

  pump() {
    if (this.running) return;
    const next = this.tasks.find((t) => t.status === 'queued');
    if (!next) {
      this.emit();
      return;
    }
    this.running = next;
    this.run(next).finally(() => {
      this.running = null;
      this.pump();
    });
  }

  makeSession(platform) {
    const cookie = this.getCookie(platform);
    if (!cookie) return null;
    return { platform, cookie, cloud: true };
  }

  async run(task) {
    task.status = 'planning';
    task.startedAt = now();
    task.message = '正在核对本地已有文件…';
    task.ctrl = new AbortController();
    this.emit(true);

    try {
      task.session = task.session || this.makeSession(task.platform);
      if (!task.session) throw new Error('登录已失效，重新连一下网盘');

      // 1. 规划
      if (!task.planned) {
        const plan = await buildPlan(task.items, {
          root: task.dest,
          index: this.index,
          rootId: task.rootId,
          mode: 'sanitize',
          platform: 'win32',
          concurrency: 24,
        });
        if (task.status === 'canceled' || task.status === 'pausing') throw abortErr();

        const byRel = new Map(plan.items.map((d) => [d.cloudRel, d]));
        for (const it of task.items) {
          const d = byRel.get(it.cloudRel);
          if (!d) continue;
          it.absPath = d.absPath;
          it.localRel = d.localRel;
          if (d.action === ACTION.SKIP) {
            it.state = 'done';
            it.skipped = true;
          } else if (d.action === ACTION.ADOPT) {
            it.state = 'adopted';
          }
        }

        // 补记索引：磁盘上有、索引里没有的，趁现在写进去，下次就是 skip
        const adopted = plan.items.filter((d) => d.action === ACTION.ADOPT);
        for (const d of adopted) {
          try {
            const st = await fs.promises.stat(toFsPath(d.absPath));
            this.index.upsert(task.rootId, {
              cloudRel: d.cloudRel,
              localRel: d.localRel,
              cloudId: d.cloudId || null,
              size: st.size,
              cloudMtime: d.cloudMtime,
              localMtime: Math.floor(st.mtimeMs / 1000),
              state: 'done',
            });
          } catch {
            /* 补记失败不影响下载 */
          }
        }

        task.counts = plan.counts;
        task.collisions = plan.collisions;
        task.skipped = plan.counts.skip;
        task.adopt = plan.counts.adopt;
        task.total = plan.counts.download;
        task.bytesTotal = plan.counts.bytesToDownload;
        task.planned = true;
        task.message =
          plan.counts.download === 0
            ? '全部已下载，无需重复下载'
            : `要下 ${plan.counts.download} 个 · 跳过 ${plan.counts.skip} 个 · 补记 ${plan.counts.adopt} 个`;
        this.emit(true);

        if (plan.counts.download === 0) {
          task.status = 'done';
          task.endedAt = now();
          task.message = `全部已下载（${plan.counts.skip} 个一致，${plan.counts.adopt} 个补记索引）`;
          this.emit(true);
          return;
        }
      }

      task.status = 'downloading';
      task.message = '开始下载…';
      this.emit(true);

      await this.downloadAll(task);

      if (task.status === 'canceled') return;
      if (task.status === 'pausing') {
        task.status = 'paused';
        task.message = `已暂停（${task.done}/${task.total}）`;
        task.endedAt = 0;
        this.emit(true);
        return;
      }

      task.status = task.failed > 0 && task.done === 0 ? 'error' : 'done';
      task.endedAt = now();
      task.current = '';
      const parts = [];
      if (task.done > 0) parts.push(`下载 ${task.done} 个`);
      if (task.skipped > 0) parts.push(`跳过 ${task.skipped} 个已有`);
      if (task.failed > 0) parts.push(`失败 ${task.failed} 个`);
      task.message = parts.length ? parts.join('，') : '没有需要下载的文件';
      this.index.flush().catch(() => {});
      this.emit(true);
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.__abort)) {
        if (task.status === 'pausing') {
          task.status = 'paused';
          task.message = `已暂停（${task.done}/${task.total}）`;
        } else {
          task.status = 'canceled';
          task.message = '已取消';
        }
        task.endedAt = task.status === 'canceled' ? now() : 0;
        this.emit(true);
        return;
      }
      task.status = 'error';
      task.endedAt = now();
      task.message = (e && e.message) || '下载失败';
      this.emit(true);
    } finally {
      task.ctrl = null;
      task.speed = 0;
    }
  }

  // ------------------------------------------------------------------
  // 下载
  // ------------------------------------------------------------------

  async downloadAll(task) {
    const todo = task.items.filter((it) => it.state === 'todo');
    let cursor = 0;

    const lane = async () => {
      while (true) {
        if (task.status === 'canceled' || task.status === 'pausing') return;
        const idx = cursor++;
        if (idx >= todo.length) return;
        const it = todo[idx];
        task.current = it.cloudRel;
        this.emit();

        let ok = false;
        let lastErr = null;
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
          if (task.status === 'canceled' || task.status === 'pausing') return;
          try {
            if (attempt > 0) await sleep(600);
            await this.fetchOne(task, it);
            ok = true;
          } catch (e) {
            if (e && (e.name === 'AbortError' || e.__abort)) return;
            lastErr = e;
          }
        }

        if (ok) {
          it.state = 'done';
          task.done++;
        } else {
          it.state = 'failed';
          it.error = (lastErr && lastErr.message) || '下载失败';
          task.failed++;
          console.warn('[queue] 失败', task.title, it.cloudRel, it.error);
        }
        this.emit();
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.lanes, todo.length) }, () => lane()));
  }

  async fetchOne(task, it) {
    const link = task.session.cloud
      ? await pan.cloudLink({ platform: task.platform, fid: it.fid, cookie: task.session.cookie })
      : await pan.shareLink(task.session, it);

    // 只有服务端真的下发了新的 __puus 才写盘，否则每张图都要改一次 config
    if (task.session.cloud && link.cookie && link.cookie !== task.session.cookie) {
      task.session.cookie = link.cookie;
      this.onCookie(task.platform, link.cookie);
    }

    const target = it.absPath;
    const tmp = target + '.part';
    await fs.promises.mkdir(path.dirname(target), { recursive: true });

    const res = await fetch(link.url, {
      headers: link.headers,
      signal: task.ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
    if (!res.body) throw new Error('服务器返回空内容');

    const expect = Number(res.headers.get('content-length') || 0) || Number(link.size || 0) || 0;
    let written = 0;

    const source = Readable.fromWeb(res.body);
    const meter = async function* (stream) {
      for await (const chunk of stream) {
        written += chunk.length;
        task.bytesDone += chunk.length;
        task.taskSamples.push({ t: now(), bytes: chunk.length });
        yield chunk;
      }
    };

    try {
      await pipeline(source, meter, fs.createWriteStream(tmp));
      if (expect > 0 && written !== expect) throw new Error(`内容不完整（${written}/${expect} 字节）`);
      if (written === 0) throw new Error('下载到 0 字节');
      await commitDownload({
        tmpPath: tmp,
        targetAbs: target,
        cloudMtime: it.mtime,
        index: this.index,
        rootId: task.rootId,
        localRel: it.localRel,
        cloudRel: it.cloudRel,
        cloudId: it.cloudId || it.fid,
      });
    } catch (e) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  // ------------------------------------------------------------------
  // 广播
  // ------------------------------------------------------------------

  /** 每张图都发 IPC 会把渲染进程拖卡，200ms 一次足够顺滑 */
  emit(force = false) {
    this.tickSpeed();
    if (force) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.onChange(this.snapshot());
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onChange(this.snapshot());
    }, 200);
  }

  /** 速度：2.5 秒滑动窗口，比「瞬时速度」稳，比「平均速度」跟手 */
  tickSpeed() {
    const t = now();
    for (const task of this.tasks) {
      if (task.status !== 'downloading') {
        if (task.speed) task.speed = 0;
        continue;
      }
      const arr = task.taskSamples;
      while (arr.length && t - arr[0].t > SPEED_WINDOW_MS) arr.shift();
      const bytes = arr.reduce((s, x) => s + x.bytes, 0);
      const span = Math.max(400, Math.min(SPEED_WINDOW_MS, t - task.startedAt));
      task.speed = Math.round((bytes / span) * 1000);
    }
  }
}

function abortErr() {
  const e = new Error('已取消');
  e.__abort = true;
  e.name = 'AbortError';
  return e;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tally(items) {
  const out = {};
  for (const d of items) {
    const k = d.reason;
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

module.exports = { DownloadQueue };
