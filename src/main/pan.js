/*
 * 云小抄 PC（YunX Guide Overlay · Desktop）
 * 基于 云析 YunX（https://github.com/CYQawa/YunX）与 云小抄（Android）二次开发。
 * Copyright (C) 2026 CYQawa（原项目作者）
 *
 * 本文件是 AGPL-3.0 衍生作品，完整协议见项目根目录 LICENSE。
 * 修改说明：新增文件。网盘小抄的下载层：只做「分享链接」与「我的网盘」两条来源，
 * 平台对齐手机版——夸克 / UC，接口参数与请求头逐条移植自 YunX 的 QuarkApi / UCApi。
 */

'use strict';

/**
 * 为什么是在 Node 里发请求，而不是开个隐藏浏览器点页面：
 *  1. 列表和直链都是普通 HTTPS 接口，参数已由手机版验证过，不需要模拟点击；
 *  2. 隐藏窗口要等页面渲染、要处理登录弹层，慢且不稳；
 *  3. 下载几十上百张图需要并发 + 断点 + 取消，浏览器里做不了。
 *
 * 登录仍然走真实网页（见 main.js 的登录窗口）——扫码 / 短信 / 密码都交给官方页面，
 * 我们只从会话里把 Cookie 取出来，不在本地存账号密码。
 */

const QUARK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.12-a038f7b798 Safari/537.36 Channel/pckk_other_ch';

const UC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

const UC_GUEST_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'uc-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';

const UC_CLOUD_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'uc-cloud-drive/1.6.1 Chrome/100.0.4896.160 Electron/18.3.5.16-b62cf9c50d Safari/537.36 Channel/ucpan_other_ch';

const PLATFORMS = {
  quark: {
    key: 'quark',
    label: '夸克',
    api: 'https://drive-pc.quark.cn',
    origin: 'https://pan.quark.cn',
    referer: 'https://pan.quark.cn/',
    ua: QUARK_UA,
    guestUa: QUARK_UA,
    // 必须带 fr=pc&platform=pc：裸地址只会渲染左侧的推广落地页，
    // 带上参数才是「PC 网页版」形态，右侧那块扫码登录卡片才会出来
    loginUrl: 'https://pan.quark.cn/?fr=pc&platform=pc',
    cookieDomains: ['pan.quark.cn', '.quark.cn'],
    tokenUrl: 'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc',
    detailUrl: 'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc',
    downloadUrl: 'https://drive-pc.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc&sys=win32&ve=3.23.2',
    sortUrl: 'https://drive-pc.quark.cn/1/clouddrive/file/sort?pr=ucpro&fr=pc',
  },
  uc: {
    key: 'uc',
    label: 'UC',
    api: 'https://pc-api.uc.cn',
    origin: 'https://drive.uc.cn',
    referer: 'https://drive.uc.cn/',
    ua: UC_UA,
    guestUa: UC_GUEST_UA,
    cloudUa: UC_CLOUD_UA,
    loginUrl: 'https://drive.uc.cn/',
    cookieDomains: ['drive.uc.cn', '.uc.cn'],
    tokenUrl: 'https://pc-api.uc.cn/1/clouddrive/share/sharepage/token?pr=UCBrowser&fr=pc',
    // UC 必须用 transfer_share/detail：返回的 share_fid_token 与 stoken 绑定，download 才认
    detailUrl: 'https://pc-api.uc.cn/1/clouddrive/transfer_share/detail?entry=ft&fr=pc&pr=UCBrowser',
    downloadUrl: 'https://pc-api.uc.cn/1/clouddrive/file/download?entry=ft&fr=pc&pr=UCBrowser',
    cloudDownloadUrl: 'https://pc-api.uc.cn/1/clouddrive/file/download',
    sortUrl: 'https://pc-api.uc.cn/1/clouddrive/file/sort?pr=UCBrowser&fr=pc',
  },
};

