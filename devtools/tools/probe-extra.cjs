#!/usr/bin/env node
/**
 * 附榜（传说曲周榜 / 年榜）验收探针：真浏览器 + CDP。
 * 用法：node src/cli.js serve --port 5199 && node devtools/tmp/probe-extra.cjs --port 5199
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function arg(name, fallback) { const i = process.argv.indexOf('--' + name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; }
function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }

async function main() {
  const port = Number(arg('port', 5173));
  const base = 'http://127.0.0.1:' + port + '/';
  const outDir = path.resolve(ROOT, arg('out', 'devtools/tmp'));
  fs.mkdirSync(outDir, { recursive: true });
  if (!(await fetch(base).then((r) => r.ok).catch(() => false))) throw new Error('服务没起来：' + base);

  const debuggingPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bbw-extra-'));
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + debuggingPort, 'about:blank'], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch('http://127.0.0.1:' + debuggingPort + '/json/new?url=about:blank', { method: 'PUT' }); target = await r.json(); if (target.webSocketDebuggerUrl) break; } catch (e) {}
    await sleep(200);
  }
  if (!target) throw new Error('连不上无头浏览器');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const logs = [];
  let nextId = 0;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('log: ' + m.params.entry.text);
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params) => { const id = ++nextId; ws.send(JSON.stringify({ id, method, params: params || {} })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(outDir, name), Buffer.from(s.data, 'base64')); };
  const key = async (k, code) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  };

  /* 等条件成立，别用固定 sleep 赌加载速度。
     实测：同一条命令，同一次提交，页面 3 秒后可能还在解析 <body> 的第一个字符
     （服务端刚 reload 完、第一次请求慢一点就会这样），
     固定 sleep 会让"页面没加载好"伪装成"功能坏了"。 */
  const waitFor = async (expr, timeout = 20000) => {
    const t0 = Date.now();
    for (;;) {
      const ok = await evaluate('(function(){try{return !!(' + expr + ')}catch(e){return false}})()');
      if (ok) return true;
      if (Date.now() - t0 > timeout) return false;
      await sleep(200);
    }
  };

  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });

  try {
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: base });
    const legendReady = await waitFor("document.querySelectorAll('#rows .row').length > 0 && document.getElementById('boardPickLabel')");
    check('周榜在 20s 内渲染出来', legendReady, legendReady ? 'ok' : '超时');
    // 行数不写死：上游曲目库补得慢时，最新一期可能只有几行（数据本身如此）
    await waitFor("document.getElementById('boardPickLabel') && document.getElementById('boardPickLabel').textContent === '周榜' && document.querySelectorAll('#rows .row').length > 0");

    const weekly = await evaluate(`(function(){
      return { pick: document.getElementById('boardPickLabel').textContent,
        rows: document.querySelectorAll('#rows .row').length,
        sub: document.getElementById('pageSub').textContent,
        champs: document.getElementById('champMeta').textContent,
        champsCount: document.querySelectorAll('#champs .champ-item').length,
        songs: document.querySelectorAll('#songItems .song-item').length };
    })()`);
    check('默认停在周榜', weekly.pick === '周榜' && weekly.rows > 0, weekly.pick + ' / ' + weekly.rows + ' 行');
    check('周榜的副标题 / 冠军段 / 曲目索引都在', /第 \d+–\d+ 期/.test(weekly.sub) && /共 \d+ 条/.test(weekly.sub) && weekly.champsCount > 0 && weekly.songs > 0,
      weekly.sub.slice(0, 30) + ' · ' + weekly.champs + ' · ' + weekly.songs + ' 首');

    // 标题里的下拉：点了才出现，三条榜都在
    await evaluate("document.getElementById('boardPick').click()");
    const opened = await waitFor("!document.getElementById('boardMenu').hidden");
    const menu = await evaluate("JSON.stringify([].map.call(document.querySelectorAll('#boardMenu button'), function (b) { return b.textContent; }))");
    check('标题里的下拉能展开三条榜', opened && menu === '["周榜","传说榜","年榜"]', menu);
    await sleep(400);   // 菜单有淡入动画，截图早一拍会拍到半透明
    await shot('pick-menu.png');

    // 切到传说榜：整页跟着换（标题、副标题、冠军卡、榜单、冠军段、页脚）
    await evaluate("document.querySelector('#boardMenu button[data-board=legend]').click()");
    await waitFor("document.getElementById('boardPickLabel').textContent === '传说榜' && document.querySelectorAll('#rows .row').length > 0");
    await sleep(600);
    const legend = await evaluate(`(function(){
      return { pick: document.getElementById('boardPickLabel').textContent,
        title: document.getElementById('pageTitle').textContent,
        rows: document.querySelectorAll('#rows .row').length,
        sub: document.getElementById('pageSub').textContent,
        champ: document.querySelector('#hero .champ h2') ? document.querySelector('#hero .champ h2').textContent : '',
        champs: document.getElementById('champMeta').textContent,
        footer: document.getElementById('footer').textContent.slice(0, 50),
        sel: document.getElementById('issueSel').value };
    })()`);
    check('切到传说榜后标题跟着变', legend.title.indexOf('传说榜') >= 0, legend.pick);
    // 传说曲榜从第 1 期开始；上界会随上游更新而动，只钉"起点是 1"
    check('传说榜有自己的期次范围', /^第 1–\d+ 期/.test(legend.sub), legend.sub.slice(0, 40));
    check('传说榜有冠军卡与冠军段', legend.champ.length > 0 && legend.champs.indexOf('段冠军') >= 0, legend.champ + ' · ' + legend.champs);
    check('传说榜页脚换了口径', legend.footer.indexOf('传说榜') >= 0 || legend.footer.indexOf('Bili-Board_Atel') >= 0, legend.footer);
    await shot('pick-legend.png');

    // 传说榜的行必须按传说榜取数（期号与周榜撞车，最容易串）
    await evaluate("document.querySelector('#rows .row').click()");
    await waitFor("document.getElementById('drawer') && document.getElementById('drawer').classList.contains('on')");
    const legendDrawer = await evaluate(`(function(){
      var b = document.getElementById('drawerBody');
      return { head: b.querySelector('.d-sec h4') ? b.querySelector('.d-sec h4').textContent : '',
        full: b.textContent,
        rows: document.querySelectorAll('#rows .row').length };
    })()`);
    check('传说榜行打开的是传说榜抽屉', legendDrawer.head.indexOf('传说曲周榜') >= 0, legendDrawer.head.slice(0, 30));
    check('传说榜抽屉里没有 undefined', legendDrawer.full.indexOf('undefined') < 0 && legendDrawer.full.indexOf('NaN') < 0, legendDrawer.full.replace(/\s+/g, ' ').slice(0, 80));
    await shot('pick-drawer.png');
    await key('Escape', 27);
    await waitFor("!document.getElementById('drawer').classList.contains('on')");

    // 传说榜最早一期：上一期按钮应当是禁用的
    await evaluate("(function(){var s=document.getElementById('issueSel'); s.value='1'; s.dispatchEvent(new Event('change'));})()");
    await waitFor("document.getElementById('issueSel').value === '1' && document.querySelectorAll('#toolbar .nav')[0].disabled");
    const first = await evaluate(`(function(){
      var navs = document.querySelectorAll('#toolbar .nav');
      return { prevDisabled: navs[0].disabled, nextDisabled: navs[1].disabled, rows: document.querySelectorAll('#rows .row').length, sub: document.getElementById('pageSub').textContent };
    })()`);
    check('传说榜第 1 期的"上一期"被禁用', first.prevDisabled && !first.nextDisabled, JSON.stringify({ prev: first.prevDisabled, next: first.nextDisabled, rows: first.rows }));

    // 年榜
    await evaluate("document.getElementById('boardPick').click()");
    await waitFor("!document.getElementById('boardMenu').hidden");
    await evaluate("document.querySelector('#boardMenu button[data-board=annual]').click()");
    await waitFor("document.getElementById('boardPickLabel').textContent === '年榜' && document.querySelectorAll('#rows .row').length > 0");
    await sleep(500);
    const annual = await evaluate(`(function(){
      return { rows: document.querySelectorAll('#rows .row').length,
        opts: document.querySelectorAll('#issueSel option').length,
        sub: document.getElementById('pageSub').textContent,
        champs: document.getElementById('champMeta').textContent };
    })()`);
    check('切到年榜后行数与期次范围跟着换', annual.rows === 50 && annual.opts === 5 && annual.sub.indexOf('第 1–5 期') >= 0,
      annual.rows + ' 行 / ' + annual.opts + ' 期可选 / ' + annual.sub.slice(0, 24));
    check('年榜有自己的冠军段', annual.champs.indexOf('段冠军') >= 0, annual.champs);

    // 年榜第 3 期是 100 行
    await evaluate("(function(){var s=document.getElementById('issueSel'); s.value='3'; s.dispatchEvent(new Event('change'));})()");
    await waitFor("document.getElementById('issueSel').value === '3' && document.querySelectorAll('#rows .row').length === 100");
    const big = await evaluate("document.querySelectorAll('#rows .row').length");
    check('年榜第 3 期是 100 行', big === 100, big + ' 行');

    // 年榜不该有走势：一年一期、总共 5 期，"逐期曲线"就是几个点
    const annualSecs = await evaluate(`(function(){
      return ['hero','boardSec','insightSec','champSec','trendSec']
        .map(function (id) { return id + ':' + (document.getElementById(id).hidden ? 'off' : 'on'); }).join(' ');
    })()`);
    check('年榜不显示走势区块', annualSecs.indexOf('trendSec:off') >= 0 && annualSecs.indexOf('champSec:on') >= 0, annualSecs);

    // 行内那条「近 30 期」小折线也一起去掉：5 个点连不成趋势，只会在每行加一道噪音
    const annualSpark = await evaluate(`(function(){
      var row = document.querySelector('#rows .row');
      var head = document.querySelector('#boardSec .board-head');
      return { cls: document.querySelector('#boardSec .board').className,
        sp: row ? getComputedStyle(row.querySelector('.sp')).display : 'none',
        head5: head && head.children[4] ? getComputedStyle(head.children[4]).display : 'none' };
    })()`);
    check('年榜行内不画「近 30 期」折线', annualSpark.sp === 'none' && annualSpark.head5 === 'none' && annualSpark.cls.indexOf('no-spark') >= 0,
      annualSpark.cls + ' · 折线 ' + annualSpark.sp + ' · 表头 ' + annualSpark.head5);
    await shot('pick-annual.png');

    // 回到周榜，后面的用例还要用
    await evaluate("document.getElementById('boardPick').click()");
    await waitFor("!document.getElementById('boardMenu').hidden");
    await evaluate("document.querySelector('#boardMenu button[data-board=weekly]').click()");
    await waitFor("document.getElementById('boardPickLabel').textContent === '周榜' && document.querySelectorAll('#rows .row').length > 0");
    await waitFor("!document.getElementById('trendSec').hidden");

    // ---- 走势区间：默认最近 30 期，可改成任意起止 ----
    await waitFor("document.getElementById('rangeFrom').options.length > 0");
    const rng = await evaluate(`(function(){
      var f = document.getElementById('rangeFrom'), t = document.getElementById('rangeTo');
      return { from: f.value, to: t.value, opts: f.options.length,
        first: f.options[f.options.length - 1].value, resetDisabled: document.getElementById('rangeReset').disabled };
    })()`);
    check('走势默认最近 30 期', Number(rng.to) - Number(rng.from) === 29 && rng.resetDisabled, rng.from + '–' + rng.to + '（共 ' + rng.opts + ' 期可选）');

    await evaluate("document.querySelector('#songItems .song-item').click()");
    await waitFor("document.querySelectorAll('#chartCard .trend-dot').length > 0");
    const dotsWin = await evaluate("document.querySelectorAll('#chartCard .trend-dot').length");
    // 把起点拉到最早一期：窗口变宽，点数只可能变多
    await evaluate("(function(){var f=document.getElementById('rangeFrom'); f.value=f.options[f.options.length-1].value; f.dispatchEvent(new Event('change'));})()");
    await sleep(500);
    const wider = await evaluate(`(function(){
      var f = document.getElementById('rangeFrom');
      return { from: f.value, dots: document.querySelectorAll('#chartCard .trend-dot').length,
        head: document.querySelector('#chartCard .chart-head .st').textContent };
    })()`);
    check('改起点后走势图重新计算区间', wider.dots >= dotsWin && wider.head.indexOf('第 ' + wider.from + '–') === 0,
      wider.from + '– · ' + wider.dots + ' 点（原 ' + dotsWin + '）');
    await shot('range-wide.png');
    await evaluate("document.getElementById('rangeReset').click()");
    await sleep(300);
    check('"近 30 期"能回到默认', await evaluate("document.getElementById('rangeReset').disabled"), '已回到默认');

    // ---- 附榜 B：ニコニコ VOCALOID TOP20（另一个 UP 主、另一套期号）----
    // 先切榜：N 榜是**另一套视图**，不切换的话它整块是收起的（这是刻意的）
    const switchCount = await evaluate("document.querySelectorAll('#chartSwitch .cs').length");
    check('顶栏有 B / N 两个切榜按钮', switchCount === 2, switchCount + ' 个');
    await evaluate("document.querySelector('#chartSwitch .cs[data-chart=n]').click()");
    await waitFor("document.getElementById('nicoSec') && !document.getElementById('nicoSec').hidden && document.querySelectorAll('#nicoRows .row').length > 0");
    await sleep(500);
    const switched = await evaluate(`(function(){
      return { board: !document.getElementById('boardSec').hidden,
        hero: !document.getElementById('hero').hidden,
        bTitle: !document.getElementById('pageTitle').hidden,
        nTitle: !document.getElementById('pageTitleN').hidden,
        title: document.getElementById('pageTitleN').textContent,
        footer: document.getElementById('footer').textContent.slice(0, 60) };
    })()`);
    check('切到 N 榜后 B 榜整套收起', !switched.board && !switched.hero && !switched.bTitle && switched.nTitle, JSON.stringify({ board: switched.board, hero: switched.hero, bTitle: switched.bTitle }));
    check('标题与页脚跟着换成 N 榜', switched.title.indexOf('ニコニコ') >= 0 && switched.footer.indexOf('Elvansphere') >= 0, switched.title + ' / ' + switched.footer);
    await sleep(300);
    const nico = await evaluate(`(function(){
      var sec = document.getElementById('nicoSec');
      var rows = document.querySelectorAll('#nicoRows .row');
      var first = rows[0];
      return {
        hidden: sec ? sec.hidden : true,
        title: document.getElementById('nicoTitle') ? document.getElementById('nicoTitle').textContent : '',
        author: document.getElementById('nicoAuthor') ? document.getElementById('nicoAuthor').textContent : '',
        authorHref: document.getElementById('nicoAuthor') ? document.getElementById('nicoAuthor').href : '',
        rows: rows.length,
        meta: document.getElementById('nicoMeta') ? document.getElementById('nicoMeta').textContent : '',
        tl: document.querySelector('#nicoToolbar .tl-meta') ? document.querySelector('#nicoToolbar .tl-meta').textContent : '',
        hasCover: first ? !!first.querySelector('img.cv').getAttribute('src') : false,
        firstBv: first ? first.getAttribute('data-bvid') : ''
      };
    })()`);
    check('ニコニコ 榜区块可见', !nico.hidden, nico.title + ' / ' + nico.meta);
    check('标注了来源 UP 主', nico.author.indexOf('Elvansphere') >= 0 && nico.authorHref.indexOf('12446725') >= 0, nico.author + ' → ' + nico.authorHref);
    check('默认显示最近一期 20 行', nico.rows === 20, nico.rows + ' 行');
    check('副标题带统计时段', /统计\s*\d{4}\/\d{1,2}\/\d{1,2}–\d{4}\/\d{1,2}\/\d{1,2}/.test(nico.tl), nico.tl);
    check('行上有封面直链与 BV 号', nico.hasCover && /^BV/.test(nico.firstBv), nico.firstBv);

    // 冠军卡：和 B 榜同构的大字标题块（上一版 N 榜只有表格，抬头是一片空白）
    const hero = await evaluate(`(function(){
      var h = document.getElementById('nicoHero');
      var champ = h.querySelector('.champ h2');
      return { exists: !!champ,
        title: champ ? champ.textContent : '',
        label: h.querySelector('.champ .lbl') ? h.querySelector('.champ .lbl').textContent.trim() : '',
        cover: !!h.querySelector('.cover-lg'),
        kpis: h.querySelectorAll('.kpi').length,
        side: h.querySelectorAll('.side-item').length,
        pills: h.querySelectorAll('.pill').length,
        h2Size: champ ? getComputedStyle(champ).fontSize : '' };
    })()`);
    check('N 榜有冠军卡大字标题', hero.exists && hero.title.length > 0, hero.title);
    check('冠军卡与 B 榜同构（标签/封面/KPI/侧栏）', hero.label.indexOf('冠') >= 0 && hero.cover && hero.kpis === 5 && hero.side === 2, JSON.stringify({ label: hero.label, cover: hero.cover, kpis: hero.kpis, side: hero.side }));
    check('冠军卡不是小字', parseFloat(hero.h2Size) >= 22, hero.h2Size + ' / ' + hero.pills + ' 个 pill');


    await waitFor("document.getElementById('nicoSec') && !document.getElementById('nicoSec').hidden && document.querySelectorAll('#nicoRows .row').length > 0");
    // 看点 / 冠军榜 / 走势：三条与 B 榜同构的区块，缺一块就是"这条榜是半成品"
    await waitFor("document.querySelectorAll('#nicoChamps .champ-item').length > 0 && document.querySelectorAll('#nicoSongItems .song-item').length > 0");
    const sections = await evaluate(`(function(){
      var panels = [].map.call(document.querySelectorAll('#nicoInsightSec .panel'), function (p) { return p.textContent.trim().length; });
      return { insightPanels: panels.length, panelText: panels,
        champs: document.querySelectorAll('#nicoChamps .champ-item').length,
        champMeta: document.getElementById('nicoChampMeta').textContent,
        songs: document.querySelectorAll('#nicoSongItems .song-item').length,
        songList: document.querySelector('#nicoSongItems .song-item .t') ? document.querySelector('#nicoSongItems .song-item .t').textContent : '' };
    })()`);
    check('N 榜有本期看点（三栏都有内容）', sections.insightPanels === 3 && sections.panelText.every(function (n) { return n > 10; }), JSON.stringify(sections.panelText));
    check('N 榜有冠军榜', sections.champs > 0 && sections.champMeta.indexOf('段冠军') >= 0, sections.champs + ' 段 / ' + sections.champMeta);
    check('N 榜有曲目索引', sections.songs > 0, sections.songs + ' 首 · 首条 ' + sections.songList);

    // 点一首歌应该画出折线（横轴必须是 N 榜自己的期号，不能借用周榜的）
    await evaluate("document.querySelector('#nicoSongItems .song-item').click()");
    await waitFor("document.querySelector('#nicoChartCard svg.chart') && document.querySelectorAll('#nicoChartCard .trend-dot').length > 0");
    const chart = await evaluate(`(function(){
      var svg = document.querySelector('#nicoChartCard svg.chart');
      var ticks = [].map.call(svg.querySelectorAll('.chart-txt'), function (t) { return t.textContent; }).filter(function (t) { return t.indexOf('期') > 0; });
      return { dots: svg.querySelectorAll('.trend-dot').length, ticks: ticks.slice(-2), head: document.querySelector('#nicoChartCard .chart-head h4').textContent };
    })()`);
    check('N 榜走势图画得出来', chart.dots > 0, chart.head + ' · ' + chart.dots + ' 个点 · 末两期 ' + JSON.stringify(chart.ticks));

    // N 榜的走势也带区间控件（默认近 30 期），改起点后横轴跟着换
    const nRange = await evaluate(`(function(){
      var f = document.getElementById('nicoRangeFrom'), t = document.getElementById('nicoRangeTo');
      return { from: f.value, to: t.value, opts: f.options.length };
    })()`);
    check('N 榜走势也有区间选择', nRange.opts > 30 && Number(nRange.to) - Number(nRange.from) >= 29,
      nRange.from + '–' + nRange.to + '（共 ' + nRange.opts + ' 期）');

    await evaluate("document.getElementById('nicoSec').scrollIntoView()");
    // 入场动画最长 320ms 延迟 + 420ms 时长：不等它跑完，截图上会看到几行"是空的"
    // ——那不是渲染错了，只是抓到动画中间态。
    await sleep(1000);
    await shot('nico-desktop.png');

    // 点冠军卡封面也能开抽屉，而且要按 N 榜的口径（放在截图之后：点完焦点环会留在封面上）
    await evaluate("document.querySelector('#nicoHero .cover-wrap').click()");
    await waitFor("document.getElementById('drawer') && document.getElementById('drawer').classList.contains('on')");
    const heroDrawer = await evaluate("document.getElementById('drawerBody').querySelector('.d-sec h4') ? document.getElementById('drawerBody').querySelector('.d-sec h4').textContent : ''");
    check('点冠军卡打开的仍是 N 榜抽屉', heroDrawer.indexOf('ニコニコ') >= 0, heroDrawer.slice(0, 30));
    await key('Escape', 27);
    await waitFor("!document.getElementById('drawer').classList.contains('on')");

    // 换到更早的一期（期号与主榜完全无关，不能串）
    const nicoRange = await evaluate("document.getElementById('nicoSel').options.length");
    await evaluate(`(function(){ var s = document.getElementById('nicoSel'); s.value = String(Number(document.getElementById('nicoSel').options[5].value)); s.dispatchEvent(new Event('change')); })()`);
    await waitFor("document.getElementById('nicoSel').value !== String(document.getElementById('nicoSel').options[0].value)");
    const nicoPrev = await evaluate(`(function(){
      return { rows: document.querySelectorAll('#nicoRows .row').length,
        tl: document.querySelector('#nicoToolbar .tl-meta').textContent,
        sel: document.getElementById('nicoSel').value,
        headerIssue: document.getElementById('nicoMeta').textContent };
    })()`);
    check('换期后行数与副标题跟着变', nicoPrev.rows === 20 && nicoRange > 100, nicoRange + ' 期可选 / 当前第 ' + nicoPrev.sel + ' 期 / ' + nicoPrev.tl);

    // 点一行开抽屉：必须按ニコニコ榜的口径显示，且带文字版入口
    await evaluate("document.querySelector('#nicoRows .row').click()");
    await waitFor("document.getElementById('drawer') && document.getElementById('drawer').classList.contains('on')");
    const nicoDrawer = await evaluate(`(function(){
      var b = document.getElementById('drawerBody');
      return { on: document.getElementById('drawer').classList.contains('on'),
        full: b.textContent,
        head: b.querySelector('.d-sec h4') ? b.querySelector('.d-sec h4').textContent : '',
        hasPost: !!b.querySelector('.d-actions a[href*="bilibili.com/opus"]') };
    })()`);
    check('ニコニコ 行能开抽屉', nicoDrawer.on, nicoDrawer.head);
    check('抽屉按ニコニコ榜口径显示', nicoDrawer.head.indexOf('ニコニコ') >= 0 && nicoDrawer.full.indexOf('该期名次') >= 0, nicoDrawer.head.slice(0, 40));
    check('抽屉里没有 undefined / NaN', nicoDrawer.full.indexOf('undefined') < 0 && nicoDrawer.full.indexOf('NaN') < 0, nicoDrawer.full.replace(/\s+/g, ' ').slice(0, 90));
    await shot('nico-drawer.png');
    await key('Escape', 27);
    await waitFor("!document.getElementById('drawer').classList.contains('on')");

    // ---- 设置抽屉：命令行那几件事的网页版 ----
    await evaluate("document.getElementById('consoleBtn').click()");
    await waitFor("document.getElementById('console').classList.contains('on')");
    const acts = await evaluate(`(function(){
      return { n: document.querySelectorAll('#consoleActions [data-run]').length,
        names: [].map.call(document.querySelectorAll('#consoleActions [data-run]'), function (b) { return b.getAttribute('data-run'); }) };
    })()`);
    check('设置抽屉列出全部任务', acts.n === 11, acts.n + ' 个：' + acts.names.join(' '));
    await shot('console-open.png');

    await evaluate("document.querySelector('#consoleActions [data-run=status]').click()");
    await waitFor("document.getElementById('consoleOut').textContent.length > 30");
    const out = await evaluate(`(function(){
      return { text: document.getElementById('consoleOut').textContent,
        state: document.getElementById('consoleState').textContent };
    })()`);
    check('设置抽屉能跑任务并回显输出', out.text.indexOf('官方曲目库') >= 0 && out.state.indexOf('完成') >= 0,
      out.state + ' · ' + out.text.split('\n')[0].slice(0, 34));
    await shot('console-status.png');

    // 跑一遍语法自检：这条会起子进程，能覆盖"长任务 + 流式输出"整条链路
    await evaluate("document.querySelector('#consoleActions [data-run=check]').click()");
    await waitFor("document.getElementById('consoleState').textContent.indexOf('完成') >= 0 && document.getElementById('consoleOut').textContent.indexOf('语法检查') >= 0", 60000);
    const chk = await evaluate("document.getElementById('consoleOut').textContent");
    check('长任务（语法自检）能跑完并回显', chk.indexOf('全部通过') >= 0 || chk.indexOf('失败') >= 0, chk.split('\n').slice(-2).join(' | ').slice(0, 70));
    await shot('console-check.png');
    await evaluate("document.getElementById('consoleClose').click()");
    await waitFor("!document.getElementById('console').classList.contains('on')");

    // 移动端
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Page.navigate', { url: base });
    // 上一次切到 N 榜 / 年榜时记住了选择（localStorage），回到页面先显式切回 B 榜 + 周榜
    await waitFor("document.getElementById('chartSwitch') && document.getElementById('rows')");
    await evaluate("document.querySelector('#chartSwitch .cs[data-chart=b]').click()");
    await waitFor("document.querySelectorAll('#rows .row').length > 0 && document.getElementById('boardPickLabel')");
    if ((await evaluate("document.getElementById('boardPickLabel').textContent")) !== '周榜') {
      await evaluate("document.getElementById('boardPick').click()");
      await waitFor("!document.getElementById('boardMenu').hidden");
      await evaluate("document.querySelector('#boardMenu button[data-board=weekly]').click()");
      await waitFor("document.getElementById('boardPickLabel').textContent === '周榜'");
    }
    await sleep(400);
    await evaluate("document.getElementById('boardSec').scrollIntoView()");
    await sleep(500);
    const mobile = await evaluate(`(function(){
      return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        rows: document.querySelectorAll('#rows .row').length,
        pick: document.getElementById('boardPickLabel').textContent,
        selW: Math.round(document.getElementById('issueSel').getBoundingClientRect().width),
        pickW: Math.round(document.getElementById('boardPick').getBoundingClientRect().width) };
    })()`);
    check('移动端周榜无横向溢出', mobile.overflow === 0, '溢出 ' + mobile.overflow + 'px');
    check('移动端标题下拉可点', mobile.rows > 0 && mobile.pickW > 0 && mobile.pickW < 200, mobile.rows + ' 行 / 下拉 ' + mobile.pickW + 'px / 期次 ' + mobile.selW + 'px');
    await shot('extra-mobile.png');

    // 手机上同样要先切到 N 榜
    await evaluate("document.querySelector('#chartSwitch .cs[data-chart=n]').click()");
    await waitFor("!document.getElementById('nicoSec').hidden && document.querySelectorAll('#nicoRows .row').length > 0");
    await evaluate("document.getElementById('nicoSec').scrollIntoView()");
    await sleep(900);
    const nicoMobile = await evaluate(`(function(){
      var sec = document.getElementById('nicoSec');
      return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        hidden: sec.hidden,
        rows: document.querySelectorAll('#nicoRows .row').length,
        selW: Math.round(document.getElementById('nicoSel').getBoundingClientRect().width) };
    })()`);
    check('移动端ニコニコ榜照常渲染', !nicoMobile.hidden && nicoMobile.rows === 20 && nicoMobile.overflow === 0, nicoMobile.rows + ' 行 / 溢出 ' + nicoMobile.overflow + 'px / sel ' + nicoMobile.selW + 'px');
    await shot('nico-mobile.png');
  } finally {
    ws.close(); edge.kill(); await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(JSON.stringify({ checks, consoleErrors: logs, screenshots: outDir }, null, 2));
  if (failed.length || logs.length) { console.error('\n✗ ' + (failed.length + logs.length) + ' 项未通过'); process.exit(1); }
  console.log('\n✓ 全部通过');
}
main().catch((e) => { console.error('[probe] ' + (e && e.stack || e)); process.exit(1); });
