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

## 验证方法论：真浏览器，不靠肉眼

前端（主题 / 动效 / 移动端）没有单元测试，改完靠**headless Edge + CDP** 量出来。
探针是可复用的，别每次重写：

```bash
# 1) 起一个临时端口的服务，别动正在用的那个
node src/cli.js serve --port 5199

# 2) 跑探针（自己起无头浏览器、截图、打印 JSON，失败时退出码 1）
node devtools/tools/probe-ui.cjs --port 5199
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
npm test          # 33 个用例
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
