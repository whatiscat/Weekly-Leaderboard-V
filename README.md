# 术力口周榜 · 数据服务

> 🤖 **AI 生成声明**
>
> 本项目的**代码、界面与数据整理均由 AI 生成**（模型：**DeepSeek-V4.1-Flash**），作者 **whatiscat**。
> 数据版权归 Bili-Board_Atel 制作组与 Biliboard 所有，本项目为非官方的个人整理。

一个 Node.js 服务：把 B 站「术力口周榜」整理成结构化数据，通过 HTTP API 提供给前端看板。
**不是静态页面生成器**——数据在服务端编译、按请求下发，前端只负责渲染。

```
data/boards/*.json  ──┐
data/raw/*.json     ──┼─→  Repository（编译期派生） ─→ HTTP API ─→ src/web（SPA）
data/covers.json    ──┘                            ↘  /api/csv, /img/:bvid
```

## 它是什么，不是什么

| 是 | 不是 |
|---|---|
| 一个只在本机跑的小服务（默认 `127.0.0.1:5173`） | 部署到公网的站点：没有账号、没有评论、没有 SEO |
| 数据服务 + 一块看板 | 通用 BI 工具：只服务「术力口周榜」这一种数据形状 |
| 零第三方依赖（Node ≥ 20.6 内置模块就够） | 一个有构建步骤的前端工程：没有打包器、没有框架 |
| 版本化的官方数据快照（`data/` 入库） | 实时爬虫：抓取失败不影响已有数据出图 |

设计上只守三条：**派生逻辑只在服务端算一次**（前端拿到的行已经带好涨跌/在榜/变体）、
**前端只读不推**（所有状态都能从 API 重建）、**动效只在数据变化时出现**。

## 功能特性

### 数据

- **曲目身份以 Biliboard 的 `song.id` 为准**：译名变化、换投稿稿件都不会把一首歌拆成两条；
  每期仍保留当周实际使用的 BV，抽屉里能看到「同一首歌用过哪些稿件」。
- **帖子配对按发布日期对齐官方期次**，不信标题里的期号（原帖有笔误，见「已知数据问题」）。
- **派生数据全部在服务端**：涨跌（`prev / delta / state`）、在榜期数、历史最高、
  冠军连段、变体数、近 30 期走势、看点（新上榜 / 上升最快 / 跌出榜单）、侧栏（上周冠军 / 在榜最久）。
