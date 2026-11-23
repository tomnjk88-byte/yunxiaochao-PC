/*
 * 云小抄 PC · 网盘同步内核自测
 * 跑法：node --test tools/test-sync.js
 *
 * 全部用真实文件 + 真实 stat，不 mock fs —— 防重复下载这种东西，
 * mock 出来的绿灯一文不值。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { normalizeRel, sanitizeSegment, resolveInside, toFsPath, dedupeRel } = require('../src/main/sync/paths');
const { decide, commitDownload, ACTION, REASON } = require('../src/main/sync/dedup');
const { JsonIndex } = require('../src/main/sync/index');
const { buildPlan } = require('../src/main/sync/plan');

let TMP;
test.before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yunx-sync-'));
});
test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function freshDir(name) {
  const d = path.join(TMP, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeFile(abs, content, mtimeSec) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  if (mtimeSec) fs.utimesSync(abs, new Date(), new Date(mtimeSec * 1000));
  return abs;
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

test('paths: 拒绝 ../ 越界', () => {
  assert.throws(() => resolveInside('/tmp/root', '../etc/passwd'), /越界|\.\./);
  assert.throws(() => normalizeRel('a/../../b'), /\.\./);
});

test('paths: 反斜杠与重复斜杠归一', () => {
  assert.equal(normalizeRel('a\\b//c/'), 'a/b/c');
  assert.equal(normalizeRel('/a/b/'), 'a/b');
});

test('paths: Windows 非法字符被替换、结尾点空格被削', () => {
  const r = resolveInside('C:\\root', 'a<b>c:d.png', { mode: 'sanitize', platform: 'win32' });
  assert.equal(r.localRel, 'a_b_c_d.png');
  const r2 = resolveInside('C:\\root', 'dir./x .png', { mode: 'sanitize', platform: 'win32' });
  assert.equal(r2.localRel, 'dir/x .png'.replace('x ', 'x ')); // 只削结尾
  const r3 = resolveInside('C:\\root', 'name... ', { mode: 'sanitize', platform: 'win32' });
  assert.equal(r3.localRel, 'name');
});

test('paths: Windows 保留名加下划线', () => {
  const r = resolveInside('C:\\root', 'CON.txt', { mode: 'sanitize', platform: 'win32' });
  assert.equal(r.localRel, '_CON.txt');
});

test('paths: strict 模式遇到非法字符直接报错', () => {
  assert.throws(() => sanitizeSegment('a?b.png', { platform: 'win32', mode: 'strict' }), /非法字符/);
});

test('paths: 长路径加 \\\\?\\ 前缀', () => {
  const long = 'C:\\' + 'a'.repeat(260);
  assert.ok(toFsPath(long, 'win32').startsWith('\\\\?\\'));
  assert.equal(toFsPath('C:\\short', 'win32'), 'C:\\short');
  assert.equal(toFsPath('/tmp/x', 'linux'), '/tmp/x');
});

test('paths: 同名去重大小写不敏感且不叠括号', () => {
  const used = new Set();
  assert.equal(dedupeRel('a/1.png', used), 'a/1.png');
  assert.equal(dedupeRel('a/1.PNG', used), 'a/1 (2).PNG');
  assert.equal(dedupeRel('a/1.png', used), 'a/1 (3).png');
});

// ---------------------------------------------------------------------------
// dedup
// ---------------------------------------------------------------------------

function ctxFor(root, index, rootId) {
  return { root, index, rootId, platform: 'linux', mode: 'sanitize' };
}

test('dedup: 本地没有 → download/missing', async () => {
  const root = freshDir('d1');
  const index = new JsonIndex(path.join(TMP, 'd1.json')).open();
  const d = await decide({ cloudRel: 'a/1.png', size: 10, mtime: 1000 }, ctxFor(root, index, 'r'));
  assert.equal(d.action, ACTION.DOWNLOAD);
  assert.equal(d.reason, REASON.MISSING);
  assert.equal(d.absPath, path.join(root, 'a/1.png'));
});

test('dedup: 大小不同 → download/size_mismatch', async () => {
  const root = freshDir('d2');
  const index = new JsonIndex(path.join(TMP, 'd2.json')).open();
  writeFile(path.join(root, 'a/1.png'), '12345', 1000);
  const d = await decide({ cloudRel: 'a/1.png', size: 99, mtime: 1000 }, ctxFor(root, index, 'r'));
  assert.equal(d.reason, REASON.SIZE_MISMATCH);
});

test('dedup: 时间不同（超出 2 秒容差）→ download/mtime_mismatch', async () => {
  const root = freshDir('d3');
  const index = new JsonIndex(path.join(TMP, 'd3.json')).open();
  writeFile(path.join(root, 'a/1.png'), '12345', 1000);
  const d = await decide({ cloudRel: 'a/1.png', size: 5, mtime: 1000 + 10 }, ctxFor(root, index, 'r'));
  assert.equal(d.reason, REASON.MTIME_MISMATCH);
});

test('dedup: 时间差 1 秒（FAT32 精度内）→ 不算不一致', async () => {
  const root = freshDir('d4');
  const index = new JsonIndex(path.join(TMP, 'd4.json')).open();
  writeFile(path.join(root, 'a/1.png'), '12345', 1000);
  const d = await decide({ cloudRel: 'a/1.png', size: 5, mtime: 1001 }, ctxFor(root, index, 'r'));
  assert.equal(d.action, ACTION.ADOPT); // 时间在容差内，但没索引 → 补记
});

test('dedup: 磁盘与网盘一致但没索引 → adopt', async () => {
  const root = freshDir('d5');
  const index = new JsonIndex(path.join(TMP, 'd5.json')).open();
  writeFile(path.join(root, 'a/1.png'), '12345', 1000);
  const d = await decide({ cloudRel: 'a/1.png', size: 5, mtime: 1000 }, ctxFor(root, index, 'r'));
  assert.equal(d.action, ACTION.ADOPT);
  assert.equal(d.reason, REASON.ADOPTED);
});

test('dedup: 索引 + 磁盘双向一致 → skip/index_hit', async () => {
  const root = freshDir('d6');
  const index = new JsonIndex(path.join(TMP, 'd6.json')).open();
  writeFile(path.join(root, 'a/1.png'), '12345', 1000);
  index.upsert('r', { cloudRel: 'a/1.png', localRel: 'a/1.png', size: 5, cloudMtime: 1000, localMtime: 1000, state: 'done' });
  const d = await decide({ cloudRel: 'a/1.png', size: 5, mtime: 1000 }, ctxFor(root, index, 'r'));
  assert.equal(d.action, ACTION.SKIP);
  assert.equal(d.reason, REASON.INDEX_HIT);
});

test('dedup: 网盘没给 mtime，但索引与大小都对 → skip/index_hit_weak（不能全量重下）', async () => {
  const root = freshDir('d7');
  const index = new JsonIndex(path.join(TMP, 'd7.json')).open();
  writeFile(path.join(root, 'a/1.png'), '12345', 1000);
  index.upsert('r', { cloudRel: 'a/1.png', localRel: 'a/1.png', size: 5, cloudMtime: null, localMtime: 1000, state: 'done' });
  const d = await decide({ cloudRel: 'a/1.png', size: 5 }, ctxFor(root, index, 'r'));
  assert.equal(d.action, ACTION.SKIP);
  assert.equal(d.reason, REASON.INDEX_HIT_WEAK);
});

test('dedup: 网盘大小时间全无 → download/unverifiable', async () => {
  const root = freshDir('d8');
  const index = new JsonIndex(path.join(TMP, 'd8.json')).open();
  writeFile(path.join(root, 'a/1.png'), '12345', 1000);
  const d = await decide({ cloudRel: 'a/1.png' }, ctxFor(root, index, 'r'));
  assert.equal(d.reason, REASON.UNVERIFIABLE);
});

test('dedup: 同名位置是目录 → download/type_mismatch', async () => {
  const root = freshDir('d9');
  const index = new JsonIndex(path.join(TMP, 'd9.json')).open();
  fs.mkdirSync(path.join(root, 'a/1.png'), { recursive: true });
  const d = await decide({ cloudRel: 'a/1.png', size: 5, mtime: 1000 }, ctxFor(root, index, 'r'));
  assert.equal(d.reason, REASON.TYPE_MISMATCH);
});

test('dedup: 本地被改过、索引还是旧的 → cloud_changed 覆盖', async () => {
  const root = freshDir('d10');
  const index = new JsonIndex(path.join(TMP, 'd10.json')).open();
  writeFile(path.join(root, 'a/1.png'), '1234567890', 2000); // 用户自己改过，时间也变了
  index.upsert('r', { cloudRel: 'a/1.png', localRel: 'a/1.png', size: 5, cloudMtime: 1000, localMtime: 1000, state: 'done' });
  const d = await decide({ cloudRel: 'a/1.png', size: 10, mtime: 2000 }, ctxFor(root, index, 'r'));
  assert.equal(d.action, ACTION.DOWNLOAD);
  assert.equal(d.reason, REASON.CLOUD_CHANGED);
});

test('dedup: 毫秒时间戳自动折成秒', async () => {
  const root = freshDir('d11');
  const index = new JsonIndex(path.join(TMP, 'd11.json')).open();
  writeFile(path.join(root, 'a/1.png'), '12345', 1_700_000_000);
  index.upsert('r', { cloudRel: 'a/1.png', localRel: 'a/1.png', size: 5, cloudMtime: 1_700_000_000, state: 'done' });
  // 接口给的是毫秒
  const d = await decide({ cloudRel: 'a/1.png', size: 5, mtime: 1_700_000_000_000 }, ctxFor(root, index, 'r'));
  assert.equal(d.action, ACTION.SKIP);
});

test('commitDownload: 写回网盘 mtime，再判定必为 skip', async () => {
  const root = freshDir('d12');
  const index = new JsonIndex(path.join(TMP, 'd12.json')).open();
  const tmp = writeFile(path.join(root, '.tmp/1.png.part'), 'abcdef', 0);
  const target = path.join(root, 'a/1.png');

  await commitDownload({
    tmpPath: tmp,
    targetAbs: target,
    cloudMtime: 1_700_000_000,
    index,
    rootId: 'r',
    localRel: 'a/1.png',
    cloudRel: 'a/1.png',
  });

  const st = fs.statSync(target);
  assert.equal(st.size, 6);
  assert.equal(Math.floor(st.mtimeMs / 1000), 1_700_000_000);

  const d = await decide({ cloudRel: 'a/1.png', size: 6, mtime: 1_700_000_000 }, ctxFor(root, index, 'r'));
  assert.equal(d.action, ACTION.SKIP, '下完立刻再规划，必须判定跳过');
});

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

test('plan: 三态计数 + 碰撞检测', async () => {
  const root = freshDir('p1');
  const index = new JsonIndex(path.join(TMP, 'p1.json')).open();

  writeFile(path.join(root, 'keep/1.png'), '12345', 1000);
  index.upsert('r', { cloudRel: 'keep/1.png', localRel: 'keep/1.png', size: 5, cloudMtime: 1000, state: 'done' });
  writeFile(path.join(root, 'adopt/2.png'), 'abc', 2000);

  const items = [
    { cloudRel: 'keep/1.png', size: 5, mtime: 1000 },
    { cloudRel: 'adopt/2.png', size: 3, mtime: 2000 },
    { cloudRel: 'new/3.png', size: 7, mtime: 3000 },
    { cloudRel: 'new/3.png', size: 7, mtime: 3000 },
    // Windows 下 a:b 与 a?b 清洗后都落到 a_b.png
    { cloudRel: 'new/a:b.png', size: 10, mtime: 1000 },
    { cloudRel: 'new2/a?b.png', size: 10, mtime: 1000 },
  ];
  const p = await buildPlan(plan2(items), { root, index, rootId: 'r', platform: 'win32' });
  // 注意：a:b 与 a?b 落在不同父目录，不算碰撞；这里只是确认清洗生效
  assert.equal(p.counts.total, 5);
  assert.equal(p.counts.duplicated, 1);
  assert.ok(p.counts.skip >= 1);
  assert.ok(p.counts.adopt >= 1);
  assert.ok(p.counts.download >= 1);
});

function plan2(items) {
  return items;
}

test('plan: 清洗后撞到同一路径 → collisions 报出来', async () => {
  const root = freshDir('p2');
  const index = new JsonIndex(path.join(TMP, 'p2.json')).open();
  const items = [
    { cloudRel: 'dir/a:b.png', size: 1, mtime: 1 },
    { cloudRel: 'dir/a?b.png', size: 1, mtime: 1 },
  ];
  const p = await buildPlan(items, { root, index, rootId: 'r', platform: 'win32', mode: 'sanitize' });
  assert.equal(p.collisions.length, 1);
  assert.equal(p.collisions[0].localRel, 'dir/a_b.png');
  assert.equal(p.counts.collisions, 1);
  // 碰撞的必须留在下载堆里，不能静默丢
  assert.equal(p.counts.download, 2);
});

test('plan: bytesToDownload 只算要下的', async () => {
  const root = freshDir('p3');
  const index = new JsonIndex(path.join(TMP, 'p3.json')).open();
  writeFile(path.join(root, 'x.png'), '12345', 1000);
  index.upsert('r', { cloudRel: 'x.png', localRel: 'x.png', size: 5, cloudMtime: 1000, state: 'done' });
  const p = await buildPlan(
    [
      { cloudRel: 'x.png', size: 5, mtime: 1000 },
      { cloudRel: 'y.png', size: 100, mtime: 1000 },
    ],
    { root, index, rootId: 'r', platform: 'linux' }
  );
  assert.equal(p.counts.bytesToDownload, 100);
});

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

test('index: 落盘 → 重新打开仍在', async () => {
  const file = path.join(TMP, 'idx', 'pan-index.json');
  const a = new JsonIndex(file).open();
  a.upsert('quark|D:\\小抄', { cloudRel: 'a/1.png', localRel: 'a/1.png', size: 1, cloudMtime: 1, state: 'done' });
  await a.close();

  const b = new JsonIndex(file).open();
  const row = b.get('quark|D:\\小抄', 'a/1.png');
  assert.ok(row, '索引必须持久化');
  assert.equal(row.size, 1);
});

test('index: 不同根目录互不串', async () => {
  const index = new JsonIndex(path.join(TMP, 'idx2.json')).open();
  index.upsert('r1', { cloudRel: 'a.png', localRel: 'a.png', size: 1, state: 'done' });
  assert.ok(index.get('r1', 'a.png'));
  assert.equal(index.get('r2', 'a.png'), null);
});

test('index: prune 清掉本地已删除的记录', async () => {
  const index = new JsonIndex(path.join(TMP, 'idx3.json')).open();
  index.upsert('r', { cloudRel: 'a.png', localRel: 'a.png', size: 1, state: 'done' });
  index.upsert('r', { cloudRel: 'b.png', localRel: 'b.png', size: 1, state: 'done' });
  const n = index.prune('r', (row) => row.localRel === 'a.png');
  assert.equal(n, 1);
  assert.ok(index.get('r', 'a.png'));
  assert.equal(index.get('r', 'b.png'), null);
});
