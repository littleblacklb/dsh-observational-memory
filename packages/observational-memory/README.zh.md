---
description: "长会话的观察式记忆：在会话进行中做观察、反思与剪枝的后台工作，确定性的零模型调用压缩摘要，以及可按记忆 id 追溯的召回。"
kind: "package-reference"
---

# @deepseek-ai/dsh-observational-memory

[English](README.md) | 中文

## Summary

长会话会失去主线，因为压缩在一次次地"总结之前的总结"。本插件在会话还活着的时候就把记忆工作做掉：后台 pass 记录发生了什么、提炼持久事实、剪掉不再重要的内容，写进一个由插件自己持有的存储。压缩发生时它确定性地渲染这些记忆，于是摘要是对持久记录的折叠，而不是模型对过去的一次重新改写。每条记录都引用它所来自的对话，因此之后的问题可以追溯到源头。

## Table of Contents

- [安装](#install)
- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="install"></a>
## 安装

两条命令，不需要改 profile。域包带着它的 bundle patch，负责挂载 ledger 并换掉压缩引擎；工具包带着自己的 patch，负责挂载 `memory_recall`。两者都是 bundle 层，加载器会像对待其他层一样组合它们。

```bash
dsh plugin --profile web add @deepseek-ai/dsh-observational-memory
dsh plugin --profile web add @deepseek-ai/dsh-tool-observational-memory
```

两个包都不修改 DeepSeek Harness。记忆不是 session 事件，所以不需要往 harness 里编译任何东西就能保证会话可读 —— 这也正是这两个包能像普通插件一样从 npm 安装的原因。

-----

<a id="use-this-package"></a>
## 使用本包

把插件挂进 profile 即可，无需其他配置。记忆节奏、worker 模型、ledger 位置、活跃记忆预算都可配置；默认值适合长时间编码会话。

### 记忆节奏：默认固定阈值

节奏由 `observeAfterTokens` 与 `reflectAfterTokens` 两个**绝对 source token 阈值**决定，这与原项目默认的非动态策略一致：

| 设置 | 默认值 | 含义 |
|---|---|---|
| `observeAfterTokens` | `10000` | 新增对话达到 10,000 source token 后运行 observer |
| `reflectAfterTokens` | `20000` | 达到 20,000 后运行 reflector |

把 `observeAfterRatio` 或 `reflectAfterRatio` 设为 `(0, 1)` 之间的比例，即可改为随**当前模型真实上下文窗口**缩放：窗口读取自持久的 `request/context` 事件，因此不产生额外调用，也能在重载后保留 —— 1M token 模型配 `observeAfterRatio: 0.05` 变成每 50,000 token 观察一次，而 128K 模型仍得到适合自己的阈值。比例设为 `0`（默认值）即关闭该比例、使用绝对阈值；adapter 不公布窗口时得到的也是同样的行为。

### Worker 模型：默认使用会话模型

除非配置 `model`，记忆 worker 使用会话自己的模型。换成更便宜或更快的路由只需一个字段：

```yaml
- id: observational-memory
  name: '@deepseek-ai/dsh-observational-memory'
  config:
    model:
      provider: openrouter
      model: google/gemma-3-27b-it
      reasoningEffort: low
```

### 查看记忆

记忆以带 id 的文本块形式到达模型。`/om` 系列就是人用来核对这些行与背后对话的手段：

| 命令 | 显示内容 |
|---|---|
| `/om status` | 记录数、observer 的覆盖漂移、活跃池相对 dropper target 的位置、以及各 worker 的水位 |
| `/om view` | 压缩此刻会渲染出的确切文本块 |
| `/om show <id>` | 单条记录，按它的来源链解析 —— 反思展开为它保留的观察，观察展开为它引用的条目 |

`/om show` 从 observer 自己的 fold 读来源，而不是重新读日志，所以来源显示的正是记录写下时读到的样子。同一套解析也以 [`memory_recall`](../../tool-observational-memory/README.md) 工具的形式提供给模型，它可以对它记忆块里看到的任何 id 调用。

命令输出会进日志（`command/run` 与 `command/done`），所以即使记忆 pass 本身不进 Trajectory，你查询记忆这件事仍然留痕。

### 记忆存在哪里

每个会话一份 JSON 文档，位于 harness home 下的 `observational-memory` 目录（`$DSH_HOME`，或 `~/.dsh`）。写入经过临时文件，因此读方永远不会看到半个 pass；读取是同步的，因此模型可见的记忆块和压缩渲染器都能在不 await 的情况下拿到它。

**这个目录 —— 而不是会话日志 —— 才是备份时必须一起带上的东西**，否则会话会丢掉它的记忆。用 `storageDir` 可以把它放到别处。

### 配置

| 设置 | 默认值 | 含义 |
|---|---|---|
| `observeAfterRatio` | `0` | observer 节奏占上下文窗口的比例；`0` 关闭该比例 |
| `reflectAfterRatio` | `0` | reflector 节奏占上下文窗口的比例；`0` 关闭该比例 |
| `observeAfterTokens` | `10000` | observer 的节奏（source token），也是比例关闭时使用的阈值 |
| `reflectAfterTokens` | `20000` | reflector 的节奏（source token），也是比例关闭时使用的阈值 |
| `observationsPoolMaxTokens` | `20000` | 活跃观察池的上界；仅用于派生与校验 target |
| `observationsPoolTargetTokens` | 最大值的一半 | dropper 维持的活跃观察目标，也是池容量计算的实际工作点 |
| `observerChunkMaxTokens` | 记忆模型窗口的五分之一 | observer 单块上限；最小 `256` |
| `agentMaxTurns` | `16` | 单次后台 worker 运行的轮次上限 |
| `model` | 会话模型 | 记忆工作的 `{ provider, model, reasoningEffort }` |
| `workerMaxTokens` | 适配器默认 | 单次 worker 调用的最大生成长度 |
| `storageDir` | `$DSH_HOME/observational-memory` | ledger 写入的目录 |
| `passive` | `false` | 关闭全部后台记忆工作 |

非法值会让插件加载失败，而不是静默降级。

-----

<a id="understand-the-implementation"></a>
## 理解实现

记忆是一个存储加上三个作用于它的转换。

- `applyObservations` 追加带来源引用的记录，按内容寻址的 id 去重，因此相同文本会收敛为一条记录。
- `applyReflections` 追加持久的方向性事实，每条都引用它所保留其含义的观察。反思比它引用的观察活得更久。
- `applyDrops` 把观察从活跃池移入墓碑列表而不是抹掉，因此召回仍能按 id 解析到它。

三个转换都会拒绝水位已经应用过的 pass。这正是让重试或重复的 pass 成为空操作、而不是被应用两次的原因。

围绕它们的 store 按会话缓存，并在每次变更时写穿。它通过 `ctx.reflect.provide` 发布到 context 上，而不是以模块级单例的形式暴露 —— 因为压缩引擎是作为自己独立的 loader row 挂载的，看不到本插件的闭包。

后台 pass 在 `turn/end` 落地时由提交后的 `session/event` 流触发，因此缓慢或失败的记忆 pass 既不会阻塞也不会拖垮对话。每个 worker 发一次 `ctx.llm.stream()` 调用，带一个工具 schema，返回的每处引用都会针对它拿到的分块校验：引用了分块之外条目的观察会被整体拒绝，因为部分可信的引用集合会破坏来源链。

压缩集成用一个子类替换默认引擎，只覆写 `summarize`。记忆非空时它直接返回渲染文本，不调用模型；记忆为空、或渲染不会让它替换的区域变小时，它委托给默认摘要器，因此真实上下文永远不会被替换成空。

-----

<a id="further-exploration"></a>
## Further Exploration

- [`FREEZE.md`](../../FREEZE.md) —— 记忆为什么离开会话日志，以及代价是什么。
- [`DESIGN.md`](../../DESIGN.md) —— 本包所依据的设计记录。
- [`src/store.ts`](src/store.ts) —— ledger、它的转换、以及它的持久化规则。
- [`src/compaction-engine.ts`](src/compaction-engine.ts) —— `summarize` 覆写与它的收缩守卫。
- [`tool-observational-memory`](../../tool-observational-memory/README.md) —— 按来源链解析 id 的 `memory_recall` 工具。

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

记忆**刻意不是** session 事件。`Session.append` 没有给插件任何把事件标记为 `ignorable` 的途径，而持久化读取路径在打开会话时会拒绝未知的必需事件类型 —— 于是树外的生产者会 append 成功、flush 成功，然后在下次 resume 时让会话永久不可读。另一条出路是把类型声明进 harness 内部，但那会让插件变成一个别人无法安装的 fork。[`FREEZE.md`](../../FREEZE.md) 记录的就是走了第一条路的那条线，以及它为什么被放弃。

store 发布在 context 上而不是导出为模块级单例，有两个原因：压缩引擎是独立的 loader row；而按 context 隔离的取值才能让同一进程内的两个应用 —— 或同一个测试文件里的两次挂载 —— 不会共用一份 ledger。

读取刻意做成同步的。`ctx.systemPrompt.context()` 接的回调必须返回字符串，而压缩在 agent 位于步骤之间时读 ledger，所以 store 每个会话做一次 `readFileSync`，之后常驻内存。

`llm` 刻意不在插件的 `inject` 里。ledger 没有任何模型路由也有用，所以没有 LLM 服务的部署仍然保留它，而不是让插件停在 PENDING；只有 observer 通过自己的 `ctx.inject` 等待 `llm`。引擎和工具则确实声明了 `observationalMemoryStore`，因此两者都不会在没有 ledger 的地方挂载 —— 没装本包的部署拿不到 `memory_recall`，而不是得到一个只会回答"没有记忆"的工具。

`pnpm run verify` 跑完整门禁：build、typecheck、100% per-file 覆盖率，以及 `scripts/check-artifacts.mjs`。最后一项在纯 Node 下加载构建产物 `lib/`，这是唯一能抓住打包故障的环节 —— `tsdown` 会把共享 chunk 从入口里拆出去，而漏掉它的 `files` 列表会产出加载时 `ERR_MODULE_NOT_FOUND` 的 tarball。

</details>

-----

<a id="model-experience"></a>
## Model Experience

### 记忆快照与召回工具

#### What the model sees

记忆通过 `ctx.systemPrompt.context()` 到达模型，循环会把它物化为一条位于保留历史之后的、持久的、已记录的快照。渲染出的块列出带 id 的反思与观察，并指示模型把它们当作过往记录、在条目冲突时优先最新的观察、不要重做已记录为完成的工作。模型还会获得生成的 `memory_recall` schema，用于把某个记忆 id 解析回它的源对话。

#### Token effect

快照按确切文本去重，因此未变化的记忆块不增加 token，也不产生新消息。后台 worker 调用消耗 token，但不属于对话上下文；压缩渲染记忆，而不是为一次摘要调用付费。

#### KV Cache effect

由于未变化的记忆不产生新消息，请求前缀保持稳定，服务端缓存的前缀得以保留。改变前缀的是记忆增长，而它每个记忆 pass 才改变一次，不是每一步都改。


## Known Limitations and Deferred Work

- **记忆工作的费用记在会话模型上，而 DSH 的账目看不到它。** observer 与 reflector 调用是使用会话所用模型的普通聊天请求。直接的 `ctx.llm.stream()` 调用不是 agent loop，因此没有任何地方把它的用量写进日志，`ctx.tokenMeter` 也永远看不到：费用是真实的、和对话出现在同一张账单上，却不产生任何警告或条目。把 `model` 配到更便宜的路由上去。

- **慢或被限流的服务商同样拖慢记忆捕获。** DSH 没有 LLM 侧的并发限制器，所以服务商饱和会同时影响对话和 worker。直接的 `ctx.llm.stream()` 调用者也没有自动重试；本插件自己实现了有界退避。

- **`purpose` 无法用来给适配器提示。** 它是一个封闭联合，因此 worker 调用是普通请求，走适配器默认的推理策略。

- **token 估算是字符启发式。** 池压力使用与 harness 估算器相同的每 token 字符比，这低估了 CJK 文本。因此在 CJK 密集的会话里，节奏与丢弃预算是近似值。

- **记忆不随会话日志一起移动。** ledger 是独立目录，因此把会话拷到别处不会带上它的记忆，重放日志也无法重建它。备份时要连同 `storageDir` 一起备份。

- **fork 不继承父会话的记忆。** fork 会拿到父会话事件前缀的副本，这是它继承对话的方式 —— 但 ledger 按 session id 索引，所以子会话从空开始。重新观察被继承的前缀是它追上进度的方式。

- **Web 客户端里没有记忆界面。** 本插件只有宿主半边，所以查看记忆只能靠 `/om` 或问模型。浏览器视图需要一个插件能自行注册的宿主到页面通道，本版本没有尝试。

- **被拒绝的记录是被丢弃，而不是被修补。** 引用落在分块之外的观察会被整体丢弃，而不是部分接受。因此把条目编号搞错的模型会失去那些观察，而不是以可疑的来源记录它们。

**Deferred.** 通过命令编辑或丢弃记录；跨会话共享反思；ledger 的浏览器视图。

-----

