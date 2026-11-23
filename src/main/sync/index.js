/*
 * 云小抄 PC（YunX Guide Overlay · Desktop）
 * 基于 云析 YunX（https://github.com/CYQawa/YunX）与 云小抄（Android）二次开发。
 * Copyright (C) 2026 CYQawa（原项目作者）
 *
 * 本文件是 AGPL-3.0 衍生作品，完整协议见项目根目录 LICENSE。
 * 修改说明：新增。本地下载索引 —— 记录「哪个网盘目录下的哪个相对路径，已经落到本地哪个文件」。
 */

'use strict';

/**
 * 为什么必须有索引，光看磁盘不够：
 *   - 用户可能自己改过图（PS 修一下、截图重存），大小和时间都变了 → 不该被当成「已下载」
 *   - 用户可能把别处的同名文件拷进来 → 大小一样，但内容不是网盘那份
 *   - 网盘侧文件更新了 → 本地旧文件不该继续挡住下载
 * 索引 + 磁盘双向核对，才能同时解决这三件事。
 *
 * 存储选型：JSON 单文件 + 原子替换。
 * 小抄的典型规模是几百到几万张图，JSON 反序列化 3 万条约 30ms，够用且零原生依赖
 * （better-sqlite3 要跟着 Electron ABI 重编，打包体积和踩坑成本都不划算）。
 * 索引结构按 (rootId, cloudRel) 唯一，要换 SQLite 只需实现同样四个方法。
 */

const fs = require('fs');
const path = require('path');

const VERSION = 1;

class JsonIndex {
  constructor(file) {
    this.file = file;
    this.data = { version: VERSION, files: {} };
    this.timer = null;
    this.dirty = false;
    this.saving = null;
    this.loadedAt = 0;
  }

  open() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === VERSION && parsed.files) this.data = parsed;
    } catch {
      /* 首次运行 / 文件损坏都从空索引开始，不阻塞下载 */
    }
    this.loadedAt = Date.now();
    return this;
  }

  /** rootKey 形如 `quark|D:\小抄`，原样当 rootId 用 */
  ensureRoot(rootKey) {
    return String(rootKey);
  }

  _key(rootId, cloudRel) {
    return rootId + '\u0000' + cloudRel;
  }

  get(rootId, cloudRel) {
    return this.data.files[this._key(rootId, cloudRel)] || null;
  }

  upsert(rootId, row) {
    this.data.files[this._key(rootId, row.cloudRel)] = {
      cloudRel: row.cloudRel,
      localRel: row.localRel,
      cloudId: row.cloudId || null,
      size: row.size,
      cloudMtime: row.cloudMtime === undefined ? null : row.cloudMtime,
      localMtime: row.localMtime,
      state: row.state || 'done',
      updatedAt: Math.floor(Date.now() / 1000),
    };
    this._schedule();
  }

  bulkUpsert(rootId, rows) {
    for (const r of rows) this.upsert(rootId, r);
    return this.flush();
  }

  /** 某个根目录下的全部记录（清理 / 迁移用） */
  entries(rootId) {
    const prefix = rootId + '\u0000';
    const out = [];
    for (const [k, v] of Object.entries(this.data.files)) {
      if (k.startsWith(prefix)) out.push(v);
    }
    return out;
  }

  remove(rootId, cloudRel) {
    const k = this._key(rootId, cloudRel);
    if (!this.data.files[k]) return false;
    delete this.data.files[k];
    this._schedule();
    return true;
  }

  /** 删掉一批「本地文件已经不在了」的记录，避免索引无限膨胀 */
  prune(rootId, existsFn) {
    const prefix = rootId + '\u0000';
    let n = 0;
    for (const [k, v] of Object.entries(this.data.files)) {
      if (!k.startsWith(prefix)) continue;
      if (!existsFn(v)) {
        delete this.data.files[k];
        n++;
      }
    }
    if (n) this._schedule();
    return n;
  }

  stats(rootId) {
    const prefix = rootId + '\u0000';
    const out = { done: 0, failed: 0, partial: 0, bytes: 0 };
    for (const [k, v] of Object.entries(this.data.files)) {
      if (!k.startsWith(prefix)) continue;
      if (out[v.state] !== undefined) out[v.state] += 1;
      if (v.state === 'done') out.bytes += v.size || 0;
    }
    return out;
  }

  _schedule() {
    this.dirty = true;
    if (this.timer) return;
    // 批量下载时每张图都会 upsert，攒 800ms 写一次盘，否则 IO 会把下载拖慢
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, 800);
    if (this.timer.unref) this.timer.unref();
  }

  /** 原子落盘：先写 .tmp 再 rename，断电不会留下半个 JSON */
  async flush() {
    if (!this.dirty) return;
    if (this.saving) {
      await this.saving.catch(() => {});
    }
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = this.file + '.tmp';
    this.saving = (async () => {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await fs.promises.writeFile(tmp, JSON.stringify(this.data), 'utf8');
      await fs.promises.rename(tmp, this.file);
    })();
    try {
      await this.saving;
    } finally {
      this.saving = null;
    }
  }

  async close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = true;
    await this.flush();
  }
}

module.exports = { JsonIndex };