class PanError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PanError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 分享链接
// ---------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s]+/;
const QUARK_RE = /pan\.quark\.cn\/s\/([A-Za-z0-9]+)/i;
const UC_RE = /drive\.uc\.cn\/s\/([A-Za-z0-9]+)/i;
const PWD_URL_RE = /[?&]pwd=([A-Za-z0-9]+)/i;
const PWD_TEXT_RE = /(?:提取码|访问码|密码)[：:]\s*([A-Za-z0-9]{4,8})/;

/**
 * 从链接或整段分享文案里抠出平台、短码、提取码。
 * 只认夸克 / UC：其它平台要么没有游客链路，要么接口结构完全不同，写进来只会半残。
 */
function parseShare(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: '先粘贴分享链接' };
  const url = (raw.match(URL_RE) || [])[0];
  if (!url) return { ok: false, error: '没找到链接，把整段分享文案粘进来也行' };
  const pwd = (url.match(PWD_URL_RE) || [])[1] || (raw.match(PWD_TEXT_RE) || [])[1] || '';

  const quark = url.match(QUARK_RE);
  if (quark) return { ok: true, platform: 'quark', shareId: quark[1], pwd, url };

  const uc = url.match(UC_RE);
  if (uc) return { ok: true, platform: 'uc', shareId: uc[1], pwd, url };

  if (/pan\.baidu\.com|pan\.xunlei\.com|123pan|115\.com|lanzou/i.test(url)) {
    return {
      ok: false,
      error: '这个平台暂不支持一键下载，现在只能直连夸克 / UC 分享。百度、迅雷、123 请用云析 PC 版转存后再下。',
    };
  }
  return { ok: false, error: '没认出这个链接，支持 pan.quark.cn/s/… 与 drive.uc.cn/s/…' };
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/** 从 Set-Cookie 合并进 cookie 串；__puus 会随响应刷新，不合并会让后续请求 401 */
function mergeCookies(base, setCookies) {
  const map = new Map();
  for (const part of String(base || '').split(';')) {
    const kv = part.trim();
    if (!kv) continue;
    const i = kv.indexOf('=');
    if (i > 0) map.set(kv.slice(0, i), kv.slice(i + 1));
  }
  for (const line of setCookies || []) {
    const kv = String(line).split(';')[0].trim();
    const i = kv.indexOf('=');
    if (i <= 0) continue;
    map.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ');
}

function pickGuestCookie(setCookies) {
  for (const line of setCookies || []) {
    const kv = String(line).split(';')[0].trim();
    if (kv.startsWith('__pugs=') && kv.length > 7) return kv;
  }
  return '';
}

/**
 * 统一的接口调用。业务失败看 body 里的 status / code，而不是 HTTP 状态码：
 * 夸克「分享不存在」返回的就是 HTTP 404 + 一段 JSON。
 */
async function apiJson(url, { platform, cookie, method = 'GET', body, timeout = 25000 } = {}) {
  const p = PLATFORMS[platform];
  if (!p) throw new PanError('未知平台');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const headers = {
      'User-Agent': p.ua,
      Accept: 'application/json, text/plain, */*',
      Origin: p.origin,
      Referer: p.referer,
    };
    if (cookie) headers.Cookie = cookie;
    if (body) headers['Content-Type'] = 'application/json;charset=UTF-8';

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new PanError(`接口返回了网页而不是数据（HTTP ${res.status}），多半是被风控拦了，过一会儿再试`);
    }
    if (json.status !== 200 && json.code !== 0) {
      throw new PanError(friendlyError(platform, json.code, json.message), json.code);
    }
    return { data: json.data || {}, setCookies };
  } catch (e) {
    if (e.name === 'AbortError') throw new PanError('网络超时，检查一下代理或网络');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function friendlyError(platform, code, message) {
  const table = {
    23018: '这个文件超出未登录可下载的大小上限（夸克约 50MB），登录后再下',
    31001: `需要登录${PLATFORMS[platform].label}网盘才能下载这个分享`,
    14001: '分享已失效或提取码不对',
    41020: '文件令牌过期了，重新点一次下载',
    41006: '分享不存在，可能作者删了或者链接复制少了几位',
  };
  return table[code] || message || `请求失败${code ? '（' + code + '）' : ''}`;
}

// ---------------------------------------------------------------------------
// 分享：会话 → 列表 → 直链
// ---------------------------------------------------------------------------

const guestCookies = { quark: '', uc: '' };

async function openShare({ platform, shareId, pwd, cookie = '' }) {
  const p = PLATFORMS[platform];
  const body =
    platform === 'uc'
      ? { pwd_id: shareId, passcode: pwd || '', share_for_transfer: true }
      : { pwd_id: shareId, passcode: pwd || '', support_visit_limit_private_share: true };

  const { data, setCookies } = await apiJson(p.tokenUrl, { platform, cookie, method: 'POST', body });
  const stoken = String(data.stoken || '');
  if (!stoken) throw new PanError('没拿到分享凭证，链接可能已失效');

  return {
    platform,
    shareId,
    stoken,
    title: String(data.title || '').trim(),
    cookie: mergeCookies(cookie, setCookies),
    guest: !cookie,
  };
}

/**
 * 列表项里的「修改时间」。
 * 夸克与 UC 的字段名不统一，而且同一家不同接口给的单位也不同（秒 / 毫秒），
 * 这里只负责尽量取到一个数字，统一折算交给 sync/dedup 的 normalizeCloudTime。
 * 取不到就返回 0 —— 上层会降级成「按大小 + 索引判定」，不会因此全量重下。
 */
function pickMtime(item) {
  const v =
    item.updated_at ??
    item.file_mtime ??
    item.modified_at ??
    item.mtime ??
    item.update_time ??
    item.edit_time ??
    0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 列分享目录（自动翻页）。字段名两套兼容：file_name/fname、dir/isdir */
async function listShare(session, dirFid = '0') {
  const p = PLATFORMS[session.platform];
  const all = [];
  for (let page = 1; page <= 100; page++) {
    let url;
    if (session.platform === 'uc') {
      url =
        `${p.detailUrl}&pwd_id=${encodeURIComponent(session.shareId)}` +
        `&pdir_fid=${encodeURIComponent(dirFid)}&fetch_file_list=1&passcode=` +
        `&_page=${page}&_size=50&_fetch_total=1&_fetch_task=1&_fetch_share=1&_sort=` +
        `&stoken=${encodeURIComponent(session.stoken)}`;
    } else {
      url =
        `${p.detailUrl}&pwd_id=${encodeURIComponent(session.shareId)}` +
        `&stoken=${encodeURIComponent(session.stoken)}&pdir_fid=${encodeURIComponent(dirFid)}` +
        `&ver=2&force=0&_page=${page}&_size=100&_fetch_banner=0&_fetch_share=0` +
        `&fetch_relate_conversation=0&_fetch_total=1&_sort=file_type:asc,file_name:asc`;
    }
    const { data, setCookies } = await apiJson(url, {
      platform: session.platform,
      cookie: session.cookie,
    });
    if (session.cookie) session.cookie = mergeCookies(session.cookie, setCookies);

    const list = data.list || (data.detail_info && data.detail_info.list) || [];
    for (const item of list) {
      all.push({
        fid: String(item.fid || ''),
        name: String(item.file_name || item.fname || ''),
        size: Number(item.size || item.fsize || 0),
        dir: !!(item.dir || item.isdir === 1),
        fidToken: String(item.share_fid_token || item.fid_token || ''),
        mtime: pickMtime(item),
      });
    }
    const pageSize = session.platform === 'uc' ? 50 : 100;
    if (list.length < pageSize) break;
  }
  return all;
}

/** 分享文件取直链。登录态无 50MB 限制；游客走 __pugs 链路 */
async function shareLink(session, file) {
  const p = PLATFORMS[session.platform];
  const body = {
    fids: [file.fid],
    fids_token: [file.fidToken],
    pwd_id: session.shareId,
    stoken: session.stoken,
    speedup_session: '',
    token: '',
  };

  const useCookie = session.cookie || guestCookies[session.platform] || '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  let res;
  try {
    res = await fetch(p.downloadUrl, {
      method: 'POST',
      headers: {
        'User-Agent': session.cookie ? p.ua : p.guestUa,
        'Content-Type': 'application/json;charset=UTF-8',
        ...(useCookie ? { Cookie: useCookie } : {}),
        ...(session.platform === 'uc' ? { Origin: p.origin, Referer: p.referer } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      redirect: 'follow',
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new PanError('取下载地址超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PanError(`取下载地址失败（HTTP ${res.status}）`);
  }
  if (json.status !== 200 && json.code !== 0) {
    throw new PanError(friendlyError(session.platform, json.code, json.message), json.code);
  }
  const item = (json.data || [])[0];
  if (!item || !item.download_url) throw new PanError('服务端没返回下载地址');

  const pugs = pickGuestCookie(setCookies);
  if (pugs) guestCookies[session.platform] = pugs;

  const downloadCookie = session.cookie ? mergeCookies(session.cookie, setCookies) : pugs || useCookie;
  return {
    url: item.download_url,
    headers: downloadHeaders(session.platform, downloadCookie),
    size: Number(item.size || 0),
  };
}

// ---------------------------------------------------------------------------
// 我的网盘
// ---------------------------------------------------------------------------

async function listCloud({ platform, cookie, fid = '0' }) {
  const p = PLATFORMS[platform];
  if (!cookie) throw new PanError(`还没登录${p.label}网盘`);
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const url =
      `${p.sortUrl}&uc_param_str=&pdir_fid=${encodeURIComponent(fid)}&_page=${page}&_size=100` +
      `&_fetch_total=1&_fetch_sub_dirs=0&_sort=file_type:asc,updated_at:desc` +
      `&fetch_all_file=1&fetch_risk_file_name=1`;
    const { data, setCookies } = await apiJson(url, { platform, cookie });
    const list = data.list || [];
    for (const item of list) {
      all.push({
        fid: String(item.fid || ''),
        name: String(item.file_name || item.fname || ''),
        size: Number(item.size || 0),
        dir: !!(item.dir || item.isdir === 1),
        mtime: pickMtime(item),
      });
    }
    if (list.length < 100) break;
  }
  return all;
}

async function cloudLink({ platform, fid, cookie }) {
  const p = PLATFORMS[platform];
  if (!cookie) throw new PanError(`还没登录${p.label}网盘`);
  const url = platform === 'uc' ? `${p.cloudDownloadUrl}?pr=UCBrowser&fr=pc&sys=win32&ve=1.6.1` : p.downloadUrl;
  const { data, setCookies } = await apiJson(url, {
    platform,
    cookie,
    method: 'POST',
    body: { fids: [fid] },
  });
  const item = (data || [])[0];
  if (!item || !item.download_url) throw new PanError('服务端没返回下载地址');
  const merged = mergeCookies(cookie, setCookies);
  return {
    url: item.download_url,
    headers: downloadHeaders(platform, merged),
    size: Number(item.size || 0),
    cookie: merged,
  };
}

function downloadHeaders(platform, cookie) {
  const p = PLATFORMS[platform];
  const headers = {
    'User-Agent': platform === 'uc' ? p.guestUa : p.ua,
    Accept: 'image/*,*/*;q=0.8',
    'Accept-Encoding': 'identity',
    Referer: p.referer,
  };
  if (platform === 'uc') headers.Origin = p.origin;
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/** 登录态是否还活着：拿一页空列表探一下，不要为了验证把整个网盘列一遍 */
async function checkLogin({ platform, cookie }) {
  if (!cookie) return false;
  const p = PLATFORMS[platform];
  try {
    await apiJson(
      `${p.sortUrl}&uc_param_str=&pdir_fid=0&_page=1&_size=1&_fetch_total=1&_fetch_sub_dirs=0` +
        `&_sort=file_type:asc,updated_at:desc`,
      { platform, cookie, timeout: 12000 }
    );
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  PLATFORMS,
  PanError,
  parseShare,
  openShare,
  listShare,
  shareLink,
  listCloud,
  cloudLink,
  checkLogin,
  mergeCookies,
  pickMtime,
};