- **对齐校验**：官方库与文字版帖子逐名次比对，稿件不一致的条目记进 `alignment`，页脚如实给出核对结果。
- **同步完整性闸门**：期次/曲目条数缩水、结构不合法、曲目库落后于榜单，任一条不过就**抛错且不写盘**，
  旧数据原样保留（细节见「[爬虫与数据整理](#爬虫与数据整理)」）。
- **数据质量可查**：满员期数、缺名次、名次不连续、原帖覆盖、同步一致性告警，同时出现在
  `/api/meta`、页脚、`report`、`doctor`、`status`。
- **离线重解析**：`data/raw` 保存原文 payload，解析规则改了用 `reparse` 重算，不必重抓。
- **限流与退避**：请求全局最小间隔 + 指数退避；命中 `-352/-412/-509` 自动刷新 WBI 密钥再重试。

### 看板

- **四档主题**：跟随系统 / 深色 / 浅色 / OLED。首帧由 `<head>` 里的内联脚本定好 `data-theme`，
  不闪屏；颜色全部走 CSS 令牌，图表（线 / 点 / 网格）也读令牌，切主题不需要重绘数据。
- **换期入场**：换一期（或换一首歌）时，新内容按顺序错开入场；**筛选框输入不重播**
  （每敲一个字整张表都抖一下是噪音，不是动效）。
- **走势图描线**：换歌时路径描一次线、圆点依次落位；图形本身是服务端算好坐标的原生 SVG。
- **封面淡入**：图片从占位扫光淡入，失败则保留占位，不出现「先黑框、后闪出图」。
- **可访问**：榜单行 / 冠军卡 / 歌曲按钮都能用键盘走到，`Enter` / `空格` 打开抽屉；
  抽屉是 `role="dialog"`，打开时锁滚动并把焦点交还来处；`:focus-visible` 统一焦点环。
- **降级**：禁用 JavaScript 时页面给出说明和「全量 CSV」入口，而不是一片空白。

### 运维

- 命令行：`serve / update / sync / crawl / reparse / report / status / doctor / schedule`。
- **配置写错拒绝启动**：端口、限流间隔、退避上下限、定时星期等都会校验（见「配置说明」）。
- `doctor` 自检：本地数据是否齐全、Biliboard / B 站接口 / 图片 CDN 是否可达。
- 定时更新：Windows 计划任务（每周三 19:30）或常驻进程 `node src/cli.js schedule`。
- 便携包：`npm run package` → `dist/术力口周榜-便携版.zip`，解压双击「启动.cmd」即用。

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js ≥ 20.6（ESM） |
| HTTP 服务 | `node:http` + 自写极简路由（GET/POST + `:param`） |
| 数据 | 本地 JSON（官方曲目库 / 期次 / 帖子原文 / 封面直链） |
| 前端 | 原生 JS + 原生 SVG 图表 + 一份手写 CSS（无框架、无构建） |
| 网络 | 内置 `fetch`、WBI 签名、指数退避 |
| 依赖 | **零第三方依赖** |

## 快速开始

```bash
npm start                 # 启动服务并打开浏览器（默认 http://127.0.0.1:5173）
node src/cli.js serve     # 同上，不自动开浏览器
node src/cli.js update    # 同步官方库 + 增量抓帖
node src/cli.js report    # 终端打印数据摘要（含数据质量）
npm test                  # 34 个用例（模型派生 / 解析 / 同步闸门 / 重解析 / WBI 签名 / 配置校验）
npm run check             # 语法自检：41 个脚本与 JSON
```

首次使用（仓库里已带数据，可跳过）：

```bash
node src/cli.js sync --full   # 拉官方期次 + 曲目库 + 封面直链（约 2 分钟）
node src/cli.js crawl         # 增量抓 B 站文字版帖子
```

> 端口被占用会自动顺延到 5174、5175……；实际地址以终端输出为准。

## 命令

| 命令 | 说明 |
|---|---|
| `serve [--port n] [--open] [--verbose]` | 启动 HTTP 服务（默认命令） |
| `update [--force] [--limit n] [--no-sync] [--no-crawl]` | 同步 + 抓帖 + 打印摘要（定时任务跑这个） |
| `sync [--full]` | 只同步 Biliboard 期次与曲目库 |
| `crawl [--deep] [--force] [--limit n]` | 只抓 B 站帖子 |
| `reparse [--write] [--limit n]` | 用当前解析器重算 `data/raw` 里的原文（默认只报告，不写盘） |
| `report` / `status` / `doctor` | 数据摘要（含质量）/ 运行状态 / 体检 |
| `schedule [--once]` | 按 `config.schedule` 常驻定时执行 `update` |

## 配置说明

默认值在 **`config/default.json`**；本机私货放 **`config/local.json`**（已被 `.gitignore` 排除，
从 `config/local.example.json` 复制），只写要改的键即可——两层是**逐键深合并**。

| 键 | 说明 |
|---|---|
| `account.mid` / `name` / `spaceUrl` | 榜单发布者。`spaceUrl` 必须带 `http(s)://` |
| `site.title` / `brand` / `csvName` | 站点标题、徽标文字、CSV 文件名（写进 `/api/meta`） |
| `paths.raw` / `data` / `logs` / `state` | 相对路径按仓库根解析；默认即 `data/raw`、`data`、`logs`、`data/state.json` |
| `http.minIntervalMs` | 两次 B 站请求的最小间隔（毫秒）。**填 0 = 不限速**，风控自负 |
| `http.maxRetries` | 单请求最大重试次数（0~12） |
| `http.backoffBaseMs` / `backoffMaxMs` | 指数退避的起点与上限；必须 `max ≥ base` |
| `http.timeoutMs` | 单请求超时（≥ 1000ms） |
| `crawl.maxPages` / `pageSize` / `timeBudgetMs` | 抓帖翻页上限、每页条数、整轮时间预算 |
| `schedule.weekday` / `hour` / `minute` | 常驻定时与「下一次更新」提示；星期 0=周日 |
| `server.port` / `host` | 监听端口（1~65535）与地址 |
| `bili.cookie` | 可选。填浏览器的 `SESSDATA`/`buvid3` 可显著降低风控概率 |

**写错就拒绝启动，不静默回落。** 静默回落真正的代价不是"少个功能"，而是"看着配了、实际永远不生效"：
把 `http.minIntervalMs` 写成负数，限速就没了、风控概率上升，而进程照常启动、日志里一个字都不会提。
所以 `src/config.js` 对每个数值都校验范围，报错会带键名与当前值，例如：

```
配置错误：http.backoffMaxMs 不能小于 http.backoffBaseMs（100 < 4000）
配置错误：schedule.weekday 不能大于 6（当前 7）
```

> **定时更新其实有两套，时间是分开的**：`config.schedule` 只作用于常驻进程
> `node src/cli.js schedule`（以及页面上的"下一次更新"提示）；Windows 计划任务的时间在
> `scripts/register-task.ps1` 的参数里（默认周三 19:30）。改时间要两边一起改，否则
> 「终端说周二、任务实际在周三跑」。
>
> `bili.cookie` 走 `config/local.json`，不会进仓库；打便携包时也**只复制 default.json 与
> local.example.json**，避免把本机 Cookie 打进 zip（`scripts/package.mjs` 里有注释）。

## 目录结构

```
.
├─ src/
│  ├─ cli.js                命令行入口
│  ├─ config.js             配置载入 + 取值校验（fail-fast）
│  ├─ run.js                同步 / 抓帖 / 更新的编排（含单实例锁）
│  ├─ logger.js  doctor.js  日志 / 体检
│  ├─ server/               app（请求管线）· router · respond · repository
│  │  └─ routes/            api.js · static.js
│  ├─ web/                  前端（无构建）
│  │  ├─ index.html         壳页面：主题引导脚本、顶栏、区块骨架
│  │  ├─ app.js             状态 + 取数 + 渲染 + 事件
│  │  ├─ theme.js           四档主题（与数据无关）
│  │  ├─ motion.js          入场交错 / 图表描线 / 封面淡入 / 滚动锁
│  │  ├─ styles.css         设计令牌 + 四档配色 + 动效
│  │  └─ favicon.svg        6×6 像素徽标（与顶栏 logo 同源）
│  ├─ model/                领域模型：数据集构建、质量摘要、统计
│  ├─ biliboard/            官方公开数据同步 · validate.js（同步闸门）· covers.js
│  ├─ bili/                 B 站接口（WBI 签名、限流重试）
│  ├─ crawler/              帖子抓取（三级降级）· parse.js · reparse.js · 原文存储
│  └─ util/                 文件 / 文本小工具
├─ data/                    数据（入库）：boards/ · raw/ · covers.json
├─ config/                  default.json · local.example.json
├─ scripts/                 check.mjs · package.mjs · serve-bg.ps1 · register-task.ps1
├─ packaging/               便携包里的启动器与说明
├─ test/                    node:test 用例
├─ devtools/                开发工具与产出物（运行不需要，见 devtools/README.md）
└─ dist/                    便携包产物（不入库）
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 存活、期数、条目数、版本、uptime |
| GET | `/api/meta` | 账号、数据范围、统计、对齐信息、**数据质量**、数据版本 |
| GET | `/api/issues` | 期次列表（含冠军与帖子链接） |
| GET | `/api/issues/:issue` | 某期完整数据：20 行 + 涨跌/在榜/变体 + 看点 + 侧栏 |
| GET | `/api/champions?limit=24` | 冠军段（连续夺冠合并） |
| GET | `/api/songs?q=&limit=` | 曲目索引，可按歌名/原名搜索 |
| GET | `/api/songs/:id` | 单曲详情：逐期名次、稿件变体 |
| GET | `/api/legend?limit=8` | 传说曲周榜附榜 |
| GET | `/api/csv` | 全量 CSV（带 BOM，Excel 直接打开） |
| GET | `/img/:bvid?w=320` | 封面：302 到 B 站直链，按需缩放 |
| POST | `/api/reload` | 重新读取磁盘数据（改完数据不用重启） |

派生逻辑全部在服务端：前端拿到的 `rows[]` 已经带 `prev / delta / state / weeks / best / variants / spark`，不再自己算。

## 爬虫与数据整理

这一节是数据规则的**权威版本**。改抓取、解析、对齐逻辑之前先读它。

### 1. 三层数据，只有一层是权威

| 层 | 文件 | 地位 | 丢了会怎样 |
|---|---|---|---|
| 官方曲目库 | `data/boards/songs.json`、`issues-1/2.json` | **权威**：曲目身份、名次、稿件、期次 | 看板没数据 |
| 帖子原文 | `data/raw/<opus_id>.json`（含 `payload`） | **旁证**：核对 BV 与期号、提供「文字版原帖」入口 | 少一个外链，不影响榜单 |
| 派生数据 | 内存（Repository） | 每次启动重算 | 重启即恢复 |

名次**只**来自官方库。文字版帖子永远不会覆盖官方数据：两边不一致时记进 `alignment`，
页脚写明「已核对 X 期 / Y 个名次，其中 N 处官方替换了稿件」，不自动「修正」。
—— 官方有时候确实会把某些曲子换成自家稿件，把这种正常差异当错误改掉才是错的。

### 2. 曲目身份：`song.id`

- 唯一键是 Biliboard 的 `song.id`；译名变化、换投稿稿件都不会拆成两首。
- 每期保留当周实际使用的 BV（`history[].bvid`），同一首歌用过几个稿件，抽屉里就列几个。
- 上游曲目库还带 `board 3`（年榜，名次到 100）。本项目只展示周榜(1)与传说曲周榜(2)，
  年榜行**保留但不展示** —— 以后加年榜视图时不用重新抓一遍。
  完整性校验按榜单区分名次上限：一刀切 1–20 会把 200 条年榜行判成脏数据（实测踩过）。

### 3. 帖子配对：按日期，不按期号

原帖标题有笔误（把第 65 期写成第 25 期），所以：

- 用**发布日期**对齐官方期次：优先同一天，否则取 ±4 天内最近的一条；
- 期号只用于去重（同一期重复发帖）与显示；
- 配对偏差记在 `postDateDiff`，>1 天计入 `alignment.looseMatches`。
  本项目 72 条配对全部同日（`maxPostDiffDays = 0`），这条指标是给未来漂移兜底的。

### 4. 抓取：三级降级 + 缺名标记

单期帖子的降级顺序是 **opus 段落 → 专栏接口 → 专栏 SSR 页**，任一能解析出条目即成功，
同时保留原文 `payload` 供离线重解析。

判定「成功」的标准不是「没报错」，而是「解析出了条目」，并且：

- 缺名次（不足官方声明的 `video_count`）标记 `complete: false` 与 `missing: [...]`，
  抓取汇总单独计数，日志写明「缺第几、第几」；
- 不补、不猜、不从帖子往官方数据里凑行 —— 缺一行就是缺一行；
- 失败记录进 `data/failures.json`，同一帖连续失败 3 次后跳过（`--force` 可重试）。

### 5. 同步的完整性闸门

`sync` 是覆盖写，所以写盘前先过闸门（`src/biliboard/validate.js`）：

| 闸门 | 防的是什么 |
|---|---|
| 期次非空 / 无重复期号 / 不缺 `issue_id` | 接口维护返回空数组 → 覆盖掉 123 期 |
| 期次条数不少于已有 | 分页提前结束 → 只写回一半期次 |
| 曲目条数不少于已有 | 合并逻辑只会增，变少说明基线坏了或全量中断 |
| 结构合法（id / issueId / 名次按榜单设上限） | 上游改字段名 → 静默写出半张表 |
| 曲目库最高期号 ≥ 榜单最新期号 − 1 | 增量翻页按「连续 3 页无新增」停；排序一变就静默漏新歌 |

任何一条不过：**抛错、不写盘**，磁盘上的旧数据原样保留。这是刻意的取舍——
同步失败是可见的，数据静默变少是不可见的。

一致性偏差（孤儿行、重复名次、曲目库落后）只记警告，写进 `data/boards/meta.json` 的
`quality`，不拦同步：上游补数据/删数据是常态，硬拦会让日常同步直接不可用。

### 6. 离线重解析

`data/raw` 存了原文，解析规则改了不必重抓：

```
node src/cli.js reparse            # 试运行：只报告差异，什么都不写
node src/cli.js reparse --write    # 确认后写回 data/raw
```

逐期比对曲名 / 链接 / 封面，输出差异统计与有差异的期号。**5 期早期记录没有 `payload`**
（迁移数据），必须 `crawl --force` 重抓才能纳入重解析。

> 改了 `src/crawler/parse.js` 的标准动作：`npm test` → `reparse` 看差异 →
> 确认后 `reparse --write` → 页面点「刷新」。

### 7. 数据质量出现在哪

`quality` 是一份「数据自己说自己」的摘要，四处一致：

| 位置 | 内容 |
|---|---|
| `GET /api/meta` 的 `quality` | 满员期数、缺名数、名次不连续期数、条目数、原帖覆盖 |
| 页面页脚 | 满员 X/Y 期、有文字版原帖 X/Y 期 |
| `node src/cli.js report` | 同上，终端一行 |
| `doctor` / `status` | 完整性、同步一致性告警、封面与失败记录数 |

「缺名」当数据的一部分来展示，而不是藏起来：第 63、73 期官方就是 19 首（页面上 19 行、
名次不连续），`numberingGaps` 记一笔，但不算成缺歌。
—— 期望条数以官方 `video_count` 为准；写死 20 会让这两期永远显示成「缺一名」。

### 8. 限流与礼貌

- Biliboard：请求间隔 350ms，失败指数退避（1s 起）；整轮同步预算 5 分钟，超时中止（避免定时任务叠跑）。
- 封面直链解析失败的稿件记进 `data/covers-failures.json`，**7 天内不再重试**：
  被删稿件的图片接口永远 404，每轮都撞一遍既慢（12 个超时能拖掉 40 秒）又不礼貌。
- B 站：全局最小间隔 `http.minIntervalMs`（默认 1200ms），指数退避 + 抖动；
  命中 `-352/-412/-509` 自动刷新 WBI 密钥后重试；`crawl.timeBudgetMs`（默认 120s）
  到点收工，剩余留待下次，不会硬拖到风控。
- 抓帖失败不影响看板：正文榜单来自官方库，帖子只是旁证。
- 单实例：`data/.lock` 记录 pid，同一时间只允许一个更新任务（进程已死且锁超过 2 小时会接管）。

更新后服务端不会自动重载：页面点「刷新」（内部调 `POST /api/reload`），或重启服务。

## 前端设计规范

视觉与动效沿用 [newBlog](https://github.com/whatiscat) 的「素净 · 精密」，但**按数据看板的实际需要裁剪过**。
这一节是规范本身，改样式 / 改动效前请先读完——尤其是「明确不做」那一节。

### 视觉令牌

- 中性色阶 `--bg / --surface / --surface-2 / --surface-3 / --line / --line-2`，文字 `--text / --muted / --faint`，
  一个强调色 `--accent`（深色 `#1896DA`、浅色 `#0d6efd`——后者在白底上对比度才够）。
- 圆角 `6 / 9 / 12 / 16 / 20`，控件高度 `30 / 38 / 46`；嵌套时用 `calc` 保持同心。
- 动效令牌：4 条曲线（`--e-out / --e-soft / --e-spring / --e-in-out`）+ 5 档时长（`--d-1 … --d-5`）。
- **不给 `box-shadow` 做动画**：抽屉与主按钮的阴影都是静态的。阴影每帧重绘，代价与收益不成比例；
  需要"阴影浮现"就该用绝对定位的 `::after` 先画好、只动 `opacity`（本项目的卡片没有悬停阴影，所以没用到）。

### 四档主题

| 值 | 场景 |
|---|---|
| `system`（默认） | 跟随系统深浅 |
| `dark` / `light` | 手动锁定 |
| `OLED` | 纯黑底，手机上省电 |

三处必须同步，改一处就要三处一起改：
1. `src/web/styles.css` 的 `:root[data-theme="…"]` 令牌组
2. `src/web/index.html` `<head>` 内联脚本里的 `COLOR` 映射（首帧防闪）
3. `src/web/theme.js` 的 `THEME` 清单与 `META_COLOR`（移动端地址栏配色）

调试与验收可以直接在控制台调用 `setTheme('system' | 'dark' | 'light' | 'OLED')`
（`devtools/tools/probe-ui.cjs` 就是这么切主题测颜色的）。

主题切换只写 `data-theme`，不重绘任何数据：图表颜色读的是 CSS 类（`.trend-line` 等）而不是 SVG 属性，
所以浅色主题下这条线会自动变成 `#0d6efd`。**任何一处把十六进制写进 JS/模板，都会在下次切主题时暴露。**

### 动效

只做三件 CSS 做不到、又确实服务读数的事：

| 动效 | 时机 | 参数 |
|---|---|---|
| 换期入场 | 换一期（榜单 / 看点 / 冠军） | `rise-in` 420ms + `--i × 26ms`，最多错开 320ms |
| 走势图描线 | 选中一首歌 | 路径 620ms 描线，圆点 14ms 递增落位 |
| 封面淡入 | 图片加载完成 | 280ms 透明度过渡 |

其余全部交给 CSS：悬停换底、按压回弹（按下 96%，松手由 `--e-spring` 弹回）、抽屉滑入、提示条。
换一首歌**不**重播榜单入场（只有选中的曲子换了，榜单没变），只播走势图那一下。

**明确不做**（在数据表上只会变成噪音，或本项目根本不需要）：

- 阅读进度条（这不是长文）、按钮文字磁吸、页眉随滚动收放；
- 软导航 / 全屏加载遮罩 / 主题切换幕布 / 首访主题提示卡——本来就是单页应用，
  再加一层"导航动画"只是让用户多等一次；
- 大范围滚动入场：面板上每个区块都"飘"进来会让人看不清自己在哪一屏；
- 筛选框输入时重播入场：每敲一个字整张表抖一遍，属于反效果。

**减少动效**：`prefers-reduced-motion: reduce` 时全局把时长压到 `.01ms`、`animation-delay` 归零，
描线动画不启动、骨架扫光停止。注意减的是"动画"，不是"信息"——内容照常显示。

### 可访问性与降级

- 可点击的 `.row` / `.champ-item` 带 `role="button"` 与 `tabindex="0"`，`Enter` / `空格` 触发；
  `activateIn()` 把这些键处理收敛到一处，不给每行单独绑。
- 抽屉：`role="dialog"` + `aria-modal`，打开时把焦点交给关闭按钮、关闭时还回触发它的那一行；
  锁滚动用 `--sbw` 补滚动条宽度，避免开合时整页左右抖。
- 所有图标按钮有 `aria-label`，主题菜单是 `role="menu"` + `menuitemradio`，方向键可走。
- 禁用 JavaScript 时 `<noscript>` 给出 CSV 与 API 的出口。

### 前端代码分工

| 文件 | 只做这件事 |
|---|---|
| `app.js` | 状态、取数、拼字符串、事件委托 |
| `theme.js` | 主题（与数据无关，首屏失败也照样能切） |
| `motion.js` | 入场序号 / 图表描线 / 封面淡入 / 滚动锁 |
| `styles.css` | 令牌、配色、布局、动效（`--i`、`is-static` 在这里生效） |

两条约定：

1. **事件委托到稳定容器**（`#rows` / `#champs` / `#songItems` / `#drawerBody`）。
   以前每次重绘都重新 `querySelectorAll` 再逐个绑，换一期就多 20 个监听；委托只绑一次。
2. **图表不写死颜色**，只给 class；主题令牌负责颜色。这是"切主题时图表还看得见"的唯一保证。

## 测试与自检

```bash
npm test          # 34 个用例（见下表）
npm run check     # 语法自检：41 个脚本 + JSON（零依赖，不需要 ESLint）
npm run doctor    # 数据完整性 + 同步一致性告警 + 网络可达性
```

| 用例文件 | 覆盖什么 |
|---|---|
| `test/model.test.js` | 数据集构建、曲目归并、对齐报告、冠军段、统计 |
| `test/parse.test.js` | 标题解析、榜单帖判定、opus/专栏/SSR 三种解析、缺名计算 |
| `test/validate.test.js` | **同步闸门**：空/缩水/重复/结构错误拦写，孤儿行与落后期次只报警告 |
| `test/reparse.test.js` | 离线重解析：三种 payload、差异比对、默认不落盘、写回后补 `missing` |
| `test/fsx.test.js` | JSON 读写：坏文件带路径报错、原子写、不留 `.tmp` |
| `test/covers.test.js` | 封面失败冷却：7 天内不重试、过期自动恢复 |
| `test/wbi.test.js` | WBI 签名与混淆表 |
| `test/config.test.js` | 配置校验（fail-fast） |

前端没有单元测试，改动视觉 / 动效时的验收方式是**真浏览器**（headless Edge + CDP）：

```bash
node src/cli.js serve --port 5199          # 另起一个端口，别动正在用的实例
node devtools/tools/probe-ui.cjs --port 5199
```

15 项断言：入场延迟是否按 `--i` 递增、描线是否真的在途中（`stroke-dashoffset` 介于 0 与 1）、
浅色主题下图表颜色是否跟着变、390px 下有没有横向溢出、Esc 关闭抽屉后焦点是否回到原行、
减少动效时动画是否被压到近乎瞬时、控制台有没有报错。全过才提交。

## 后台运行 / 定时更新 / 便携包

```powershell
powershell -ExecutionPolicy Bypass -File scripts\serve-bg.ps1          # 脱离终端启动
powershell -ExecutionPolicy Bypass -File scripts\serve-bg.ps1 -Status
powershell -ExecutionPolicy Bypass -File scripts\serve-bg.ps1 -Stop

powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1          # 每周三 19:30
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Remove
```

```bash
npm run package   # → dist/术力口周榜-便携版.zip
```

解压后双击「启动.cmd」：检查 Node → 起服务 → 开浏览器；首次运行询问是否添加每周三自动更新。

已发布版本：[Releases](https://github.com/whatiscat/Weekly-Leaderboard-V/releases)

## devtools/

开发相关的东西（推广文案、一次性迁移脚本、临时探针、截图、备份）都收在 `devtools/`，
**运行不需要它**。`devtools/tmp/`、`devtools/backups/` 已被 `.gitignore` 排除。
目录约定与验证手法见 [devtools/README.md](devtools/README.md)。

## 已知数据问题

这些都是**上游数据本身的样子**，不是本项目能修的；页面与 `doctor` 会如实写出来，而不是假装没有。

- 官方曲目库自第 2 期起；第 2–52 期没有对应的 B 站帖子，页面不显示「文字版原帖」（72/123 期有原帖）。
- 原帖期号偶有笔误（如把第 65 期写成第 25 期），按发布日期配对规避；配对偏差记在 `postDateDiff`。
- 少数曲目官方统一替换为本家稿件，与文字版帖子的 BV 不一致：1434 个核对名次里有 69 处，页脚写明。
- 第 63、73 期官方就是 19 首（名次不连续），页面显示 19 行，`numberingGaps` 记一笔、不算缺歌。
- 曲目库还带年榜（board 3）的行，本项目不展示；保留原始数据是为了以后加视图时不用重抓。
- 5 期早期记录（迁移数据）没有原文 `payload`，无法离线重解析；要纳入得 `crawl --force` 重抓。
- 传说曲周榜与主榜期号独立，单独列在页面附录。
- 封面来自 B 站图床（`i0.hdslb.com`），网络不通时列表里是占位扫光，不影响名次与走势。

## 免责

数据版权归 Bili-Board_Atel 制作组与 Biliboard 所有，本项目仅做个人学习用途的整理与展示；
抓取已限流，请勿高频请求。名次不完全等同于歌曲质量，请理性看待。
