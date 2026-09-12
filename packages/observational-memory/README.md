---
description: "Observational memory for long sessions: background observation, reflection, and pruning workers over the session, deterministic model-free compaction summaries, and traceable recall by memory id."
kind: "package-reference"
---

# @deepseek-ai/dsh-observational-memory

English | [中文](README.zh.md)

## Summary

Long sessions lose their thread because compaction summarizes a summary, generation after generation. This plugin does the memory work while the session is still live: background passes record what happened, distill durable facts, and prune what no longer matters, in a store the plugin owns. When compaction runs it renders that memory deterministically, so the summary is a fold of durable records rather than a fresh model rewrite of the past. Every record cites the conversation it came from, so a later question can be traced back to its source.

## Table of Contents

- [Install](#install)
- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="install"></a>
## Install

Two commands, no profile editing. The domain package carries the bundle patch that mounts the ledger and swaps in the compaction engine; the tool package carries its own patch that mounts `memory_recall`. Both are bundle layers, so the loader composes them like any other.

```bash
dsh plugin --profile web add @deepseek-ai/dsh-observational-memory
dsh plugin --profile web add @deepseek-ai/dsh-tool-observational-memory
```

Neither package changes DeepSeek Harness. Memory is not a session event, so nothing has to be compiled into the harness for a session to stay readable — which is also why these packages install from npm like any other plugin.

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile and it works with no further configuration. Memory cadence, the worker model, the ledger location, and the active-memory budget are all configurable; the defaults suit a long coding session.

### Memory cadence scales with your model's context window

This is the plugin's main behavioural difference from a fixed-threshold memory design.

Thresholds are fractions of the **active model's real context window**, not absolute token counts tuned for one window size:

| Setting | Default | Meaning |
|---|---|---|
| `observeAfterRatio` | `0.05` | The observer runs after 5% of the window in new conversation |
| `reflectAfterRatio` | `0.10` | The reflector runs after 10% |

The window is read from the durable `request/context` event, so it costs no extra call and survives a reload. A 1M-token model therefore gets memory passes at a granularity suited to a 1M-token model, instead of the cadence a 128K-tuned constant would impose — neither firing far too often nor letting the window fill.

`observeAfterTokens` and `reflectAfterTokens` remain as the fallback used when no window is known, which is also exactly what a deployment gets if it sets a ratio to `0`.

### Worker model: the session model by default

Memory workers use the session's model unless you configure `model`. Setting a cheaper or faster route is a single field:

```yaml
- id: observational-memory
  name: '@deepseek-ai/dsh-observational-memory'
  config:
    model:
      provider: openrouter
      model: google/gemma-3-27b-it
      reasoningEffort: low
```

### Inspecting memory

Memory reaches the model as a block of id-tagged lines. The `/om` family is how a person checks those lines against the conversation behind them:

| Command | Shows |
|---|---|
| `/om status` | Record counts, the observer's coverage drift, the active pool against its budget, and per-worker watermarks |
| `/om view` | The exact block compaction would render right now |
| `/om show <id>` | One record, resolved through its provenance — a reflection to the observations it preserves, an observation to the entries it cites |

`/om show` reads sources from the observer's own fold rather than re-reading the log, so a source is shown exactly as it was when the record was written. The same resolution is available to the model as the [`memory_recall`](../../tool-observational-memory/README.md) tool, which it can call on any id it sees in its memory block.

Command output is logged (`command/run` and `command/done`), so asking about memory leaves a trace in the session's Trajectory even though the memory passes themselves do not.

### Where memory is stored

One JSON document per session, under `observational-memory` in the harness home (`$DSH_HOME`, or `~/.dsh`), written through a temporary file so a reader never sees a partial pass and read synchronously so both the model-visible block and the compaction renderer can reach it without awaiting anything.

This directory — not the session log — is what a backup has to carry for a session to keep its memory. Set `storageDir` to put it somewhere else.

### Configuration

| Setting | Default | Meaning |
|---|---|---|
| `observeAfterRatio` | `0.05` | Observer cadence as a fraction of the context window; `0` disables the ratio |
| `reflectAfterRatio` | `0.10` | Reflector cadence as a fraction of the context window; `0` disables the ratio |
| `observeAfterTokens` | `10000` | Absolute observer threshold, used when no window is known |
| `reflectAfterTokens` | `20000` | Absolute reflector threshold, used when no window is known |
| `observationsPoolMaxTokens` | `20000` | Active-observation budget at which compaction folds the whole ledger |
| `observationsPoolTargetTokens` | half of the maximum | Active-observation target the dropper maintains |
| `observerChunkMaxTokens` | one fifth of the memory model's window | Largest observer chunk; minimum `256` |
| `agentMaxTurns` | `16` | Turn cap for one background worker run |
| `model` | the session model | `{ provider, model, reasoningEffort }` for memory work |
| `workerMaxTokens` | adapter default | Largest generation for one worker call |
| `storageDir` | `$DSH_HOME/observational-memory` | Directory the ledger is written to |
| `passive` | `false` | Disable all background memory work |

Invalid values fail plugin load rather than degrading silently.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Memory is one store and three transitions over it.

- `applyObservations` appends source-cited records, deduplicated by a content-addressed id so the same text collapses to one record.
- `applyReflections` appends durable orientation facts, each citing the observations whose meaning it preserves. A reflection outlives the observations it cites.
- `applyDrops` moves an observation out of the active pool into a tombstone list rather than erasing it, so recall still resolves it by id.

Each transition refuses a pass whose watermark it has already applied. That is what makes a retried or duplicated pass a no-op instead of a double-apply.

The store around them caches per session and writes through on every mutation. It is published on the context (`ctx.reflect.provide`) rather than reached through a module singleton, because the compaction engine is mounted as its own loader row and cannot see this plugin's closure.

A background pass runs off the post-commit `session/event` feed when a `turn/end` lands, so a slow or failing memory pass can neither block nor fail the conversation. Each worker makes one `ctx.llm.stream()` call with a single tool schema, and every citation it returns is validated against the chunk it was given: an observation citing an entry outside its chunk is rejected whole, because a partially trusted citation set would corrupt provenance.

The compaction integration replaces the default engine with a subclass that overrides `summarize`. When memory is non-empty it returns the rendered text without calling a model; when memory is empty, or when the render would not shrink the region it replaces, it delegates to the default summarizer, so real context is never replaced by nothing.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`FREEZE.md`](../../FREEZE.md) — why memory left the session log, and what that costs.
- [`DESIGN.md`](../../DESIGN.md) — the design record this package was built from.
- [`src/store.ts`](src/store.ts) — the ledger, its transitions, and its durability rules.
- [`src/compaction-engine.ts`](src/compaction-engine.ts) — the `summarize` override and its shrink guard.
- [`tool-observational-memory`](../../tool-observational-memory/README.md) — the `memory_recall` tool that resolves ids through provenance.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Memory is deliberately **not** a session event. `Session.append` gives a plugin no way to mark its events `ignorable`, and the persistence read path refuses an unknown required event type when a session is opened — so an out-of-tree producer would append successfully, flush successfully, and then make the session permanently unreadable on the next resume. Declaring the types inside the harness is the other way out, but that makes the plugin a fork that cannot be installed by anyone else. [`FREEZE.md`](../../FREEZE.md) records the line that took the first approach and why it was abandoned.

