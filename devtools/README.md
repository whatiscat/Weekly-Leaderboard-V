# 开发工具与产出物（devtools/）

**这个目录里的东西，运行时不参与**。删掉它，`npm start` 照样能跑。
反过来讲：**任何运行时需要的文件都不许放进这里**——包括配置、数据、脚本依赖。

## 目录约定

| 路径 | 放什么 | 入库 |
|---|---|---|
| `docs/` | 开发笔记、推广文案、设计决策记录 | ✅ 入库 |
| `tools/` | 一次性脚本（迁移、修复）与可复用的验收探针 | ✅ 入库 |
| `tmp/` | 探针脚本、截图、临时输出 | ❌ 忽略 |
| `backups/` | 数据备份、旧版本快照 | ❌ 忽略 |

`.gitignore` 里对应的是 `devtools/tmp/` 与 `devtools/backups/`；
`docs/` 和 `tools/` 保留入库，因为它们是"为什么这么做"的记录，删了下次还得重新想一遍。

放置原则：

- 能脚本化的检查**优先写成脚本**（可重复），而不是截个图贴上；
- 一次性脚本用完可以留着，但要在文件头写清楚**跑一次就够**、以及它读什么写什么；
- 截图放 `tmp/`，别塞进 README——README 只放结论和数字。

## tools/

### `migrate-legacy.mjs`

把上一版 `_tools/` 目录下的抓取缓存迁移成 `data/raw/<id>.json`（含 opus / 专栏接口 / SSR 三路回退）。

```bash
node devtools/tools/migrate-legacy.mjs
```

只跑一次。迁移完可以把 `_tools/` 删掉；脚本留在仓库里是为了"当时是怎么迁的"有据可查。
它 import 的是 `../../src/`，所以必须从仓库根执行，不要复制到别处。

### `probe-extra.cjs`

两条"多榜"入口的验收探针：标题下拉（周榜 / 传说榜 / 年榜）与顶栏的 ニコニコ 榜。
开下拉、换榜、换期次、点行开抽屉，逐项断言：

```bash
node devtools/tools/probe-extra.cjs --port 5199
```

它盯的是那种"看起来正常、其实全错"的问题——传说榜/年榜的涨跌与在榜期数如果借用周榜的索引，
数字依旧像一个合理的名次，只有对着断言才发现算错了。所以这几条是硬断言：

- 切榜之后**标题、副标题、冠军卡、冠军段、页码范围**必须一起换（只换标题不换数据比不换更糟）；
- 年榜第 3 期正好 100 行；传说榜第 1 期的"上一期"按钮是 disabled；
- 抽屉里必须写「该期名次」且标题带榜名，不是周榜口径；
- 抽屉里不许出现 `undefined` / `NaN`（漏一个 `BOARD_LABEL` 就会漏出来）。

ニコニコ 那条榜先是**另一次页面级切换**（顶栏 B 榜 ⇄ N 榜），再才是表格本身。
它另有一组断言，因为它的身份空间与主榜**完全不同**（曲目 id 是曲名）：

- 顶栏两个切榜按钮都在；点 N 之后 B 榜的区块（hero / 本期榜单 / 看点 / 冠军 / 走势）必须**整套收起**，
  标题与页脚也要换成这条榜的口径；
- 区块标题、来源 UP 主链接（space.bilibili.com/12446725）必须出现；
- 副标题必须带「统计 2026/10/12–2026/10/18」这种时段 —— 那是正文里的官方口径；
- 行上必须有封面直链与 BV 号（BV 由 aid 本地换算，算错了链接就是空的）；
- 换期后行数与副标题要跟着变，而且可选期次要**过百**（说明历史回填成功）；
- 抽屉必须按「ニコニコ TOP20」口径显示，并给出「本期文字版」入口；
- 冠军卡必须存在且**字号够大**（`>= 22px`）、五个 KPI、两条侧栏 —— 只判断"有个 h2"会放过
  一个被样式压成小字的标题；
- 看点 / 冠军榜 / 走势三块必须有内容，且走势点一首歌要真能画出折线、横轴刻度是这条榜的期号
  （借用周榜的期次索引会让 N 榜第 124 期和 B 榜第 124 期落在同一个横坐标上）。

## 验证方法论：真浏览器，不靠肉眼

前端（主题 / 动效 / 移动端）没有单元测试，改完靠**headless Edge + CDP** 量出来。
探针是可复用的，别每次重写：

```bash
# 1) 起一个临时端口的服务，别动正在用的那个
node src/cli.js serve --port 5199

# 2) 跑探针（自己起无头浏览器、截图、打印 JSON，失败时退出码 1）
node devtools/tools/probe-ui.cjs --port 5199      # 主榜 / 主题 / 动效 / 移动端
node devtools/tools/probe-extra.cjs --port 5199   # 标题下拉（传说榜 / 年榜）+ ニコニコ 榜
```

截图落在 `devtools/tmp/`。探针里值得抄的几件事：

- **`--headless=new` 的 Edge 默认是 `prefers-reduced-motion: reduce`**，不显式模拟
  `no-preference` 就永远测不到入场/描线。第一条要检查的就是
  `matchMedia('(prefers-reduced-motion: reduce)').matches`。
- **量"是不是真的在动"**，不要只看最终样子：
  `getComputedStyle(line).strokeDashoffset` 在动画中应介于 0 与 1 之间；
  `getComputedStyle(row).animationDelay` 应按 `--i` 递增（0 / 0.026s / 0.052s…）。
- **量溢出**：`document.documentElement.scrollWidth - clientWidth`，390px 下必须是 0。
- **收集报错**：`Runtime.consoleAPICalled` + `Runtime.exceptionThrown` + `Log.entryAdded`，
  白名单式地只打印 error/warning。
- **截图按主题分组**：深色 / 浅色 / OLED / 移动端各一张，看图时先看对比度与换行。

## 改完之后的自检顺序

```bash
npm run check     # 语法 + JSON
npm test          # 47 个用例
npm run doctor    # 数据完整性 + 网络
```

然后跑一次浏览器探针。三者都过，再提交。

## 数据侧的改动流程

改 `src/crawler/parse.js`、`src/model/build.js`、`src/biliboard/*` 之后，
除单元测试外还要过一遍真实数据（这些脚本都不会联网，除非写明）：

```bash
node src/cli.js report            # 期数 / 条目 / 数据质量一行行看
node src/cli.js reparse           # 解析规则变了？先试运行看差异，别直接写
node src/cli.js reparse --write   # 确认无误再落盘（之后页面点「刷新」）
node src/cli.js doctor            # 完整性 + 一致性告警 + 网络
```

**同步闸门不是可选项**：`sync` 拦下写入时会打印具体哪一条不过。
不要为了"先跑通"去放宽 `validate.js` 里的阈值 —— 先弄清是上游真的变了，还是自己写错了。

## 一条经验

**"配置了但没生效"是这类项目最常见的坑**（限流写成负数、主题色写在 JS 里、媒体查询与令牌不同步）。
所以此项目的约定是：要么校验后拒绝启动，要么在页面上如实写出来（例如页脚的对齐结果、
`doctor` 的 ✓/✗），不要静默吞掉。
