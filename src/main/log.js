'use strict';

/**
 * 全局日志（v1.4.0）
 *
 * 为什么必须自己写而不是用 console：
 *   打包后是 --asar + Windows GUI 子系统，进程没有控制台，stdout 全部丢弃。
 *   用户在别人电脑上崩了，你手上连一行堆栈都没有，只能靠猜。
 *
 * 设计约束：
 *   1. 日志系统自身绝不能抛 —— 所有 IO 都用 try 包住，写失败就只进内存；
 *   2. 崩溃钩子里必须能同步落盘 —— 提供 flushSync()，不走异步队列；
 *   3. 高频路径不写盘 —— 下载进度这类每 100ms 一次的日志降级为 debug，
 *      默认级别 info 时直接丢弃，避免几千个文件把磁盘刷满。
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_MAX = 600;
const KEEP_DAYS = 7;

let baseDir = '';
let dayKey = '';
let stream = null;
let minLevel = process.env.YUNX_LOG === 'debug' ? LEVELS.debug : LEVELS.info;
let ready = false;
const ring = [];
let dropped = 0;

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

/** 本地时间，人类可读。ISO 的 Z 后缀对着一堆 UTC 时间排查很费劲 */
function stamp(d = new Date()) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function dayOf(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmt(v, depth = 0) {
  if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack || ''}`;
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') {
    if (depth > 2) return '[object]';
    try {
      return JSON.stringify(v);
    } catch {
      return '[unserializable]';
    }
  }
  return String(v);
}

/** 只保留最近 KEEP_DAYS 天，避免 userData 无限膨胀 */
function prune() {
  try {
    const files = fs.readdirSync(baseDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_DAYS))) {
      fs.unlinkSync(path.join(baseDir, f));
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

function open() {
  if (stream) return true;
  try {
    // 延迟到首次写入再取 userData：app ready 前后都能工作，但避免 require 阶段就依赖 app
    const { app } = require('electron');
    baseDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(baseDir, { recursive: true });
    dayKey = dayOf();
    stream = fs.createWriteStream(path.join(baseDir, `${dayKey}.log`), { flags: 'a' });
    stream.on('error', () => {
      // 磁盘满 / 权限变更：关掉流，退回纯内存模式，不要让 error 事件冒到 uncaughtException
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
      stream = null;
    });
    ready = true;
    prune();
    return true;
  } catch {
    ready = false;
    return false;
  }
}

function line(level, tag, args) {
  const body = args.map((a) => fmt(a)).join(' ');
  return `${stamp()} ${level.toUpperCase().padEnd(5)} [${tag}] ${body}`;
}

function write(level, tag, args) {
  if (LEVELS[level] < minLevel) return;
  const text = line(level, tag, args);

  ring.push(text);
  if (ring.length > RING_MAX) {
    ring.shift();
    dropped++;
  }

  if (!open() || !stream) return;
  try {
    // 跨天自动切文件
    const today = dayOf();
    if (today !== dayKey) {
      try {
        stream.end();
      } catch {
        /* ignore */
      }
      stream = null;
      open();
    }
    stream.write(text + '\n');
  } catch {
    /* 写失败就只留内存，绝不再抛 */
  }
}

/**
 * 同步落盘。只在崩溃钩子与退出时调用：
 * 崩溃瞬间异步队列大概率来不及 flush，这里直接 appendFileSync。
 */
function flushSync() {
  try {
    if (stream) {
      stream.end();
      stream = null;
    }
    if (!baseDir) {
      const { app } = require('electron');
      baseDir = path.join(app.getPath('userData'), 'logs');
    }
    fs.mkdirSync(baseDir, { recursive: true });
    const tail = ring.slice(-120).join('\n');
    if (tail) {
      fs.appendFileSync(path.join(baseDir, `${dayOf()}.log`), tail + '\n', 'utf8');
    }
  } catch {
    /* 崩溃路径里唯一的要求是「不要二次崩溃」 */
  }
}

function withLevel(level) {
  return (tag, ...args) => write(level, tag, args);
}

const log = {
  debug: withLevel('debug'),
  info: withLevel('info'),
  warn: withLevel('warn'),
  error: withLevel('error'),

  /** 给界面「导出诊断」用：最近若干行 + 环境信息 */
  recent(n = 200) {
    const head = [
      `app=${process.versions.electron} node=${process.versions.node} chrome=${process.versions.chrome}`,
      `platform=${process.platform} ${process.arch} release=${require('os').release()}`,
      `cwd=${process.cwd()}`,
    ];
    return head.concat(ring.slice(-n)).join('\n');
  },

  dir() {
    return baseDir;
  },

  flushSync,

  setLevel(name) {
    if (LEVELS[name]) minLevel = LEVELS[name];
  },

  /** 拿一个带前缀的子 logger，省得到处手写 tag */
  scope(tag) {
    return {
      debug: (...a) => write('debug', tag, a),
      info: (...a) => write('info', tag, a),
      warn: (...a) => write('warn', tag, a),
      error: (...a) => write('error', tag, a),
    };
  },
};

/**
 * 包装 ipcMain.handle：任何异常都不许穿过 IPC 边界。
 * 穿过会怎样？渲染层的 invoke 变成 rejected promise，如果那边没 catch，
 * 就是一条 unhandledRejection；主进程这边则是一个没人管的异常上下文。
 */
function safeHandle(ipcMain, channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (e) {
      log.error('ipc', `${channel} 抛错:`, e);
      return { ok: false, error: (e && e.message) || '内部错误', channel };
    }
  });
}

module.exports = { log, safeHandle, LEVELS };
