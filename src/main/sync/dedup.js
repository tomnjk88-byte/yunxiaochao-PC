/*
 * 云小抄 PC（YunX Guide Overlay · Desktop）
 * 基于 云析 YunX（https://github.com/CYQawa/YunX）与 云小抄（Android）二次开发。
 * Copyright (C) 2026 CYQawa（原项目作者）
 *
 * 本文件是 AGPL-3.0 衍生作品，完整协议见项目根目录 LICENSE。
 * 修改说明：新增。防重复下载的唯一判定入口 —— 全工程只有这里能回答「这个文件要不要下」。
 */

'use strict';

/**
 * 判定顺序（任何一条不满足都视为「需要下载」）：
 *   1. 按相对路径映射出的本地文件必须存在，且是普通文件
 *   2. 大小必须与网盘一致
 *   3. 修改时间必须与网盘一致，允许 2 秒容差（FAT32/exFAT 只有 2 秒精度）
 *   4. 索引里必须有一条 done 记录，且记录的 size / cloudMtime / localRel 与本次一致
 *
 * 第 4 条不是多余：它区分「这份文件是我下过的」和「用户从别处拷来的同名同大小文件」，
 * 也让网盘侧内容变了（大小/时间变了）时能主动重下，而不是被本地的旧文件挡住。
 *
 * 网盘不返回修改时间时（部分分享接口、部分目录）不能直接判「需要下载」——
 * 那样每次点下载都会全量重下。此时的降级策略是：大小 + 索引双向一致即跳过，
 * reason 标成 index_hit_weak，界面上写清楚「按大小+索引判定」。
 */

const fs = require('fs');
const path = require('path');
const { resolveInside, toFsPath } = require('./paths');

const ACTION = { SKIP: 'skip', ADOPT: 'adopt', DOWNLOAD: 'download' };

const REASON = {
  INDEX_HIT: 'index_hit', // 索引 + 磁盘双向一致
  INDEX_HIT_WEAK: 'index_hit_weak', // 网盘没给时间，按大小 + 索引判定一致
  ADOPTED: 'adopted_existing', // 磁盘上有且一致，索引里没记过 → 补记后跳过
  MISSING: 'missing', // 本地没有
  SIZE_MISMATCH: 'size_mismatch', // 大小不同
  MTIME_MISMATCH: 'mtime_mismatch', // 时间不同
  TYPE_MISMATCH: 'type_mismatch', // 该是文件的位置是个目录
  CLOUD_CHANGED: 'cloud_changed', // 网盘侧变了（对比索引得知），需要覆盖
  UNVERIFIABLE: 'unverifiable', // 网盘既没给大小也没给时间，无法验证 → 重下
};

/** 网盘时间可能是秒也可能是毫秒，统一成整数秒 */
function normalizeCloudTime(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n > 1e11 ? n / 1000 : n);
}

/** 本地 stat 的毫秒时间戳 → 秒 */
function localMtimeSec(st) {
  return Math.floor(st.mtimeMs / 1000);
}

/**
 * @param {{cloudRel:string, size?:number, mtime?:number, cloudId?:string}} item
 * @param {{root:string, index:object, rootId:any, mode?:'strict'|'sanitize',
 *          platform?:string, mtimeToleranceSec?:number, fsStat?:Function}} ctx
 */
async function decide(item, ctx) {
  const {
    root,
    index,
    rootId,
    mode = 'sanitize',
    platform = process.platform,
    mtimeToleranceSec = 2,
    fsStat = fs.promises.stat,
  } = ctx;

  const { abs, localRel } = resolveInside(root, item.cloudRel, { mode, platform });
  const cloudSize = Number.isFinite(item.size) && item.size >= 0 ? item.size : null;
  const cloudMtime = normalizeCloudTime(item.mtime);

  let st = null;
  try {
    st = await fsStat(toFsPath(abs, platform));
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
  }

  const base = { absPath: abs, localRel, indexRow: null, cloudSize, cloudMtime };

  if (!st) return { ...base, action: ACTION.DOWNLOAD, reason: REASON.MISSING };
  if (!st.isFile()) return { ...base, action: ACTION.DOWNLOAD, reason: REASON.TYPE_MISMATCH };

  if (cloudSize === null && cloudMtime === null) {
    return { ...base, action: ACTION.DOWNLOAD, reason: REASON.UNVERIFIABLE };
  }
  if (cloudSize !== null && st.size !== cloudSize) {
    return { ...base, action: ACTION.DOWNLOAD, reason: REASON.SIZE_MISMATCH };
  }
  if (cloudMtime !== null && Math.abs(localMtimeSec(st) - cloudMtime) > mtimeToleranceSec) {
    return { ...base, action: ACTION.DOWNLOAD, reason: REASON.MTIME_MISMATCH };
  }

  const row = index.get(rootId, item.cloudRel);
  if (row && row.state === 'done') {
    const sameSize = cloudSize === null || row.size === cloudSize;
    const sameTime = cloudMtime === null || normalizeCloudTime(row.cloudMtime) === cloudMtime;
    const samePath = row.localRel === localRel;
    if (sameSize && sameTime && samePath) {
      return {
        ...base,
        indexRow: row,
        action: ACTION.SKIP,
        reason: cloudMtime === null ? REASON.INDEX_HIT_WEAK : REASON.INDEX_HIT,
      };
    }
    // 本地文件还是旧版本、网盘已经变了 → 覆盖下载
    return { ...base, indexRow: row, action: ACTION.DOWNLOAD, reason: REASON.CLOUD_CHANGED };
  }

  // 磁盘上已有一致的文件，但索引没记过（用户从别处拷来、或换过索引文件）
  return { ...base, indexRow: null, action: ACTION.ADOPT, reason: REASON.ADOPTED };
}

/**
 * 下载完成后的收尾：原子替换 → 对齐网盘修改时间 → 回读 → 写索引。
 * 顺序不能变：先 utimes 再 stat，否则索引里记的是「下载时刻」，
 * 下次比对又会对不上，白白重下一遍。
 */
async function commitDownload({
  tmpPath,
  targetAbs,
  cloudMtime,
  index,
  rootId,
  localRel,
  cloudRel,
  cloudId,
}) {
  const fsPath = toFsPath(targetAbs);
  await fs.promises.mkdir(toFsPath(path.dirname(targetAbs)), { recursive: true });
  await fs.promises.rename(tmpPath, fsPath);

  const sec = normalizeCloudTime(cloudMtime);
  if (sec !== null) {
    // atime 给当前时间，mtime 对齐网盘 —— 只改 mtime 会被某些文件系统按 atime 规则连坐
    await fs.promises.utimes(fsPath, new Date(), new Date(sec * 1000));
  }

  const st = await fs.promises.stat(fsPath);
  index.upsert(rootId, {
    cloudRel,
    localRel,
    cloudId,
    size: st.size,
    // 网盘没给时间就存 null，不要拿本地时间冒充，否则下次必判 mtime 不一致
    cloudMtime: sec,
    localMtime: localMtimeSec(st),
    state: 'done',
  });
  return { size: st.size, mtime: localMtimeSec(st) };
}

module.exports = { decide, commitDownload, normalizeCloudTime, localMtimeSec, ACTION, REASON };
