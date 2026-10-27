# 术力口周榜 · 数据服务

> 🤖 **AI 生成声明**
>
> 本项目的**代码、界面与数据整理均由 AI 生成**（模型：**DeepSeek-V4.1-Flash**），作者 **whatiscat**。
> 数据版权归 Bili-Board_Atel 制作组与 Biliboard 所有，本项目为非官方的个人整理。

一个 Node.js 服务：把 B 站「术力口周榜」整理成结构化数据，通过 HTTP API 提供给前端看板。
不是静态页面生成器——数据在服务端编译、按请求下发，前端只负责渲染。

```
data/boards/*.json  →  Repository（编译期派生）  →  HTTP API  →  src/web（SPA）
                                          ↘  /api/csv, /img/:bvid
```

## 快速开始

```bash
npm start                 # 启动服务并打开浏览器（默认 http://127.0.0.1:5173）
node src/cli.js serve     # 同上，不自动开浏览器
node src/cli.js update    # 同步官方库 + 增量抓帖
node src/cli.js report    # 终端打印数据摘要
node --test               # 17 个用例
```

零第三方依赖，只用 Node.js 内置模块（Node ≥ 20.6）。

## 目录结构

```
src/
├─ cli.js                 命令行入口（serve / update / sync / crawl / report / status / doctor / schedule）
├─ server/                HTTP 服务
│  ├─ index.js            监听、端口顺延、打开浏览器
│  ├─ app.js              请求管线：路由 → 处理 → 统一日志/错误
│  ├─ router.js           极简路由（GET/POST + :param）
│  ├─ respond.js          JSON（gzip）/ 文本 / 302
│  ├─ repository.js       数据访问层：缓存数据集，派生涨跌、在榜、变体、冠军段
│  └─ routes/             api.js · static.js
├─ web/                   前端（无框架 SPA）
│  ├─ index.html          壳页面，无内联数据
│  ├─ app.js              取 API → 渲染榜单 / 抽屉 / 走势
│  └─ styles.css
├─ model/                 领域模型：数据集构建与统计
├─ biliboard/             官方公开数据同步（期次、曲目库、封面直链）
├─ bili/                  B 站接口（WBI 签名、限流重试）
├─ crawler/               帖子抓取（三级降级）与原始数据存储
├─ config.js  logger.js  run.js  doctor.js
└─ util/
data/                    官方期次、曲目库、帖子原文、封面缓存
test/                    node:test 用例
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 存活、期数、条目数、版本 |
| GET | `/api/meta` | 账号、数据范围、统计、对齐信息、数据版本 |
| GET | `/api/issues` | 期次列表（含冠军与帖子链接） |
| GET | `/api/issues/:issue` | 某期完整数据：20 行 + 涨跌/在榜/变体 + 看点 + 侧栏 |
| GET | `/api/champions?limit=24` | 冠军段（连续夺冠合并） |
| GET | `/api/songs?q=&limit=` | 曲目索引，可按歌名/原名搜索 |
| GET | `/api/songs/:id` | 单曲详情：逐期名次、稿件变体 |
| GET | `/api/legend?limit=8` | 传说曲周榜附榜 |
| GET | `/api/csv` | 全量 CSV 下载 |
| GET | `/img/:bvid?w=320` | 封面：302 到 B 站直链，按需缩放 |
| POST | `/api/reload` | 重新读取磁盘数据（改完数据不用重启） |

派生逻辑全部在服务端：前端拿到的 `rows[]` 已经带 `prev / delta / state / weeks / best / variants / spark`，不再自己算。

## 数据流水线

```bash
node src/cli.js sync        # 同步 Biliboard 期次与曲目库（增量，约 3 秒）
node src/cli.js sync --full # 全量同步（约 2 分钟）
node src/cli.js crawl       # 增量抓 B 站文字版帖子
node src/cli.js update      # 以上两步 + 打印摘要（定时任务跑这个）
```

- **曲目身份**：Biliboard 公开曲目库的 `song.id`。译名变化、稿件更换都不会拆成两首；每期保留当周实际使用的 BV。
- **帖子配对**：用发布日期对齐官方期次，不依赖标题里的期号（原帖有笔误）。
- **限流**：B 站请求全局限速 + 指数退避，命中 `-352/-412/-509` 自动刷新 WBI 密钥；抓帖失败不影响服务。

更新后服务端不会自动重载：页面点「刷新」（内部调 `POST /api/reload`），或重启服务。

## 定时更新

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1          # 每周三 19:30
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Remove
```

或常驻进程：`node src/cli.js schedule`。

## 后台运行

```powershell
powershell -ExecutionPolicy Bypass -File scripts\serve-bg.ps1          # 脱离终端启动
powershell -ExecutionPolicy Bypass -File scripts\serve-bg.ps1 -Status
powershell -ExecutionPolicy Bypass -File scripts\serve-bg.ps1 -Stop
```

## 便携包

```bash
npm run package   # → dist/术力口周榜-便携版.zip
```

解压后双击 `启动.cmd`：检查 Node → 起服务 → 开浏览器；首次运行询问是否添加每周三自动更新。

已发布版本：[Releases](https://github.com/whatiscat/Weekly-Leaderboard-V/releases)

## 已知数据问题

- 官方曲目库自第 2 期起；第 2–52 期没有对应的 B 站帖子，页面不显示「文字版原帖」。
- 原帖期号偶有笔误（如把第 65 期写成第 25 期），按发布日期配对规避。
- 少数曲目官方统一替换为本家稿件，与文字版帖子的 BV 不一致，页脚给出核对结果。
- 传说曲周榜与主榜期号独立，单独列在页面附录。

## 免责

数据版权归 Bili-Board_Atel 制作组与 Biliboard 所有，本项目仅做个人学习用途的整理与展示；抓取已限流，请勿高频请求。名次不完全等同于歌曲质量，请理性看待。
