---
description: "The memory_recall tool: resolve one memory id back to the exact conversation it came from, so a compacted record can be checked against its evidence."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-observational-memory

English | [中文](README.md)

## Summary

Compaction replaces the exact record of what was said with condensed memory, so the model can hold a fact without the evidence behind it. This package adds `memory_recall`: given one memory id — the twelve hex characters printed in brackets on a memory line — it returns the conversation that produced it, following the chain from a reflection to the observations it preserves, and from an observation to its source entries. It is a lookup for a known id, not a search, and it reports what it could not resolve.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount it beside `@deepseek-ai/dsh-observational-memory`, which owns the memory ledger this tool reads. Both commands are required: the ledger joins the profile's bundle layers only when it is a direct dependency, so installing this package alone leaves its ledger copy transitive, and the tool then waits for a store no layer publishes.

```bash
dsh plugin --profile web add @deepseek-ai/dsh-observational-memory
dsh plugin --profile web add @deepseek-ai/dsh-tool-observational-memory
```

The tool is opt-in: a deployment that does not mount it still records memory, and simply cannot resolve an id back to its sources. It declares the ledger store in its inject list, so where the ledger is absent the tool does not mount at all rather than registering a tool that can only answer "no memory".

There is nothing to configure. The tool registers one name and one schema, and contributes one prompt section telling the model when recall is worth a call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Recall is a read over two existing seams, and it adds no storage of its own.

Memory comes from the ledger store the domain package publishes on the context: the same store the compaction renderer and the `/om` commands read, so recall cannot disagree with them about what memory holds. Resolving an id expands a reflection into the observations it names, and an observation into the entries it cites.

The source entries come from `ctx.sessionQuery`, because arbitrary historical reads are no longer available synchronously. Each cited seq is read and then traced, so a source that compaction has since shadowed reports the checkpoint that replaced it rather than reading as an ordinary entry that no longer reaches the model.

Everything that could not be resolved is reported: a supporting observation missing from the ledger, a cited entry absent from the log, or a cited entry that exists but is not conversation. A gap is stated rather than papered over, because a recall that silently returns less than it claims is worse than one that says what is missing.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-observational-memory`](../observational-memory/README.en.md) — the ledger, its transitions, and the compaction renderer this tool reads.
- [`src/index.ts`](src/index.ts) — the tool definition, its own prompt section, and the provenance walk.
- [`FREEZE.md`](../../FREEZE.md) — why memory left the session log, which is what makes this a store read.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The plugin is a pure consumer: it reads the published ledger store and adds no storage of its own. It does declare that store in its inject list, so a deployment that mounts the tool without the ledger gets no tool at all rather than one that can only answer "no memory".

`memory_recall` is the tool name, not `recall`. `recall` is already a `ContextForm` value in the model message vocabulary, and the chat UI renders a "recall" context body for it, so reusing the word as a tool name would collide with an existing meaning.

The catalog generator mounts this package over the SQLite query provider and a session store, because the tool's `inject` includes `sessionQuery` and the provider needs a store to read. A manifest entry that omits either leaves the plugin PENDING and the generator fails loudly rather than cataloguing an empty section.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### The memory_recall schema

#### What the model sees

The model sees the generated `memory_recall` schema: an object with one required `id` string, described as the twelve-character id exactly as printed in brackets on a memory line. The description states that this is a lookup for a known id and not a search, so the model does not treat it as a way to browse history.

#### Token effect

A fixed schema cost on every request where the tool is visible. One call returns a bounded result: at most twelve source entries, each clamped to two thousand characters, plus one line per resolved record.

#### KV Cache effect

The schema and its description are stable for a given configuration, so the prefix stays cacheable. Recalled text arrives as an ordinary tool result at the context tail and does not disturb the reusable prefix.

### The recall result

#### What the model sees

A short note saying what resolved, one line per matched reflection and observation with the record's id, timestamp, relevance, and whether it is still active or has been dropped, then the cited conversation as `#seq role: text` lines. A source that compaction has shadowed carries the checkpoint that replaced it. Anything unresolved is listed last, naming the missing supporting observations, absent source entries, or cited entries that are not conversation.

#### Token effect

The result grows with the number of matched records and their sources, bounded by the twelve-entry and two-thousand-character caps. A reflection resolves through its supporting observations, so one reflection lookup can return several records and their sources together.

#### KV Cache effect

Append-only tool results, so newly recalled content follows the reusable request prefix and does not invalidate existing cache entries.

## Known Limitations and Deferred Work

- **Recall is a lookup, not a search.** An id that the model was never shown cannot be recalled, and there is no query form. Browsing history by content is what the session-query tools are for.
- **It answers only about the calling session's memory.** Cross-session recall is out of scope here; the query tools cover cross-session history.
- **A reflection resolves only as well as its citations.** When a supporting observation is no longer in the ledger, recall reports the gap rather than following a weaker path, so a poorly cited reflection returns less evidence.
- **Source text is clamped and the entry count is capped.** A long source is truncated in the result with the truncation stated; reading it in full is the query tools' job.
- **Shadowed sources report their replacer, not the original text through the chain.** The result names the checkpoint that replaced a source; it does not walk the chain to reconstruct the text as it stood before compaction.
- **Deferred.** A web card rendering the recalled evidence beside the conversation, and an optional semantic fallback when a literal id lookup returns nothing.

-----

