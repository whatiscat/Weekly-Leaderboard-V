
(function () {
  var DATA = window.__DATA__ || {};
  var ISSUES = DATA.issues || [];
  var N = ISSUES.length;
  var el = function (id) { return document.getElementById(id); };
  if (!N) { document.body.innerHTML = '<p style="padding:40px">暂无数据</p>'; return; }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtDate(d) { var p = String(d || '').split('-'); return p.length === 3 ? p[0] + '.' + p[1] + '.' + p[2] : String(d || ''); }
  function num(n) { return (n < 10 ? '0' : '') + n; }
  function idOf(e) { return e.songId || e.bvid || e.title; }
  var COVERS = DATA.covers || {};
  var PROXY = 'https://biliboard.uk/api/provider/biliimg/bvid/';
  function coverOf(bvid, spec) {
    if (!bvid) return '';
    var base = COVERS[bvid];
    if (!base) return PROXY + encodeURIComponent(bvid);
    if (spec && base.indexOf('@') < 0 && base.indexOf('hdslb.com') >= 0) return base + '@' + spec;
    return base;
  }
  function playerUrl(bvid) { return 'https://player.bilibili.com/player.html?bvid=' + encodeURIComponent(bvid) + '&autoplay=0&high_quality=1&danmaku=1'; }
  function videoUrl(bvid) { return 'https://www.bilibili.com/video/' + encodeURIComponent(bvid); }
  function names(list) { return (list || []).join(' / '); }

  /* ---------- 索引 ---------- */
  var hist = {};
  ISSUES.forEach(function (is, i) {
    is.entries.forEach(function (e) {
      var id = idOf(e);
      (hist[id] = hist[id] || []).push({ i: i, rank: e.rank, e: e });
    });
  });
  Object.keys(hist).forEach(function (k) { hist[k].sort(function (a, b) { return a.i - b.i; }); });

  var deco = ISSUES.map(function (is, idx) {
    var prev = {};
    if (idx > 0) ISSUES[idx - 1].entries.forEach(function (e) { prev[idOf(e)] = e.rank; });
    return is.entries.map(function (e) {
      var id = idOf(e);
      var h = (hist[id] || []).filter(function (x) { return x.i < idx; });
      var p = (id in prev) ? prev[id] : null;
      var isNew = h.length === 0 && p === null;
      var state = isNew ? 'new' : (p === null ? 're' : (p - e.rank > 0 ? 'up' : (p - e.rank < 0 ? 'down' : 'same')));
      var best = e.rank, sum = e.rank;
      h.forEach(function (x) { if (x.rank < best) best = x.rank; sum += x.rank; });
      var variants = {};
      (hist[id] || []).forEach(function (x) { if (x.e.bvid) variants[x.e.bvid] = 1; });
      return {
        id: id, rank: e.rank, bvid: e.bvid, title: e.titleCn || e.title, alt: e.title && e.title !== (e.titleCn || e.title) ? e.title : '',
        producers: e.producers || [], vocalists: e.vocalists || [], score: e.score,
        prev: p, delta: p === null ? null : p - e.rank, state: state,
        weeks: h.length + 1, best: best, avg: sum / (h.length + 1),
        variants: Object.keys(variants).length, raw: e
      };
    }).sort(function (a, b) { return a.rank - b.rank; });
  });

  var cur = N - 1;
  var curSong = null;
  var drawer = { open: false, id: null, issue: null, bvid: null };

  /* ---------- 悬浮预览 ---------- */
  var hover = document.createElement('div');
  hover.className = 'hovercard';
  hover.innerHTML = '<img alt=""><div class="hc-t"></div><div class="hc-m"></div>';
  document.body.appendChild(hover);
  function showHover(e, x, y) {
    var img = hover.querySelector('img');
    if (!e.bvid) return;
    img.src = coverOf(e.bvid, '480w_270h_1c.webp');
    hover.querySelector('.hc-t').textContent = e.title;
    hover.querySelector('.hc-m').textContent = '#' + e.rank + ' · ' + (names(e.producers) || '未知 P 主') + (e.vocalists.length ? ' · ' + names(e.vocalists) : '');
    hover.classList.add('on');
    var w = 300, h = 240;
    var left = Math.min(window.innerWidth - w - 12, x + 16);
    var top = Math.max(12, Math.min(window.innerHeight - h - 12, y - 90));
    hover.style.transform = 'translate(' + left + 'px,' + top + 'px)';
  }
  function hideHover() { hover.classList.remove('on'); }

  /* ---------- 顶部 ---------- */
  function kpi(label, value, cls) {
    return '<div class="kpi ' + (cls || '') + '"><b>' + value + '</b><span>' + label + '</span></div>';
  }
  function renderHero() {
    var is = ISSUES[cur], d = deco[cur], champ = d[0] || {};
    var champWeeks = 1;
    for (var i = cur - 1; i >= 0; i--) { var t = deco[i].filter(function (x) { return x.rank === 1; })[0]; if (t && t.id === champ.id) champWeeks++; else break; }
    var news = d.filter(function (x) { return x.state === 'new'; }).length;
    var ups = d.filter(function (x) { return x.state === 'up'; }).length;
    var downs = d.filter(function (x) { return x.state === 'down'; }).length;
    var prevTop = cur > 0 ? deco[cur - 1].filter(function (x) { return x.rank === 1; })[0] : null;
    var prevNow = prevTop ? d.filter(function (x) { return x.id === prevTop.id; })[0] : null;
    var longest = d.slice().sort(function (a, b) { return b.weeks - a.weeks; })[0];

    var h = '<div class="hero-top">'
      + '<span class="pill hot">第 ' + is.issue + ' 期</span>'
      + '<span class="pill">' + fmtDate(is.date) + '</span>'
      + (is.week ? '<span class="pill">第 ' + is.week + ' 周</span>' : '')
      + '<span class="pill">共 ' + is.entries.length + ' 首在榜</span>'
      + (is.postUrl ? '<a class="pill link" href="' + esc(is.postUrl) + '" target="_blank" rel="noopener">文字版原帖 ↗</a>' : '')
      + '</div>';
    h += '<div class="hero-main">';
    h += '<div class="cover-wrap" data-bvid="' + esc(champ.bvid) + '"><img class="cover-lg" src="' + esc(coverOf(champ.bvid, '640w_360h_1c.webp')) + '" alt="" onerror="this.remove()"><span class="play-l"></span></div>';
    h += '<div class="champ">'
      + '<div class="lbl">本 期 冠 军</div>'
      + '<h2><a href="' + esc(videoUrl(champ.bvid)) + '" target="_blank" rel="noopener">' + esc(champ.title) + '</a></h2>'
      + (champ.alt ? '<div class="alt">' + esc(champ.alt) + '</div>' : '')
      + '<div class="tags">' + esc(names(champ.producers) || '—') + (champ.vocalists.length ? ' · ' + esc(names(champ.vocalists)) : '') + '</div>'
      + '<div class="meta"><span>在榜 ' + champ.weeks + ' 期</span><span>最高 #' + champ.best + '</span>'
      + '<span>' + (champ.prev ? '上周 #' + champ.prev : '上周未上榜') + '</span>'
      + (champWeeks > 1 ? '<span style="color:var(--gold)">已连冠 ' + champWeeks + ' 期</span>' : '')
      + '</div>'
      + '</div>';
    h += '<div class="hero-side">'
      + (prevTop ? '<div class="side-item"><span>上周冠军</span><b>' + esc(prevTop.title) + '</b><em>' + (prevNow ? '本期 #' + prevNow.rank : '本期未上榜') + '</em></div>' : '')
      + (longest ? '<div class="side-item"><span>在榜最久</span><b>' + esc(longest.title) + '</b><em>累计 ' + longest.weeks + ' 期</em></div>' : '')
      + '</div>';
    h += '</div>';
    h += '<div class="kpis">' + kpi('新上榜', news, 'new') + kpi('排名上升', ups, 'up') + kpi('排名下降', downs, 'down') + kpi('冠军连庄', champWeeks) + kpi('在榜曲目', is.entries.length) + '</div>';
    el('hero').innerHTML = h;
    var cw = el('hero').querySelector('.cover-wrap');
    if (cw) cw.addEventListener('click', function () { openDrawer(champ.id, cur, champ.bvid); });
  }

  /* ---------- 期次工具条 ---------- */
  function renderToolbar() {
    var is = ISSUES[cur];
    var opts = ISSUES.map(function (x, i) {
      return '<option value="' + i + '"' + (i === cur ? ' selected' : '') + '>第 ' + x.issue + ' 期 · ' + fmtDate(x.date) + '</option>';
    }).reverse().join('');
    el('toolbar').innerHTML = '<button class="nav" data-step="-1" title="上一期">‹</button>'
      + '<select id="issueSel" class="sel">' + opts + '</select>'
      + '<button class="nav" data-step="1" title="下一期">›</button>'
      + '<span class="tl-meta">' + fmtDate(is.date) + (is.week ? ' · 第 ' + is.week + ' 周' : '') + ' · 共 ' + is.entries.length + ' 首</span>'
      + '<input id="rowFilter" class="filter" placeholder="筛选本期歌曲 / P 主…">';
    el('issueSel').addEventListener('change', function (e) { setIssue(Number(e.target.value)); });
    Array.prototype.forEach.call(el('toolbar').querySelectorAll('.nav'), function (b) {
      b.addEventListener('click', function () { setIssue(cur + Number(b.getAttribute('data-step'))); });
    });
    el('rowFilter').addEventListener('input', renderBoard);
  }
  function setIssue(i) {
    cur = Math.max(0, Math.min(N - 1, i));
    renderToolbar(); renderHero(); renderBoard(); renderInsights(); renderChampions();
    window.scrollTo({ top: el('boardSec').offsetTop - 70, behavior: 'smooth' });
  }

  /* ---------- 榜单 ---------- */
  function renderBoard() {
    var is = ISSUES[cur], d = deco[cur];
    var q = (el('rowFilter') && el('rowFilter').value || '').trim().toLowerCase();
    var rows = d.filter(function (e) {
      if (!q) return true;
      return (e.title + ' ' + e.alt + ' ' + names(e.producers) + ' ' + names(e.vocalists)).toLowerCase().indexOf(q) >= 0;
    });
    var h = rows.map(function (e) {
      var cls = 'row' + (e.rank === 1 ? ' top1' : '') + (e.rank === 2 ? ' top2' : '') + (e.rank === 3 ? ' top3' : '');
      var dl;
      if (e.state === 'new') dl = '<div class="delta new">NEW</div>';
      else if (e.state === 're') dl = '<div class="delta re">RE</div>';
      else if (e.state === 'up') dl = '<div class="delta up">▲' + e.delta + '</div>';
      else if (e.state === 'down') dl = '<div class="delta down">▼' + (-e.delta) + '</div>';
      else dl = '<div class="delta same">—</div>';
      return '<div class="' + cls + '" data-id="' + esc(e.id) + '" data-bvid="' + esc(e.bvid) + '" data-rank="' + e.rank + '">'
        + '<div class="rk mono">' + num(e.rank) + '</div>'
        + dl
        + '<div class="cv-wrap"><img class="cv" loading="lazy" src="' + esc(coverOf(e.bvid, '320w_180h_1c.webp')) + '" alt="" onerror="this.style.opacity=0"><span class="play"></span></div>'
        + '<div class="tcell"><div class="ttl">' + esc(e.title) + (e.alt ? '<span class="alt">' + esc(e.alt) + '</span>' : '') + '</div>'
        + '<div class="sub">' + esc(names(e.producers) || '—') + (e.vocalists.length ? ' <i>·</i> ' + esc(names(e.vocalists)) : '') + (e.variants > 1 ? ' <b class="vb" title="该曲在榜期间使用过 ' + e.variants + ' 个不同稿件">多稿件</b>' : '') + '</div></div>'
        + '<div class="sp">' + spark(e.id, cur) + '</div>'
        + '<div class="meta">' + (e.prev ? '# ' + e.prev : '—') + '</div>'
        + '<div class="meta"><b>' + e.weeks + '</b> 周</div>'
        + '</div>';
    }).join('');
    el('rows').innerHTML = h || '<div class="empty">没有匹配的曲目</div>';
    el('boardMeta').textContent = '第 ' + is.issue + ' 期 · ' + is.date + ' · ' + rows.length + ' 首';
    Array.prototype.forEach.call(el('rows').querySelectorAll('.row'), function (r) {
      var id = r.getAttribute('data-id'), bvid = r.getAttribute('data-bvid');
      r.addEventListener('click', function () { openDrawer(id, cur, bvid); });
    });
  }

  function spark(id, upto) {
    var all = hist[id] || [];
    var h = all.filter(function (x) { return x.i <= upto; });
    if (h.length < 2 || h[h.length - 1].i < upto - 29) return '<span class="spark"></span>';
    h = h.filter(function (x) { return x.i >= upto - 29; });
    var W = 180, H = 24, start = Math.max(0, upto - 29), span = Math.max(1, upto - start);
    function X(i) { return (i - start) / span * W; }
    function Y(r) { return 3 + (r - 1) / 19 * (H - 6); }
    var segs = [], last = null, prevI = null;
    h.forEach(function (p) {
      var x = X(p.i).toFixed(1), y = Y(p.rank).toFixed(1);
      segs.push((prevI !== null && p.i === prevI + 1 ? 'L ' : 'M ') + x + ' ' + y);
      prevI = p.i; last = [x, y];
    });
    return '<svg class="spark" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">'
      + '<path d="' + segs.join(' ') + '" fill="none" stroke="rgba(24,150,218,.55)" stroke-width="1.3" stroke-linejoin="round"/>'
      + '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="2" fill="#1896DA"/></svg>';
  }

  /* ---------- 看点 ---------- */
  function renderInsights() {
    var d = deco[cur], prev = cur > 0 ? deco[cur - 1] : [];
    var news = d.filter(function (x) { return x.state === 'new'; });
    var ups = d.filter(function (x) { return x.state === 'up'; }).sort(function (a, b) { return b.delta - a.delta; }).slice(0, 6);
    var curIds = {}; d.forEach(function (x) { curIds[x.id] = 1; });
    var outs = prev.filter(function (x) { return !curIds[x.id]; }).slice(0, 6);
    function li(t, right, cls) { return '<li><span class="t">' + esc(t) + '</span><span class="d ' + (cls || '') + '">' + right + '</span></li>'; }
    el('p-new').innerHTML = '<h4><span>新上榜</span><span>' + news.length + '</span></h4>'
      + (news.length ? '<ul>' + news.slice(0, 6).map(function (x) { return li('#' + x.rank + ' ' + x.title, 'NEW', 'delta-new'); }).join('') + '</ul>' : '<p>本期无新上榜曲目</p>');
    el('p-up').innerHTML = '<h4><span>上升最快</span><span>' + d.filter(function (x) { return x.state === 'up'; }).length + '</span></h4>'
      + (ups.length ? '<ul>' + ups.map(function (x) { return li(x.title, '▲' + x.delta, 'delta-up'); }).join('') + '</ul>' : '<p>本期无明显上升</p>');
    el('p-down').innerHTML = '<h4><span>跌出榜单</span><span>' + outs.length + '</span></h4>'
      + (outs.length ? '<ul>' + outs.map(function (x) { return li(x.title, '上周 #' + x.rank, 'delta-down'); }).join('') + '</ul>' : '<p>上周曲目全部在榜</p>');
  }

  /* ---------- 冠军榜 ---------- */
  function renderChampions() {
    var runs = [];
    ISSUES.forEach(function (it, i) {
      var top = it.entries.filter(function (e) { return e.rank === 1; })[0];
      if (!top) return;
      var id = idOf(top), last = runs[runs.length - 1];
      if (last && last.id === id) { last.end = i; last.count++; }
      else runs.push({ id: id, title: top.titleCn || top.title, bvid: top.bvid, start: i, end: i, count: 1 });
    });
    runs.reverse();
    el('champs').innerHTML = runs.slice(0, 24).map(function (r) {
      var label = r.start === r.end ? ('第 ' + ISSUES[r.start].issue + ' 期') : ('第 ' + ISSUES[r.start].issue + '–' + ISSUES[r.end].issue + ' 期');
      return '<div class="champ-item" data-id="' + esc(r.id) + '" data-bvid="' + esc(r.bvid) + '" data-issue="' + r.end + '">'
        + '<img loading="lazy" src="' + esc(coverOf(r.bvid, '320w_180h_1c.webp')) + '" alt="" onerror="this.style.opacity=0">'
        + '<div style="min-width:0"><div class="t">' + esc(r.title) + '</div><div class="m">' + label + ' · ' + fmtDate(ISSUES[r.end].date) + '</div></div>'
        + '<div class="c">' + (r.count > 1 ? r.count + ' 连冠' : '1 周') + '</div></div>';
    }).join('');
    el('champMeta').textContent = '共 ' + runs.length + ' 段冠军 · 显示最近 ' + Math.min(24, runs.length) + ' 段';
    Array.prototype.forEach.call(el('champs').querySelectorAll('.champ-item'), function (c) {
      c.addEventListener('click', function () { openDrawer(c.getAttribute('data-id'), Number(c.getAttribute('data-issue')), c.getAttribute('data-bvid')); });
    });
  }

  /* ---------- 走势 ---------- */
  var SONGS = Object.keys(hist).map(function (id) {
    var h = hist[id], best = 99;
    h.forEach(function (x) { if (x.rank < best) best = x.rank; });
    var last = h[h.length - 1].e;
    return { id: id, title: last.titleCn || last.title, titleAlt: last.title, weeks: h.length, best: best, last: h[h.length - 1].i };
  }).sort(function (a, b) { return b.weeks - a.weeks || a.best - b.best; });
  var SONG_BY_ID = {}; SONGS.forEach(function (s) { SONG_BY_ID[s.id] = s; });

  function renderSongItems(filter) {
    var f = (filter || '').trim().toLowerCase();
    var list = SONGS.filter(function (s) { return !f || (s.title + ' ' + s.titleAlt).toLowerCase().indexOf(f) >= 0; }).slice(0, 120);
    el('songItems').innerHTML = list.map(function (s) {
      return '<div class="song-item' + (s.id === curSong ? ' on' : '') + '" data-id="' + esc(s.id) + '"><span class="t">' + esc(s.title) + '</span><span class="w">' + s.weeks + ' 期</span></div>';
    }).join('') || '<div style="padding:10px;color:var(--tx3);font-size:12.5px">没有匹配的歌曲</div>';
    Array.prototype.forEach.call(document.querySelectorAll('.song-item'), function (x) {
      x.addEventListener('click', function () { openSong(x.getAttribute('data-id')); });
    });
  }
  function openSong(id) {
    curSong = id;
    renderSongItems(el('q').value);
    renderChart(id);
    window.scrollTo({ top: el('trendSec').offsetTop - 64, behavior: 'smooth' });
  }

  function renderChart(id) {
    var h = hist[id] || [];
    var card = el('chartCard');
    if (!h.length) { card.innerHTML = '<div style="color:var(--tx3)">选择左侧歌曲查看走势</div>'; return; }
    if (h.length === 1) {
      var only = h[0], is = ISSUES[only.i];
      var ent = is.entries.filter(function (e) { return idOf(e) === id; })[0] || {};
      card.innerHTML = '<div class="chart-head"><h4>' + esc(ent.titleCn || ent.title) + '</h4><span class="st">仅上榜 1 期 · 第 ' + is.issue + ' 期 #' + only.rank + '</span>'
        + (ent.bvid ? '<a class="lnk" href="' + videoUrl(ent.bvid) + '" target="_blank" rel="noopener">在 B 站打开 ↗</a>' : '') + '</div>'
        + '<div class="single-rank"><div class="big">#' + only.rank + '</div><div>该曲目前只在第 ' + is.issue + ' 期（' + fmtDate(is.date) + '）上榜一次</div></div>';
      return;
    }
    var first = h[0].i, last = h[h.length - 1].i, span = Math.max(1, last - first);
    var W = 780, H = 320, PL = 44, PR = 22, PT = 26, PB = 42, iw = W - PL - PR, ih = H - PT - PB;
    function X(i) { return PL + (i - first) / span * iw; }
    function Y(r) { return PT + (r - 1) / 19 * ih; }
    var segs = [], dots = '', prevI = null;
    h.forEach(function (p) {
      var x = X(p.i), y = Y(p.rank);
      segs.push((prevI !== null && p.i === prevI + 1 ? 'L ' : 'M ') + x.toFixed(1) + ' ' + y.toFixed(1));
      prevI = p.i;
      dots += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.2" fill="#1896DA" stroke="#0a0b0e" stroke-width="1.6"></circle>';
    });
    var grid = '';
    [1, 5, 10, 15, 20].forEach(function (r) {
      var y = Y(r);
      grid += '<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y.toFixed(1) + '" stroke="rgba(255,255,255,.06)"/>'
        + '<text x="' + (PL - 10) + '" y="' + (y + 3.5).toFixed(1) + '" fill="#6b7280" font-size="10" text-anchor="end">#' + r + '</text>';
    });
    var ticks = '';
    var step = Math.max(1, Math.ceil(span / 7));
    for (var i = first; i <= last; i += step) ticks += '<text x="' + X(i).toFixed(1) + '" y="' + (H - PB + 20) + '" fill="#6b7280" font-size="10" text-anchor="middle">' + ISSUES[i].issue + '期</text>';
    var best = 99, sum = 0; h.forEach(function (p) { if (p.rank < best) best = p.rank; sum += p.rank; });
    var e0 = h[h.length - 1].e;
    card.innerHTML = '<div class="chart-head"><h4>' + esc(e0.titleCn || e0.title) + '</h4>'
      + '<span class="st">在榜 ' + h.length + ' 期 · 最高 #' + best + ' · 平均 #' + (sum / h.length).toFixed(1) + ' · 首次 ' + ISSUES[first].issue + ' 期</span>'
      + (e0.bvid ? '<a class="lnk" href="' + videoUrl(e0.bvid) + '" target="_blank" rel="noopener">在 B 站打开 ↗</a>' : '') + '</div>'
      + '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;margin-top:8px">' + grid
      + '<path d="' + segs.join(' ') + '" fill="none" stroke="#1896DA" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>' + dots + ticks + '</svg>';
  }

  /* ---------- 详情抽屉（含预览播放器） ---------- */
  function ensureDrawer() {
    if (el('drawer')) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = '<div class="overlay" id="overlay"></div>'
      + '<aside class="drawer" id="drawer" aria-hidden="true">'
      + '<button class="close" id="drawerClose" aria-label="关闭">×</button>'
      + '<div class="player" id="player"></div>'
      + '<div class="d-body" id="drawerBody"></div>'
      + '</aside>';
    document.body.appendChild(wrap);
    el('overlay').addEventListener('click', closeDrawer);
    el('drawerClose').addEventListener('click', closeDrawer);
  }
  function openDrawer(id, issueIndex, bvid) {
    ensureDrawer();
    drawer = { open: true, id: id, issue: issueIndex, bvid: bvid };
    el('drawer').classList.add('on');
    el('overlay').classList.add('on');
    el('drawer').setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    renderDrawer();
  }
  function closeDrawer() {
    if (!el('drawer')) return;
    drawer.open = false;
    el('drawer').classList.remove('on');
    el('overlay').classList.remove('on');
    el('drawer').setAttribute('aria-hidden', 'true');
    el('player').innerHTML = '';
    document.body.style.overflow = '';
  }
  function renderDrawer() {
    var id = drawer.id, h = hist[id] || [];
    if (!h.length) return;
    var at = h.filter(function (x) { return x.i === drawer.issue; })[0] || h[h.length - 1];
    var e = at.e;
    var bvid = drawer.bvid || e.bvid;
    el('player').innerHTML = bvid
      ? '<iframe src="' + playerUrl(bvid) + '" scrolling="no" frameborder="0" allowfullscreen allow="autoplay; encrypted-media"></iframe>'
      : '<div class="no-player">没有可播放的稿件</div>';
    var best = 99; h.forEach(function (x) { if (x.rank < best) best = x.rank; });
    var variants = {};
    h.forEach(function (x) { if (x.e.bvid) (variants[x.e.bvid] = variants[x.e.bvid] || []).push(ISSUES[x.i].issue); });
    var vlist = Object.keys(variants).map(function (bv) {
      return '<button class="bv' + (bv === bvid ? ' on' : '') + '" data-bv="' + esc(bv) + '"><span class="mono">' + esc(bv) + '</span><em>' + variants[bv].map(function (n) { return '第' + n + '期'; }).join('、') + '</em></button>';
    }).join('');
    var body = '<div class="d-head">'
      + '<h3>' + esc(e.titleCn || e.title) + '</h3>'
      + (e.title && e.title !== e.titleCn ? '<div class="alt">' + esc(e.title) + '</div>' : '')
      + '<div class="tags">' + esc(names(e.producers) || '—') + (e.vocalists?.length ? ' · ' + esc(names(e.vocalists)) : '') + '</div>'
      + '</div>'
      + '<div class="d-stats">'
      + '<div><b>#' + at.rank + '</b><span>本期名次</span></div>'
      + '<div><b>#' + best + '</b><span>最高名次</span></div>'
      + '<div><b>' + h.length + '</b><span>在榜期数</span></div>'
      + '<div><b>' + Object.keys(variants).length + '</b><span>使用稿件</span></div>'
      + '</div>'
      + '<div class="d-chart">' + drawerChart(h) + '</div>'
      + '<div class="d-sec"><h4>稿件（同一首歌可能更换视频）</h4><div class="bv-list">' + vlist + '</div></div>'
      + '<div class="d-sec"><h4>上榜记录</h4><ol class="history">' + h.slice().reverse().slice(0, 12).map(function (x) {
        return '<li><span>第 ' + ISSUES[x.i].issue + ' 期</span><b>#' + x.rank + '</b><em>' + fmtDate(ISSUES[x.i].date) + '</em></li>';
      }).join('') + '</ol></div>'
      + '<div class="d-actions">'
      + (bvid ? '<a class="btn primary" href="' + videoUrl(bvid) + '" target="_blank" rel="noopener">在 B 站打开</a>' : '')
      + (ISSUES[drawer.issue]?.postUrl ? '<a class="btn" href="' + esc(ISSUES[drawer.issue].postUrl) + '" target="_blank" rel="noopener">本期文字版</a>' : '')
      + '</div>';
    el('drawerBody').innerHTML = body;
    Array.prototype.forEach.call(el('drawerBody').querySelectorAll('.bv'), function (b) {
      b.addEventListener('click', function () { drawer.bvid = b.getAttribute('data-bv'); renderDrawer(); });
    });
  }

  function drawerChart(h) {
    var first = h[0].i, last = h[h.length - 1].i, span = Math.max(1, last - first);
    var W = 420, H = 160, PL = 30, PR = 12, PT = 14, PB = 26, iw = W - PL - PR, ih = H - PT - PB;
    function X(i) { return PL + (i - first) / span * iw; }
    function Y(r) { return PT + (r - 1) / 19 * ih; }
    var segs = [], dots = '', prevI = null;
    h.forEach(function (p) {
      var x = X(p.i), y = Y(p.rank);
      segs.push((prevI !== null && p.i === prevI + 1 ? 'L ' : 'M ') + x.toFixed(1) + ' ' + y.toFixed(1));
      prevI = p.i;
      dots += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="2.6" fill="#1896DA"/>';
    });
    var grid = '';
    [1, 10, 20].forEach(function (r) {
      var y = Y(r);
      grid += '<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y.toFixed(1) + '" stroke="rgba(255,255,255,.06)"/><text x="' + (PL - 6) + '" y="' + (y + 3) + '" fill="#6b7280" font-size="9" text-anchor="end">#' + r + '</text>';
    });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto">' + grid
      + '<path d="' + segs.join(' ') + '" fill="none" stroke="#1896DA" stroke-width="1.8" stroke-linejoin="round"/>' + dots
      + '<text x="' + PL + '" y="' + (H - 8) + '" fill="#6b7280" font-size="9">' + ISSUES[first].issue + '期</text>'
      + '<text x="' + (W - PR) + '" y="' + (H - 8) + '" fill="#6b7280" font-size="9" text-anchor="end">' + ISSUES[last].issue + '期</text></svg>';
  }

  /* ---------- 图片失败重试（偶发网络抖动） ---------- */
  document.addEventListener('error', function (e) {
    var img = e.target;
    if (!img || img.tagName !== 'IMG' || img.dataset.retried) return;
    img.dataset.retried = '1';
    img.src = img.src.split('?')[0] + '?r=' + Date.now();
  }, true);

  /* ---------- 刷新 ---------- */
  function toast(msg, kind) {
    var t = document.getElementById('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'toast on' + (kind === 'err' ? ' err' : '');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.className = 'toast'; }, 2600);
  }

  async function refreshData(force) {
    var btn = document.getElementById('refreshBtn');
    var label = btn ? btn.querySelector('.lbl') : null;
    if (!btn || btn.classList.contains('loading')) return;
    if (force) { location.reload(); return; }
    btn.classList.add('loading');
    var before = label ? label.textContent : '';
    if (label) label.textContent = '刷新中';
    try {
      var res = await fetch('data.json?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var fresh = await res.json();
      var prev = (DATA.meta && DATA.meta.generatedAt) || '';
      var next = (fresh.meta && fresh.meta.generatedAt) || '';
      if (next && next !== prev) {
        toast('发现新数据，正在刷新…');
        setTimeout(function () { location.reload(); }, 500);
        return;
      }
      toast('已是最新：第 ' + ISSUES[N - 1].issue + ' 期');
    } catch (err) {
      toast('本地文件模式，重新加载页面');
      setTimeout(function () { location.reload(); }, 400);
    } finally {
      setTimeout(function () {
        btn.classList.remove('loading');
        if (label) label.textContent = before;
      }, 450);
    }
  }

  function bindRefresh() {
    var btn = document.getElementById('refreshBtn');
    if (!btn) return;
    btn.addEventListener('click', function (e) { refreshData(e.ctrlKey || e.metaKey); });
  }

  /* ---------- 悬停事件（委托，避免每次重渲染重绑） ---------- */
  function bindHover() {
    var rowsEl = el('rows');
    function findEntry(target) {
      var cv = target.closest ? target.closest('.cv-wrap') : null;
      var row = cv && cv.closest('.row');
      if (!row) return null;
      var id = row.getAttribute('data-id');
      return deco[cur].filter(function (x) { return String(x.id) === id; })[0] || null;
    }
    rowsEl.addEventListener('mouseover', function (ev) {
      var e = findEntry(ev.target);
      if (e) showHover(e, ev.clientX, ev.clientY);
    });
    rowsEl.addEventListener('mousemove', function (ev) {
      var e = findEntry(ev.target);
      if (e) showHover(e, ev.clientX, ev.clientY);
    });
    rowsEl.addEventListener('mouseleave', hideHover);
    rowsEl.addEventListener('scroll', hideHover, true);
  }

  /* ---------- 初始化 ---------- */
  el('q').addEventListener('input', function (e) { renderSongItems(e.target.value); });
  bindHover();
  bindRefresh();
  renderToolbar(); renderHero(); renderBoard(); renderInsights(); renderChampions(); renderSongItems('');
  el('chartCard').innerHTML = '<div style="color:var(--tx3);padding:24px;font-size:13px">从左侧选择一首歌曲，或点击榜单中的任意一行，查看走势与视频预览。</div>';
  if (SONGS.length) { curSong = SONGS[0].id; renderSongItems(''); renderChart(SONGS[0].id); }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeDrawer();
    if (!drawer.open && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) setIssue(cur + (e.key === 'ArrowLeft' ? -1 : 1));
  });
  window.scrollTo(0, 0);
})();