The store is published on the context rather than exported as a module singleton for two reasons: the compaction engine is a separate loader row, and a per-context value is what keeps two applications in one process — or two mounts in one test file — from sharing a ledger.

Reads are synchronous by design. `ctx.systemPrompt.context()` takes a callback that must return a string, and compaction reads the ledger while the agent is between steps, so the store does one `readFileSync` per session and stays memory-resident after that.

`llm` is deliberately not in the plugin's `inject`. The ledger is useful without any model route, so a deployment with no LLM service keeps it instead of the plugin staying PENDING; only the observer waits for `llm`, through its own `ctx.inject`. The engine and the tool do declare `observationalMemoryStore`, so neither mounts where the ledger does not — a deployment without this package gets no `memory_recall` rather than a tool that can only answer "no memory".

`pnpm run verify` runs the whole gate: build, typecheck, 100% per-file coverage, and `scripts/check-artifacts.mjs`. The last one loads the built `lib/` under plain Node, which is the only thing that catches a packaging fault — `tsdown` splits a shared chunk out of the entry, and a `files` list that omits it produces a tarball that fails to import with `ERR_MODULE_NOT_FOUND`.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Memory snapshot and recall tool

#### What the model sees

Memory reaches the model through `ctx.systemPrompt.context()`, which the loop materializes as a durable, logged snapshot after retained history. The rendered block lists reflections and observations with their ids, and instructs the model to treat them as past records, to prefer the most recent observation when entries conflict, and not to redo work recorded as completed. The model also gains the generated `memory_recall` schema for resolving one memory id back to its source conversation.

#### Token effect

The snapshot is deduplicated by exact text, so an unchanged memory block adds no tokens and produces no new message. Background worker calls consume tokens but are not part of the conversation's context; compaction renders memory instead of paying for a summarization call.

#### KV Cache effect

Because unchanged memory produces no new message, the request prefix stays stable and the provider's cached prefix survives. Memory growth is what changes the prefix, and it changes it once per memory pass rather than on every step.


## Known Limitations and Deferred Work

- **Memory work bills against the session model, and DSH's accounting does not show it.** Observer and reflector calls are ordinary chat requests on whatever model the session uses. A direct `ctx.llm.stream()` call is not the agent loop, so nothing appends its usage to the log and `ctx.tokenMeter` never sees it: the cost is real, appears on the same bill as the conversation, and produces no warning or line item. Configure `model` to route memory work somewhere cheaper.

- **A slow or rate-limited provider slows memory capture too.** There is no LLM-side concurrency limiter in DSH, so a saturated provider affects the conversation and the workers together. Direct `ctx.llm.stream()` callers also get no automatic retry; this plugin implements bounded backoff itself.

- **`purpose` cannot be used to hint the adapter.** It is a closed union, so worker calls are ordinary requests that take the adapter's default reasoning policy.

- **Token estimation is a character heuristic.** Pool pressure uses the same characters-per-token ratio as the harness estimator, which underprices CJK text. Cadence and drop budgets are therefore approximate on CJK-heavy sessions.

- **Memory does not travel with the session log.** The ledger is a separate directory, so copying a session elsewhere does not carry its memory, and replaying a log does not reconstruct it. Back up `storageDir` alongside the session.

- **A fork does not inherit the parent's memory.** A fork gets a copy of the parent's event prefix, which is how it inherits conversation — but the ledger is keyed by session id, so the child starts empty. Re-observing the inherited prefix is how it catches up.

- **There is no memory surface in the web client.** This plugin is host-only, so checking memory means `/om` or asking the model. A browser view would need a host-to-page channel the plugin can register by itself, which this version does not attempt.

- **Rejected records are dropped, not repaired.** An observation whose citations fall outside its chunk is discarded rather than partially accepted. A model that misnumbers entries therefore loses those observations instead of recording them with suspect provenance.

**Deferred.** Editing or dropping a record from a command; cross-session reflection sharing; a browser explorer for the ledger.

-----

