# 术力口周榜 · 周榜跟踪

> 🤖 **AI 生成声明**
>
> 本项目的**代码、界面与数据整理均由 AI 生成**（模型：**DeepSeek-V4.1-Flash**），作者 **whatiscat**。
> 数据版权归 Bili-Board_Atel 制作组与 Biliboard 所有，本项目为非官方的个人整理。

> 数据：第 2–124 期 · 123 期 · 2458 条 · 631 首曲目　|　产出：单文件看板 + 全量 CSV + 便携包

抓取 B 站 UP 主 **Bili-Board_Atel**（[3546800279522160](https://space.bilibili.com/3546800279522160)）发布的「术力口周榜」，整理成可交互的数据看板与全量 CSV，并按周自动更新。

- 数据：第 2–124 期，共 123 期 / 2458 条 / 631 首曲目（2024-06-19 ~ 2026-10-21）
- 产出：`public/index.html`（单文件看板，离线可开）、`public/术力口周榜-全量数据.csv`、`public/data.json`
- 依赖：**零第三方依赖**，只用 Node.js 内置模块（Node ≥ 20.6）

## 曲目对齐方式

看板不按「歌名」也不按「BV 号」认曲目，而是用 **Biliboard 公开曲目库的 song.id** 作为身份：

- 同一首歌的不同译名（《向修女忏悔吧》/《シスターに懺悔を》）→ 同一个 id，不会拆成两首
- 同一首歌的不同稿件（不同 BV）→ 同一个 id，每期保留当周实际使用的 BV，详情页可逐个预览
- 同名不同曲（两首都叫《nan》）→ 不同 id，不会被误合并

对齐校验：用**发布日期**把每期「文字版帖子」与官方期次配对（标题里的期号有笔误），逐名次比较 BV，差异数量写在页脚。

## 便携版（双击即用）

```
npm run package        # 或 node scripts/package.mjs
```

产物：`dist/术力口周榜-便携版.zip`（约 1MB，解压后 10MB）。

解压后双击 `启动.cmd`：

1. 检查 Node.js（≥20，没有会提示下载地址）
2. 缺看板时自动生成
3. **首次运行询问是否添加每周三 19:30 的自动更新计划任务**（Y/N），选择写进 `.installed`，之后不再问
4. 启动本地服务并自动打开浏览器，关掉窗口即停止

另外 `更新数据.cmd` 可手动同步最新一期。包内 `说明.txt` 是给使用者的说明，`README.md`（本文件）是开发文档。

## 快速开始

```bash
node src/cli.js status          # 抓取与构建状态
node src/cli.js build           # 用本地数据重新生成看板（不联网）
node src/cli.js serve           # 本地预览 http://127.0.0.1:5173/
node src/cli.js update          # 同步曲目库 + 增量抓帖 + 重新生成（每周跑这个）
node src/cli.js sync            # 只同步官方曲目库（增量）
node src/cli.js sync --full     # 全量同步曲目库（首次 / 补漏，约 2 分钟）
node src/cli.js crawl --deep    # 完整翻页补抓遗漏的帖子
node src/cli.js doctor          # 自检：数据、网络、产物         
node src/cli.js report          # 终端打印数据摘要
node --test                     # 单元测试
```

也可以走 npm 脚本：`npm run build` / `npm run update` / `npm start` / `npm test`。

## 目录结构

```
.
├─ config/
│  └─ default.json           # 账号、限流、路径、定时策略
├─ src/
│  ├─ cli.js                 # 命令行入口（update / sync / crawl / build / serve / schedule / report / status）
│  ├─ run.js                 # 流水线、运行锁、状态文件
│  ├─ server.js              # 静态服务器（预览 public/）
│  ├─ config.js  logger.js
│  ├─ util/                  # 文本归一化、文件读写
│  ├─ biliboard/             # 官方公开数据同步（期次、曲目库、逐期稿件）
│  ├─ bili/                  # WBI 签名、限流/重试客户端、接口地址
│  ├─ crawler/               # 动态列表、单帖抓取（三级降级）、解析、原始数据仓库
│  ├─ model/                 # 数据集构建（官方 ID 对齐 + 帖子核对）、统计
│  └─ render/                # 模板 + CSS + 前端脚本 + 生成器
├─ data/
│  ├─ boards/                # 官方期次、曲目库（含每首歌的逐期历史与 BV）
│  ├─ raw/<id>.json          # 每期文字版帖子的抓取结果（用于链接与核对）
│  └─ state.json             # 最近运行/构建状态
├─ public/                   # 构建产物（看板 / CSV / JSON）
├─ scripts/
│  ├─ migrate-legacy.mjs     # 一次性迁移旧版缓存
│  └─ register-task.ps1      # 注册 Windows 计划任务
└─ test/                     # node:test 用例
```

## 数据流

```
Biliboard 公开 API ──▶ 期次 + 曲目库（song.id / 逐期 BV / 排名）
B 站动态列表 API  ──▶ 逐期帖子（opus → 专栏接口 → 专栏 SSR）
                     │
                     ▼
           对齐（按发布日期配对）+ 校验（逐名次比对 BV）
                     │
                     ▼
        public/index.html · *.csv · data.json
```

- **身份**：曲目 id 来自官方库，译名与稿件变化都不影响统计口径
- **增量**：`update` 只抓缺失的帖子，曲目库只扫最近几页，新一期通常只发几个请求
- **可重放**：帖子原文与官方数据都落盘，`build` 可离线重算
- **限流**：B 站请求全局限速 + 指数退避，命中 `-352/-412/-509` 自动刷新 WBI 密钥
- **运行锁 / 失败记忆**：`data/.lock` 防并发；同一帖连续失败 3 次后跳过（`data/failures.json`）

## 界面

视觉系统参照 `D:\newBlog`：同一套中性灰阶 + 单一强调色（站点蓝 #1896DA）、6/9/12/16/20 圆角、30/38/46 控件高度、玻璃吸顶栏、克制的阴影与 spring 动效。

- **刷新**：右上角按钮检查 `data.json` 是否有更新——有新数据自动重载，没有则提示「已是最新」；Ctrl/⌘ + 点击强制重载

- **预览**：悬停封面放大预览；点击任意一行打开右侧抽屉，内嵌 B 站播放器，可切换该曲的各个稿件
- **本期榜单**：工具栏切换期次（‹ › 或下拉）、筛选本期歌曲 / P 主；▲/▼/NEW/RE 表示相对上期变化
- **近 30 期**：行内迷你走势，越高越靠上；**多稿件**标记表示该曲在榜期间换过视频
- **冠军榜 / 本期看点 / 歌曲走势**：连冠合并、榜单流动、逐期名次曲线

## 配置

默认配置见 `config/default.json`，需要覆盖时新建 `config/local.json`（深度合并）。常改项：

| 键 | 说明 |
| --- | --- |
| `http.minIntervalMs` | 请求最小间隔，遇到限流可调到 3000+ |
| `bili.cookie` | 可选：填入浏览器 Cookie（SESSDATA 等），显著降低 B 站风控概率 |
| `crawl.timeBudgetMs` | 抓帖时间预算，超时自动跳过，默认 120s |
| `http.maxRetries` / `backoffBaseMs` | 重试次数与退避基数 |
| `crawl.maxPages` | 动态列表最多翻页数 |
| `schedule.weekday/hour/minute` | `schedule` 命令的定时（0=周日，3=周三） |
| `server.port` | 本地预览端口 |

## 本地预览与后台常驻

```powershell
npm start                          # 前台启动并打开浏览器（关窗口即停）
powershell -ExecutionPolicy Bypass -File scripts\serve-bg.ps1          # 后台常驻，关窗口也不停
powershell -ExecutionPolicy Bypass -File scripts\serve-bg.ps1 -Status  # 查看 PID 与端口
powershell -ExecutionPolicy Bypass -File scripts\serve-bg.ps1 -Stop    # 停止
```

后台模式用 WMI 创建进程，不挂在当前终端或任务对象下，日志写到 `logs/serve.log`。

## 自动化

1. **常驻进程**：`node src/cli.js schedule`，按配置每周三 19:30 执行 update。
2. **Windows 计划任务**（已注册）：

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1
   powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Remove
   ```

   任务名 `BiliBoardWeekly`，每周三 19:30 执行 `node src/cli.js update`，日志追加到 `logs/update.log`。

## 已知数据问题

- 官方曲目库自第 2 期起；第 2–52 期没有对应的 B 站帖子，页面不显示「文字版原帖」链接。
- 原帖期号偶有笔误（如把第 65 期写成第 25 期），看板按发布日期配对，不依赖标题期号。
- 少数曲目官方统一替换为本家稿件，与文字版帖子的 BV 不一致，页脚给出差异计数。
- 传说曲周榜与主榜期号独立，单独列在页面附录（最近 8 期冠军），不计入主榜统计。

## 免责声明

数据版权归 Bili-Board_Atel 制作组与 Biliboard 所有；本项目仅做个人学习用途的整理与展示，抓取已限流，请勿高频请求。名次不完全等同于歌曲质量，请理性看待。

## 常见问题

**页面打不开 / 一片空白**

1. 先跑 `node src/cli.js doctor`，它会告诉你缺什么、哪个地址连不上；
2. 直接双击 `public/index.html` 也能看（数据内嵌，不依赖服务）；
3. 用 `npm start` 起本地服务，会自动打开浏览器；端口被占用时会自动换一个。

**B 站接口报 -352 / -412 / -509**

匿名访问 B 站接口有风控，属正常现象。已做三件事：

- 抓帖变成「可失败」：接口挂了只记一条警告，看板照常生成（主体数据来自 Biliboard 官方库）；
- 总时间预算 120 秒、初始化 30 秒，超时直接跳过，不会卡住；
- 想更稳可以在 `config/local.json` 里加自己的 Cookie：

  ```json
  { "bili": { "cookie": "SESSDATA=xxx; bili_jct=xxx; buvid3=xxx" } }
  ```

  或者直接 `node src/cli.js update --no-bili` 跳过抓帖。

**封面加载慢 / 显示不出来**

构建时会把每个稿件解析成 hdslb 直链并缓存到 `data/covers.json`，页面用 `@320w_180h_1c.webp` 缩略图（约 9KB/张）。若首次没有直链，会回退到 Biliboard 的图片代理。解析失败时跑一次 `node src/cli.js sync` 即可补齐。
