/* 术力口周榜 · 前端（纯渲染层，数据全部来自 /api）
 *
 * 分工：
 *   · 本文件：状态、取数、拼字符串、事件 —— 不写任何动画定时器
 *   · motion.js：入场交错 / 图表描线 / 封面淡入 / 滚动锁
 *   · theme.js：主题（与数据无关）
 *
 * 两条约定：
 *   1. 事件一律**委托到稳定的容器**（#rows / #champs / #songItems / #drawerBody）。
 *      以前是每次重绘都 querySelectorAll 再逐个绑，换一期就绑 20 个新监听，
 *      旧节点虽然丢了但代码路径越用越绕；委托只需绑一次。
 *   2. 图表的颜色不写在 JS 里（不写 #1896DA），只给 class，让主题令牌决定颜色。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    meta: null,
    issues: [],
    indexByIssue: new Map(),
    issueIdx: 0,
    issue: null,
    issueCache: new Map(),
    champions: [],
    songs: [],
    songCache: new Map(),
    curSong: null,
    filter: '',
    /* 当前选中的 B 站榜单：weekly / legend / annual。
       三条榜在页面上只有一个位置，切换等于换**整页**（标题、概览、榜单、看点、冠军、走势），
       不是给表格加筛选。三者的期号序列各自独立，所以目录与缓存都按榜分开。 */
    board: 'weekly',
    /* 传说曲 / 年榜的目录（期次列表）。它们已经是标题下拉里的一等公民，
       不再是"附榜"，所以这里只存目录，某一期的数据与周榜共用 issueCache。 */
    extras: { index: {} },
    /* 按榜缓存冠军段与曲目索引：来回切榜不该每次都重新拉一遍 */
    boardCache: { champions: {}, songs: {} },
    boardMaps: {},
    /* 走势图的区间（按榜各存一份）：默认最近 30 期，用户可改成任意起止期 */
    ranges: {},
    /* 当前画在走势图里的曲子 { key, song }。换区间时要能重画，所以得留住它 */
    curTrend: null,
    /* 单曲档案：搜索结果、当前选中的 key（"b:15" / "n:曲名"）、卡片缓存 */
    song: { q: '', items: [], cur: null, cache: new Map(), loaded: false },
    /* 附榜 B：ニコニコ VOCALOID SONGS TOP20（另一个 UP 主、另一套期号） */
    nico: {
      index: null,
      indexByIssue: null,   // 期号 → 在主页次序列里的位置（走势图横轴用）
      champions: null,
      songs: [],
      curSong: null,
      curIssue: null,
      cache: new Map(),
      loading: false,
      loaded: false
    },
    /* 顶栏的榜单切换：'b' = Biliboard 那一套（周榜 + 传说曲 + 年榜），'n' = ニコニコ。
       这不是"筛选"，是换一整套视图：标题、区块、页脚、侧栏入口都会跟着换。 */
    view: 'b',
    drawer: { open: false, id: null, song: null, board: 'weekly', issue: null, bvid: null, returnFocus: null }
  };

  /* 三条榜的显示名。周榜也在里面 —— 抽屉里的"另外两张榜"会引用到它，
     少一项就会渲染出 "undefined 27 期"（这种字符串没人会在第一眼发现）。 */
  var BOARD_LABEL = { weekly: '周榜', legend: '传说曲周榜', annual: '年榜', nico: 'ニコニコ TOP20' };

  /* 标题下拉里的三条榜。label 是标题里显示的字（短），full 用在别处 */
  var B_BOARDS = [
    { name: 'weekly', label: '周榜', full: '术力口周榜' },
    { name: 'legend', label: '传说榜', full: '传说曲周榜' },
    { name: 'annual', label: '年榜', full: '年榜' }
  ];

  function boardLabel(name) {
    for (var i = 0; i < B_BOARDS.length; i++) if (B_BOARDS[i].name === name) return B_BOARDS[i].label;
    return B_BOARDS[0].label;
  }

  /** 某条榜的期次列表（周榜用 /api/issues 那份，其余用目录接口） */
  function boardIndexItems(name) {
    if (name === 'weekly') return state.issues;
    var e = state.extras.index[name];
    return (e && e.items) || [];
  }

  /** 期号 → 在该榜序列里的位置。走势图的横轴用它，必须按榜各算一份 */
  function boardIndexMap(name) {
    if (name === 'weekly') return state.indexByIssue;
    if (!state.boardMaps[name]) {
      var m = new Map();
      boardIndexItems(name).forEach(function (x, i) { m.set(x.issue, i); });
      state.boardMaps[name] = m;
    }
    return state.boardMaps[name];
  }

  /** 某条榜某一期的数据。缓存键带榜名 —— 三条榜都有"第 84 期"，不能混。 */
  async function loadBoardIssue(name, n) {
    var key = name + ':' + n;
    if (state.issueCache.has(key)) return state.issueCache.get(key);
    var path = name === 'weekly' ? '/api/issues/' + n : '/api/' + name + '/' + n;
    var data = await api(path);
    state.issueCache.set(key, data);
    return data;
  }

  /* ---------- 走势区间 ----------
   * 默认最近 30 期：一屏放得下，也确实是"最近"。但一首在榜 80 期的曲子，
   * 30 期窗口会把它压成一根斜线，所以两头都可以改，改完即时重画。 */
  var RANGE_DEFAULT = 30;

  /** 某个 key（榜名 / 'nico'）对应的期次序列 */
  function rangeItems(key) {
    if (key === 'nico') return (state.nico.index && state.nico.index.items) || [];
    return boardIndexItems(key);
  }

  function defaultRange(len) {
    // auto = "用户还没动过区间"。只有这种状态下才会为了让某首歌可见而自动调整，
    // 用户手动选过的区间绝不覆盖（那等于偷偷改掉他刚做的选择）。
    return { n: len, fromIdx: Math.max(0, Math.min(len - 1, len - RANGE_DEFAULT)), toIdx: Math.max(0, len - 1), auto: true };
  }

  /** 取区间。期次数量变了（来了新一期）就回到默认 —— 否则窗口会停在一个越变越旧的位置 */
  function getRange(key) {
    var items = rangeItems(key);
    var r = state.ranges[key];
    if (!r || r.n !== items.length) r = state.ranges[key] = defaultRange(items.length);
    return r;
  }

  function setRange(key, fromIdx, toIdx, opts) {
    var items = rangeItems(key);
    var a = Math.max(0, Math.min(fromIdx, items.length - 1));
    var b = Math.max(0, Math.min(toIdx, items.length - 1));
    if (a > b) { var t = a; a = b; b = t; }
    state.ranges[key] = { n: items.length, fromIdx: a, toIdx: b, auto: Boolean(opts && opts.auto) };
  }

  /** 默认区间里看不到这首歌时，自动把窗口挪到它在榜的那一段。
   *  近 30 期是给"每周都看"的人准备的；点开一首三年前在榜的歌却看到"0 期"，
   *  那不是默认值的问题，是我们没读懂这一次点击。 */
  function fitSongIntoRange(key, song) {
    var r = getRange(key);
    if (!r.auto) return false;
    var app = song.appearances || [];
    if (!app.length) return false;
    var items = rangeItems(key);
    var inside = false;
    app.forEach(function (a) {
      var i = rangeIndexByIssue(key, a.issue);
      if (i >= r.fromIdx && i <= r.toIdx) inside = true;
    });
    if (inside) return false;
    var i0 = rangeIndexByIssue(key, app[0].issue);
    var i1 = rangeIndexByIssue(key, app[app.length - 1].issue);
    if (i0 < 0 || i1 < 0) return false;
    state.ranges[key] = { n: items.length, fromIdx: i0, toIdx: i1, auto: true };
    return true;
  }

  function rangeEls(key) {
    return key === 'nico'
      ? { from: $('nicoRangeFrom'), to: $('nicoRangeTo'), reset: $('nicoRangeReset') }
      : { from: $('rangeFrom'), to: $('rangeTo'), reset: $('rangeReset') };
  }

  /** 两个下拉 + "近 30 期"。倒序：最近一期在最上面，和期次下拉一致 */
  function renderRangeControls(key) {
    var els = rangeEls(key);
    var fromSel = els.from, toSel = els.to, resetBtn = els.reset;
    var items = rangeItems(key);
    var r = getRange(key);
    if (!items.length || !fromSel) return;
    var opts = items.map(function (x, i) {
      return '<option value="' + x.issue + '">第 ' + x.issue + ' 期</option>';
    }).reverse().join('');
    fromSel.innerHTML = opts;
    toSel.innerHTML = opts;
    fromSel.value = String(items[r.fromIdx].issue);
    toSel.value = String(items[r.toIdx].issue);
    if (resetBtn) resetBtn.disabled = r.fromIdx === Math.max(0, items.length - RANGE_DEFAULT) && r.toIdx === items.length - 1;
  }

  /** key = 榜名（B 侧）或 'nico' */
  function drawTrend(key) {
    var t = state.curTrend;
    if (!t || t.key !== key) return;
    var jump = function () {
      var app = t.song.appearances || [];
      if (!app.length) return;
      var i0 = rangeIndexByIssue(key, app[0].issue);
      var i1 = rangeIndexByIssue(key, app[app.length - 1].issue);
      if (i0 < 0 || i1 < 0) return;
      setRange(key, i0, i1, { auto: true });
      renderRangeControls(key);
      drawTrend(key);
    };
    if (key === 'nico') {
      renderChart(t.song, { card: $('nicoChartCard'), indexByIssue: nicoIndexMap(), issues: rangeItems('nico'), range: getRange('nico'), jump: jump });
    } else {
      renderChart(t.song, { card: $('chartCard'), indexByIssue: boardIndexMap(key), issues: rangeItems(key), range: getRange(key), jump: jump });
    }
  }

  function onRangeChange(key, which, value) {
    var idx = rangeIndexByIssue(key, Number(value));
    if (idx < 0) return;
    var r = getRange(key);
    if (which === 'from') setRange(key, idx, r.toIdx, { auto: false });
    else setRange(key, r.fromIdx, idx, { auto: false });
    renderRangeControls(key);
    drawTrend(key);
  }

  function resetRange(key) {
    var items = rangeItems(key);
    var d = defaultRange(items.length);   // auto 也随之重新打开
    state.ranges[key] = d;
    renderRangeControls(key);
    drawTrend(key);
  }

  function rangeIndexByIssue(key, issue) {
    var items = rangeItems(key);
    for (var i = 0; i < items.length; i++) if (items[i].issue === issue) return i;
    return -1;
  }

  /** 冠军段 / 曲目索引：按榜缓存，第一次用到才拉 */
  async function loadBoardResources(name) {
    if (!state.boardCache.champions[name]) {
      state.boardCache.champions[name] = name === 'weekly'
        ? { total: 0, runs: [] }
        : await api('/api/' + name + '/champions?limit=24').catch(function () { return { total: 0, runs: [] }; });
    }
    if (!state.boardCache.songs[name]) {
      state.boardCache.songs[name] = name === 'weekly'
        ? []
        : (await api('/api/' + name + '/songs?limit=1000').catch(function () { return { items: [] }; })).items || [];
    }
    state.champions = state.boardCache.champions[name];
    state.songs = state.boardCache.songs[name];
  }

  /* B 视图独占的区块。切到 N 榜时整块收起来 —— 两条榜的期号与曲目身份都不一样，
     把它们并排放在同一屏里，读者迟早会拿 B 榜第 124 期去对 N 榜第 124 期。 */
  var B_SECTIONS = ['hero', 'boardSec', 'insightSec', 'champSec', 'trendSec'];
  var VIEW_KEY = 'chart';

  function storedView() {
    try {
      var v = localStorage.getItem(VIEW_KEY);
      return v === 'n' || v === 'song' ? v : 'b';
    } catch (e) { return 'b'; }
  }

  var BOARD_KEY = 'board';
  function storedBoard() {
    try {
      var v = localStorage.getItem(BOARD_KEY);
      return v === 'legend' || v === 'annual' ? v : 'weekly';
    } catch (e) { return 'weekly'; }
  }

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fmtDate(d) {
    var p = String(d || '').split('-');
    return p.length === 3 ? p[0] + '.' + p[1] + '.' + p[2] : String(d || '');
  }
  /* ISO 时间 → "2026.10.24 04:56"。页脚的"数据更新 / 服务端载入"用得上：
     只写日期看不出"今天的和昨天那份是不是同一份数据"。 */
  function fmtTime(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso || ''));
    return m ? m[1] + '.' + m[2] + '.' + m[3] + ' ' + m[4] + ':' + m[5] : String(iso || '');
  }
  function num(n) { return (n < 10 ? '0' : '') + n; }
  function names(list) { return (list || []).join(' / '); }
  function cover(bvid, w) { return bvid ? '/img/' + encodeURIComponent(bvid) + (w ? '?w=' + w : '') : ''; }
  function videoUrl(bvid) { return 'https://www.bilibili.com/video/' + encodeURIComponent(bvid); }
  function playerUrl(bvid) {
    return 'https://player.bilibili.com/player.html?bvid=' + encodeURIComponent(bvid) + '&autoplay=0&high_quality=1&danmaku=1';
  }
  /* 滚动落点：吸顶栏 58px + 18px 呼吸空间，与 styles.css 的 scroll-padding-top 同一个数。
     减少动效时用 'auto' —— CSS 的 scroll-behavior 管不到 JS 的 options，这一条只能在这里让。 */
  var SCROLL_OFFSET = 76;

  function scrollToSection(el) {
    if (!el) return;
    var y = el.getBoundingClientRect().top + window.scrollY - SCROLL_OFFSET;
    window.scrollTo({ top: y < 0 ? 0 : y, behavior: (window.DshMotion && window.DshMotion.reduced()) ? 'auto' : 'smooth' });
  }


  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
      t.setAttribute('role', 'status');
      t.setAttribute('aria-live', 'polite');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'toast on' + (kind === 'err' ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 2600);
  }

  async function api(path, opts) {
    var res = await fetch(path, opts);
    if (!res.ok) {
      var body = await res.json().catch(function () { return {}; });
      throw new Error(body.message || 'HTTP ' + res.status);
    }
    return res.json();
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    try {
      var results = await Promise.all([
        api('/api/meta'),
        api('/api/issues'),
        api('/api/champions?limit=24'),
        api('/api/songs?limit=1000')
      ]);
      state.meta = results[0];
      state.issues = results[1].items;
      state.champions = results[2];
      state.songs = results[3].items;
      state.boardCache.champions.weekly = results[2];
      state.boardCache.songs.weekly = results[3].items;
      state.issues.forEach(function (it, i) { state.indexByIssue.set(it.issue, i); });

      state.view = storedView();
      paintHeader();
      bindUI();
      await viewIssue('weekly', state.issues[state.issues.length - 1].issue, { silent: true });
      chartPlaceholder();
      // 首次填充 120 首不做入场：一屏之外的一百多个元素同时起跑，
      // 除了让弱机器掉帧之外没有观感收益（滚动到列表里时才看得见前几条）
      fillSongList('', { animate: false });
      applyView();
      loadBoardIndexes();
      loadNico();
    } catch (err) {
      $('pageSub').textContent = '加载失败：' + err.message;
      $('rows').innerHTML = '<div class="empty">数据加载失败，请确认服务正在运行（node src/cli.js serve）</div>';
    }
  }

  /* 标题与页脚都跟着视图走：切到 N 榜还挂着"第 2–124 期 / 曲目按 Biliboard ID 对齐"，
     等于告诉读者这两条榜是同一套数据 —— 它们不是。 */
  /** 某条 B 站榜的"第几期 ~ 第几期 / 共多少条" */
  function boardRangeText(name) {
    var m = state.meta;
    if (name === 'weekly') {
      var s = m.stats;
      return '第 ' + m.charts.first + '–' + m.charts.last + ' 期（' + fmtDate(s.firstDate).slice(0, 7) + ' – '
        + fmtDate(s.lastDate).slice(0, 7) + '）· 共 ' + s.entries + ' 条';
    }
    var e = state.extras.index[name];
    if (!e) return '正在加载…';
    var dates = e.firstDate && e.lastDate
      ? '（' + fmtDate(e.firstDate).slice(0, 7) + ' – ' + fmtDate(e.lastDate).slice(0, 7) + '）'
      : '';
    return '第 ' + e.first + '–' + e.last + ' 期' + dates + ' · 共 ' + e.entries + ' 条';
  }

  function paintHeader() {
    var m = state.meta;
    if (!m) return;
    var ni = state.nico.index;
    var isN = state.view === 'n';
    var isS = state.view === 'song';
    $('pageTitle').hidden = isN || isS;
    $('pageTitleN').hidden = !isN;
    $('pageTitleS').hidden = !isS;
    if (isS) {
      $('pageSub').textContent = '在四条榜上查同一首曲子：周榜 / 传说榜 / 年榜 / ニコニコ VOCALOID TOP20';
      $('linkSpace').href = m.sources.space;
      $('linkRead').href = m.sources.readList;
    } else if (isN) {
      $('pageTitleN').textContent = (ni && ni.title) || 'ニコニコ VOCALOID SONGS TOP20';
      $('pageSub').textContent = ni
        ? '第 ' + ni.first + '–' + ni.last + ' 期（' + fmtDate(ni.firstDate).slice(0, 7) + ' – ' + fmtDate(ni.lastDate).slice(0, 7)
          + '）· 共 ' + ni.entries + ' 条 · Billboard JAPAN × ニコニコ · 来源 ' + ((ni.account && ni.account.name) || '')
        : '正在加载…';
      $('linkSpace').href = (ni && ni.account && ni.account.spaceUrl) || m.sources.space;
      $('linkRead').href = (ni && ni.account && ni.account.spaceUrl) || m.sources.readList;
    } else {
      markBoardPick();
      // 传说曲榜与年榜的曲目同样以 Biliboard 的 song.id 为准，口径一致；
      // 只有周榜那两行才需要额外点出"曲目按 ID 对齐"这件事
      $('pageSub').textContent = boardRangeText(state.board)
        + ' · 曲目按 Biliboard ID 对齐 · 来源 ' + m.account.name;
      $('linkSpace').href = m.sources.space;
      $('linkRead').href = m.sources.readList;
    }
    document.title = isS ? '单曲档案 · 术力口周榜' : (isN ? $('pageTitleN').textContent : '术力口' + boardLabel(state.board) + ' · 数据看板');
    renderFooter();
  }

  /** 把当前视图落到 DOM 上：区块显隐、切换按钮状态、标题、页脚 */
  function applyView() {
    // 兜底：N 榜没有数据时不能停在 N 视图（B 的区块收起了、N 的又没内容，就是一屏空白）。
    // 这里也管住"上次记住的是 N，这次抓取失败"的情况。
    if (state.view === 'n' && !state.nico.loaded) state.view = 'b';
    var v = state.view;
    var n = v === 'n';
    B_SECTIONS.forEach(function (id) { var el = $(id); if (el) el.hidden = v !== 'b'; });
    // 年榜没有走势：一年一期、总共 5 期，"逐期名次曲线"画出来就是三五个点，没有信息量
    if (v === 'b' && state.board === 'annual') $('trendSec').hidden = true;
    $('nicoSec').hidden = !n || !state.nico.loaded;
    $('songSec').hidden = v !== 'song';
    // 顶栏那几个出口都是 B 榜的东西（文集 / 收录公示 / CSV 导出的都是 B 榜数据），
    // 在 N 榜视图里留着只会让人点开一个不相干的页面。
    ['linkRead', 'linkBoard', 'linkCsv'].forEach(function (id) {
      var el = $(id);
      if (el) el.hidden = n;
    });
    Array.prototype.forEach.call(document.querySelectorAll('#chartSwitch .cs'), function (b) {
      var on = b.getAttribute('data-chart') === state.view;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    paintHeader();
  }

  function setView(v) {
    if (v !== 'b' && v !== 'n' && v !== 'song') v = 'b';
    // N 榜还没抓到时不许切过去 —— 那会是一屏空白，看起来像页面坏了。
    // 但"正在加载"和"没有数据"是两回事：前者记下来，加载完自动切过去，
    // 否则用户刚打开页面就点 N 榜会挨一句莫名其妙的"还没有数据"。
    if (v === 'n' && !state.nico.loaded) {
      if (state.nico.loading) { state.pendingView = 'n'; return; }
      toast(state.nico.index ? 'ニコニコ 榜还没有数据' : 'ニコニコ 榜还没抓 —— 先跑 node src/cli.js nico');
      return;
    }
    if (v === state.view) return;
    state.view = v;
    try { localStorage.setItem(VIEW_KEY, v); } catch (e) { /* 存储不可用就只是不记住 */ }
    if (v === 'song') openSongView();
    applyView();
    window.scrollTo({ top: 0, behavior: (window.DshMotion && window.DshMotion.reduced()) ? 'auto' : 'smooth' });
  }

  /* 对齐结果：说清「核对了几期、几处官方换了稿件」。
     不一致不是脏数据 —— 官方偶尔统一换成本家稿件；页脚如实写出来，
     比「看起来完美」更可信。 */
  function alignmentLine(meta) {
    var a = meta.alignment;
    if (!a) return "";
    var mismatch = a.bvidMismatch ? "，其中 " + a.bvidMismatch + " 处官方替换了稿件" : "";
    return "<div><b>曲目对齐</b>：以 Biliboard 公开曲目库的歌曲 ID 为准，同一首歌的不同译名、不同投稿稿件归为同一条记录；每行显示该期实际使用的稿件。已核对 "
      + a.issues + " 期 / " + a.ranks + " 个名次" + mismatch + "。</div>";
  }

  /* 数据完整性：如实说清"缺哪几期、缺几个名次、有多少期能找到原帖"。
     不补、不猜 —— 缺一行就是缺一行，这比"看起来满满的"有用得多。 */
  function qualityLine(meta) {
    var q = meta.quality;
    if (!q) return '';
    var missing = q.missingRanks ? '，缺 ' + q.missingRanks + ' 个名次' : '';
    return '<div><b>数据完整性</b>：' + q.completeIssues + ' / ' + q.totalIssues + ' 期名次齐全' + missing
      + ' · 有文字版原帖 ' + q.posts.aligned + ' / ' + q.posts.total + ' 期</div>';
  }

  /* 传说曲 / 年榜的页脚：来源与口径都换了，不能继续挂着周榜那套
     "已核对 X 期 / 有文字版原帖 Y 期" —— 那两项对它们不成立。 */
  function renderBoardFooter() {
    var m = state.meta;
    var e = state.extras.index[state.board];
    var parts = [
      '<div><b>数据来源</b>：' + esc(m.account.name) + ' 的' + boardLabel(state.board) + '（' + esc(m.account.spaceUrl)
        + '）+ Biliboard 公开曲目库（' + esc(m.sources.board) + '）。</div>'
    ];
    if (e) {
      parts.push('<div><b>范围</b>：第 ' + e.first + '–' + e.last + ' 期 · 共 ' + e.entries + ' 条。'
        + (state.board === 'legend'
          ? '传说曲周榜与周榜的期号各自独立，不要跨榜对照名次。'
          : '年榜名次到 100，期号同样与周榜独立。') + '</div>');
    }
    parts.push('<div><b>说明</b>：曲目身份以 Biliboard 的 song.id 为准，名次只来自官方曲目库；'
      + '这里是同一个账号发布的另一条榜，与周榜不共用期次。数据版权归原作者所有，本项目为非官方个人整理。</div>');
    parts.push('<div><b>数据</b>：服务端载入于 ' + fmtTime(m.builtAt) + '</div>');
    $('footer').innerHTML = parts.join('');
  }

  /* 单曲档案的页脚：这里唯一需要解释的是**跨榜是怎么对上的** ——
     B 站三条榜用 song.id，ニコニコ 用曲名，两套 id 空间只能靠日文原名归一化后匹配。 */
  function renderSongFooter() {
    var m = state.meta;
    $('footer').innerHTML = [
      '<div><b>数据来源</b>：Biliboard 公开曲目库（' + esc(m.sources.board) + '）+ ' + esc(m.account.name)
        + ' 的文字版周榜；ニコニコ 榜由 Elvansphere 译制（Billboard JAPAN × ニコニコ）。</div>',
      '<div><b>匹配口径</b>：B 站那三条榜共用 song.id，直接按 id 查；ニコニコ 没有曲目库，'
        + '只能按**日文曲名**归一化后匹配 —— 改名或写法不同的曲子可能对不上，对不上时如实显示"没上过这条榜"。</div>',
      '<div><b>数据</b>：服务端载入于 ' + fmtTime(m.builtAt) + '</div>'
    ].join('');
  }

  function renderFooter() {
    if (state.view === 'song') return renderSongFooter();
    if (state.view === 'n') return renderNicoFooter();
    var m = state.meta;
    if (!m) return;
    if (state.board !== 'weekly') return renderBoardFooter();
    var gaps = (m.gaps || []).map(function (g) { return '第 ' + g.issue + ' 期缺第 ' + g.miss.join('、') + ' 名'; }).join('；');
    $('footer').innerHTML = [
      alignmentLine(m),
      '<div><b>数据来源</b>：' + esc(m.account.name) + ' 的文字版周榜（' + esc(m.account.spaceUrl) + '）+ Biliboard 公开曲目库（' + esc(m.sources.board) + '）。</div>',
      qualityLine(m),
      '<div><b>说明</b>：' + (gaps ? gaps + '。' : '') + '名次不完全等同于歌曲质量，请理性看待。数据版权归原作者所有，本项目为非官方个人整理。</div>',
      '<div><b>数据</b>：文件更新于 ' + fmtTime(m.generatedAt) + ' · 服务端载入于 ' + fmtTime(m.builtAt) + '</div>'
    ].join('');
  }

  /* N 榜的页脚：来源换成 UP 主本人，口径换成"名次与在榜周数取自正文"。
     这里**不**写"满员 X/Y 期"之外的东西 —— 它没有官方曲目库，能说的只有抓到了多少。 */
  function renderNicoFooter() {
    var ni = state.nico.index;
    if (!ni) { $('footer').innerHTML = ''; return; }
    var acc = ni.account || {};
    var miss = (ni.incomplete || []).length;
    var missingLine = miss
      ? '<div><b>数据完整性</b>：' + miss + ' / ' + ni.total + ' 期名次不满 20 首（' + (ni.incomplete || []).slice(0, 4).map(function (x) { return '第 ' + x.issue + ' 期 ' + x.count + ' 首'; }).join('、') + (miss > 4 ? ' …' : '') + '）。</div>'
      : '<div><b>数据完整性</b>：' + ni.total + ' 期全部满员（每期 20 首）。</div>';
    $('footer').innerHTML = [
      '<div><b>数据来源</b>：' + esc(acc.name || '') + ' 的 B 站文字版（' + esc(acc.spaceUrl || '') + '）；榜单原始出处为 Billboard JAPAN × ニコニコ「' + esc(ni.title) + '」。</div>',
      '<div><b>统计口径</b>：名次、上周名次与在榜周数全部取自每期正文（榜单官方口径），本服务只做整理与对齐；没有二次曲目库。</div>',
      missingLine,
      '<div><b>说明</b>：这条榜与「术力口周榜」是<b>两条完全独立的榜</b> —— 发布者、期号、曲目身份都不同，不要跨榜对比名次。曲目身份用曲名，同一首歌换稿件不会拆成两条。</div>',
      '<div><b>数据</b>：共 ' + ni.total + ' 期 / ' + ni.entries + ' 条 · 服务端载入于 ' + fmtTime(state.meta && state.meta.builtAt) + '</div>'
    ].join('');
  }

  /* ---------- 期次 ---------- */
  /* 渲染"某条榜的某一期"。周榜与传说曲/年榜在这里完全同构 —— 它们本来就是
     同一种东西（一条榜的一期），只是数据来自不同的接口。 */
  async function viewIssue(name, n, opts) {
    var o = opts || {};
    var data = await loadBoardIssue(name, n);
    state.issue = data;
    state.issueIdx = data.index;
    renderToolbar(data);
    renderHero(data);
    // 换期是"数据整体换了"：这次可以播入场。筛选重绘走 animate:false（见 renderBoard）
    renderBoard(data, { animate: true });
    renderInsights(data);
    renderChampions();
    renderRangeControls(state.board);
    // 年榜没有「近 30 期」那一列：一年一期，5 个点连不成趋势线，留着只是给每行加一道无意义的细线
    var isAnnual = state.board === 'annual';
    var boardEl = document.querySelector('#boardSec .board');
    if (boardEl) boardEl.classList.toggle('no-spark', isAnnual);
    $('boardDesc').textContent = isAnnual
      ? '点击任意一行查看该曲在年榜上的历年名次与视频'
      : '点击任意一行查看名次走势与视频预览';
    if (!o.silent) scrollToSection($('boardSec'));
  }

  /** 标题下拉：切到另一条 B 站榜。整页跟着换，所以顺带把走势图清空重填。 */
  async function setBoard(name, opts) {
    var o = opts || {};
    if (name === state.board) return;
    var items = boardIndexItems(name);
    if (!items.length) { toast('这条榜还没有数据'); return; }
    state.board = name;
    state.curSong = null;
    state.curTrend = null;
    try { localStorage.setItem(BOARD_KEY, name); } catch (e) { /* 存储不可用就只是不记住 */ }
    await loadBoardResources(name);
    await viewIssue(name, items[items.length - 1].issue, { silent: true });
    chartPlaceholder();
    fillSongList('', { animate: false });
    applyView();
    paintHeader();
    markBoardPick();
    // 换榜是"整页换了一份东西"，回到顶部看新的标题与冠军卡才合理；
    // 直接跳到榜单会让人错过"我已经换了一条榜"这件事
    if (!o.silent) window.scrollTo({ top: 0, behavior: (window.DshMotion && window.DshMotion.reduced()) ? 'auto' : 'smooth' });
  }

  /** 走势图右栏的空状态：没选歌时不能是一块白板 */
  function chartPlaceholder() {
    $('chartCard').innerHTML = '<div style="color:var(--faint);font-size:13px;padding:6px 2px">'
      + '左侧选一首歌，看它在这条榜上的走势</div>';
  }

  function toggleBoardMenu(on) {
    var menu = $('boardMenu');
    if (!menu) return;
    menu.hidden = !on;
    $('boardPick').setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  /** 标题下拉的选中态与展开按钮上的字 */
  function markBoardPick() {
    var label = $('boardPickLabel');
    if (label) label.textContent = boardLabel(state.board);
    Array.prototype.forEach.call(document.querySelectorAll('#boardMenu button'), function (b) {
      b.setAttribute('aria-checked', b.getAttribute('data-board') === state.board ? 'true' : 'false');
    });
  }

  /** 工具条右侧那行：日期 / 周次 / 条数，缺哪个就不写哪个（年榜就没有日期） */
  function toolbarMeta(data) {
    var bits = [];
    if (data.date) bits.push(fmtDate(data.date));
    if (data.week) bits.push('第 ' + data.week + ' 周');
    bits.push('共 ' + data.count + ' 首');
    return bits.join(' · ');
  }

  function renderToolbar(data) {
    var items = boardIndexItems(state.board);
    var opts = items.map(function (x) {
      return '<option value="' + x.issue + '"' + (x.issue === data.issue ? ' selected' : '') + '>第 ' + x.issue + ' 期'
        + (x.date ? ' · ' + fmtDate(x.date) : '') + '</option>';
    }).reverse().join('');
    // 首末期把"上一期/下一期"置灰：点了没反应比按钮灰着更让人困惑
    var atFirst = data.index <= 0;
    var atLast = data.index >= items.length - 1;
    $('toolbar').innerHTML = '<button class="nav" type="button" data-step="-1" aria-label="上一期" title="上一期"' + (atFirst ? ' disabled' : '') + '>‹</button>'
      + '<select id="issueSel" class="sel" aria-label="选择期次">' + opts + '</select>'
      + '<button class="nav" type="button" data-step="1" aria-label="下一期" title="下一期"' + (atLast ? ' disabled' : '') + '>›</button>'
      // 年榜没有发布日期（上游没给），拼字符串时不能把 null 漏进去
      + '<span class="tl-meta">' + toolbarMeta(data) + '</span>'
      + '<input id="rowFilter" class="filter" placeholder="筛选本期歌曲 / P 主…" autocomplete="off" aria-label="筛选本期歌曲" value="' + esc(state.filter) + '">';
    $('issueSel').addEventListener('change', function (e) { viewIssue(state.board, Number(e.target.value)); });
    Array.prototype.forEach.call(document.querySelectorAll('#toolbar .nav'), function (b) {
      b.addEventListener('click', function () {
        var idx = state.issueIdx + Number(b.getAttribute('data-step'));
        var list = boardIndexItems(state.board);
        if (idx >= 0 && idx < list.length) viewIssue(state.board, list[idx].issue);
      });
    });
    // 筛选时保留输入内容：换期后用户多半还想看同一个筛选条件下的对比
    $('rowFilter').addEventListener('input', function (e) {
      state.filter = e.target.value;
      renderBoard(state.issue, { animate: false });
    });
  }

  /* ---------- 概览 ---------- */
  function renderHero(data) {
    var champ = data.rows[0] || {};
    var side = data.sidebar || {};
    var h = '<div class="hero-top">'
      + '<span class="pill hot">第 ' + data.issue + ' 期</span>'
      + '<span class="pill">' + fmtDate(data.date) + '</span>'
      + (data.week ? '<span class="pill">第 ' + data.week + ' 周</span>' : '')
      // 「共 N 首在榜」删掉了：每期固定就那么多行，区块标题右边已经写着
      // 「第 124 期 · 2026-10-21 · 20 首」，这一格纯属噪音。
      // 传说曲/年榜没有文字版原帖，只有榜单视频，就给那个。
      + (data.postUrl
        ? '<a class="pill link" href="' + esc(data.postUrl) + '" target="_blank" rel="noopener">文字版原帖 ↗</a>'
        : (data.videoBvid ? '<a class="pill link" href="' + videoUrl(data.videoBvid) + '" target="_blank" rel="noopener">榜单视频 ↗</a>' : ''))
      + '</div>';

    h += '<div class="hero-main">'
      + '<div class="cover-wrap" data-bvid="' + esc(champ.bvid) + '" role="button" tabindex="0" aria-label="查看冠军详情">'
      + '<img class="cover-lg" data-img src="' + esc(cover(champ.bvid, 640)) + '" alt=""><span class="play-l"></span></div>'
      + '<div class="champ">'
      + '<div class="lbl">本 期 冠 军</div>'
      + '<h2><a href="' + esc(videoUrl(champ.bvid)) + '" target="_blank" rel="noopener">' + esc(champ.title || '—') + '</a></h2>'
      + (champ.titleAlt ? '<div class="alt">' + esc(champ.titleAlt) + '</div>' : '')
      + '<div class="tags">' + esc(names(champ.producers) || '—') + (champ.vocalists && champ.vocalists.length ? ' · ' + esc(names(champ.vocalists)) : '') + '</div>'
      + '<div class="meta"><span>在榜 ' + champ.weeks + ' 期</span><span>最高 #' + champ.best + '</span>'
      + '<span>' + (champ.prev ? '上周 #' + champ.prev : '上周未上榜') + '</span>'
      + (data.champStreak > 1 ? '<span style="color:var(--warn-ink)">已连冠 ' + data.champStreak + ' 期</span>' : '')
      + '</div></div>';

    h += '<div class="hero-side">'
      + (side.prevChampion ? '<div class="side-item"><span>上周冠军</span><b>' + esc(side.prevChampion.title) + '</b><em>' + (side.prevChampion.rank ? '本期 #' + side.prevChampion.rank : '本期未上榜') + '</em></div>' : '')
      + (side.longest ? '<div class="side-item"><span>在榜最久</span><b>' + esc(side.longest.title) + '</b><em>累计 ' + side.longest.weeks + ' 期</em></div>' : '')
      + '</div></div>';

    h += '<div class="kpis">'
      + kpi('新上榜', data.kpi.news, 'new')
      + kpi('排名上升', data.kpi.ups, 'up')
      + kpi('排名下降', data.kpi.downs, 'down')
      + kpi('冠军连庄', data.kpi.streak)
      + kpi('在榜曲目', data.kpi.count)
      + '</div>';
    $('hero').innerHTML = h;

    window.DshMotion.images($('hero'));
    var cw = $('hero').querySelector('.cover-wrap');
    var heroCtx = { board: state.board, issue: data.issue, bvid: champ.bvid };
    cw.addEventListener('click', function () { openDrawer(champ.songId, heroCtx, cw); });
    cw.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(champ.songId, heroCtx, cw); }
    });
  }

  function kpi(label, value, cls) {
    return '<div class="kpi ' + (cls || '') + '"><b>' + value + '</b><span>' + label + '</span></div>';
  }

  /* ---------- 榜单 ---------- */
  /* 一行榜单。主榜与附榜共用同一套结构：列的含义三张榜完全一样
     （名次 / 相对上一期 / 封面 / 曲目 / 该榜近 30 期走势 / 上一期 / 在榜期数），
     所以列一多就分叉成两份模板的话，改一边忘一边是迟早的事。
     lastIdx 是"当前这一期在该榜序列里的位置"，spark 用它对齐横轴。 */
  function rowHtml(r, lastIdx) {
    var cls = 'row' + (r.rank === 1 ? ' top1' : r.rank === 2 ? ' top2' : r.rank === 3 ? ' top3' : '');
    var dl;
    if (r.state === 'new') dl = '<div class="delta new">NEW</div>';
    else if (r.state === 're') dl = '<div class="delta re">RE</div>';
    else if (r.state === 'up') dl = '<div class="delta up">▲' + r.delta + '</div>';
    else if (r.state === 'down') dl = '<div class="delta down">▼' + (-r.delta) + '</div>';
    else dl = '<div class="delta same">—</div>';
    return '<div class="' + cls + '" role="button" tabindex="0" data-id="' + esc(r.songId) + '" data-bvid="' + esc(r.bvid) + '"'
      + ' aria-label="第 ' + r.rank + ' 名，' + esc(r.title) + '，查看走势">'
      + '<div class="rk mono">' + num(r.rank) + '</div>'
      + dl
      + '<div class="cv-wrap"><img class="cv" data-img loading="lazy" src="' + esc(cover(r.bvid, 320)) + '" alt=""><span class="play"></span></div>'
      + '<div class="tcell"><div class="ttl">' + esc(r.title) + (r.titleAlt ? '<span class="alt">' + esc(r.titleAlt) + '</span>' : '') + '</div>'
      + '<div class="sub">' + esc(names(r.producers) || '—') + (r.vocalists.length ? ' <i>·</i> ' + esc(names(r.vocalists)) : '')
      + (r.variants > 1 ? ' <b class="vb" title="该曲在榜期间使用过 ' + r.variants + ' 个不同稿件">多稿件</b>' : '') + '</div></div>'
      + '<div class="sp">' + spark(r.spark, lastIdx) + '</div>'
      + '<div class="meta">' + (r.prev ? '# ' + r.prev : '—') + '</div>'
      + '<div class="meta"><b>' + r.weeks + '</b> 周</div>'
      + '</div>';
  }

  function renderBoard(data, opts) {
    var animate = !opts || opts.animate !== false;
    var q = state.filter.trim().toLowerCase();
    var rows = data.rows.filter(function (r) {
      if (!q) return true;
      return (r.title + ' ' + r.titleAlt + ' ' + names(r.producers) + ' ' + names(r.vocalists)).toLowerCase().indexOf(q) >= 0;
    });

    var html = rows.map(function (r) { return rowHtml(r, state.issueIdx); }).join('');

    $('rows').innerHTML = html || '<div class="empty">没有匹配的曲目</div>';
    $('boardMeta').textContent = '第 ' + data.issue + ' 期' + (data.date ? ' · ' + fmtDate(data.date) : '') + ' · ' + rows.length + ' 首';
    window.DshMotion.animate($('rows'), { animate: animate });
  }

  function spark(points, lastIdx) {
    if (!points || points.length < 2) return '<span class="spark"></span>';
    var W = 180, H = 24, start = Math.max(0, lastIdx - 29), span = Math.max(1, lastIdx - start);
    var segs = [], last = null, prevI = null;
    points.forEach(function (p) {
      var x = ((p.i - start) / span) * W;
      var y = 3 + ((p.rank - 1) / 19) * (H - 6);
      segs.push((prevI !== null && p.i === prevI + 1 ? 'L ' : 'M ') + x.toFixed(1) + ' ' + y.toFixed(1));
      prevI = p.i;
      last = [x.toFixed(1), y.toFixed(1)];
    });
    // 颜色由 .spark path / .spark circle 决定（主题令牌），这里不写死十六进制
    return '<svg class="spark" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">'
      + '<path d="' + segs.join(' ') + '"/>'
      + '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="2"/></svg>';
  }

  /* ---------- 看点 ---------- */
  function renderInsights(data) {
    var ins = data.insights;
    function li(text, right, cls) {
      return '<li><span class="t">' + esc(text) + '</span><span class="d ' + (cls || '') + '">' + right + '</span></li>';
    }
    $('p-new').innerHTML = '<h4><span>新上榜</span><span>' + ins.news.length + '</span></h4>'
      + (ins.news.length ? '<ul>' + ins.news.map(function (x) { return li('#' + x.rank + ' ' + x.title, 'NEW', 'delta-new'); }).join('') + '</ul>' : '<p>本期无新上榜曲目</p>');
    $('p-up').innerHTML = '<h4><span>上升最快</span><span>' + data.kpi.ups + '</span></h4>'
      + (ins.ups.length ? '<ul>' + ins.ups.map(function (x) { return li(x.title, '▲' + x.delta, 'delta-up'); }).join('') + '</ul>' : '<p>本期无明显上升</p>');
    $('p-down').innerHTML = '<h4><span>跌出榜单</span><span>' + ins.outs.length + '</span></h4>'
      + (ins.outs.length ? '<ul>' + ins.outs.map(function (x) { return li(x.title, '上周 #' + x.rank, 'delta-down'); }).join('') + '</ul>' : '<p>上周曲目全部在榜</p>');
    window.DshMotion.animate(document.querySelector('#insightSec .grid3'), { animate: true });
  }

  /* ---------- 冠军榜 ---------- */
  function renderChampions() {
    var data = state.champions;
    $('champs').innerHTML = data.runs.map(function (r) {
      var label = r.issueFrom === r.issueTo ? '第 ' + r.issueFrom + ' 期' : '第 ' + r.issueFrom + '–' + r.issueTo + ' 期';
      return '<div class="champ-item" role="button" tabindex="0" data-id="' + esc(r.id) + '" data-bvid="' + esc(r.bvid) + '" data-issue="' + r.issueTo + '"'
        + ' aria-label="' + esc(r.title) + '，' + label + '，查看详情">'
        + '<img data-img loading="lazy" src="' + esc(cover(r.bvid, 320)) + '" alt="">'
        + '<div style="min-width:0"><div class="t">' + esc(r.title) + '</div><div class="m">' + label + ' · ' + fmtDate(r.date) + '</div></div>'
        + '<div class="c">' + (r.count > 1 ? r.count + ' 连冠' : '1 周') + '</div></div>';
    }).join('');
    $('champMeta').textContent = '共 ' + data.total + ' 段冠军 · 显示最近 ' + data.runs.length + ' 段';
    window.DshMotion.animate($('champs'), { animate: true });
  }

  /* ---------- 歌曲列表 / 走势 ---------- */
  function fillSongList(q, opts) {
    var animate = !opts || opts.animate !== false;
    var needle = (q || '').trim().toLowerCase();
    var list = state.songs.filter(function (s) {
      return !needle || (s.title + ' ' + s.titleAlt).toLowerCase().indexOf(needle) >= 0;
    }).slice(0, 120);
    $('songItems').innerHTML = list.map(function (s) {
      return '<button type="button" class="song-item' + (String(s.id) === String(state.curSong) ? ' on' : '') + '" data-id="' + esc(s.id) + '">'
        + '<span class="t">' + esc(s.title) + '</span><span class="w">' + s.weeks + ' 期</span></button>';
    }).join('') || '<div style="padding:10px;color:var(--faint);font-size:12.5px">没有匹配的歌曲</div>';
    // 搜索框每敲一个字都会重绘，这里不能播入场
    window.DshMotion.animate($('songItems'), { animate: animate });
  }

  /* 三个 id 空间：主榜/传说曲/年榜共用 Biliboard 的 song.id；ニコニコ 榜用曲名。
     缓存键带上榜名，否则一首歌在两个榜上可能撞到同一个键。 */
  async function fetchSong(id, board) {
    board = board || state.board;
    var key = board + ':' + String(id);
    if (state.songCache.has(key)) return state.songCache.get(key);
    var base = board === 'weekly' ? '/api/songs/'
      : board === 'nico' ? '/api/nico/song/'
      : '/api/' + board + '/song/';
    var data = await api(base + encodeURIComponent(id));
    state.songCache.set(key, data);
    return data;
  }

  async function selectSong(id) {
    state.curSong = id;
    fillSongList($('q').value, { animate: false });
    var song = await fetchSong(id, state.board);
    state.curTrend = { key: state.board, song: song };
    fitSongIntoRange(state.board, song);
    renderRangeControls(state.board);
    drawTrend(state.board);
    scrollToSection($('trendSec'));
  }

  /* 走势图。ctx 指定"画到哪个容器、用哪张榜的期次索引"：
     两条榜的期号序列不同，图上的横轴必须用各自的那一份，否则 B 榜第 124 期
     和 N 榜第 124 期会被画在同一个横坐标上。 */
  /* ctx = { card, indexByIssue, issues, range }。range 决定横轴的起止期 ——
     横轴画的是"选中的那段区间"，不是"这首曲子自己的上榜区间"：
     否则把区间改到近 5 期时，图上会突然只剩 2 个点，看不出它和其它期的关系。 */
  function renderChart(song, ctx) {
    ctx = ctx || {};
    var card = ctx.card || $('chartCard');
    var issues = ctx.issues || [];
    var map = ctx.indexByIssue || new Map();
    var all = song.appearances || [];
    if (!all.length) { card.innerHTML = '<div style="color:var(--faint)">暂无走势数据</div>'; return; }

    var win = ctx.range || { fromIdx: 0, toIdx: issues.length - 1 };
    var first = Math.max(0, Math.min(win.fromIdx, Math.max(0, issues.length - 1)));
    var last = Math.max(first, Math.min(win.toIdx, Math.max(0, issues.length - 1)));

    var app = [], idx = [];
    all.forEach(function (a) {
      var i = map.get(a.issue);
      if (i == null || i < first || i > last) return;
      app.push(a); idx.push(i);
    });

    var rangeText = '第 ' + (issues[first] ? issues[first].issue : first) + '–' + (issues[last] ? issues[last].issue : last) + ' 期';
    // 单曲档案里的四块小图由卡片自己写标题，图就不用再带一份
    if (ctx.bare) {
      if (!app.length) { card.innerHTML = '<div class="sc-empty">这段区间里没有上榜记录</div>'; return; }
      if (app.length === 1) { card.innerHTML = '<div class="sc-empty">区间内只上榜 1 期（#' + app[0].rank + '）</div>'; return; }
    }
    var head = ctx.bare ? '' : '<div class="chart-head"><h4>' + esc(song.title) + '</h4>'
      + '<span class="st">' + rangeText + ' · 区间内上榜 ' + app.length + ' 期 · 最高 #' + song.best + '</span>'
      + (all[all.length - 1].bvid ? '<a class="lnk" href="' + videoUrl(all[all.length - 1].bvid) + '" target="_blank" rel="noopener">在 B 站打开 ↗</a>' : '')
      + '</div>';

    if (!app.length) {
      card.innerHTML = head + '<div class="single-rank"><div>这个区间没有上榜记录</div>'
        + '<div>该曲最早出现在第 ' + all[0].issue + ' 期，共在榜 ' + all.length + ' 期</div>'
        + (ctx.jump ? '<button class="btn sm" type="button" id="jumpRange">跳到它在榜的区间</button>' : '')
        + '</div>';
      if (ctx.jump) card.querySelector('#jumpRange').addEventListener('click', ctx.jump);
      return;
    }
    if (app.length === 1) {
      var one = app[0];
      card.innerHTML = head + '<div class="single-rank"><div class="big">#' + one.rank + '</div>'
        + '<div>区间内只在第 ' + one.issue + ' 期（' + fmtDate(one.date) + '）上榜一次</div></div>';
      return;
    }

    var span = Math.max(1, last - first);
    var W = 780, H = 320, PL = 44, PR = 22, PT = 26, PB = 42, iw = W - PL - PR, ih = H - PT - PB;
    function X(i) { return PL + ((i - first) / span) * iw; }
    function Y(r) { return PT + ((r - 1) / 19) * ih; }

    var segs = [], dots = '', prevI = null;
    app.forEach(function (a, k) {
      var x = X(idx[k]), y = Y(a.rank);
      segs.push((prevI !== null && idx[k] === prevI + 1 ? 'L ' : 'M ') + x.toFixed(1) + ' ' + y.toFixed(1));
      prevI = idx[k];
      dots += '<circle class="trend-dot" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.2"></circle>';
    });

    var grid = '';
    [1, 5, 10, 15, 20].forEach(function (r) {
      var y = Y(r);
      grid += '<line class="trend-grid" x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y.toFixed(1) + '"/>'
        + '<text class="chart-txt" x="' + (PL - 10) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end">#' + r + '</text>';
    });

    var ticks = '';
    var step = Math.max(1, Math.ceil(span / 7));
    for (var i = first; i <= last; i += step) {
      var issueNo = issues[i] ? issues[i].issue : '';
      ticks += '<text class="chart-txt" x="' + X(i).toFixed(1) + '" y="' + (H - PB + 20) + '" text-anchor="middle">' + issueNo + '期</text>';
    }

    // pathLength="1" 让描线动画不需要在 JS 里量路径长度（见 motion.js 的 chart()）
    card.innerHTML = head + '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(song.title) + ' 逐期名次走势">'
      + grid
      + '<path class="trend-line" pathLength="1" d="' + segs.join(' ') + '"/>'
      + dots + ticks + '</svg>';

    window.DshMotion.chart(card.querySelector('svg.chart'));
  }

  /* ---------- 抽屉 ---------- */
  function ensureDrawer() {
    if ($('drawer')) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = '<div class="overlay" id="overlay"></div>'
      + '<aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-labelledby="drawerTitle" aria-hidden="true">'
      + '<button class="close" id="drawerClose" type="button" aria-label="关闭">×</button>'
      + '<div class="player" id="player"></div>'
      + '<div class="d-body" id="drawerBody"></div></aside>';
    document.body.appendChild(wrap);
    $('overlay').addEventListener('click', closeDrawer);
    $('drawerClose').addEventListener('click', closeDrawer);

    // 稿件切换按钮是整块重绘的，委托到 #drawerBody 一次即可
    $('drawerBody').addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.bv');
      if (!b) return;
      state.drawer.bvid = b.getAttribute('data-bv');
      paintDrawer();
    });
  }

  /* ctx = { board, issue, bvid }：board 决定抽屉里看的是哪张榜的记录。
     不传就是周榜 —— 三张榜的期号长得一模一样（都有"第 84 期"），
     不把榜名带上，抽屉会把年榜第 3 期当成周榜第 3 期去查，然后显示错的名字。 */
  async function openDrawer(songId, ctx, opener) {
    if (!songId) return;
    ensureDrawer();
    // 记住点开抽屉的那一行：关闭时把焦点还回去，键盘用户不会掉到页面顶部。
    // 优先用传进来的激活元素：程序化点击（或某些浏览器）里 document.activeElement
    // 可能还停在 body 上，那样"关闭后焦点回到原处"就静默失效了。
    state.drawer.returnFocus = opener || document.activeElement;
    var c = ctx || {};
    var song = await fetchSong(songId, c.board || 'weekly');
    state.drawer = {
      open: true, id: songId, song: song,
      board: c.board || 'weekly', issue: Number(c.issue), bvid: c.bvid || '',
      returnFocus: state.drawer.returnFocus
    };
    $('drawer').classList.add('on');
    $('overlay').classList.add('on');
    $('drawer').setAttribute('aria-hidden', 'false');
    window.DshMotion.lockScroll(true);
    paintDrawer();
    $('drawerClose').focus();
  }

  function closeDrawer() {
    if (!$('drawer') || !state.drawer.open) return;
    state.drawer.open = false;
    $('drawer').classList.remove('on');
    $('overlay').classList.remove('on');
    $('drawer').setAttribute('aria-hidden', 'true');
    $('player').innerHTML = '';
    window.DshMotion.lockScroll(false);
    var back = state.drawer.returnFocus;
    state.drawer.returnFocus = null;
    if (back && document.contains(back)) back.focus();
  }

  /* 某张榜上的上榜记录。三张榜各存一份，不互相借用。
     周榜与ニコニコ榜的记录直接放在顶层 appearances（各自的接口就是这么返回的），
     传说曲/年榜放在 boards 里。 */
  function boardAppearances(song, board) {
    var b = song.boards && song.boards[board];
    return b ? b.appearances || [] : song.appearances || [];
  }

  function boardStat(song, board) {
    var b = song.boards && song.boards[board];
    return b ? { weeks: b.weeks, best: b.best } : { weeks: song.weeks || 0, best: song.best };
  }

  /* 抽屉底部的"去原帖"入口：每条榜的来源不一样，就给各自最接近原文的那个 */
  function boardLinkHtml(board) {
    if (board === 'weekly') {
      return state.issue && state.issue.postUrl
        ? '<a class="btn" href="' + esc(state.issue.postUrl) + '" target="_blank" rel="noopener">本期文字版</a>'
        : '';
    }
    if (board === 'nico') {
      var url = nicoPostUrl();
      return url ? '<a class="btn" href="' + esc(url) + '" target="_blank" rel="noopener">本期文字版</a>' : '';
    }
    // 传说曲 / 年榜没有文字版原帖，只有当期的榜单视频
    var video = state.issue && state.issue.videoBvid;
    return video ? '<a class="btn" href="' + videoUrl(video) + '" target="_blank" rel="noopener">榜单视频</a>' : '';
  }

  function paintDrawer() {
    var d = state.drawer, song = d.song;
    var board = d.board || 'weekly';
    var list = boardAppearances(song, board);
    var at = null;
    for (var i = 0; i < list.length; i++) { if (list[i].issue === d.issue) { at = list[i]; break; } }
    // 这一期没上榜（例如从冠军卡点进来选的是夺冠那期）：退到这张榜上最近的一次
    if (!at) at = list[list.length - 1] || null;
    var bvid = d.bvid || (at ? at.bvid : '');
    var stat = boardStat(song, board);

    $('player').innerHTML = bvid
      ? '<iframe src="' + playerUrl(bvid) + '" scrolling="no" frameborder="0" allowfullscreen allow="autoplay; encrypted-media" title="视频播放器"></iframe>'
      : '<div class="no-player">没有可播放的稿件</div>';

    var byBvid = new Map();
    list.forEach(function (a) {
      if (!a.bvid) return;
      if (!byBvid.has(a.bvid)) byBvid.set(a.bvid, []);
      byBvid.get(a.bvid).push(a.issue);
    });
    var variantList = [];
    byBvid.forEach(function (issues, bv) { variantList.push({ bvid: bv, issues: issues }); });

    var variants = variantList.map(function (v) {
      return '<button class="bv' + (v.bvid === bvid ? ' on' : '') + '" type="button" data-bv="' + esc(v.bvid) + '">'
        + '<span class="mono">' + esc(v.bvid) + '</span><em>' + v.issues.map(function (n) { return '第' + n + '期'; }).join('、') + '</em></button>';
    }).join('');

    var history = list.slice().reverse().slice(0, 12).map(function (a) {
      return '<li><span>第 ' + a.issue + ' 期</span><b>#' + a.rank + '</b><em>' + fmtDate(a.date) + '</em></li>';
    }).join('');

    // 另外两张榜上的成绩：点开一首年榜曲时，"它周榜上过几期、最高第几"是最自然的下一个问题
    var cross = [];
    (board === 'nico' ? [] : ['weekly', 'legend', 'annual']).forEach(function (n) {
      if (n === board) return;
      var s = boardStat(song, n);
      if (!s.weeks) return;
      cross.push('<li><span>' + BOARD_LABEL[n] + '</span><b>' + s.weeks + ' 期</b><em>最高 #' + s.best + '</em></li>');
    });

    $('drawerBody').innerHTML = '<div class="d-head"><h3 id="drawerTitle">' + esc(song.title) + '</h3>'
      + (song.titleAlt ? '<div class="alt">' + esc(song.titleAlt) + '</div>' : '')
      + '<div class="tags">' + esc(names(song.producers) || '—') + (song.vocalists.length ? ' · ' + esc(names(song.vocalists)) : '') + '</div></div>'
      + '<div class="d-stats">'
      + '<div><b>' + (at ? '#' + at.rank : '—') + '</b><span>' + (board === 'weekly' ? '本期名次' : '该期名次') + '</span></div>'
      + '<div><b>' + (stat.best ? '#' + stat.best : '—') + '</b><span>最高名次</span></div>'
      + '<div><b>' + stat.weeks + '</b><span>在榜期数</span></div>'
      + '<div><b>' + variantList.length + '</b><span>使用稿件</span></div>'
      + '</div>'
      + '<div class="d-sec"><h4>' + BOARD_LABEL[board] + ' · 稿件（同一首歌可能更换视频）</h4><div class="bv-list">' + variants + '</div></div>'
      + '<div class="d-sec"><h4>' + BOARD_LABEL[board] + ' · 上榜记录</h4>' + (history ? '<ol class="history">' + history + '</ol>' : '<p class="no-player">这张榜上没有记录</p>') + '</div>'
      + (cross.length ? '<div class="d-sec"><h4>另外两张榜</h4><ol class="history">' + cross.join('') + '</ol></div>' : '')
      + '<div class="d-actions">'
      + (bvid ? '<a class="btn primary" href="' + videoUrl(bvid) + '" target="_blank" rel="noopener">在 B 站打开</a>' : '')
      + boardLinkHtml(board)
      + '</div>';
  }

  /* ---------- 传说曲周榜 / 年榜的目录 ----------
   *
   * 这两条榜已经是标题下拉里的一等公民（见 setBoard），不再是"附榜"。
   * 这里只负责把它们的**期次列表**拉下来：下拉的选项、上一期/下一期、
   * 走势图的横轴都要用；某一期的数据走 loadBoardIssue，与周榜共用缓存。
   */
  async function loadBoardIndexes() {
    var names = ['legend', 'annual'];
    var results = await Promise.all(names.map(function (n) {
      // 某一条榜没有数据（或接口出问题）不该拖垮另一条
      return api('/api/' + n).catch(function () { return null; });
    }));
    names.forEach(function (n, i) {
      var data = results[i];
      if (!data || !data.items || !data.items.length) return;
      state.extras.index[n] = data;
    });
    markBoardPick();
    // 上次看的是传说榜 / 年榜就切回去 —— 但要等目录到手才知道那条榜有哪些期
    var want = storedBoard();
    if (want !== state.board && boardIndexItems(want).length) setBoard(want, { silent: true });
  }

  /* 期次下拉的选项：倒序（最近一期在最上面），期号 + 日期 */
  function issueOptionsHtml(items, current) {
    return items.map(function (x) {
      return '<option value="' + x.issue + '"' + (x.issue === current ? ' selected' : '') + '>第 ' + x.issue + ' 期'
        + (x.date ? ' · ' + fmtDate(x.date) : '') + '</option>';
    }).reverse().join('');
  }

  /* ---------- 附榜：ニコニコ VOCALOID SONGS TOP20 ----------
   *
   * 和上面两条附榜不同，这条来自**另一个 UP 主**，也没有官方曲目库：
   * 帖子正文就是数据源（自带「上周：N」「在榜周数：M」）。所以它的曲目身份是
   * 曲名而不是 Biliboard ID，单曲详情走 /api/nico/song/:id，不与 /api/songs 混用。
   */
  async function loadNico() {
    state.nico.loading = true;
    try {
      // 目录 / 冠军段 / 曲目索引 一次拿齐：切到 N 榜时就该立刻有东西，
      // 而不是切过去之后再看三个骨架屏
      var results = await Promise.all([
        api('/api/nico'),
        api('/api/nico/champions?limit=24').catch(function () { return { total: 0, runs: [] }; }),
        api('/api/nico/songs?limit=1000').catch(function () { return { total: 0, items: [] }; })
      ]);
      var data = results[0];
      if (!data.items || !data.items.length) {
        state.nico.loaded = false;
        if (state.view === 'n') state.view = 'b';
        applyView();
        return;
      }
      state.nico.index = data;
      state.nico.indexByIssue = null;
      state.nico.cache.clear();
      state.songCache.clear();
      state.nico.champions = results[1];
      state.nico.songs = results[2].items || [];
      state.nico.loaded = true;
      applyView();
      if (data.account) {
        $('nicoAuthor').textContent = data.account.name;
        $('nicoAuthor').href = data.account.spaceUrl;
      }
      renderNicoChampions();
      fillNicoSongList($('nq') ? $('nq').value : '', { animate: false });
      await selectNico(data.items[data.items.length - 1].issue, { silent: true });
      // 加载期间点过 N 榜的，这时候补上 —— 不再需要用户再点一次
      if (state.pendingView) { state.view = state.pendingView; state.pendingView = null; }
      applyView();
    } catch (e) {
      // 附榜挂了不该影响主榜：这条榜整块不出现，B 榜照常
      state.nico.loaded = false;
      state.pendingView = null;
      if (state.view === 'n') state.view = 'b';
      applyView();
    } finally {
      state.nico.loading = false;
    }
  }

  async function loadNicoIssue(issue) {
    var key = String(issue);
    if (state.nico.cache.has(key)) return state.nico.cache.get(key);
    var data = await api('/api/nico/' + issue);
    state.nico.cache.set(key, data);
    return data;
  }

  function nicoMetaText(data) {
    var bits = [];
    if (data.date) bits.push(fmtDate(data.date));
    if (data.period) bits.push('统计 ' + data.period.from + '–' + data.period.to);
    bits.push(data.count + ' 首' + (data.missing && data.missing.length ? '（缺第 ' + data.missing.join('、') + ' 名）' : ''));
    return bits.join(' · ');
  }

  function renderNicoToolbar(data) {
    var opts = issueOptionsHtml(state.nico.index.items, data.issue);
    var sib = data.siblings || {};
    $('nicoToolbar').innerHTML = '<button class="nav" type="button" data-to="-1"' + (sib.prev == null ? ' disabled' : '') + ' aria-label="上一期">‹</button>'
      + '<select id="nicoSel" class="sel" aria-label="选择期次">' + opts + '</select>'
      + '<button class="nav" type="button" data-to="1"' + (sib.next == null ? ' disabled' : '') + ' aria-label="下一期">›</button>'
      + '<span class="tl-meta">' + esc(nicoMetaText(data)) + '</span>';

    $('nicoSel').addEventListener('change', function (e) {
      selectNico(Number(e.target.value), { silent: true });
    });
    Array.prototype.forEach.call($('nicoToolbar').querySelectorAll('.nav'), function (b) {
      b.addEventListener('click', function () {
        if (b.disabled) return;
        var target = Number(b.getAttribute('data-to')) < 0 ? sib.prev : sib.next;
        if (target != null) selectNico(target, { silent: true });
      });
    });
  }

  function renderNicoRows(data) {
    $('nicoRows').innerHTML = data.rows.map(function (r) { return rowHtml(r, data.index); }).join('')
      || '<div class="empty">这一期没有数据</div>';
    // 区间与总条数已经写在页面副标题里了，这里不再重复；改成"这一期是否满员" ——
    // 数据质量放在最显眼的位置，是这个项目的一贯做法（缺一行就写缺一行）。
    $('nicoMeta').textContent = (data.missing && data.missing.length)
      ? '缺第 ' + data.missing.join('、') + ' 名'
      : '本期满员 · ' + data.count + ' / 20';
    window.DshMotion.animate($('nicoRows'), { animate: true });
  }

  async function selectNico(issue, opts) {
    var o = opts || {};
    var data = await loadNicoIssue(issue);
    state.nico.curIssue = data.issue;
    renderNicoHero(data);
    renderNicoToolbar(data);
    renderNicoRows(data);
    renderNicoInsights(data);
    if (!o.silent) scrollToSection($('nicoSec'));
  }

  /* ニコニコ 榜的冠军卡。结构与 B 榜的 renderHero 一致（.hero 那套类名），
     所以两条榜的"本期概览"是同一种东西，而不是各画一版。 */
  function renderNicoHero(data) {
    var champ = data.champion || {};
    var side = data.sidebar || {};

    var h = '<div class="hero-top">'
      + '<span class="pill hot">第 ' + data.issue + ' 期</span>'
      + '<span class="pill">' + fmtDate(data.date) + '</span>'
      + (data.period ? '<span class="pill">统计 ' + esc(data.period.from) + '–' + esc(data.period.to) + '</span>' : '')
      + (data.postUrl ? '<a class="pill link" href="' + esc(data.postUrl) + '" target="_blank" rel="noopener">文字版原帖 ↗</a>' : '')
      + '</div>';

    h += '<div class="hero-main">'
      + '<div class="cover-wrap" role="button" tabindex="0" aria-label="查看冠军详情">'
      // 没有稿件 BV 时不渲染 img：<img src=""> 会让浏览器回头再请求一次当前页面
      + (champ.bvid ? '<img class="cover-lg" data-img src="' + esc(cover(champ.bvid, 640)) + '" alt="">' : '')
      + '<span class="play-l"></span></div>'
      + '<div class="champ">'
      + '<div class="lbl">本 期 冠 军</div>'
      + '<h2><a href="' + esc(champ.bvid ? videoUrl(champ.bvid) : '#') + '" target="_blank" rel="noopener">' + esc(champ.title || '—') + '</a></h2>'
      + '<div class="tags">' + esc(champ.producer || '—') + '</div>'
      + '<div class="meta">'
      + '<span>在榜 ' + (champ.weeks != null ? champ.weeks : '—') + ' 期</span>'
      + '<span>最高 #' + (champ.best != null ? champ.best : '—') + '</span>'
      + '<span>' + (champ.prev ? '上周 #' + champ.prev : '上周未上榜') + '</span>'
      + (data.champStreak > 1 ? '<span style="color:var(--warn-ink)">已连冠 ' + data.champStreak + ' 期</span>' : '')
      + '</div></div>';

    h += '<div class="hero-side">'
      + (side.prevChampion ? '<div class="side-item"><span>上周冠军</span><b>' + esc(side.prevChampion.title) + '</b><em>' + (side.prevChampion.rank ? '本期 #' + side.prevChampion.rank : '本期未上榜') + '</em></div>' : '')
      + (side.longest ? '<div class="side-item"><span>在榜最久</span><b>' + esc(side.longest.title) + '</b><em>累计 ' + side.longest.weeks + ' 期</em></div>' : '')
      + '</div></div>';

    h += '<div class="kpis">'
      + kpi('新上榜', data.kpi.news, 'new')
      + kpi('排名上升', data.kpi.ups, 'up')
      + kpi('排名下降', data.kpi.downs, 'down')
      + kpi('冠军连庄', data.kpi.streak)
      + kpi('在榜曲目', data.kpi.count)
      + '</div>';

    $('nicoHero').innerHTML = h;
    window.DshMotion.images($('nicoHero'));

    var cw = $('nicoHero').querySelector('.cover-wrap');
    if (!cw || !champ.songId) return;
    var ctx = { board: 'nico', issue: data.issue, bvid: champ.bvid };
    cw.addEventListener('click', function () { openDrawer(champ.songId, ctx, cw); });
    cw.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(champ.songId, ctx, cw); }
    });
  }

  /* 下面三块与 B 榜同名同构：看点 / 冠军榜 / 走势。
     结构照抄不是为了省事，是为了"两条榜的同一件事长得一样" ——
     用户不需要在两套不同的信息架构之间重新学一遍。 */

  function renderNicoInsights(data) {
    var ins = data.insights || { news: [], ups: [], outs: [] };
    function li(text, right, cls) {
      return '<li><span class="t">' + esc(text) + '</span><span class="d ' + (cls || '') + '">' + right + '</span></li>';
    }
    $('n-new').innerHTML = '<h4><span>新上榜</span><span>' + data.kpi.news + '</span></h4>'
      + (ins.news.length ? '<ul>' + ins.news.map(function (x) { return li('#' + x.rank + ' ' + x.title, 'NEW', 'delta-new'); }).join('') + '</ul>' : '<p>本期无新上榜曲目</p>');
    $('n-up').innerHTML = '<h4><span>上升最快</span><span>' + data.kpi.ups + '</span></h4>'
      + (ins.ups.length ? '<ul>' + ins.ups.map(function (x) { return li(x.title, '▲' + x.delta, 'delta-up'); }).join('') + '</ul>' : '<p>本期无明显上升</p>');
    $('n-down').innerHTML = '<h4><span>跌出榜单</span><span>' + ins.outs.length + '</span></h4>'
      + (ins.outs.length ? '<ul>' + ins.outs.map(function (x) { return li(x.title, '上期 #' + x.rank, 'delta-down'); }).join('') + '</ul>' : '<p>上期曲目全部在榜</p>');
    window.DshMotion.animate(document.querySelector('#nicoInsightSec .grid3'), { animate: true });
  }

  function renderNicoChampions() {
    var data = state.nico.champions || { total: 0, runs: [] };
    $('nicoChamps').innerHTML = data.runs.map(function (r) {
      var label = r.issueFrom === r.issueTo ? '第 ' + r.issueFrom + ' 期' : '第 ' + r.issueFrom + '–' + r.issueTo + ' 期';
      return '<div class="champ-item" role="button" tabindex="0" data-id="' + esc(r.id) + '" data-bvid="' + esc(r.bvid) + '" data-issue="' + r.issueTo + '"'
        + ' aria-label="' + esc(r.title) + '，' + label + '，查看详情">'
        + '<img data-img loading="lazy" src="' + esc(cover(r.bvid, 320)) + '" alt="">'
        + '<div style="min-width:0"><div class="t">' + esc(r.title) + '</div><div class="m">' + label + ' · ' + fmtDate(r.date) + '</div></div>'
        + '<div class="c">' + (r.count > 1 ? r.count + ' 连冠' : '1 周') + '</div></div>';
    }).join('');
    $('nicoChampMeta').textContent = '共 ' + data.total + ' 段冠军 · 显示最近 ' + data.runs.length + ' 段';
    window.DshMotion.animate($('nicoChamps'), { animate: true });
  }

  function nicoIndexMap() {
    if (!state.nico.indexByIssue) {
      var m = new Map();
      ((state.nico.index && state.nico.index.items) || []).forEach(function (x, i) { m.set(x.issue, i); });
      state.nico.indexByIssue = m;
    }
    return state.nico.indexByIssue;
  }

  function fillNicoSongList(q, opts) {
    var animate = !opts || opts.animate !== false;
    var needle = (q || '').trim().toLowerCase();
    var list = (state.nico.songs || []).filter(function (s) {
      return !needle || String(s.title).toLowerCase().indexOf(needle) >= 0;
    }).slice(0, 120);
    $('nicoSongItems').innerHTML = list.map(function (s) {
      return '<button type="button" class="song-item' + (String(s.id) === String(state.nico.curSong) ? ' on' : '') + '" data-id="' + esc(s.id) + '">'
        + '<span class="t">' + esc(s.title) + '</span><span class="w">' + s.weeks + ' 期</span></button>';
    }).join('') || '<div style="padding:10px;color:var(--faint);font-size:12.5px">没有匹配的歌曲</div>';
    window.DshMotion.animate($('nicoSongItems'), { animate: animate });
  }

  async function selectNicoSong(id) {
    state.nico.curSong = id;
    fillNicoSongList($('nq').value, { animate: false });
    var song = await fetchSong(id, 'nico');
    state.curTrend = { key: 'nico', song: song };
    fitSongIntoRange('nico', song);
    renderRangeControls('nico');
    drawTrend('nico');
    scrollToSection($('nicoTrendSec'));
  }

  /** 在ニコニコ榜上前后翻一期（左右方向键、上一期/下一期按钮都走这里） */
  function stepNico(step) {
    var idx = state.nico.index;
    if (!idx) return;
    var pos = -1;
    idx.items.forEach(function (x, i) { if (x.issue === state.nico.curIssue) pos = i; });
    var next = pos + step;
    if (pos < 0 || next < 0 || next >= idx.items.length) return;
    selectNico(idx.items[next].issue, { silent: true });
  }

  /** 当前ニコニコ榜这一期的文字版原帖（抽屉里的入口） */
  function nicoPostUrl() {
    var idx = state.nico.index;
    if (!idx) return '';
    var hit = null;
    idx.items.forEach(function (x) { if (x.issue === state.nico.curIssue) hit = x; });
    return hit ? hit.postUrl || '' : '';
  }

  /* ---------- 刷新：真的去 B 站重抓一次 ----------
   *
   * 以前这里是"重读磁盘"（POST /api/reload）：只对命令行跑完 update 之后有意义，
   * 在网页上点它等于什么也没发生。现在改成启动一个后台更新任务，前端轮询进度：
   * 一次更新要同步官方库 + 抓帖 + 抓附榜，几分钟量级，不能挂在一个 HTTP 请求上。
   */
  var POLL_MS = 1500;
  var POLL_MAX_MS = 25 * 60 * 1000;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function refresh() {
    var btn = $('refreshBtn');
    var label = btn.querySelector('.lbl');
    if (btn.classList.contains('loading')) return;
    btn.classList.add('loading');
    label.textContent = '抓取中';
    try {
      var status = await api('/api/update', { method: 'POST' });
      if (status.started === false) toast('已经在更新了，等它跑完');

      var waited = 0;
      while (status.running) {
        await sleep(POLL_MS);
        waited += POLL_MS;
        if (waited > POLL_MAX_MS) {
          toast('更新跑了 25 分钟还没完，先停在这里；稍后刷新页面看结果', 'err');
          return;
        }
        try {
          status = await api('/api/update');
        } catch (e) {
          // 更新期间服务端在写盘，偶发一个失败不该让轮询停下
          continue;
        }
        if (status.stageLabel) label.textContent = status.stageLabel;
      }
      await afterUpdate(status.last);
    } catch (err) {
      toast('更新失败：' + err.message, 'err');
    } finally {
      btn.classList.remove('loading');
      label.textContent = '刷新';
    }
  }

  /** 把服务端的新数据整套取回来，并停在当前这条榜的最新一期 */
  async function reloadData() {
    var results = await Promise.all([
      api('/api/meta'),
      api('/api/issues'),
      api('/api/champions?limit=24'),
      api('/api/songs?limit=1000')
    ]);
    state.meta = results[0];
    state.issues = results[1].items;
    state.champions = results[2];
    state.songs = results[3].items;
    state.indexByIssue = new Map();
    state.issues.forEach(function (it, i) { state.indexByIssue.set(it.issue, i); });
    state.issueCache.clear();
    state.songCache.clear();
    state.boardCache = { champions: { weekly: state.champions }, songs: { weekly: state.songs } };
    state.boardMaps = {};
    state.extras.index = {};
    state.curSong = null;

    await loadBoardIndexes();
    if (!boardIndexItems(state.board).length) state.board = 'weekly';
    if (state.board !== 'weekly') await loadBoardResources(state.board);

    var list = boardIndexItems(state.board);
    var latest = list[list.length - 1].issue;
    await viewIssue(state.board, latest, { silent: true });
    fillSongList($('q').value, { animate: false });
    chartPlaceholder();
    await loadNico();
    return { before: before, latest: latest };
  }

  /** 更新跑完：重载 + 一句话结果 */
  async function afterUpdate(last) {
    var res = await reloadData();
    var before = res.before;
    var latest = res.latest;

    // 结果提示分三档：变了什么 / 没变 / 哪一段没成。不要把它们搅成一句话，
    // 否则"已是最新：官方库没同步上"读起来像是件好事。
    var done = [];
    var warn = [];
    if (last && last.ok) {
      var c = last.crawl || {};
      var n = last.nico || {};
      if (c.fetched) done.push('新抓帖子 ' + c.fetched + ' 条');
      if (n.fetched) done.push('附榜 ' + n.fetched + ' 期');
      if (last.syncError) warn.push('官方库没连上，曲目库保持原样');
      if ((c.failed || 0) + (n.failed || 0) > 0) warn.push('失败 ' + ((c.failed || 0) + (n.failed || 0)) + ' 项');
      if (last.ms) done.push(Math.round(last.ms / 1000) + 's');
    } else if (last && last.error) {
      warn.push(last.error);
    }
    var head = latest !== before ? '已更新到第 ' + latest + ' 期' : '已是最新（第 ' + latest + ' 期）';
    toast(head + (done.length ? ' · ' + done.join(' · ') : '') + (warn.length ? ' · ' + warn.join(' · ') : ''), warn.length ? 'err' : '');
  }

  /* ---------- 单曲档案 ----------
   * 以一首曲子为中心：四条榜上的记录摊在一起。
   * 跨榜靠曲名对齐 —— Biliboard 用 song.id，ニコニコ 用曲名，两套 id 空间在服务端拼好。
   */
  var songTimer = null;

  async function loadSongIndex(q) {
    var data = await api('/api/find?limit=100&q=' + encodeURIComponent(q || ''));
    state.song.items = data.items || [];
    state.song.q = q || '';
    renderSongPick();
    if ($('songMeta')) {
      $('songMeta').textContent = state.song.q
        ? '匹配 ' + data.total + ' 首'
        : '共 ' + data.total + ' 首 · 按在榜期数排序';
    }
  }

  function songCountsText(c) {
    var bits = [];
    if (c.weekly) bits.push('周 ' + c.weekly);
    if (c.legend) bits.push('传 ' + c.legend);
    if (c.annual) bits.push('年 ' + c.annual);
    if (c.nico) bits.push('N ' + c.nico);
    return bits.join(' · ');
  }

  function renderSongPick() {
    var html = state.song.items.map(function (s) {
      var key = (s.kind === 'n' ? 'n:' : 'b:') + s.id;
      var badge = songCountsText(s.counts) || '—';
      return '<button type="button" class="song-item' + (key === state.song.cur ? ' on' : '') + '" data-key="' + esc(key) + '"'
        + ' title="' + esc(s.title + '（周榜 ' + s.counts.weekly + ' · 传说榜 ' + s.counts.legend + ' · 年榜 ' + s.counts.annual + ' · ニコニコ ' + s.counts.nico + ' 期）') + '">'
        + '<span class="t">' + esc(s.title) + '</span>'
        + '<span class="w">' + esc(badge) + '</span></button>';
    }).join('') || '<div style="padding:10px;color:var(--faint);font-size:12.5px">没有匹配的曲子</div>';
    $('songPick').innerHTML = html;
    window.DshMotion.animate($('songPick'), { animate: false });
  }

  function boardCtxFor(name) {
    if (name === 'nico') return { issues: rangeItems('nico'), map: nicoIndexMap() };
    return { issues: boardIndexItems(name), map: boardIndexMap(name) };
  }

  function scKpi(label, stats) {
    var on = stats && stats.weeks;
    return '<div class="sc-kpi' + (on ? '' : ' off') + '"><b>' + (on ? stats.weeks + ' 期' : '—') + '</b>'
      + '<span>' + esc(label) + '</span></div>';
  }

  function scPanel(name, label, stats, note) {
    var head = '<h4>' + esc(label) + '<span>' + (stats && stats.weeks
      ? stats.weeks + ' 期 · 最高 #' + stats.best + (note ? ' · ' + note : '')
      : '没上过这条榜') + '</span></h4>';
    // CSS 的 --i 是入场延迟；这里不参与，给个空 div 让渲染器有落点
    return '<div class="sc-panel">' + head
      + (stats && stats.weeks ? '<div class="sc-chart" data-board="' + name + '"></div>' : '<div class="sc-empty">—</div>')
      + '</div>';
  }

  function scAnnualPanel(stats) {
    if (!stats || !stats.weeks) return scPanel('annual', '年榜', null);
    var list = stats.appearances.slice().reverse().map(function (a) {
      return '<li><span class="y">第 ' + a.issue + ' 期' + (a.date ? ' · ' + fmtDate(a.date) : '') + '</span>'
        + '<span class="r">#' + a.rank + '</span></li>';
    }).join('');
    return '<div class="sc-panel"><h4>年榜<span>' + stats.weeks + ' 次 · 最高 #' + stats.best + '</span></h4>'
      + '<ul class="sc-years">' + list + '</ul></div>';
  }

  async function selectSongCard(key) {
    state.song.cur = key;
    renderSongPick();
    var card;
    if (state.song.cache.has(key)) card = state.song.cache.get(key);
    else {
      card = await api('/api/song-card?key=' + encodeURIComponent(key));
      state.song.cache.set(key, card);
    }
    renderSongDetail(card);
  }

  function renderSongDetail(card) {
    var b = card.boards;
    var h = '<div class="chart-card">'
      + '<div class="sc-head"><h3>' + esc(card.title || '—') + '</h3>'
      + (card.titleAlt ? '<div class="alt">' + esc(card.titleAlt) + '</div>' : '')
      + '<div class="tags">' + esc(names(card.producers) || '—')
      + (card.vocalists && card.vocalists.length ? ' · ' + esc(names(card.vocalists)) : '') + '</div></div>'
      + '<div class="sc-kpis">' + scKpi('周榜', b.weekly) + scKpi('传说榜', b.legend) + scKpi('年榜', b.annual) + scKpi('ニコニコ', b.nico) + '</div>'
      + '<div class="sc-grid">'
      + scPanel('weekly', '周榜', b.weekly)
      + scPanel('legend', '传说榜', b.legend)
      + scAnnualPanel(b.annual)
      + scPanel('nico', 'ニコニコ TOP20', b.nico, b.nico && b.nico.reported && b.nico.reported > b.nico.weeks ? '正文自报 ' + b.nico.reported + ' 期' : '')
      + '</div>'
      + (card.variants && card.variants.length > 1
        ? '<div class="sc-vary">这首歌用过 ' + card.variants.length + ' 个稿件：'
          + card.variants.map(function (v) {
            return '<a href="' + videoUrl(v.bvid) + '" target="_blank" rel="noopener">' + esc(v.bvid) + '</a>';
          }).join(' · ') + '</div>'
        : '')
      + '</div>';
    $('songDetail').innerHTML = h;

    // 四块小图：横轴用这首曲子自己的上榜区间，而不是整条榜的全部期次
    Array.prototype.forEach.call($('songDetail').querySelectorAll('.sc-chart'), function (el) {
      var name = el.getAttribute('data-board');
      var stats = b[name];
      if (!stats || !stats.weeks) return;
      var ctx = boardCtxFor(name);
      var idx = stats.appearances.map(function (a) { return ctx.map.get(a.issue); })
        .filter(function (i) { return i != null; });
      if (idx.length < 2) { el.innerHTML = '<div class="sc-empty">只有 1 个点，画不出走势</div>'; return; }
      var from = Math.min.apply(null, idx);
      var to = Math.max.apply(null, idx);
      renderChart(
        { title: card.title, best: stats.best, appearances: stats.appearances },
        { card: el, indexByIssue: ctx.map, issues: ctx.issues, range: { fromIdx: from, toIdx: to }, bare: true }
      );
    });
  }

  function openSongView() {
    if (state.song.loaded) return;
    state.song.loaded = true;
    // 第一次进来就选中第一条：整个页面是为"某一首曲子"组织的，
    // 右侧先空着等于让人看一块白板，还得自己猜要点哪里
    loadSongIndex('').then(function () {
      if (!state.song.cur && state.song.items.length) {
        var s = state.song.items[0];
        selectSongCard((s.kind === 'n' ? 'n:' : 'b:') + s.id);
      }
    }).catch(function () { /* 列表拉不到就先空着，搜索还能用 */ });
  }

  /* ---------- 设置抽屉：命令行那几件事的网页版 ----------
   * 每个按钮对应后端白名单里的一个动作（src/server/console.js），前端不拼命令。
   * 长任务（同步/抓帖/附榜）后台跑，这里轮询日志；短任务（报告/状态/体检）直接拿文本。
   */
  var CONSOLE_UI = [
    { group: '数据', items: [
      { name: 'update', label: '更新数据', desc: '同步官方库 + 抓帖 + 附榜（几分钟）' },
      { name: 'sync', label: '同步官方库', desc: 'Biliboard 曲目库与期次表', flags: [{ k: 'full', label: '全量' }] },
      { name: 'crawl', label: '抓取帖子', desc: 'B 站文字版（周榜）', flags: [{ k: 'deep', label: '深度' }, { k: 'force', label: '强制重抓' }] },
      { name: 'nico', label: '抓取附榜', desc: 'ニコニコ VOCALOID TOP20', flags: [{ k: 'deep', label: '深度' }, { k: 'backfill', label: '回填封面' }] }
    ] },
    { group: '诊断', items: [
      { name: 'report', label: '数据报告', desc: '期数 / 条目 / 冠军段 / 封面覆盖' },
      { name: 'status', label: '运行状态', desc: '数据文件与最近一次跑批' },
      { name: 'doctor', label: '体检', desc: '数据文件、网络、目录' },
      { name: 'schedule', label: '定时任务', desc: '按周自动更新的配置与下次运行时间' }
    ] },
    { group: '开发', items: [
      { name: 'check', label: '语法自检', desc: '全部脚本语法 + JSON 有效性' },
      { name: 'test', label: '跑测试', desc: 'node --test' },
      { name: 'package', label: '打便携包', desc: '生成 dist/ 下的便携版与 zip' }
    ] }
  ];
  // 会改数据的动作：跑完要重载页面数据，否则界面还是旧的
  var DATA_ACTIONS = { update: 1, sync: 1, crawl: 1, nico: 1 };
  var consoleTimer = null;
  var consoleActive = null;   // { name, reloaded }

  function renderConsoleActions() {
    var host = $('consoleActions');
    if (!host || host.childElementCount) return;
    host.innerHTML = CONSOLE_UI.map(function (g) {
      return '<div class="c-group"><h4>' + esc(g.group) + '</h4>' + g.items.map(function (it) {
        var flags = (it.flags || []).map(function (f) {
          return '<label><input type="checkbox" data-flag="' + f.k + '">' + esc(f.label) + '</label>';
        }).join('');
        return '<div class="c-item" data-action="' + it.name + '">'
          + '<div class="cm"><b>' + esc(it.label) + '</b><span>' + esc(it.desc) + '</span></div>'
          + (flags ? '<div class="c-flags">' + flags + '</div>' : '')
          + '<button class="btn c-run" type="button" data-run="' + it.name + '">运行</button>'
          + '</div>';
      }).join('') + '</div>';
    }).join('');
    host.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-run]');
      if (!b || b.disabled) return;
      var row = b.closest('.c-item');
      var flags = {};
      Array.prototype.forEach.call(row.querySelectorAll('input[data-flag]'), function (inp) {
        if (inp.checked) flags[inp.getAttribute('data-flag')] = true;
      });
      runConsole(b.getAttribute('data-run'), flags);
    });
  }

  function paintConsole(lines) {
    var out = $('consoleOut');
    if (!out) return;
    out.innerHTML = (lines || []).map(function (l) {
      return '<span class="cl ' + esc(l.level || 'info') + '">' + esc(l.text) + '</span>';
    }).join('');
    out.scrollTop = out.scrollHeight;
  }

  function consoleBusy(running, name) {
    Array.prototype.forEach.call(document.querySelectorAll('#consoleActions [data-run]'), function (b) {
      b.disabled = Boolean(running);
      if (running && b.getAttribute('data-run') === name) b.textContent = '运行中…';
      else if (!running) b.textContent = '运行';
    });
  }

  async function pollConsole() {
    clearTimeout(consoleTimer);
    var data;
    try {
      data = await api('/api/console');
    } catch (e) {
      $('consoleState').textContent = '连不上服务';
      return;
    }
    var job = data.job || {};
    paintConsole(job.lines || []);
    if (job.running) {
      $('consoleState').textContent = (job.label || job.name) + ' · ' + Math.round((job.elapsedMs || 0) / 1000) + 's';
      consoleBusy(true, job.name);
      consoleTimer = setTimeout(pollConsole, 900);
      return;
    }
    consoleBusy(false, null);
    if (!job.name) { $('consoleState').textContent = '输出'; return; }
    $('consoleState').textContent = (job.label || job.name) + ' · ' + (job.ok === false ? '失败' : '完成');
    // 只重载一次：轮询会一直拿到"已完成"的同一个任务
    if (DATA_ACTIONS[job.name] && consoleActive && !consoleActive.reloaded) {
      consoleActive.reloaded = true;
      await reloadData();
      toast(job.ok === false ? '任务失败，数据未变' : '数据已重载', job.ok === false ? 'err' : '');
    }
  }

  async function runConsole(name, flags) {
    $('consoleState').textContent = '启动中…';
    $('consoleOut').textContent = '';
    consoleActive = { name: name, reloaded: false };
    var qs = '?name=' + encodeURIComponent(name);
    Object.keys(flags || {}).forEach(function (k) { if (flags[k]) qs += '&' + encodeURIComponent(k) + '=1'; });
    try {
      var res = await api('/api/console/run' + qs, { method: 'POST' });
      if (res.kind === 'text') {
        paintConsole((res.lines || []).concat([{ level: res.ok ? 'ok' : 'error', text: res.text || '' }]));
        $('consoleState').textContent = name + ' · ' + (res.ok ? '完成' : '失败');
        return;
      }
      if (res.started === false) toast(res.error === 'busy' ? '已经有一个任务在跑' : '启动失败');
      pollConsole();
    } catch (err) {
      $('consoleState').textContent = '失败';
      paintConsole([{ level: 'error', text: '启动失败：' + err.message }]);
    }
  }

  function openConsole() {
    if (!$('console')) return;
    renderConsoleActions();
    closeDrawer();
    $('consoleOverlay').classList.add('on');
    $('console').classList.add('on');
    $('console').setAttribute('aria-hidden', 'false');
    $('consoleBtn').setAttribute('aria-expanded', 'true');
    window.DshMotion.lockScroll(true);
    $('consoleClose').focus();
    pollConsole();
  }

  function closeConsole() {
    if (!$('console') || !$('console').classList.contains('on')) return;
    clearTimeout(consoleTimer);
    $('console').classList.remove('on');
    $('consoleOverlay').classList.remove('on');
    $('console').setAttribute('aria-hidden', 'true');
    $('consoleBtn').setAttribute('aria-expanded', 'false');
    window.DshMotion.lockScroll(false);
    $('consoleBtn').focus();
  }

  /* ---------- 事件 ---------- */
  function activateIn(container, selector, handler) {
    container.addEventListener('click', function (e) {
      var el = e.target.closest && e.target.closest(selector);
      if (!el || !container.contains(el)) return;
      handler(el);
    });
    container.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var el = e.target.closest && e.target.closest(selector);
      if (!el || !container.contains(el)) return;
      // 原生按钮 / 链接自己会把 Enter/空格 转成 click；再手动触发一次就成了执行两遍
      // （歌曲列表是 <button>，榜单行是 <div role="button">，两者必须走不同分支）
      if (el.tagName === 'BUTTON' || el.tagName === 'A') return;
      e.preventDefault();
      handler(el);
    });
  }

  function bindUI() {
    $('refreshBtn').addEventListener('click', refresh);
    $('q').addEventListener('input', function (e) { fillSongList(e.target.value, { animate: false }); });

    activateIn($('rows'), '.row', function (el) {
      openDrawer(el.getAttribute('data-id'), { board: state.board, issue: state.issue.issue, bvid: el.getAttribute('data-bvid') }, el);
    });
    activateIn($('champs'), '.champ-item', function (el) {
      openDrawer(el.getAttribute('data-id'), { board: state.board, issue: Number(el.getAttribute('data-issue')), bvid: el.getAttribute('data-bvid') }, el);
    });
    // 单曲档案：搜索（防抖）+ 点选
    $('sq').addEventListener('input', function (e) {
      var q = e.target.value;
      clearTimeout(songTimer);
      songTimer = setTimeout(function () { loadSongIndex(q).catch(function () { /* 输入中途的失败忽略 */ }); }, 220);
    });
    activateIn($('songPick'), '.song-item', function (el) {
      selectSongCard(el.getAttribute('data-key'));
    });

    // 走势区间：两个下拉 + 一键回默认
    $('rangeFrom').addEventListener('change', function (e) { onRangeChange(state.board, 'from', e.target.value); });
    $('rangeTo').addEventListener('change', function (e) { onRangeChange(state.board, 'to', e.target.value); });
    $('rangeReset').addEventListener('click', function () { resetRange(state.board); });
    $('nicoRangeFrom').addEventListener('change', function (e) { onRangeChange('nico', 'from', e.target.value); });
    $('nicoRangeTo').addEventListener('change', function (e) { onRangeChange('nico', 'to', e.target.value); });
    $('nicoRangeReset').addEventListener('click', function () { resetRange('nico'); });

    // 标题里的榜单下拉：点开、选一条、点外面收起
    $('boardPick').addEventListener('click', function (e) {
      e.stopPropagation();
      toggleBoardMenu($('boardMenu').hidden);
    });
    activateIn($('boardMenu'), 'button[data-board]', function (el) {
      toggleBoardMenu(false);
      setBoard(el.getAttribute('data-board'));
    });
    document.addEventListener('click', function (e) {
      if ($('boardMenu').hidden) return;
      if (e.target.closest && e.target.closest('.pick')) return;
      toggleBoardMenu(false);
    });
    activateIn($('nicoRows'), '.row', function (el) {
      openDrawer(el.getAttribute('data-id'), { board: 'nico', issue: state.nico.curIssue, bvid: el.getAttribute('data-bvid') }, el);
    });
    activateIn($('nicoChamps'), '.champ-item', function (el) {
      openDrawer(el.getAttribute('data-id'), { board: 'nico', issue: Number(el.getAttribute('data-issue')), bvid: el.getAttribute('data-bvid') }, el);
    });
    activateIn($('nicoSongItems'), '.song-item', function (el) {
      selectNicoSong(el.getAttribute('data-id'));
    });
    $('nq').addEventListener('input', function (e) { fillNicoSongList(e.target.value, { animate: false }); });
    activateIn($('songItems'), '.song-item', function (el) {
      selectSong(el.getAttribute('data-id'));
    });
    activateIn($('chartSwitch'), '.cs', function (el) {
      setView(el.getAttribute('data-chart'));
    });

    $('consoleBtn').addEventListener('click', openConsole);
    $('consoleClose').addEventListener('click', closeConsole);
    $('consoleOverlay').addEventListener('click', closeConsole);
    $('consoleClear').addEventListener('click', function () {
      $('consoleOut').textContent = '';
      $('consoleState').textContent = '输出';
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        // 设置抽屉在最上层：先关它，再关单曲抽屉
        if ($('console') && $('console').classList.contains('on')) return closeConsole();
        closeDrawer();
      }

      // 在输入框里按左右键是移动光标，绝不该顺带换期（这是很容易踩的一条）
      var tag = (e.target && e.target.tagName) || '';
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
      if (state.drawer.open || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      var step = e.key === 'ArrowLeft' ? -1 : 1;
      // 左右键跟着当前视图走：在 N 榜按左右，换的必须是 N 榜的期，
      // 否则按键"有效果但看不见"——比没反应更让人困惑。
      if (state.view === 'n') return stepNico(step);
      var idx = state.issueIdx + step;
      var list = boardIndexItems(state.board);
      if (idx >= 0 && idx < list.length) viewIssue(state.board, list[idx].issue, { silent: true });
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
