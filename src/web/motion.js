/**
 * motion.js —— 看板的动效编排（只做 CSS 做不到的部分）
 *
 * 这一版刻意做得很薄。看板是"读数"的地方，动效只在**数据变了**的时候出现，
 * 否则就是噪音：
 *   · 换一期 / 换一首歌时，新内容按顺序错开入场（--i → animation-delay）
 *   · 走势图换歌时描一次线、圆点依次落位
 *   · 封面图从占位淡入（不再出现"先黑框、后闪出图"）
 *   · 其余交互（悬停、按压、抽屉、提示条）全交给 CSS
 *
 * 明确不做（博客需要、看板不需要，做了反而碍事）：
 *   阅读进度条、按钮文字磁吸、页眉随滚动收放、滚动入场、全屏加载遮罩。
 *
 * 两条规矩：
 *   1. 只写 transform / opacity / 入场序号，不读写会引起重排的属性
 *   2. 尊重 prefers-reduced-motion：减少动效时**不做动画编排**，
 *      但内容照常显示（"减少动效"减的是动画，不是信息）
 */
(function () {
  'use strict';

  var reducedMq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function reduced() { return !!(reducedMq && reducedMq.matches); }

  /* ---------- 1. 入场交错 ---------- */

  /**
   * 给容器里的直接子元素编号，CSS 用 --i 换算成 animation-delay。
   *
   * @param {Element|null} container
   * @param {{animate?: boolean, step?: number, max?: number}} [opts]
   *   animate=false 时给容器打上 .is-static（CSS 里直接 animation:none）：
   *   筛选框每敲一个字都会重绘整张表，那种重绘不该播入场。
   */
  function stagger(container, opts) {
    if (!container) return;
    var o = opts || {};
    var animate = o.animate !== false;
    var max = o.max == null ? 12 : o.max;

    if (!animate) {
      container.classList.add('is-static');
      return;
    }
    container.classList.remove('is-static');

    var n = 0;
    for (var i = 0; i < container.children.length; i++) {
      var el = container.children[i];
      if (el.nodeType !== 1) continue;
      // 序号超过上限就不再加：第 21 行和第 13 行一起出发，比"最后一行要等 1 秒"好得多
      el.style.setProperty('--i', String(Math.min(n, max)));
      n++;
    }
  }

  /* ---------- 2. 走势图描线 ---------- */

  /**
   * 让一张刚插入的走势图播一次描线动画。
   *
   * 路径上必须带 pathLength="1"（由渲染函数的字符串模板写死），
   * 这样 dasharray/dashoffset 可以直接写 1，不用在 JS 里量 getTotalLength()。
   * 圆点的序号（--i）也在这里按出现顺序写入 —— 它们是 SVG 子节点，
   * 不能复用 rows 那套容器编号。
   */
  function chart(svg) {
    if (!svg) return;
    // 动画类每次先摘再戴：换歌时 SVG 是新建的，但同一个元素重复调用也能重播
    svg.classList.remove('is-drawing');
    if (reduced()) return;

    var dots = svg.querySelectorAll('.trend-dot');
    for (var i = 0; i < dots.length; i++) {
      dots[i].style.setProperty('--i', String(Math.min(i, 24)));
    }
    // 允许浏览器先按"无动画"结算一次，再戴上类，动画才会从头播
    void svg.getBoundingClientRect();
    svg.classList.add('is-drawing');
  }

  /* ---------- 3. 封面淡入 ---------- */

  /**
   * 图片淡入走的是 document 级委托，而不是给每个 <img> 挂 onload：
   *   - 内联 onload/onerror 是 CSP 不友好的写法（本项目目前没有 CSP，但没有理由
   *     再增加一类"只能在特定安全策略下才工作"的代码）；
   *   - 榜单行是整块重绘的，委托对"之后才插进来的图"天然有效，不用逐次重绑。
   *
   * ⚠️ 委托装好了还不够：本函数在页面底部执行，它之前插入的图可能**已经加载完**
   * （缓存命中 / 小图秒开）—— 那时 load 事件早已烧掉，委托收不到。所以要补一遍 complete。
   */
  function markImage(img) {
    if (!img || img.tagName !== 'IMG' || !img.hasAttribute('data-img')) return;
    if (img.classList.contains('is-loaded') || img.classList.contains('is-broken')) return;
    if (img.complete && img.naturalWidth > 0) img.classList.add('is-loaded');
  }

  function installImageHooks() {
    document.addEventListener('load', function (e) {
      if (e.target && e.target.tagName === 'IMG') e.target.classList.add('is-loaded');
    }, true);
    document.addEventListener('error', function (e) {
      var img = e.target;
      if (!img || img.tagName !== 'IMG' || !img.hasAttribute('data-img')) return;
      // 图挂了就把容器自己的扫光留着，再给 img 一个 is-broken（CSS 里 visibility:hidden，
      // 布局不塌，旁边的文字也不会跳位）
      img.classList.add('is-broken');
    }, true);
  }

  /** 新插入一批图之后调用：把其中已经加载完的直接点亮。 */
  function images(container) {
    if (!container) return;
    var list = container.querySelectorAll ? container.querySelectorAll('img[data-img]') : [];
    for (var i = 0; i < list.length; i++) markImage(list[i]);
  }

  /* ---------- 4. 抽屉的滚动锁 ---------- */

  /**
   * 锁住页面滚动，并补上被吃掉的滚动条宽度。
   * 不补的话抽屉一开一关，整页会左右抖一下 —— 在深色底上非常明显。
   */
  function lockScroll(on) {
    var body = document.body;
    if (on) {
      var sbw = window.innerWidth - document.documentElement.clientWidth;
      body.style.setProperty('--sbw', (sbw > 0 ? sbw : 0) + 'px');
      body.classList.add('is-locked');
    } else {
      body.classList.remove('is-locked');
      body.style.removeProperty('--sbw');
    }
  }

  installImageHooks();

  window.DshMotion = {
    stagger: stagger,
    chart: chart,
    images: images,
    lockScroll: lockScroll,
    reduced: reduced,
    /** 与外部（app.js 的换期渲染）对齐的统一入口 */
    animate: function (container, opts) {
      stagger(container, opts);
      images(container);
    }
  };
})();
