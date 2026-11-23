/*
 * 云小抄 PC（YunX Guide Overlay · Desktop）
 * 基于 云析 YunX（https://github.com/CYQawa/YunX）与 云小抄（Android）二次开发。
 * Copyright (C) 2026 CYQawa（原项目作者）
 *
 * 本文件是 AGPL-3.0 衍生作品，完整协议见项目根目录 LICENSE。
 * 修改说明：新增。路径映射层 —— 网盘里的「相对路径」是唯一身份，本地落盘路径由它推导。
 */

'use strict';

/**
 * 为什么所有判定都绕回「相对路径」：
 *   文件名不唯一（A 目录和 B 目录都叫 1.png），网盘 fileId 一变（重新分享、重新转存）
 *   就全失效。只有「从下载根算起的相对路径」在同一份网盘目录结构里是稳定的。
 *
 * 三条铁律：
 *  1. 只用 path.resolve / path.join 拼接，不手写字符串加号。
 *  2. 结果必须落在用户指定的根目录内，`..` 一律拒绝。
 *  3. 清洗只影响落盘名，不影响索引键（索引仍以 cloudRel 为准）。
 */

const path = require('path');

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
const WIN_ILLEGAL_G = /[<>:"|?*\u0000-\u001f]/g;
const POSIX_ILLEGAL_G = /[/\u0000]/g;
// 检测用不带 g 的版本：带 g 的正则 test() 会记住 lastIndex，第二次调用结果会错
const WIN_ILLEGAL = /[<>:"|?*\u0000-\u001f]/;
const POSIX_ILLEGAL = /[/\u0000]/;

/** 把任意来源的路径规范成 POSIX 相对路径；遇到 .. 直接抛错 */
function normalizeRel(rel) {
  if (typeof rel !== 'string') throw new TypeError('rel 必须是字符串');
  const unified = rel.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  const segs = unified.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.some((s) => s === '..')) throw new Error('路径包含 ..，已拒绝：' + rel);
  if (/^[a-zA-Z]:/.test(unified)) throw new Error('路径不能是绝对路径：' + rel);
  return segs.join('/');
}

/**
 * 单段文件名的落盘清洗。
 * strict 模式只做「不合法就报错」，sanitize 模式替换掉 Windows 不接受字符。
 */
function sanitizeSegment(name, { platform = process.platform, mode = 'strict' } = {}) {
  if (!name) throw new Error('空文件名');
  const illegal = platform === 'win32' ? WIN_ILLEGAL : POSIX_ILLEGAL;
  const illegalG = platform === 'win32' ? WIN_ILLEGAL_G : POSIX_ILLEGAL_G;

  if (mode === 'strict') {
    if (illegal.test(name)) throw new Error(`文件名含非法字符，无法落盘：${name}`);
    if (platform === 'win32' && WIN_RESERVED.test(name)) throw new Error(`Windows 保留名：${name}`);
    return name;
  }

  let out = name.replace(illegalG, '_');
  if (platform === 'win32') {
    // Windows 会悄悄吃掉结尾的点和空格，导致「路径对不上」，这里先削掉
    out = out.replace(/[. ]+$/, '');
    if (WIN_RESERVED.test(out)) out = '_' + out;
    if (out === '') out = '_';
  }
  // 单段超过 120 字符容易撞 260 上限，保留扩展名截断
  if (out.length > 120) {
    const ext = path.extname(out).slice(0, 10);
    out = out.slice(0, 120 - ext.length) + ext;
  }
  return out;
}

/**
 * 网盘相对路径 → 本地绝对路径，并保证不越出 root。
 * @returns {{abs:string, localRel:string, segments:string[]}}
 */
function resolveInside(root, rel, opts = {}) {
  const rootAbs = path.resolve(root);
  const segments = normalizeRel(rel)
    .split('/')
    .filter(Boolean)
    .map((s) => sanitizeSegment(s, opts));
  const abs = path.resolve(rootAbs, ...segments);

  const withSep = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (abs !== rootAbs && !abs.startsWith(withSep)) {
    throw new Error('路径越界，已拒绝：' + rel);
  }
  return { abs, localRel: segments.join('/'), segments };
}

/** Windows 长路径前缀：>240 字符时加 \\?\，否则会出现 ENAMETOOLONG / 静默失败 */
function toFsPath(abs, platform = process.platform) {
  if (platform !== 'win32') return abs;
  if (abs.startsWith('\\\\?\\')) return abs;
  return abs.length > 240 ? '\\\\?\\' + abs : abs;
}

/** 本地绝对路径 → 相对 root 的 POSIX 路径 */
function toRel(root, abs) {
  const r = path.relative(path.resolve(root), path.resolve(abs));
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error('不在根目录内：' + abs);
  return r.split(path.sep).join('/');
}

/** 同名去重：x.png → x (2).png，大小写不敏感（Windows 上 a.png 与 A.png 是同一个文件） */
function dedupeRel(rel, used) {
  let out = rel;
  let n = 2;
  while (used.has(out.toLowerCase())) {
    const dir = path.posix.dirname(out);
    const ext = path.posix.extname(out);
    const base = path.posix.basename(out, ext);
    // 已经带 (n) 的，先剥掉再自增，避免出现 1 (2) (3).png
    const stripped = base.replace(/ \(\d+\)$/, '');
    out = path.posix.join(dir === '.' ? '' : dir, `${stripped} (${n++})${ext}`);
  }
  used.add(out.toLowerCase());
  return out;
}

module.exports = { normalizeRel, sanitizeSegment, resolveInside, toFsPath, toRel, dedupeRel };
