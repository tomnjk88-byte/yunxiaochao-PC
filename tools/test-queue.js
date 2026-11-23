/*
 * 云小抄 PC · 下载队列端到端自测
 * 跑法：node --test tools/test-queue.js
 *
 * 用一个本地 HTTP 服务冒充网盘直链，真下真写盘真建索引，
 * 验证「下完 → 再点下载 → 一个都不重下」这条最关键的闭环。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const pan = require('../src/main/pan');
const { JsonIndex } = require('../src/main/sync/index');
const { DownloadQueue } = require('../src/main/sync/queue');

let TMP;
let server;
let PORT;
const FILES = {};
const HITS = {};

test.before(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yunx-queue-'));
  for (let i = 1; i <= 5; i++) {
    FILES[`f${i}`] = Buffer.from(`file-${i}-`.repeat(200));
  }
  server = http.createServer((req, res) => {
    const key = String(req.url || '').replace('/dl/', '');
    HITS[key] = (HITS[key] || 0) + 1;
    const buf = FILES[key];
    if (!buf) {
      res.writeHead(404);
      return res.end('no');
    }
    res.writeHead(200, { 'Content-Length': buf.length, 'Content-Type': 'image/png' });
    res.end(buf);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
});

test.after(() => {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const CLOUD_MTIME = 1_700_000_000;

function mockLink() {
  // 冒充夸克「我的网盘」取直链
  pan.cloudLink = async ({ fid }) => ({
    url: `http://127.0.0.1:${PORT}/dl/${fid}`,
    headers: {},
    size: FILES[fid].length,
    cookie: 'x=1',
  });
}

function makeItems() {
  return Object.keys(FILES).map((fid, i) => ({
    cloudRel: `分类A/子目录${(i % 2) + 1}/${fid}.png`,
    size: FILES[fid].length,
    mtime: CLOUD_MTIME,
    fid,
    cloudId: fid,
  }));
}

function waitDone(q, id, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const t = q.tasks.find((x) => x.id === id);
      if (!t) return reject(new Error('任务不存在'));
      if (['done', 'error', 'canceled', 'paused'].includes(t.status)) return resolve(t);
      if (Date.now() - t0 > timeout) return reject(new Error('超时：' + t.status + ' ' + t.message));
      setTimeout(tick, 40);
    };
    tick();
  });
}

test('队列：首次下载全部落盘，目录结构与网盘 1:1', async () => {
  mockLink();
  const dest = path.join(TMP, 'dl1');
  const index = new JsonIndex(path.join(TMP, 'i1.json')).open();
  const q = new DownloadQueue({ index, getCookie: () => 'x=1', onCookie: () => {}, onChange: () => {} });

  const { id } = q.enqueue({
    platform: 'quark',
    title: '我的网盘',
    dest,
    rootId: 'quark|' + dest,
    items: makeItems(),
    session: { platform: 'quark', cookie: 'x=1', cloud: true },
  });
  const t = await waitDone(q, id);

  assert.equal(t.status, 'done', t.message);
  assert.equal(t.done, 5);
  assert.equal(t.failed, 0);

  for (const [fid, buf] of Object.entries(FILES)) {
    const i = Object.keys(FILES).indexOf(fid);
    const abs = path.join(dest, '分类A', `子目录${(i % 2) + 1}`, `${fid}.png`);
    assert.ok(fs.existsSync(abs), '缺文件：' + abs);
    assert.equal(fs.readFileSync(abs).length, buf.length);
    // 修改时间必须写回网盘时间，否则下次比对必然不一致
    assert.equal(Math.floor(fs.statSync(abs).mtimeMs / 1000), CLOUD_MTIME);
  }
  await index.flush();
});

test('队列：同一批再下一次 → 0 个下载、全部跳过（核心诉求）', async () => {
  mockLink();
  const dest = path.join(TMP, 'dl1');
  const index = new JsonIndex(path.join(TMP, 'i1.json')).open();
  const q = new DownloadQueue({ index, getCookie: () => 'x=1', onCookie: () => {}, onChange: () => {} });

  for (const k of Object.keys(HITS)) HITS[k] = 0;

  const { id } = q.enqueue({
    platform: 'quark',
    title: '我的网盘',
    dest,
    rootId: 'quark|' + dest,
    items: makeItems(),
    session: { platform: 'quark', cookie: 'x=1', cloud: true },
  });
  const t = await waitDone(q, id);

  assert.equal(t.status, 'done');
  assert.equal(t.done, 0, '不应该再下载任何文件');
  assert.equal(t.skipped, 5, '5 个都应该判定为已下载');
  assert.equal(Object.values(HITS).reduce((a, b) => a + b, 0), 0, '一次直链请求都不该发');
});

test('队列：删掉本地一个文件 → 只补这一个', async () => {
  mockLink();
  const dest = path.join(TMP, 'dl1');
  const victim = path.join(dest, '分类A', '子目录1', 'f1.png');
  fs.rmSync(victim);

  const index = new JsonIndex(path.join(TMP, 'i1.json')).open();
  const q = new DownloadQueue({ index, getCookie: () => 'x=1', onCookie: () => {}, onChange: () => {} });
  for (const k of Object.keys(HITS)) HITS[k] = 0;

  const { id } = q.enqueue({
    platform: 'quark',
    title: '我的网盘',
    dest,
    rootId: 'quark|' + dest,
    items: makeItems(),
    session: { platform: 'quark', cookie: 'x=1', cloud: true },
  });
  const t = await waitDone(q, id);

  assert.equal(t.done, 1);
  assert.equal(t.skipped, 4);
  assert.equal(HITS.f1, 1, '只有被删的那个该发一次请求');
  assert.equal(HITS.f2 || 0, 0);
});

test('队列：本地被改过（时间变了）→ 重下覆盖', async () => {
  mockLink();
  const dest = path.join(TMP, 'dl1');
  const target = path.join(dest, '分类A', '子目录2', 'f2.png');
  fs.utimesSync(target, new Date(), new Date(1_600_000_000 * 1000));

  const index = new JsonIndex(path.join(TMP, 'i1.json')).open();
  const q = new DownloadQueue({ index, getCookie: () => 'x=1', onCookie: () => {}, onChange: () => {} });
  for (const k of Object.keys(HITS)) HITS[k] = 0;

  const { id } = q.enqueue({
    platform: 'quark',
    title: '我的网盘',
    dest,
    rootId: 'quark|' + dest,
    items: makeItems(),
    session: { platform: 'quark', cookie: 'x=1', cloud: true },
  });
  const t = await waitDone(q, id);
  assert.equal(t.done, 1);
  assert.equal(HITS.f2, 1);
  // 覆盖后时间被拉回网盘时间
  assert.equal(Math.floor(fs.statSync(target).mtimeMs / 1000), CLOUD_MTIME);
});

test('队列：取消后不再继续，已完成的不回滚', async () => {
  mockLink();
  const dest = path.join(TMP, 'dl2');
  const index = new JsonIndex(path.join(TMP, 'i2.json')).open();
  const q = new DownloadQueue({ index, getCookie: () => 'x=1', onCookie: () => {}, onChange: () => {} });

  const { id } = q.enqueue({
    platform: 'quark',
    title: '我的网盘',
    dest,
    rootId: 'quark|' + dest,
    items: makeItems(),
    session: { platform: 'quark', cookie: 'x=1', cloud: true },
  });
  q.cancel(id);
  const t = await waitDone(q, id);
  assert.equal(t.status, 'canceled');
  assert.equal(t.endedAt > 0, true);
});

test('dryRun：预检不需要真下载就能报出跳过数', async () => {
  const dest = path.join(TMP, 'dl1');
  const index = new JsonIndex(path.join(TMP, 'i1.json')).open();
  const q = new DownloadQueue({ index, getCookie: () => 'x=1', onCookie: () => {}, onChange: () => {} });
  const r = await q.dryRun({
    platform: 'quark',
    dest,
    rootId: 'quark|' + dest,
    items: makeItems(),
    session: { platform: 'quark', cookie: 'x=1', cloud: true },
  });
  assert.equal(r.ok, true);
  assert.equal(r.counts.skip, 5);
  assert.equal(r.counts.download, 0);
});
