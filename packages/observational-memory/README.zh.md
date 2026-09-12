---
description: "长会话的观察式记忆：在 session log 上运行观察、反思与裁剪后台任务，确定性的无模型压缩摘要，以及按记忆 id 可追溯的召回。"
kind: "package-reference"
---

# @deepseek-ai/dsh-observational-memory

[English](README.md) | 中文

## Summary

长会话之所以会失去脉络，是因为压缩在一代又一代地总结上一次的总结。本插件在会话仍然鲜活时完成记忆工作：后台任务记录发生了什么、提炼持久的事实、裁剪不再重要的内容，全部写入 session log。压缩运行时确定性地渲染这些记忆，所以摘要是对持久记录的折叠，而不是对过去的一次重新改写。每一条记忆记录都引用它来自的对话，因此后续的疑问可以追溯回它的来源。

## Table of Contents

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发者注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 profile 中挂载本插件即可，无需进一步配置。记忆节奏、记忆模型以及活跃记忆预算都可配置；默认值适用于长时间的编码会话。

### 记忆节奏随模型上下文窗口缩放

这是本插件相对固定阈值记忆设计的核心行为差异。

阈值是**当前模型真实上下文窗口**的比例，而不是针对某一种窗口大小调好的绝对 token 数：

| 设置 | 默认值 | 含义 |
|---|---|---|
| `observeAfterRatio` | `0.05` | 新对话累积到窗口的 5% 后运行 observer |
| `reflectAfterRatio` | `0.10` | 达到 10% 后运行 reflector |

窗口值读取自持久的 `request/context` 事件，因此不产生额外调用，也能在 reload 之后保留。于是一个 100 万 token 的模型会得到与 100 万 token 相称的记忆节奏，而不是被一个面向 128K 调好的常量所左右——既不会触发得过于频繁，也不会让窗口白白填满。

`observeAfterTokens` 与 `reflectAfterTokens` 仍然作为未知窗口时的兜底值；把比例设为 `0` 的部署得到的也正是这一行为。

### 记忆标签页

插件会在对话视图环中贡献一个 **记忆** 标签页，与 Chat 和 Trajectory 并列。它采用与这位同类一致的账本加检查器布局：一排记录计数的工具栏压在固定列标题与单行记录之上，选中记录的完整内容、状态以及被引用的对话则在右侧的详情面板中展开。第四个标签页列出浏览器当前保留的每一次压缩，包含写入它的路由以及它究竟替换了哪些消息——由记忆渲染出的检查点会被标记为未调用模型。

这个页面用来回答记忆块本身回答不了的问题。模型看到的是一行形如 `[a1b2c3d4e5f6] high …` 的记录；这个标签页正是让人把这行记录与它背后的对话对照的地方：从一条反思走到它保留的观察，再走到被引用的原始条目。页面显示的一切都已经驻留在浏览器中：记录来自 `observationalMemory` session projection（本插件在 host 侧折叠它，而 session controller 已经在把它推送到页面），引用则对照 Conversation 与 Trajectory 视图读取的同一个事件窗口来解析。composer 坞站里还会多一条紧凑读数，位于输入框下方、与会话的轮次与 token 药丸并列：它显示当前会话握有多少观察与反思，点开可以看到按后台任务划分的明细。因此浏览器半边不持有自己的传输、store 或轮询。

### 记忆条与浏览器

记忆条与浏览器界面的模型可见效果见下方模型体验章节：它读取客户端投影，不产生模型可见内容。

指定一个更便宜或更快的路由只需一个字段：

```yaml
- id: observational-memory
  name: '@deepseek-ai/dsh-observational-memory'
  config:
    model:
      provider: openrouter
      model: google/gemma-3-27b-it
      reasoningEffort: low
```

### 配置

| 设置 | 默认值 | 含义 |
|---|---|---|
| `observeAfterRatio` | `0.05` | observer 节奏占上下文窗口的比例；`0` 表示禁用比例 |
| `reflectAfterRatio` | `0.10` | reflector 节奏占上下文窗口的比例；`0` 表示禁用比例 |
| `observeAfterTokens` | `10000` | 未知窗口时使用的 observer 绝对阈值 |
| `reflectAfterTokens` | `20000` | 未知窗口时使用的 reflector 绝对阈值 |
| `observationsPoolMaxTokens` | `20000` | 触发压缩整体折叠账本的活跃观察预算 |
| `observationsPoolTargetTokens` | 最大值的一半 | dropper 维护的活跃观察目标 |
| `observerChunkMaxTokens` | 记忆模型窗口的五分之一 | 单次 observer 分块上限；最小 `256` |
| `agentMaxTurns` | `16` | 单次后台任务轮次上限 |
| `model` | session 模型 | 记忆工作所用的 `{ provider, model, reasoningEffort }` |
| `workerMaxTokens` | 适配器默认 | 单次 worker 调用的最大生成量 |
| `passive` | `false` | 关闭全部后台记忆工作 |

非法值会让插件加载失败，而不是静默降级。

-----

<a id="understand-the-implementation"></a>
## 理解实现

记忆是三个仅写入日志的 session event，以及建立在它们之上的一个折叠。

- `memory/observations-recorded` —— 从对话中提取的、带时间戳与来源引用的观察。
- `memory/reflections-recorded` —— 持久的方向性事实，每条都引用它所保留含义的那些观察。
- `memory/observations-dropped` —— 墓碑。裁剪会把一条观察移出活跃记忆，但绝不从日志中删除，因此召回仍然能解析它。

