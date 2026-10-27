/* 术力口周榜 · 前端（纯渲染层，数据全部来自 /api） */
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
    drawer: { open: false, id: null, issue: null, bvid: null }
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
  function num(n) { return (n < 10 ? '0' : '') + n; }
  function names(list) { return (list || []).join(' / '); }
  function cover(bvid, w) { return bvid ? '/img/' + encodeURIComponent(bvid) + (w ? '?w=' + w : '') : ''; }
  function videoUrl(bvid) { return 'https://www.bilibili.com/video/' + encodeURIComponent(bvid); }
  function playerUrl(bvid) {
    return 'https://player.bilibili.com/player.html?bvid=' + encodeURIComponent(bvid) + '&autoplay=0&high_quality=1&danmaku=1';
  }

  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
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
      fillSongList('');
      loadLegend();
    } catch (err) {
      $('pageSub').textContent = '加载失败：' + err.message;
      $('rows').innerHTML = '<div class="empty">数据加载失败，请确认服务正常运行</div>';
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

  function renderFooter() {
    var m = state.meta;
    var gaps = (m.gaps || []).map(function (g) { return '第 ' + g.issue + ' 期缺第 ' + g.miss.join('、') + ' 名'; }).join('；');
    $('footer').innerHTML = [
      '<div><b>曲目对齐</b>：以 Biliboard 公开曲目库的歌曲 ID 为准，同一首歌的不同译名、不同投稿稿件归为同一条记录；每行显示该期实际使用的稿件。已核对 ' + m.alignment.issues + ' 期 / ' + m.alignment.ranks + ' 个名次。</div>',
      '<div><b>数据来源</b>：' + esc(m.account.name) + ' 的文字版周榜（' + esc(m.account.spaceUrl) + '）+ Biliboard 公开曲目库（' + esc(m.sources.board) + '）。</div>',
      '<div><b>说明</b>：' + (gaps ? gaps + '。' : '') + '名次不完全等同于歌曲质量，请理性看待。数据版权归原作者所有，本项目为非官方个人整理。</div>',
      '<div><b>构建</b>：' + fmtDate(String(m.generatedAt).slice(0, 10)) + ' · 服务端 ' + (m.builtAt ? '已就绪' : '') + '</div>'
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
    var data = await loadIssue(n);
    state.issue = data;
    state.issueIdx = state.indexByIssue.get(data.issue);
    renderToolbar();
    renderHero(data);
    renderBoard(data);
    renderInsights(data);
    renderChampions();
    if (!opts || !opts.silent) {
      window.scrollTo({ top: $('boardSec').offsetTop - 70, behavior: 'smooth' });
    }
  }

  function renderToolbar() {
    var opts = state.issues.map(function (x, i) {
      return '<option value="' + x.issue + '"' + (x.issue === state.issue.issue ? ' selected' : '') + '>第 ' + x.issue + ' 期 · ' + fmtDate(x.date) + '</option>';
    }).reverse().join('');
    $('toolbar').innerHTML = '<button class="nav" data-step="-1" title="上一期">‹</button>'
      + '<select id="issueSel" class="sel">' + opts + '</select>'
      + '<button class="nav" data-step="1" title="下一期">›</button>'
      + '<span class="tl-meta">' + fmtDate(state.issue.date) + (state.issue.week ? ' · 第 ' + state.issue.week + ' 周' : '') + ' · 共 ' + state.issue.count + ' 首</span>'
      + '<input id="rowFilter" class="filter" placeholder="筛选本期歌曲 / P 主…" autocomplete="off">';
    $('issueSel').addEventListener('change', function (e) { selectIssue(Number(e.target.value)); });
    Array.prototype.forEach.call(document.querySelectorAll('#toolbar .nav'), function (b) {
      b.addEventListener('click', function () {
        var idx = state.issueIdx + Number(b.getAttribute('data-step'));
        if (idx >= 0 && idx < state.issues.length) selectIssue(state.issues[idx].issue);
      });
    });
    $('rowFilter').addEventListener('input', function () { renderBoard(state.issue); });
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
      + '<div class="cover-wrap" data-bvid="' + esc(champ.bvid) + '"><img class="cover-lg" src="' + esc(cover(champ.bvid, 640)) + '" alt="" onerror="this.remove()"><span class="play-l"></span></div>'
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

    var cw = $('hero').querySelector('.cover-wrap');
    if (cw) cw.addEventListener('click', function () { openDrawer(champ.songId, data.issue, champ.bvid); });
  }

  function kpi(label, value, cls) {
    return '<div class="kpi ' + (cls || '') + '"><b>' + value + '</b><span>' + label + '</span></div>';
  }

  /* ---------- 榜单 ---------- */
  function renderBoard(data) {
    var q = ($('rowFilter') && $('rowFilter').value || '').trim().toLowerCase();
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
      return '<div class="' + cls + '" data-id="' + esc(r.songId) + '" data-bvid="' + esc(r.bvid) + '">'
        + '<div class="rk mono">' + num(r.rank) + '</div>'
        + dl
        + '<div class="cv-wrap"><img class="cv" loading="lazy" src="' + esc(cover(r.bvid, 320)) + '" alt="" onerror="this.style.opacity=0"><span class="play"></span></div>'
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

    Array.prototype.forEach.call($('rows').querySelectorAll('.row'), function (el) {
      el.addEventListener('click', function () {
        openDrawer(el.getAttribute('data-id'), data.issue, el.getAttribute('data-bvid'));
      });
    });
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
    return '<svg class="spark" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">'
      + '<path d="' + segs.join(' ') + '" fill="none" stroke="rgba(24,150,218,.6)" stroke-width="1.3" stroke-linejoin="round"/>'
      + '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="2" fill="#1896DA"/></svg>';
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
  }

  /* ---------- 冠军榜 ---------- */
  function renderChampions() {
    var data = state.champions;
    $('champs').innerHTML = data.runs.map(function (r) {
      var label = r.issueFrom === r.issueTo ? '第 ' + r.issueFrom + ' 期' : '第 ' + r.issueFrom + '–' + r.issueTo + ' 期';
      return '<div class="champ-item" data-id="' + esc(r.id) + '" data-bvid="' + esc(r.bvid) + '" data-issue="' + r.issueTo + '">'
        + '<img loading="lazy" src="' + esc(cover(r.bvid, 320)) + '" alt="" onerror="this.style.opacity=0">'
        + '<div style="min-width:0"><div class="t">' + esc(r.title) + '</div><div class="m">' + label + ' · ' + fmtDate(r.date) + '</div></div>'
        + '<div class="c">' + (r.count > 1 ? r.count + ' 连冠' : '1 周') + '</div></div>';
    }).join('');
    $('champMeta').textContent = '共 ' + data.total + ' 段冠军 · 显示最近 ' + data.runs.length + ' 段';
    Array.prototype.forEach.call($('champs').querySelectorAll('.champ-item'), function (el) {
      el.addEventListener('click', function () {
        openDrawer(el.getAttribute('data-id'), Number(el.getAttribute('data-issue')), el.getAttribute('data-bvid'));
      });
    });
  }

  /* ---------- 歌曲列表 / 走势 ---------- */
  function fillSongList(q) {
    var needle = (q || '').trim().toLowerCase();
    var list = state.songs.filter(function (s) {
      return !needle || (s.title + ' ' + s.titleAlt).toLowerCase().indexOf(needle) >= 0;
    }).slice(0, 120);
    $('songItems').innerHTML = list.map(function (s) {
      return '<div class="song-item' + (String(s.id) === String(state.curSong) ? ' on' : '') + '" data-id="' + esc(s.id) + '">'
        + '<span class="t">' + esc(s.title) + '</span><span class="w">' + s.weeks + ' 期</span></div>';
    }).join('') || '<div style="padding:10px;color:var(--faint);font-size:12.5px">没有匹配的歌曲</div>';
    Array.prototype.forEach.call(document.querySelectorAll('.song-item'), function (el) {
      el.addEventListener('click', function () { selectSong(el.getAttribute('data-id')); });
    });
  }

  async function fetchSong(id) {
    if (state.songCache.has(String(id))) return state.songCache.get(String(id));
    var data = await api('/api/songs/' + encodeURIComponent(id));
    state.songCache.set(String(id), data);
    return data;
  }

  async function selectSong(id) {
    state.curSong = id;
    fillSongList($('q').value);
    var song = await fetchSong(id);
    renderChart(song);
    window.scrollTo({ top: $('trendSec').offsetTop - 64, behavior: 'smooth' });
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
      dots += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.2" fill="#1896DA" stroke="#0e0f13" stroke-width="1.6"></circle>';
    });

    var grid = '';
    [1, 5, 10, 15, 20].forEach(function (r) {
      var y = Y(r);
      grid += '<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y.toFixed(1) + '" stroke="rgba(255,255,255,.06)"/>'
        + '<text x="' + (PL - 10) + '" y="' + (y + 3.5).toFixed(1) + '" fill="#676e7d" font-size="10" text-anchor="end">#' + r + '</text>';
    });

    var ticks = '';
    var step = Math.max(1, Math.ceil(span / 7));
    for (var i = first; i <= last; i += step) {
      var issueNo = state.issues[i] ? state.issues[i].issue : '';
      ticks += '<text x="' + X(i).toFixed(1) + '" y="' + (H - PB + 20) + '" fill="#676e7d" font-size="10" text-anchor="middle">' + issueNo + '期</text>';
    }

    var head = '<div class="chart-head"><h4>' + esc(song.title) + '</h4>'
      + '<span class="st">在榜 ' + app.length + ' 期 · 最高 #' + song.best + ' · 首次 ' + app[0].issue + ' 期</span>'
      + (app[app.length - 1].bvid ? '<a class="lnk" href="' + videoUrl(app[app.length - 1].bvid) + '" target="_blank" rel="noopener">在 B 站打开 ↗</a>' : '')
      + '</div>';

    card.innerHTML = head + '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;margin-top:8px">' + grid
      + '<path d="' + segs.join(' ') + '" fill="none" stroke="#1896DA" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>'
      + dots + ticks + '</svg>';
  }

  /* ---------- 抽屉 ---------- */
  function ensureDrawer() {
    if ($('drawer')) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = '<div class="overlay" id="overlay"></div>'
      + '<aside class="drawer" id="drawer" aria-hidden="true">'
      + '<button class="close" id="drawerClose" aria-label="关闭">×</button>'
      + '<div class="player" id="player"></div>'
      + '<div class="d-body" id="drawerBody"></div></aside>';
    document.body.appendChild(wrap);
    $('overlay').addEventListener('click', closeDrawer);
    $('drawerClose').addEventListener('click', closeDrawer);
  }

  async function openDrawer(songId, issue, bvid) {
    if (!songId) return;
    ensureDrawer();
    var song = await fetchSong(songId);
    state.drawer = { open: true, song: song, issue: Number(issue), bvid: bvid || '' };
    $('drawer').classList.add('on');
    $('overlay').classList.add('on');
    $('drawer').setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    paintDrawer();
  }

  function closeDrawer() {
    if (!$('drawer')) return;
    state.drawer.open = false;
    $('drawer').classList.remove('on');
    $('overlay').classList.remove('on');
    $('drawer').setAttribute('aria-hidden', 'true');
    $('player').innerHTML = '';
    document.body.style.overflow = '';
  }

  function paintDrawer() {
    var d = state.drawer, song = d.song;
    var at = song.appearances.filter(function (a) { return a.issue === d.issue; })[0] || song.appearances[song.appearances.length - 1];
    var bvid = d.bvid || at.bvid;

    $('player').innerHTML = bvid
      ? '<iframe src="' + playerUrl(bvid) + '" scrolling="no" frameborder="0" allowfullscreen allow="autoplay; encrypted-media"></iframe>'
      : '<div class="no-player">没有可播放的稿件</div>';

    var variants = song.variants.map(function (v) {
      return '<button class="bv' + (v.bvid === bvid ? ' on' : '') + '" data-bv="' + esc(v.bvid) + '">'
        + '<span class="mono">' + esc(v.bvid) + '</span><em>' + v.issues.map(function (n) { return '第' + n + '期'; }).join('、') + '</em></button>';
    }).join('');

    var history = song.appearances.slice().reverse().slice(0, 12).map(function (a) {
      return '<li><span>第 ' + a.issue + ' 期</span><b>#' + a.rank + '</b><em>' + fmtDate(a.date) + '</em></li>';
    }).join('');

    $('drawerBody').innerHTML = '<div class="d-head"><h3>' + esc(song.title) + '</h3>'
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

    Array.prototype.forEach.call($('drawerBody').querySelectorAll('.bv'), function (b) {
      b.addEventListener('click', function () { state.drawer.bvid = b.getAttribute('data-bv'); paintDrawer(); });
    });
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
    } catch { /* 附榜没有就算了 */ }
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
        fillSongList($('q').value);
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
  function bindUI() {
    $('refreshBtn').addEventListener('click', refresh);
    $('q').addEventListener('input', function (e) { fillSongList(e.target.value); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
      if (!state.drawer.open && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        var idx = state.issueIdx + (e.key === 'ArrowLeft' ? -1 : 1);
        if (idx >= 0 && idx < state.issues.length) selectIssue(state.issues[idx].issue, { silent: true });
      }
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
