/**
 * theme.js —— 主题管理（跟随系统 / 深色 / 浅色 / OLED）
 *
 * 为什么要有这个文件，而不是把几行代码塞进 app.js：
 *   主题是**与数据无关的页面状态**。它必须在 app.js 跑起来之前就能用（首屏
 *   加载失败时用户仍然应该能切换主题），也必须能在将来页面结构变化时独立存活。
 *
 * 三条必须守住的约定：
 *   1. **首帧不闪**：真正的"防闪"发生在 index.html <head> 的内联脚本里
 *      （在 CSS 之前就把 data-theme 定好）。这个文件只负责后续的切换与 UI 同步，
 *      两边读的是同一个 localStorage 键，取值必须一致。
 *   2. **存储不可用不能中断初始化**：无痕模式 / 企业策略 / 阻止所有 Cookie 时
 *      localStorage 会直接抛异常。读写都包一层，失败按"未设置"处理。
 *   3. **只换令牌，不换结构**：这里只写 data-theme，颜色全部由 styles.css 决定。
 *      任何一处往前端代码里写死 #1896DA，浅色主题下就会出现"深色图表贴白纸"。
 */
(function () {
  'use strict';

  var KEY = 'theme';
  var root = document.documentElement;

  /* 主题清单：value 写进 data-theme，label 给按钮与菜单用。
     system 的 value 不是最终的 data-theme —— 它要在应用时解析成 dark / light。 */
  var THEMES = [
    { value: 'system', label: '跟随系统' },
    { value: 'dark', label: '深色' },
    { value: 'light', label: '浅色' },
    { value: 'OLED', label: 'OLED' }
  ];

  /* 与 styles.css 的 --bg、.theme-color-meta 的兜底、head 内联脚本三处一致。
     写得意一把移动端地址栏染成另一种底色，在深色下特别扎眼。 */
  var META_COLOR = { dark: '#0e0f13', light: '#f7f8fa', OLED: '#000000' };

  var lightMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* 存不了就只在本次会话生效 */ }
  }

  function storedTheme() {
    var t = read(KEY);
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].value === t) return t;
    return 'system';   // 未设置 / 值不认识：都按跟随系统
  }

  function resolve(value) {
    if (value !== 'system') return value;
    return lightMq && lightMq.matches ? 'light' : 'dark';
  }

  function labelOf(value) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].value === value) return THEMES[i].label;
    return THEMES[0].label;
  }

  /* ---------- DOM ---------- */
  var btn = null;
  var menu = null;
  var label = null;
  var items = [];

  function apply() {
    var value = storedTheme();
    var resolved = resolve(value);

    root.setAttribute('data-theme', resolved);

    var meta = document.getElementById('theme-color-meta');
    if (meta) meta.setAttribute('content', META_COLOR[resolved] || META_COLOR.dark);

    if (label) label.textContent = labelOf(value);
    if (btn) {
      // aria-label 说清楚"现在是什么、点下去做什么"，而不是只有一句"切换主题"
      btn.setAttribute('aria-label', '主题：' + labelOf(value) + '（打开主题菜单）');
      btn.setAttribute('title', '主题：' + labelOf(value));
    }
    items.forEach(function (item) {
      var on = item.getAttribute('data-theme-value') === value;
      item.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function setTheme(value) {
    write(KEY, value);
    apply();
  }

  /* ---------- 菜单开合 ---------- */
  function openMenu(focusTarget) {
    if (!menu || !btn) return;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    var target = focusTarget || items.filter(function (i) { return i.getAttribute('aria-checked') === 'true'; })[0] || items[0];
    if (target) target.focus();
  }

  function closeMenu(refocus) {
    if (!menu || !btn) return;
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus();
  }

  function isOpen() {
    return !!(menu && !menu.hidden);
  }

  function wireMenu() {
    if (!btn || !menu) return;

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (isOpen()) closeMenu(false);
      else openMenu();
    });

    items.forEach(function (item) {
      item.addEventListener('click', function () {
        setTheme(item.getAttribute('data-theme-value'));
        // 选完立刻收起并把焦点还给按钮：焦点停在一个已经消失的菜单项上是键盘用户的常见陷阱
        closeMenu(true);
      });
    });

    // 点菜单外面关掉。用 document 级委托而不是给 body 挂遮罩：
    // 这个菜单很小，铺一层遮罩反而挡住它想覆盖的内容。
    document.addEventListener('click', function (e) {
      if (!isOpen()) return;
      if (menu.contains(e.target) || btn.contains(e.target)) return;
      closeMenu(false);
    });

    document.addEventListener('keydown', function (e) {
      if (!isOpen()) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu(true);
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;

      // 上下键在菜单项之间循环：菜单打开时焦点就在菜单里，方向键不该带走焦点
      e.preventDefault();
      var index = items.indexOf(document.activeElement);
      var next = e.key === 'ArrowDown' ? index + 1 : index - 1;
      if (next < 0) next = items.length - 1;
      if (next >= items.length) next = 0;
      items[next].focus();
    });

    // 焦点离开菜单（Tab 出去）就收起，避免"看不见但还开着"的状态
    document.addEventListener('focusin', function (e) {
      if (!isOpen()) return;
      if (menu.contains(e.target) || btn.contains(e.target)) return;
      closeMenu(false);
    });
  }

  function init() {
    btn = document.getElementById('themeBtn');
    menu = document.getElementById('themeMenu');
    label = document.getElementById('themeLabel');
    items = menu ? Array.prototype.slice.call(menu.querySelectorAll('[data-theme-value]')) : [];

    apply();
    wireMenu();
  }

  // 系统主题变化：只有"跟随系统"时才需要重算。手动选了深/浅色的用户
  // 不该因为系统到了夜间自动改掉自己的选择。
  if (lightMq && lightMq.addEventListener) {
    lightMq.addEventListener('change', function () {
      if (storedTheme() === 'system') apply();
    });
  }

  // 控制台 / 验收探针的入口：setTheme('light' | 'dark' | 'OLED' | 'system')
  window.setTheme = setTheme;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
