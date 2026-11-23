/*
 * 云小抄 PC · 网盘页（v1.3.0）· AGPL-3.0
 *
 * 三栏：目录树 → 文件列表 → 下载队列。
 *
 * 这一层不碰磁盘、不碰网络，只做三件事：
 *   1. 记住「用户在哪些目录勾了哪些文件」（以 cloudRel 为键，切目录不丢）；
 *   2. 把勾选结果交给主进程预检 / 入队；
 *   3. 把队列状态画出来。
 */

'use strict';

(function () {
  const PAN = {
    platform: 'quark',
    logged: { quark: false, uc: false },
    dest: '',
    destRoot: '',
    trees: { quark: null, uc: null },
    cur: { fid: '0', rel: '' },
    sel: new Map(),        // 单文件勾选：cloudRel → 行数据
    dirSel: new Map(),     // 整目录勾选：rel → { rel, fid, name }
    expandInfo: '',        // 预检时「正在展开 N 个文件夹」的提示
    rows: [],
    filter: '',
    loading: false,
    queue: { tasks: [], activeId: 0 },
    pending: null,
  };

  const PLAT_LABEL = { quark: '夸克', uc: 'UC' };

  // 主界面那几个 modal 的开关是 bindDownload 内部的闭包，这里自己来一份
  const openModal = (id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add('show');
  };
  const closeModal = (id) => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('show');
  };

  function fmtB(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
    return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function fmtSpeed(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' B/s';
    if (v < 1024 * 1024) return (v / 1024).toFixed(0) + ' KB/s';
    return (v / 1024 / 1024).toFixed(1) + ' MB/s';
  }

  function fmtEta(task) {
    if (!task.speed || !task.bytesTotal) return '';
    const left = Math.max(0, task.bytesTotal - task.bytesDone);
    const sec = Math.round(left / task.speed);
    if (!isFinite(sec) || sec <= 0) return '';
    if (sec < 60) return sec + ' 秒';
    if (sec < 3600) return Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒';
    return Math.floor(sec / 3600) + ' 小时';
  }

  // ------------------------------------------------------------------
  // 平台与保存目录
  // ------------------------------------------------------------------

  async function refreshPlatforms() {
    const st = await yunx.pan.status().catch(() => null);
    if (st) PAN.logged = { quark: !!st.quark, uc: !!st.uc };
    for (const p of ['quark', 'uc']) {
      const el = p === 'quark' ? $('#paStateQuark') : $('#paStateUc');
      if (!el) continue;
      el.textContent = PAN.logged[p] ? '已连接' : '未连接';
      el.classList.toggle('on', PAN.logged[p]);
      const btn = $(`[data-panlogin="${p}"]`);
      if (btn) btn.textContent = PAN.logged[p] ? '重新连接' : '连接';
    }
    // 默认选中一个已连接的平台
    if (!PAN.logged[PAN.platform] && PAN.logged.quark) PAN.platform = 'quark';
    else if (!PAN.logged[PAN.platform] && PAN.logged.uc) PAN.platform = 'uc';
  }

  async function refreshDest() {
    const r = await yunx.pan.dest().catch(() => null);
    if (!r || !r.ok) return;
    PAN.dest = r.dest;
    PAN.destRoot = r.root;
    const el = $('#panDestPath');
    if (el) {
      el.textContent = r.dest || '—';
      el.title = r.dest || '';
    }
  }

  // ------------------------------------------------------------------
  // 目录树
  // ------------------------------------------------------------------

  function newRoot(platform) {
    return {
      fid: '0',
      name: `${PLAT_LABEL[platform]}网盘`,
      rel: '',
      open: true,
      loaded: false,
      children: null,
      platform,
    };
  }

  async function loadChildren(node) {
    if (node.loading || node.loaded) return;
    node.loading = true;
    const r = await yunx.pan
      .ls({ platform: node.platform || PAN.platform, fid: node.fid, rel: node.rel })
      .catch((e) => ({ ok: false, error: String(e) }));
    node.loading = false;
    if (!r || !r.ok) {
      node.loaded = true;
      node.children = [];
      if (r && r.needLogin) toast(`还没登录${PLAT_LABEL[PAN.platform]}网盘`);
      else if (r && r.error) toast(r.error);
      return;
    }
    node.loaded = true;
    node.children = (r.items || [])
      .filter((x) => x.dir)
      .map((x) => ({
        fid: x.fid,
        name: x.name,
        rel: node.rel ? `${node.rel}/${x.name}` : x.name,
        open: false,
        loaded: false,
        children: null,
        platform: node.platform || PAN.platform,
      }));
  }

  /**
   * 选中态的前缀集合：一次遍历，O(选中数 × 层级)。
   * 千万不能在每个目录行里现遍历 fileSel —— 那是 O(目录数 × 选中数)，
   * 上千张图 + 几十个目录就是几万次，每帧重算必卡（v1.2.6 踩过）。
   */
  function buildSelPrefix() {
    const pre = new Set();
    const add = (r) => {
      let idx = String(r).lastIndexOf('/');
      while (idx > 0) {
        const p = String(r).slice(0, idx);
        if (pre.has(p)) break;
        pre.add(p);
        idx = p.lastIndexOf('/');
      }
    };
    for (const k of PAN.sel.keys()) add(k);
    for (const k of PAN.dirSel.keys()) add(k);
    return pre;
  }

  function renderTree() {
    const pre = buildSelPrefix();
    const box = $('#panTree');
    if (!box) return;
    const root = PAN.trees[PAN.platform];
    box.innerHTML = '';
    if (!root) {
      box.innerHTML = `<div class="pf-empty">${PAN.logged[PAN.platform] ? '点右上角刷新' : '先连接网盘'}</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    // treeRow 自己会把展开的子节点递归画出来，这里不能再遍历一遍
    frag.appendChild(treeRow(root, 0, pre));
    if (root.open && !root.loaded) {
      const d = document.createElement('div');
      d.className = 'pf-empty';
      d.style.padding = '14px 0';
      d.textContent = '正在读取…';
      frag.appendChild(d);
    } else if (root.open && root.loaded && root.children && !root.children.length) {
      const d = document.createElement('div');
      d.className = 'pf-empty';
      d.style.padding = '14px 0';
      d.textContent = '这个网盘里还没有文件夹';
      frag.appendChild(d);
    }
    box.appendChild(frag);
  }

  function treeRow(node, depth, pre) {
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'pn-row' + (PAN.cur.fid === node.fid && PAN.cur.rel === node.rel ? ' active' : '');
    row.style.paddingLeft = depth * 13 + 'px';
    const picked = PAN.dirSel.has(node.rel);
    const partial = !picked && pre.has(node.rel);
    const pick = node.rel
      ? `<span class="pn-pick ${picked ? 'on' : ''} ${partial ? 'part' : ''}" title="${
          picked ? '取消整选' : '整个文件夹一起下载'
        }"><svg><use href="#i-check"/></svg></span>`
      : '<span class="pn-pick ghost"></span>';
    row.innerHTML =
      `<span class="pn-caret ${node.open ? 'open' : ''}"><svg><use href="#i-play"/></svg></span>` +
      pick +
      `<svg class="pn-ico"><use href="#i-folder"/></svg>` +
      `<span class="pn-name">${escapeHtml(node.name)}</span>` +
      (node.children && node.children.length ? `<span class="pn-sub">${node.children.length}</span>` : '');

    // 整选按钮：只认「整目录」语义，不预先展开子文件
    const pickEl = row.querySelector('.pn-pick');
    if (pickEl && node.rel) {
      pickEl.onclick = (e) => {
        e.stopPropagation();
        toggleDir(node);
      };
    }

    row.querySelector('.pn-caret').onclick = async (e) => {
      e.stopPropagation();
      node.open = !node.open;
      if (node.open && !node.loaded) {
        renderTree();
        await loadChildren(node);
      }
      renderTree();
    };
    row.onclick = () => openDir(node);
    wrap.appendChild(row);

    if (node.open && node.loaded && node.children && node.children.length) {
      for (const c of node.children) wrap.appendChild(treeRow(c, depth + 1, pre));
    }
    return wrap;
  }

  async function openDir(node) {
    PAN.cur = { fid: node.fid, rel: node.rel };
    PAN.filter = '';
    const f = $('#panFilter');
    if (f) f.value = '';
    renderTree();
    renderCrumb();
    await loadFiles();
  }

  function renderCrumb() {
    const el = $('#panCrumb');
    if (!el) return;
    const parts = PAN.cur.rel ? PAN.cur.rel.split('/') : [];
    if (!parts.length) {
      el.innerHTML = `<b>${PLAT_LABEL[PAN.platform]}网盘</b>`;
      el.title = `${PLAT_LABEL[PAN.platform]}网盘`;
      return;
    }
    // 只显示最后两级：面包屑再长也放不下，完整路径放 title
    const tail = parts.slice(-2);
    const bits = [];
    if (parts.length > 2) bits.push('<span>…</span><i>/</i>');
    tail.forEach((p, i) => {
      if (i > 0) bits.push('<i>/</i>');
      bits.push(i === tail.length - 1 ? `<b>${escapeHtml(p)}</b>` : `<span>${escapeHtml(p)}</span>`);
    });
    el.innerHTML = bits.join('');
    el.title = `${PLAT_LABEL[PAN.platform]}网盘 / ${parts.join(' / ')}`;
  }

  // ------------------------------------------------------------------
  // 文件列表
  // ------------------------------------------------------------------

  async function loadFiles() {
    if (!PAN.logged[PAN.platform]) {
      PAN.rows = [];
      const box = $('#panFiles');
      if (box) box.innerHTML = `<div class="pf-empty">还没连接${PLAT_LABEL[PAN.platform]}网盘，点上面的「连接」</div>`;
      return;
    }
    PAN.loading = true;
    renderFiles(true);
    const r = await yunx.pan
      .ls({ platform: PAN.platform, fid: PAN.cur.fid, rel: PAN.cur.rel })
      .catch((e) => ({ ok: false, error: String(e) }));
    PAN.loading = false;
    if (!r || !r.ok) {
      PAN.rows = [];
      renderFiles();
      const em = $('#panFilesEmpty');
      if (em) em.textContent = (r && r.error) || '读取失败';
      if (r && r.error) toast(r.error);
      return;
    }
    PAN.rows = r.items || [];
    renderFiles();
  }

  function renderFiles(loading) {
    const box = $('#panFiles');
    if (!box) return;
    if (loading) {
      box.innerHTML = `<div class="pf-empty">正在读取目录…</div>`;
      return;
    }
    const kw = PAN.filter.trim().toLowerCase();
    const rows = PAN.rows.filter((x) => !kw || x.name.toLowerCase().includes(kw));

    if (!rows.length) {
      box.innerHTML = `<div class="pf-empty">${kw ? '没有匹配的文件' : '这个目录是空的'}</div>`;
      return;
    }

    // 目录排前面
    rows.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));

    // 整选目录的前缀提到循环外：每行都现算一次是 O(行数 × 目录数)
    const dirPre = [...PAN.dirSel.keys()];
    const inPickedDir = (rel) => dirPre.some((d) => rel === d || rel.startsWith(d + '/'));

    const frag = document.createDocumentFragment();
    for (const it of rows) {
      const el = document.createElement('div');
      const on = it.dir ? inPickedDir(PAN.cur.rel ? `${PAN.cur.rel}/${it.name}` : it.name) : PAN.sel.has(it.cloudRel) || inPickedDir(it.cloudRel);
      el.className = 'pf-row' + (it.dir ? ' dir' : '') + (on ? ' sel' : '');
      const sub = it.dir ? '文件夹' : `${fmtB(it.size)}${it.mtime ? ' · ' + fmtTime(it.mtime) : ''}`;
      el.innerHTML =
        `<span class="pf-check ${on ? 'on' : ''}"><svg><use href="#i-check"/></svg></span>` +
        `<svg class="pf-ico"><use href="#i-${it.dir ? 'folder' : 'image'}"/></svg>` +
        `<span class="pf-name"><b>${escapeHtml(it.name)}</b><span>${sub}</span></span>` +
        (it.dir ? '<span></span>' : `<span class="pf-tag ${on ? 'have' : 'new'}">${on ? '已选' : '未选'}</span>`);

      if (it.dir) {
        el.onclick = () => {
          const node = findNode(PAN.trees[PAN.platform], it.fid);
          if (node) {
            node.open = true;
            node.loaded = node.loaded || false;
            renderTree();
            loadChildren(node).then(() => {
              renderTree();
              openDir(node);
            });
          } else {
            openDir({ fid: it.fid, rel: PAN.cur.rel ? `${PAN.cur.rel}/${it.name}` : it.name });
          }
        };
      } else {
        el.onclick = () => toggleSel(it);
      }
      frag.appendChild(el);
    }
    box.innerHTML = '';
    box.appendChild(frag);
  }

  function findNode(node, fid) {
    if (!node) return null;
    if (node.fid === fid) return node;
    for (const c of node.children || []) {
      const r = findNode(c, fid);
      if (r) return r;
    }
    return null;
  }

  function fmtTime(sec) {
    const n = Number(sec) || 0;
    if (!n) return '';
    const ms = n > 1e11 ? n : n * 1000;
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function toggleSel(it) {
    if (PAN.sel.has(it.cloudRel)) PAN.sel.delete(it.cloudRel);
    else
      PAN.sel.set(it.cloudRel, {
        cloudRel: it.cloudRel,
        name: it.name,
        size: it.size,
        mtime: it.mtime,
        fid: it.fid,
        cloudId: it.fid,
      });
    renderFiles();
    renderSelInfo();
  }

  /** 整目录勾选。勾上之后不再存子文件，等预检那一刻才展开 —— 勾一下是 O(1) 的 */
  function toggleDir(node) {
    const rel = node.rel;
    if (!rel) return; // 根目录用「全选本页」更明确，不允许整选根
    if (PAN.dirSel.has(rel)) {
      PAN.dirSel.delete(rel);
      // 取消整选时，把该目录下已单独勾的文件也一起清掉，避免「看不见却还在列表里」
      for (const k of [...PAN.sel.keys()]) {
        if (k === rel || k.startsWith(rel + '/')) PAN.sel.delete(k);
      }
    } else {
      PAN.dirSel.set(rel, { rel, fid: node.fid, name: node.name });
      // 整选后，范围内的单文件勾选没有意义了，删掉以免重复计数
      for (const k of [...PAN.sel.keys()]) {
        if (k.startsWith(rel + '/')) PAN.sel.delete(k);
      }
    }
    renderTree();
    renderFiles();
    renderSelInfo();
  }

  function hasSelection() {
    return PAN.sel.size > 0 || PAN.dirSel.size > 0;
  }

  function renderSelInfo() {
    const el = $('#panSelInfo');
    if (!el) return;
    let bytes = 0;
    const dirs = new Set();
    for (const v of PAN.sel.values()) {
      bytes += v.size || 0;
      const i = v.cloudRel.lastIndexOf('/');
      dirs.add(i > 0 ? v.cloudRel.slice(0, i) : '');
    }
    for (const k of PAN.dirSel.keys()) dirs.add(k);

    const nFile = PAN.sel.size;
    const nDir = PAN.dirSel.size;
    if (!nFile && !nDir) {
      el.innerHTML = '已选 <b>0</b> 个';
    } else {
      const bits = [];
      if (nFile) bits.push(`<b>${nFile}</b> 个文件`);
      if (nDir) bits.push(`<b>${nDir}</b> 个整文件夹`);
      const tail = [nFile ? fmtB(bytes) : '', dirs.size > 1 ? `${dirs.size} 个目录` : '']
        .filter(Boolean)
        .join(' · ');
      el.innerHTML = `已选 ${bits.join(' + ')}${tail ? ' · ' + tail : ''}`;
    }
    if (nDir) el.innerHTML += ' <span class="pf-hint">（文件夹在预检时展开）</span>';

    const btn = $('#panStartBtn');
    if (btn) {
      btn.disabled = !hasSelection();
      const total = nFile + nDir;
      btn.textContent = total ? `开始下载（${total} 项）` : '开始下载';
    }
  }


  // ------------------------------------------------------------------
  // 预检 + 入队
  // ------------------------------------------------------------------

  async function doPlan() {
    if (!hasSelection()) return;
    const items = [...PAN.sel.values()];
    const dirs = [...PAN.dirSel.values()].map((d) => ({ fid: d.fid, rel: d.rel }));

    // 先把弹层立起来再发请求：展开几十个文件夹要几秒，
    // 期间界面没有任何反馈的话，用户会以为按钮没反应，反复点。
    $('#pcSub').textContent = dirs.length
      ? `正在展开 ${dirs.length} 个文件夹…（目录越深越慢，别关窗口）`
      : `共选中 ${items.length} 个文件，已按「相对路径 + 大小 + 修改时间」逐个核对本地`;
    $('#pcDown').textContent = '…';
    $('#pcSkip').textContent = '…';
    $('#pcBytes').textContent = '…';
    $('#pcCollide').textContent = '…';
    $('#pcList').innerHTML = '';
    $('#pcDest').textContent = PAN.destRoot || '—';
    const goBtn = $('#pcGo');
    goBtn.disabled = true;
    goBtn.textContent = dirs.length ? '展开中…' : '统计中…';
    openModal('panConfirm');

    const r = await yunx
      .pan
      .plan({ platform: PAN.platform, items, dirs })
      .catch((e) => ({ ok: false, error: String(e) }));

    if (!r || !r.ok) {
      closeModal('panConfirm');
      toast((r && r.error) || '预检失败');
      return;
    }

    PAN.pending = { items, dirs };

    $('#pcSub').textContent = dirs.length
      ? `已展开 ${dirs.length} 个文件夹，共 ${r.itemCount || items.length} 个文件，逐个核对本地`
      : `共选中 ${items.length} 个文件，已按「相对路径 + 大小 + 修改时间」逐个核对本地`;
    $('#pcDown').textContent = r.counts.download;
    $('#pcSkip').textContent = r.counts.skip + r.counts.adopt;
    $('#pcBytes').textContent = fmtB(r.counts.bytesToDownload);
    $('#pcCollide').textContent = r.counts.collisions;
    $('#pcDest').textContent = r.dest || PAN.destRoot;

    const lines = [];
    if (r.counts.download === 0) lines.push(['全部已下载过，这次不会有任何重复下载', '']);
    for (const sm of r.samples || []) lines.push([sm.rel, sm.why]);
    if (r.collisions && r.collisions.length) {
      lines.push([`有 ${r.collisions.length} 组文件清洗后落到同一路径，会自动加序号保留两份`, '保留两份']);
    }
    // 截断必须显式告知：少下了却不吭声，比直接报错更难排查
    if (r.truncated) lines.push(['文件夹太多或太深，只展开了前 60 个目录 / 2 万个文件', '建议分批下']);
    if (r.dirFailed) lines.push([`有 ${r.dirFailed} 个子目录读取失败，已跳过`, '网络或权限']);
    $('#pcList').innerHTML = lines
      .map(([a, b]) => `<div><span>${escapeHtml(a)}</span><span>${escapeHtml(b)}</span></div>`)
      .join('');

    goBtn.disabled = r.counts.download === 0;
    goBtn.textContent = r.counts.download === 0 ? '没有新文件' : `下载 ${r.counts.download} 个`;
  }

  async function doStart() {
    const pending = PAN.pending || {
      items: [...PAN.sel.values()],
      dirs: [...PAN.dirSel.values()].map((d) => ({ fid: d.fid, rel: d.rel })),
    };
    if (!pending.items.length && !pending.dirs.length) return;
    closeModal('panConfirm');
    const r = await yunx
      .pan
      .start({ platform: PAN.platform, items: pending.items, dirs: pending.dirs })
      .catch((e) => ({ ok: false, error: String(e) }));
    if (!r || !r.ok) {
      toast((r && r.error) || '入队失败');
      return;
    }
    PAN.sel.clear();
    PAN.dirSel.clear();
    PAN.pending = null;
    renderTree();
    renderFiles();
    renderSelInfo();
    toast(`已加入队列：${r.count} 个文件${r.truncated ? '（目录过多，已截断）' : ''}`);
  }

  // ------------------------------------------------------------------
  // 队列
  // ------------------------------------------------------------------

  function renderQueue(snap) {
    if (snap) PAN.queue = snap;
    const box = $('#panQueue');
    if (!box) return;
    const tasks = PAN.queue.tasks || [];
    if (!tasks.length) {
      box.innerHTML = '<div class="pq-empty">还没有下载任务</div>';
      const foot = $('#panQueueFoot');
      if (foot) foot.textContent = '';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const t of tasks) {
      const el = document.createElement('div');
      el.className =
        'pq-item' +
        (t.status === 'downloading' || t.status === 'planning' ? ' running' : '') +
        (t.status === 'done' ? ' done' : '') +
        (t.status === 'error' ? ' error' : '');

      const pct =
        t.bytesTotal > 0
          ? Math.min(100, Math.round((t.bytesDone / t.bytesTotal) * 100))
          : t.total > 0
          ? Math.round((t.done / t.total) * 100)
          : t.status === 'done'
          ? 100
          : 0;

      const badge = {
        queued: '排队中',
        planning: '核对中',
        downloading: '下载中',
        pausing: '暂停中',
        paused: '已暂停',
        done: '完成',
        error: '出错',
        canceled: '已取消',
      }[t.status] || t.status;

      const meta = [];
      if (t.total > 0) meta.push(`${t.done}/${t.total}`);
      if (t.skipped > 0) meta.push(`跳过 ${t.skipped}`);
      if (t.failed > 0) meta.push(`失败 ${t.failed}`);
      if (t.status === 'downloading' && t.speed) meta.push(fmtSpeed(t.speed));
      if (t.bytesTotal > 0) meta.push(fmtB(t.bytesTotal));
      const eta = t.status === 'downloading' ? fmtEta(t) : '';

      const ops = [];
      if (t.status === 'downloading' || t.status === 'planning' || t.status === 'queued')
        ops.push(`<button data-qop="pause" data-qid="${t.id}">暂停</button>`);
      if (t.status === 'paused' || t.status === 'canceled')
        ops.push(`<button data-qop="resume" data-qid="${t.id}">继续</button>`);
      if (t.status === 'error' || t.failed > 0)
        ops.push(`<button data-qop="retry" data-qid="${t.id}">重试失败项</button>`);
      if (['downloading', 'planning', 'paused', 'queued', 'pausing'].includes(t.status))
        ops.push(`<button class="danger" data-qop="cancel" data-qid="${t.id}">取消</button>`);
      if (['done', 'error', 'canceled'].includes(t.status))
        ops.push(`<button class="danger" data-qop="remove" data-qid="${t.id}">移除</button>`);

      el.innerHTML =
        `<div class="pq-top"><b>${escapeHtml(t.title)}</b><span class="pq-badge ${t.status}">${badge}</span></div>` +
        `<div class="pq-bar"><i style="width:${pct}%"></i></div>` +
        `<div class="pq-meta"><span>${meta.join(' · ')}</span>${eta ? `<span class="sp">剩 ${eta}</span>` : ''}</div>` +
        `<div class="pq-path">${escapeHtml(t.current || t.message || '')}</div>` +
        (ops.length ? `<div class="pq-ops">${ops.join('')}</div>` : '');
      frag.appendChild(el);
    }
    box.innerHTML = '';
    box.appendChild(frag);

    const foot = $('#panQueueFoot');
    if (foot) {
      const done = tasks.filter((t) => t.status === 'done').length;
      foot.textContent = tasks.length
        ? `共 ${tasks.length} 个任务 · ${done} 个完成 · 队列串行执行（任务内 3 并发）`
        : '';
    }
  }

  async function queueOp(op, id) {
    const r = await yunx.pan.queueOp(op, id).catch(() => ({ ok: false }));
    if (!r || !r.ok) {
      if (op === 'retry') toast('没有需要重试的文件');
      return;
    }
    const s = await yunx.pan.queueState().catch(() => null);
    if (s) renderQueue(s);
  }

  // ------------------------------------------------------------------
  // 事件绑定
  // ------------------------------------------------------------------

  function bind() {
    for (const p of ['quark', 'uc']) {
      const btn = $(`[data-panlogin="${p}"]`);
      if (btn)
        btn.onclick = async () => {
          const r = await yunx.pan.login(p).catch(() => ({ ok: false }));
          if (r && !r.ok) toast(r.error || '打不开登录页');
        };
      const card = $(`.pa-plat[data-plat="${p}"]`);
      if (card)
        card.onclick = async (e) => {
          if (e.target.closest('button')) return;
          await selectPlatform(p);
        };
    }

    $('#panPickDest').onclick = async () => {
      const r = await yunx.pan.pickDest().catch(() => ({ ok: false }));
      if (r && r.ok) {
        await refreshDest();
        toast('保存位置已更新');
      }
    };
    $('#panOpenDest').onclick = () => yunx.pan.openDest(PAN.platform);

    $('#panTreeRefresh').onclick = async () => {
      const root = PAN.trees[PAN.platform];
      if (root) {
        root.loaded = false;
        root.children = null;
      }
      await loadChildren(root);
      renderTree();
      await loadFiles();
    };

    $('#panFilter').oninput = (e) => {
      PAN.filter = e.target.value || '';
      renderFiles();
    };

    $('#panSelAll').onclick = () => {
      const kw = PAN.filter.trim().toLowerCase();
      for (const it of PAN.rows) {
        if (it.dir) continue;
        if (kw && !it.name.toLowerCase().includes(kw)) continue;
        if (!PAN.sel.has(it.cloudRel))
          PAN.sel.set(it.cloudRel, {
            cloudRel: it.cloudRel,
            name: it.name,
            size: it.size,
            mtime: it.mtime,
            fid: it.fid,
            cloudId: it.fid,
          });
      }
      renderFiles();
      renderSelInfo();
    };

    $('#panSelNone').onclick = () => {
      PAN.sel.clear();
      renderFiles();
      renderSelInfo();
    };

    $('#panStartBtn').onclick = doPlan;
    $('#pcGo').onclick = doStart;

    $('#panQueue').addEventListener('click', (e) => {
      const b = e.target.closest('[data-qop]');
      if (!b) return;
      queueOp(b.dataset.qop, Number(b.dataset.qid));
    });

    $('#panQueueClear').onclick = async () => {
      await yunx.pan.queueOp('clear', 0).catch(() => null);
      const s = await yunx.pan.queueState().catch(() => null);
      if (s) renderQueue(s);
    };
  }

  async function selectPlatform(p) {
    if (PAN.platform === p) return;
    PAN.platform = p;
    PAN.cur = { fid: '0', rel: '' };
    PAN.rows = [];
    PAN.filter = '';
    renderCrumb();
    renderTree();
    await ensureTree();
    await loadFiles();
  }

  async function ensureTree() {
    if (!PAN.logged[PAN.platform]) {
      renderTree();
      return;
    }
    if (!PAN.trees[PAN.platform]) {
      PAN.trees[PAN.platform] = newRoot(PAN.platform);
    }
    const root = PAN.trees[PAN.platform];
    if (!root.loaded) await loadChildren(root);
    renderTree();
  }

  // ------------------------------------------------------------------
  // 初始化
  // ------------------------------------------------------------------

  let booted = false;
  window.initPanPage = async function initPanPage() {
    if (booted) return;
    booted = true;
    bind();
    await refreshPlatforms();
    await refreshDest();
    renderCrumb();
    renderSelInfo();
    renderTree();

    const s = await yunx.pan.queueState().catch(() => null);
    if (s) renderQueue(s);

    yunx.pan.onQueue((snap) => renderQueue(snap));
    yunx.pan.onChanged(async () => {
      await refreshPlatforms();
      PAN.trees = { quark: null, uc: null };
      PAN.cur = { fid: '0', rel: '' };
      await ensureTree();
      await loadFiles();
    });
  };

  // 切到网盘页时才真正读目录，避免启动时白打一次接口
  window.panPageShown = async function panPageShown() {
    await refreshPlatforms();
    await refreshDest();
    await ensureTree();
    if (!PAN.rows.length) await loadFiles();
    const s = await yunx.pan.queueState().catch(() => null);
    if (s) renderQueue(s);
  };
})();
