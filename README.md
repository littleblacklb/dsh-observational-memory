# 面向 DeepSeek Harness 的观察式记忆

[English](README.en.md) | 中文

![dsh observational memory：捕获会话观察、提炼有用的记忆、之后召回它们](docs/assets/banner.webp)

一个为长时间运行的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 会话提供的观察式记忆插件，改编自 [elpapi42/pi-observational-memory](https://github.com/elpapi42/pi-observational-memory)。它在会话进行中捕获有用的事实，保留一份可追溯的记忆账本，并在压缩时渲染这些记忆，而不是让模型把同一段历史再总结一遍。

**这是 DeepSeek Harness 的实现，不是 Pi 扩展。** 可安装的 `main` 分支是 host-only 的：它不包含浏览器记忆面板，也不需要对 Harness 源码树做任何改动。

## 它做什么

- **观察、反思、剪枝：** 后台 worker 记录带来源引用的观察、提炼更持久的反思，并给活跃记忆池设上界。它们运行的时候，对话照常继续。
- **跨压缩记忆：** 当记忆非空、且结果会让被压缩的区域变短时，插件不调用模型，直接把自己的记忆渲染进压缩摘要；否则回退到标准摘要器。
- **把断言追溯回来源：** 观察引用对话条目，反思引用观察。`/om show <id>` 与可选的 `memory_recall` 工具沿着这些链接走，遇到缺失的证据就如实报告，而不是编造。
- **不 fork Harness 也能安装：** 账本与召回工具是两个独立的插件 bundle。账本持有每会话一个 JSON 存储，而不是往 Harness 会话日志里写自定义事件类型。

## 包

| 包 | 作用 |
| --- | --- |
| [`@deepseek-ai/dsh-observational-memory`](packages/observational-memory/README.md) | 账本、后台 worker、`/om` 命令与压缩集成。先装这个。 |
| [`@deepseek-ai/dsh-tool-observational-memory`](packages/tool-observational-memory/README.md) | 可选的 `memory_recall` 模型工具。要求账本 bundle 直接安装在同一个 profile 里。 |

## 状态与本地安装

本仓库中的两个包版本是 **`0.1.5-rc.2`**。**它们尚未发布到 npm。** 目前请从本地 checkout 构建并安装。下例使用 `web` profile；如果你的 profile 名不同，请替换。

```bash
cd /path/to/dsh-observational-memory
pnpm install
pnpm run build
LEDGER_DIR="$PWD/packages/observational-memory"
TOOL_DIR="$PWD/packages/tool-observational-memory"

cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add "$LEDGER_DIR"
pnpm dsh plugin --profile web add "$TOOL_DIR"
pnpm dsh --profile web web
```

改完插件 `src/` 要重新构建：bundle 加载的是 `lib/`，而这两个包没有 prepack 构建钩子。想要 `memory_recall`，就必须**把两个包都作为 profile 的直接依赖安装**；只装工具会让它一直等待账本 store。插件 bundle 自带各自的 profile 补丁，因此不需要改动 Harness 源码，也不需要手工编辑 profile。

想确认安装是否生效，在会话里运行 `/om status`。`/om view` 显示压缩将要渲染的记忆块；`/om show <12 位 id>` 解析某一条记录的来源。模型可以用它见过的 id 调用 `memory_recall`。新会话里记忆视图为空是正常的，直到 observer pass 跑过一次。`main` 上没有 Web 记忆标签页。

## 存储与取舍

记忆与会话日志分开存储，位置是 `$DSH_HOME/observational-memory/<sessionId>.json`（默认 `~/.dsh/observational-memory/`）。请把这个目录和你的会话一起备份：只复制或重放会话日志不会带上它的记忆，fork 出来的会话会从一份新的记忆账本开始。可以用 `storageDir` 改位置。

后台 pass 会调用 LLM 并消耗 token。默认使用会话模型，你也可以配置另一个 `model`。它们的用量目前不会反映在 Harness 的会话 token 计量里。节奏、池大小、worker 上限与被动模式都可配置；见[账本包参考](packages/observational-memory/README.md#configuration)。

## 浏览器 UI 实验

已冻结的 [`parked/browser-ui` 分支](FREEZE.md)保留了一套更早的设计：Chat、Trajectory 旁边的只读 Memory 标签页，加上输入框下方的一条记忆读数。**它不属于 `main` 版本，也不是另一种安装开关。** 那套设计把记忆存在会话日志事件里，并且需要对 DeepSeek Harness 打补丁（包括它的已知会话事件类型与客户端接线）。该分支保留了插件侧代码与 Harness 补丁以供参考；见[它为什么被搁置](FREEZE.md)。不要为了使用上面的独立包去套用那个补丁。

## 由来与致谢

本项目基于 elpapi42 及其贡献者的 [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory)：它的「观察 → 反思 → 剪枝」模型与可追溯记忆的思路影响了本次实现。Harness 专属的存储、压缩集成、命令与包接线记录在这里以及各包的参考文档中。感谢上游作者以 MIT 许可发布他们的工作。

## 许可

MIT。两个包都在 `package.json` 里声明了 `license: MIT`。

## 开发

```bash
pnpm run build
pnpm run test
pnpm run check:artifacts
```

`pnpm run verify` 跑完整门禁：构建、类型检查、逐文件 100% 覆盖率、README 配对与构建产物检查。

关于会话日志那条取舍见[冻结线的说明](FREEZE.md)，配置与实现细节见各包 README。

## 仓库结构

| 路径 | 是什么 |
| --- | --- |
| [`README.md`](README.md)、[`FREEZE.md`](FREEZE.md) | 产品首页，以及早期那条会话日志线路为什么被搁置 |
| [`docs/decisions.md`](docs/decisions.md) | `main` 决定了什么，以及每条决定的代价 |
| [`docs/design.md`](docs/design.md) | 两条线共享的记忆模型设计 —— 冻结线专属章节在正文里标注 |
| [`docs/reference/`](docs/reference/) | 本移植所改编的上游参考实现的研究记录 |
| [`AGENTS.md`](AGENTS.md)、[`HANDOFF.md`](HANDOFF.md) | 维护者入口与当前工作状态 |

`AGENTS.md` 与 `HANDOFF.md` 是给维护者和 AI agent 的工作笔记；其余内容是面向用户的。
