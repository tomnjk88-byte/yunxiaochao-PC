/*
 * 云小抄 PC（YunX Guide Overlay · Desktop）
 * 基于 云析 YunX（https://github.com/CYQawa/YunX）与 云小抄（Android）二次开发。
 * Copyright (C) 2026 CYQawa（原项目作者）
 *
 * 本文件是 AGPL-3.0 衍生作品，完整协议见项目根目录 LICENSE。
 * 修改说明：新增。计划阶段 —— 先把「选中项」判成跳过 / 补记 / 下载三堆，再动手。
 */

'use strict';

const { decide, ACTION, REASON } = require('./dedup');

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, limit) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(lanes);
  return out;
}

/**
 * @param {Array} items [{cloudRel,size,mtime,cloudId}]
 * @param {object} ctx   见 dedup.decide
 * @param {{concurrency?:number}} opts
 */
async function buildPlan(items, ctx, opts = {}) {
  const concurrency = opts.concurrency || 32;

  const seen = new Set();
  const unique = [];
  let duplicated = 0;
  for (const it of items) {
    if (seen.has(it.cloudRel)) {
      duplicated++;
      continue;
    }
    seen.add(it.cloudRel);
    unique.push(it);
  }

  const decided = [];
  const byLocal = new Map();
  const collisions = [];

  await mapLimit(unique, concurrency, async (it) => {
    const d = await decide(it, ctx);
    decided.push({ ...it, ...d });

    const prev = byLocal.get(d.localRel);
    if (prev && prev.cloudRel !== it.cloudRel) {
      collisions.push({ localRel: d.localRel, a: prev.cloudRel, b: it.cloudRel });
    } else {
      byLocal.set(d.localRel, { cloudRel: it.cloudRel });
    }
  });

  const counts = {
    total: decided.length,
    skip: 0,
    adopt: 0,
    download: 0,
    duplicated,
    collisions: collisions.length,
    bytesToDownload: 0,
  };
  for (const d of decided) {
    if (d.action === ACTION.SKIP) counts.skip++;
    else if (d.action === ACTION.ADOPT) counts.adopt++;
    else {
      counts.download++;
      counts.bytesToDownload += d.size > 0 ? d.size : 0;
    }
  }

  // 下载堆按路径排序，落盘顺序稳定，出问题好复现
  decided.sort((a, b) => (a.localRel < b.localRel ? -1 : a.localRel > b.localRel ? 1 : 0));
  return { items: decided, counts, collisions };
}

/** 供 UI 直接展示的中文原因 */
const REASON_TEXT = {
  [REASON.INDEX_HIT]: '已下载且一致',
  [REASON.INDEX_HIT_WEAK]: '已下载（网盘未给时间，按大小判定）',
  [REASON.ADOPTED]: '本地已有且一致，已补记索引',
  [REASON.MISSING]: '本地没有',
  [REASON.SIZE_MISMATCH]: '大小变了',
  [REASON.MTIME_MISMATCH]: '网盘侧改过',
  [REASON.TYPE_MISMATCH]: '同名位置被目录占用',
  [REASON.CLOUD_CHANGED]: '网盘侧已更新',
  [REASON.UNVERIFIABLE]: '网盘未给大小与时间，重下兜底',
};

module.exports = { buildPlan, mapLimit, REASON_TEXT, ACTION, REASON };
