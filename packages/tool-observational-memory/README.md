---
description: "memory_recall 工具：把一个记忆 id 解析回它来自的确切对话，从而可以让被压缩的记录与其证据对照。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-observational-memory

[English](README.en.md) | 中文

## Summary

压缩会用浓缩的记忆替换掉「说过的原话」的确切记录，这意味着模型可能持有一个事实却没有它背后的证据。本包加入 `memory_recall`：一个面向模型的工具，接受一个记忆 id——也就是记忆行方括号中打印的十二个十六进制字符——返回产生它的那段对话，沿着溯源链从一条反思走到它所保留的观察，再从一条观察走到它的来源条目。它是对已知 id 的查找而非搜索，并且如实报告它无法解析的部分，而不是把缺口填上。

## Table of Contents

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [开发者注记](#dev-note)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把它挂载在 `@deepseek-ai/dsh-observational-memory` 旁边，后者拥有本工具所读取的记忆账本。两条命令都要执行：账本只有作为直接依赖安装时才会进入 profile 的 bundle 层，只装本包时它的账本副本只是传递依赖，工具便会一直等待一个从不发布的 store。

```bash
dsh plugin --profile web add @deepseek-ai/dsh-observational-memory
dsh plugin --profile web add @deepseek-ai/dsh-tool-observational-memory
```

本工具是可选的：没有挂载它的部署仍然会记录记忆，只是无法把一个 id 解析回它的来源。它把账本 store 声明在自己的 inject 列表里，因此在没有账本的地方工具根本不会挂载，而不是注册一个只会回答「没有记忆」的工具。

没有任何需要配置的东西。工具注册一个名字和一个 schema，并贡献一段提示词章节，告诉模型何时值得调用召回。

-----

<a id="understand-the-implementation"></a>
## 理解实现

召回是对两个既有接缝的读取，它不新增任何自己的存储。

记忆来自域包发布到 context 上的账本 store：与压缩渲染器和 `/om` 命令读取的是同一个 store，所以召回不可能与它们对「记忆里有什么」产生分歧。解析一个 id 会把一条反思展开为它所引用的观察，把一条观察展开为它所引用的条目。

来源条目来自 `ctx.sessionQuery`，因为任意的历史读取已不再同步可用。每一个被引用的 seq 都会先被读取、再被追踪，因此一个之后被压缩遮蔽的来源会报告替换它的检查点，而不是读起来像一个仍然到达模型、实则不然的普通条目。

所有无法解析的部分都会被报告：账本中缺失的支撑观察、日志中不存在的被引条目，或者存在但不是对话的被引条目。缺口是被陈述出来的，而不是被粉饰的，因为一次悄悄少给内容的召回，比一次明说自己缺了什么的召回更糟。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`dsh-observational-memory`](../observational-memory/README.md) —— 本工具所读取的账本、它的转换，以及压缩渲染器。
- [`src/index.ts`](src/index.ts) —— 工具定义、它自己的提示词章节，以及来源链遍历。
- [`FREEZE.md`](../../FREEZE.md) —— 记忆为什么离开会话日志，那正是这里变成 store 读取的原因。

-----

<a id="dev-note"></a>
## 开发者注记

<details>
<summary>维护者工作背景——点击展开</summary>

插件是纯消费者：它读取发布出来的账本 store，自己不新增任何存储。它确实把该 store 声明在 inject 列表里，因此在没有账本的情况下挂载工具会完全得不到工具，而不是得到一个只会回答「没有记忆」的工具。

工具名是 `memory_recall`，而不是 `recall`。`recall` 已经是模型消息词汇表中一个 `ContextForm` 取值，聊天界面会为它渲染一个 "recall" 上下文体，所以把同一个词复用为工具名会与既有含义冲突。

工具目录生成器会把本包挂载在 SQLite 查询提供方与一个 session store 之上，因为工具的 `inject` 包含 `sessionQuery`，而该提供方需要一个 store 才能读取。遗漏其中任何一个的清单条目都会让插件停在 PENDING，生成器会显式失败，而不是把一个空章节收进目录。

</details>

-----

<a id="model-experience"></a>
## Model Experience

### The memory_recall schema

#### What the model sees

模型看到的生成后的 `memory_recall` schema：一个对象，包含一个必填的 `id` 字符串，描述为记忆行方括号中打印的十二个字符 id。描述说明这是对已知 id 的查找而非搜索，因此模型不会把它当作浏览历史的手段。

#### Token effect

在工具可见的每个请求上产生固定的 schema 开销。一次调用返回有界的结果：最多十二条来源条目，每条截断到两千字符，加上每条已解析记录一行。

#### KV Cache effect

给定配置下 schema 与其描述保持稳定，因此前缀可被缓存。召回的文本作为普通工具结果落在上下文尾部，不扰动可复用的前缀。

### The recall result

#### What the model sees

一句说明解析了什么的短注，然后是每条匹配到的反思与观察各一行，带上记录的 id、时间戳、重要性与它仍处于活跃还是已被裁剪；接着是按 `#seq role: text` 形式给出的被引对话。被压缩遮蔽的来源会带上替换它的检查点。任何无法解析的部分列在最后，指出缺失的支撑观察、不存在的来源条目，或者存在但不是对话的被引条目。

#### Token effect

结果随匹配记录数与其来源数量增长，并受十二条与两千字符上限约束。一条反思会通过它的支撑观察展开，所以一次反思查找可能同时返回若干条记录及其来源。

#### KV Cache effect

仅追加的工具结果，因此新召回的文本跟在可复用的请求前缀之后，不会使既有缓存条目失效。

## Known Limitations and Deferred Work

- **召回是查找，不是搜索。** 模型从未见过的 id 无法召回，也没有查询形式。按内容浏览历史是 session-query 工具的职责。
- **它只回答调用会话自身的记忆。** 跨会话召回不在本包范围内；查询工具覆盖跨会话历史。
- **一条反思的解析质量取决于它的引用。** 当某个支撑观察已不在账本中时，召回会报告这个缺口，而不是沿一条更弱的路径继续，因此引用不佳的反思会返回更少的证据。
- **来源文本会被截断，条目数量有上限。** 过长的来源会在结果中被截断并说明截断量；完整读取它是查询工具的职责。
- **被遮蔽的来源报告的是替换者，而不是穿过链条的原文。** 结果会指出替换该来源的检查点，但不会沿链条重建压缩之前的文本。
- **待办。** 在对话旁渲染召回证据的 Web 卡片，以及在字面 id 查找无果时的可选语义兜底。

-----