`observationalMemory` projection 折叠这些事件，其余一切都读这个折叠结果：压缩渲染器、`memory_recall` 工具，以及浏览器界面。

后台任务在 `turn/end` 落到提交后的 `session/event` 事件流上运行，所以一次缓慢或失败的记忆任务既不会阻塞也不会拖垮对话。每个 worker 用单一工具 schema 发起一次 `ctx.llm.stream()` 调用，它返回的每一处引用都会针对收到的分块做校验：引用分块之外条目的观察会被整体拒绝，因为部分可信的引用集合会腐蚀溯源信息。

压缩集成把默认引擎替换为一个覆写 `summarize` 的子类。当折叠后的记忆非空时，它不调用模型直接返回渲染文本；当记忆为空时，它委派给默认总结器，因此真实上下文绝不会被替换成空。

-----

<a id="further-exploration"></a>
## Further Exploration

- [`docs/subsystems/compaction.md`](../../../docs/subsystems/compaction.zh.md) —— 本插件所扩展的压缩接缝。
- [`docs/subsystems/session-projection.md`](../../../docs/subsystems/session-projection.zh.md) —— 记忆状态所在的折叠机制。
- [`dsh-session`](../../core/session/README.zh.md) —— 记忆写入的追加式日志。

-----

<a id="model-experience"></a>

## Dev Note

<details>
<summary>维护者工作背景——点击展开</summary>

记忆事件的词汇表必须声明在本仓库内。`Session.append` 没有给插件任何方式来把自身事件标记为 `ignorable`，而持久化读取路径在打开会话时会拒绝未知的必需事件类型——所以一个仓库外的生产者会追加成功、刷盘成功，然后让会话在下次恢复时永久不可读。`pnpm run gen-persistence-catalog` 正是把这些事件类型放进 `KNOWN_SESSION_EVENT_TYPES` 的那一步；`tests/vocabulary.spec.ts` 是证明这次往返的关卡。

浏览器半边作为独立产物（`lib/client.js`）挂在 `./client` 导出下发布，因为客户端模块系统把该 bundle 作为一个整体读取，并在页面中求值。它由工作区的 client pass 构建，而不是由本包自己的 host 构建，所以改动记忆条需要先跑那一趟，页面才会显示出来。

客户端导入共享的 vocabulary 模块而不是 logging 模块：记录形状与覆盖率规则是浏览器安全的，而 id 生成会导入 `node:crypto`。

`llm` 有意不在插件的 `inject` 里。账本及其折叠在没有模型路由时依然有用，所以一个没有 LLM 服务的部署会保留它们，而不是让插件停在 PENDING；只有 observer 才等待 `llm`，通过它自己的 `ctx.inject`。

</details>

-----

## Model Experience

### 记忆快照与召回工具

#### What the model sees

模型看到的生成后的 [`memory_recall` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-observational-memory)：一个对象，包含一个必填的 `id` 字符串，描述为记忆行方括号中打印的 12 个字符 id。描述说明这是对已知 id 的查找而非搜索，因此模型不会把它当作浏览历史的手段。

#### Token effect

在工具可见的每个请求上产生固定的 schema 开销。一次调用返回有界的结果：最多十二条来源条目，每条截断到两千字符，加上每条已解析记录一行。

#### KV Cache effect

给定配置下 schema 与其描述保持稳定，因此前缀可被缓存。召回的文本作为普通工具结果落在上下文尾部，不扰动可复用的前缀。

## Known Limitations and Deferred Work

- **记忆工作计入 session 模型，而 DSH 的计费看不到它。** observer 与 reflector 调用是使用会话模型发起的普通对话请求。直接的 `ctx.llm.stream()` 调用不是 agent loop，所以没有任何东西把它的用量写入日志，`ctx.tokenMeter` 也永远看不到：这份开销是真实的，与对话出现在同一张账单上，却不产生任何警告或条目。配置 `model` 可以把记忆工作路由到更便宜的地方。
- **缓慢或限流的提供方也会拖慢记忆采集。** DSH 没有 LLM 侧的并发限制器，所以一个饱和的提供方会同时影响对话与 worker。直接的 `ctx.llm.stream()` 调用者也没有自动重试；本插件自行实现有界退避。
- **`purpose` 无法用来提示适配器。** 它是封闭联合，所以 worker 调用是普通请求，采用适配器的默认推理策略。
- **Token 估计是字符启发式。** 池压力使用与 harness 估计器相同的每 token 字符比例，会低估 CJK 文本。因此在 CJK 密集的会话上，节奏与裁剪预算是近似的。
- **记忆是会话本地的。** 反思与观察不跨会话共享，fork 会把父会话的记忆带过去，却不调和之后的分歧。
- **被拒绝的记录是丢弃而非修复。** 引用落在分块之外的观察会被整体丢弃，而不是部分接受。因此一个编号错误的模型会失去这些观察，而不是以可疑的溯源记录它们。
- **记忆标签页是只读的。** 从页面强制一次记忆任务或裁剪选中的记录需要 host 侧 Remote 变更面，本版本未提供；这些操作对模型可用，对用户不可用。
- **记忆标签页只显示已经加载的历史。** 压缩记录读取自浏览器驻留的事件窗口，因此比已加载分页更早的压缩，在窗口回翻到它之前不会列出。记录本身来自覆盖整个会话的投影，始终完整。
**待办。** 从页面编辑或裁剪记录；把同一个浏览器停靠到右侧栏的呈现方式；为 `memory_recall` 工具结果提供专门的客户端卡片；以及跨会话的反思共享。

-----

