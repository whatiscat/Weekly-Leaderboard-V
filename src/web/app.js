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
    drawer: { open: false, id: null, issue: null, bvid: null, returnFocus: null }
  };

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
      state.issues.forEach(function (it, i) { state.indexByIssue.set(it.issue, i); });

      paintHeader();
      bindUI();
      await selectIssue(state.issues[state.issues.length - 1].issue, { silent: true });
      // 首次填充 120 首不做入场：一屏之外的一百多个元素同时起跑，
      // 除了让弱机器掉帧之外没有观感收益（滚动到列表里时才看得见前几条）
      fillSongList('', { animate: false });
      loadLegend();
    } catch (err) {
      $('pageSub').textContent = '加载失败：' + err.message;
      $('rows').innerHTML = '<div class="empty">数据加载失败，请确认服务正在运行（node src/cli.js serve）</div>';
    }
  }

  function paintHeader() {
    var m = state.meta;
    var s = m.stats;
    $('pageTitle').textContent = '术力口周榜 · 数据看板';
    $('pageSub').textContent = '第 ' + m.charts.first + '–' + m.charts.last + ' 期（' + fmtDate(s.firstDate).slice(0, 7) + ' – '
      + fmtDate(s.lastDate).slice(0, 7) + '）· 共 ' + s.entries + ' 条 · 曲目按 Biliboard ID 对齐 · 来源 ' + m.account.name;
    $('linkSpace').href = m.sources.space;
    $('linkRead').href = m.sources.readList;
    renderFooter();
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

  function renderFooter() {
    var m = state.meta;
    var gaps = (m.gaps || []).map(function (g) { return '第 ' + g.issue + ' 期缺第 ' + g.miss.join('、') + ' 名'; }).join('；');
    $('footer').innerHTML = [
      alignmentLine(m),
      '<div><b>数据来源</b>：' + esc(m.account.name) + ' 的文字版周榜（' + esc(m.account.spaceUrl) + '）+ Biliboard 公开曲目库（' + esc(m.sources.board) + '）。</div>',
      qualityLine(m),
      '<div><b>说明</b>：' + (gaps ? gaps + '。' : '') + '名次不完全等同于歌曲质量，请理性看待。数据版权归原作者所有，本项目为非官方个人整理。</div>',
      '<div><b>数据</b>：文件更新于 ' + fmtTime(m.generatedAt) + ' · 服务端载入于 ' + fmtTime(m.builtAt) + '</div>'
    ].join('');
  }

  /* ---------- 期次 ---------- */
  async function loadIssue(n) {
    if (state.issueCache.has(n)) return state.issueCache.get(n);
    var data = await api('/api/issues/' + n);
    state.issueCache.set(n, data);
    return data;
  }

  async function selectIssue(n, opts) {
    var o = opts || {};
    var data = await loadIssue(n);
    state.issue = data;
    state.issueIdx = state.indexByIssue.get(data.issue);
    renderToolbar();
    renderHero(data);
    // 换期是"数据整体换了"：这次可以播入场。筛选重绘走 animate:false（见 renderBoard）
    renderBoard(data, { animate: true });
    renderInsights(data);
    renderChampions();
    if (!o.silent) scrollToSection($('boardSec'));
  }

  function renderToolbar() {
    var opts = state.issues.map(function (x) {
      return '<option value="' + x.issue + '"' + (x.issue === state.issue.issue ? ' selected' : '') + '>第 ' + x.issue + ' 期 · ' + fmtDate(x.date) + '</option>';
    }).reverse().join('');
    $('toolbar').innerHTML = '<button class="nav" type="button" data-step="-1" aria-label="上一期" title="上一期">‹</button>'
      + '<select id="issueSel" class="sel" aria-label="选择期次">' + opts + '</select>'
      + '<button class="nav" type="button" data-step="1" aria-label="下一期" title="下一期">›</button>'
      + '<span class="tl-meta">' + fmtDate(state.issue.date) + (state.issue.week ? ' · 第 ' + state.issue.week + ' 周' : '') + ' · 共 ' + state.issue.count + ' 首</span>'
      + '<input id="rowFilter" class="filter" placeholder="筛选本期歌曲 / P 主…" autocomplete="off" aria-label="筛选本期歌曲" value="' + esc(state.filter) + '">';
    $('issueSel').addEventListener('change', function (e) { selectIssue(Number(e.target.value)); });
    Array.prototype.forEach.call(document.querySelectorAll('#toolbar .nav'), function (b) {
      b.addEventListener('click', function () {
        var idx = state.issueIdx + Number(b.getAttribute('data-step'));
        if (idx >= 0 && idx < state.issues.length) selectIssue(state.issues[idx].issue);
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
      + '<span class="pill">共 ' + data.count + ' 首在榜</span>'
      + (data.postUrl ? '<a class="pill link" href="' + esc(data.postUrl) + '" target="_blank" rel="noopener">文字版原帖 ↗</a>' : '')
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
    cw.addEventListener('click', function () { openDrawer(champ.songId, data.issue, champ.bvid, cw); });
    cw.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(champ.songId, data.issue, champ.bvid, cw); }
    });
  }

  function kpi(label, value, cls) {
    return '<div class="kpi ' + (cls || '') + '"><b>' + value + '</b><span>' + label + '</span></div>';
  }

  /* ---------- 榜单 ---------- */
  function renderBoard(data, opts) {
    var animate = !opts || opts.animate !== false;
    var q = state.filter.trim().toLowerCase();
    var rows = data.rows.filter(function (r) {
      if (!q) return true;
      return (r.title + ' ' + r.titleAlt + ' ' + names(r.producers) + ' ' + names(r.vocalists)).toLowerCase().indexOf(q) >= 0;
    });

    var html = rows.map(function (r) {
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
        + '<div class="sp">' + spark(r.spark, state.issueIdx) + '</div>'
        + '<div class="meta">' + (r.prev ? '# ' + r.prev : '—') + '</div>'
        + '<div class="meta"><b>' + r.weeks + '</b> 周</div>'
        + '</div>';
    }).join('');

    $('rows').innerHTML = html || '<div class="empty">没有匹配的曲目</div>';
    $('boardMeta').textContent = '第 ' + data.issue + ' 期 · ' + data.date + ' · ' + rows.length + ' 首';
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

  async function fetchSong(id) {
    if (state.songCache.has(String(id))) return state.songCache.get(String(id));
    var data = await api('/api/songs/' + encodeURIComponent(id));
    state.songCache.set(String(id), data);
    return data;
  }

  async function selectSong(id) {
    state.curSong = id;
    fillSongList($('q').value, { animate: false });
    var song = await fetchSong(id);
    renderChart(song);
    scrollToSection($('trendSec'));
  }

  function renderChart(song) {
    var app = song.appearances || [];
    var card = $('chartCard');
    if (!app.length) { card.innerHTML = '<div style="color:var(--faint)">暂无走势数据</div>'; return; }
    if (app.length === 1) {
      var one = app[0];
      card.innerHTML = '<div class="chart-head"><h4>' + esc(song.title) + '</h4>'
        + '<span class="st">仅上榜 1 期 · 第 ' + one.issue + ' 期 #' + one.rank + '</span>'
        + (one.bvid ? '<a class="lnk" href="' + videoUrl(one.bvid) + '" target="_blank" rel="noopener">在 B 站打开 ↗</a>' : '')
        + '</div><div class="single-rank"><div class="big">#' + one.rank + '</div><div>该曲目前只在第 ' + one.issue + ' 期（' + fmtDate(one.date) + '）上榜一次</div></div>';
      return;
    }

    var idx = app.map(function (a) { return state.indexByIssue.get(a.issue); });
    var first = idx[0], last = idx[idx.length - 1], span = Math.max(1, last - first);
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
      var issueNo = state.issues[i] ? state.issues[i].issue : '';
      ticks += '<text class="chart-txt" x="' + X(i).toFixed(1) + '" y="' + (H - PB + 20) + '" text-anchor="middle">' + issueNo + '期</text>';
    }

    var head = '<div class="chart-head"><h4>' + esc(song.title) + '</h4>'
      + '<span class="st">在榜 ' + app.length + ' 期 · 最高 #' + song.best + ' · 首次 ' + app[0].issue + ' 期</span>'
      + (app[app.length - 1].bvid ? '<a class="lnk" href="' + videoUrl(app[app.length - 1].bvid) + '" target="_blank" rel="noopener">在 B 站打开 ↗</a>' : '')
      + '</div>';

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

  async function openDrawer(songId, issue, bvid, opener) {
    if (!songId) return;
    ensureDrawer();
    // 记住点开抽屉的那一行：关闭时把焦点还回去，键盘用户不会掉到页面顶部。
    // 优先用传进来的激活元素：程序化点击（或某些浏览器）里 document.activeElement
    // 可能还停在 body 上，那样"关闭后焦点回到原处"就静默失效了。
    state.drawer.returnFocus = opener || document.activeElement;
    var song = await fetchSong(songId);
    state.drawer = { open: true, id: songId, song: song, issue: Number(issue), bvid: bvid || '', returnFocus: state.drawer.returnFocus };
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

  function paintDrawer() {
    var d = state.drawer, song = d.song;
    var at = song.appearances.filter(function (a) { return a.issue === d.issue; })[0] || song.appearances[song.appearances.length - 1];
    var bvid = d.bvid || at.bvid;

    $('player').innerHTML = bvid
      ? '<iframe src="' + playerUrl(bvid) + '" scrolling="no" frameborder="0" allowfullscreen allow="autoplay; encrypted-media" title="视频播放器"></iframe>'
      : '<div class="no-player">没有可播放的稿件</div>';

    var variants = song.variants.map(function (v) {
      return '<button class="bv' + (v.bvid === bvid ? ' on' : '') + '" type="button" data-bv="' + esc(v.bvid) + '">'
        + '<span class="mono">' + esc(v.bvid) + '</span><em>' + v.issues.map(function (n) { return '第' + n + '期'; }).join('、') + '</em></button>';
    }).join('');

    var history = song.appearances.slice().reverse().slice(0, 12).map(function (a) {
      return '<li><span>第 ' + a.issue + ' 期</span><b>#' + a.rank + '</b><em>' + fmtDate(a.date) + '</em></li>';
    }).join('');

    $('drawerBody').innerHTML = '<div class="d-head"><h3 id="drawerTitle">' + esc(song.title) + '</h3>'
      + (song.titleAlt ? '<div class="alt">' + esc(song.titleAlt) + '</div>' : '')
      + '<div class="tags">' + esc(names(song.producers) || '—') + (song.vocalists.length ? ' · ' + esc(names(song.vocalists)) : '') + '</div></div>'
      + '<div class="d-stats">'
      + '<div><b>#' + at.rank + '</b><span>本期名次</span></div>'
      + '<div><b>#' + song.best + '</b><span>最高名次</span></div>'
      + '<div><b>' + song.weeks + '</b><span>在榜期数</span></div>'
      + '<div><b>' + song.variants.length + '</b><span>使用稿件</span></div>'
      + '</div>'
      + '<div class="d-sec"><h4>稿件（同一首歌可能更换视频）</h4><div class="bv-list">' + variants + '</div></div>'
      + '<div class="d-sec"><h4>上榜记录</h4><ol class="history">' + history + '</ol></div>'
      + '<div class="d-actions">'
      + (bvid ? '<a class="btn primary" href="' + videoUrl(bvid) + '" target="_blank" rel="noopener">在 B 站打开</a>' : '')
      + (state.issue && state.issue.postUrl ? '<a class="btn" href="' + esc(state.issue.postUrl) + '" target="_blank" rel="noopener">本期文字版</a>' : '')
      + '</div>';
  }

  /* ---------- 传说曲附榜 ---------- */
  async function loadLegend() {
    try {
      var data = await api('/api/legend?limit=8');
      if (!data.items.length) return;
      $('legendSec').hidden = false;
      $('legendBody').innerHTML = data.items.map(function (it) {
        return '<tr><td>第 ' + it.issue + ' 期</td><td>' + fmtDate(it.date) + '</td><td>' + esc(it.champion) + '</td>'
          + '<td>' + (it.videoBvid ? '<a href="' + videoUrl(it.videoBvid) + '" target="_blank" rel="noopener">榜单视频 ↗</a>' : '') + '</td></tr>';
      }).join('');
    } catch (e) { /* 附榜没有就算了，不该影响主榜 */ }
  }

  /* ---------- 刷新 ---------- */
  async function refresh() {
    var btn = $('refreshBtn');
    var label = btn.querySelector('.lbl');
    if (btn.classList.contains('loading')) return;
    btn.classList.add('loading');
    label.textContent = '刷新中';
    try {
      await api('/api/reload', { method: 'POST' });
      var meta = await api('/api/meta');
      var issues = await api('/api/issues');
      var changed = Number(meta.dataVersion) !== Number(state.meta.dataVersion) || issues.items.length !== state.issues.length;
      state.meta = meta;
      state.issues = issues.items;
      state.indexByIssue = new Map();
      state.issues.forEach(function (it, i) { state.indexByIssue.set(it.issue, i); });
      state.issueCache.clear();
      state.songCache.clear();
      paintHeader();
      if (changed) {
        var last = state.issues[state.issues.length - 1].issue;
        await selectIssue(last, { silent: true });
        state.champions = await api('/api/champions?limit=24');
        state.songs = (await api('/api/songs?limit=1000')).items;
        renderChampions();
        fillSongList($('q').value, { animate: false });
        toast('已更新到第 ' + last + ' 期');
      } else {
        toast('已是最新：第 ' + state.issue.issue + ' 期');
      }
    } catch (err) {
      toast('刷新失败：' + err.message, 'err');
    } finally {
      btn.classList.remove('loading');
      label.textContent = '刷新';
    }
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
      openDrawer(el.getAttribute('data-id'), state.issue.issue, el.getAttribute('data-bvid'), el);
    });
    activateIn($('champs'), '.champ-item', function (el) {
      openDrawer(el.getAttribute('data-id'), Number(el.getAttribute('data-issue')), el.getAttribute('data-bvid'), el);
    });
    activateIn($('songItems'), '.song-item', function (el) {
      selectSong(el.getAttribute('data-id'));
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();

      // 在输入框里按左右键是移动光标，绝不该顺带换期（这是很容易踩的一条）
      var tag = (e.target && e.target.tagName) || '';
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
      if (!state.drawer.open && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        var idx = state.issueIdx + (e.key === 'ArrowLeft' ? -1 : 1);
        if (idx >= 0 && idx < state.issues.length) selectIssue(state.issues[idx].issue, { silent: true });
      }
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
