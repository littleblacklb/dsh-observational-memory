---
description: "Observational memory for long sessions: background observation, reflection, and pruning workers over the session log, deterministic model-free compaction summaries, and traceable recall by memory id."
kind: "package-reference"
---

# @deepseek-ai/dsh-observational-memory

English | [中文](README.zh.md)

## Summary

Long sessions lose their thread because compaction summarizes a summary, generation after generation. This plugin does the memory work while the session is still live: background passes record what happened, distill durable facts, and prune what no longer matters, all written to the session log. When compaction runs it renders that memory deterministically, so the summary is a fold of durable records rather than a fresh model rewrite of the past. Every memory record cites the conversation it came from, so a later question can be traced back to its source.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile and it works with no further configuration. Memory cadence, the worker model, and the active-memory budget are all configurable; the defaults suit a long coding session.

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

### The Memory tab

The plugin contributes a **Memory** tab to the conversation view ring, beside Chat and Trajectory. It is laid out as a ledger and an inspector, the same shape as its sibling: a toolbar of record counts over a sticky column header and one-line rows, with the selected record's full text, its state, and the cited conversation opening in a details panel on the right. A fourth tab lists each compaction the resident history still holds, with the route that wrote it and exactly which messages it replaced — a checkpoint rendered from memory is marked as needing no model call.

The page exists to answer a question the memory block cannot answer for itself. The model is shown a line like `[a1b2c3d4e5f6] high …`; the tab is where a person checks that line against the conversation behind it, following a reflection to the observations it preserves and from there to the cited entries. Everything shown is already resident in the browser: records come from the `observationalMemory` session projection, which this plugin folds on the host and the session controller already streams to the page, and citations resolve against the same event window the Conversation and Trajectory views read. A compact reading joins the composer dock as well, under the composer and beside the session's turn and token pills: it shows how many observations and reflections the session is holding, and opens the breakdown by background pass. The browser half therefore carries no transport, no store, and no polling of its own.

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
| `passive` | `false` | Disable all background memory work |

Invalid values fail plugin load rather than degrading silently.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Memory is three log-only session events and one fold over them.

- `memory/observations-recorded` — timestamped, source-cited events drawn from the conversation.
- `memory/reflections-recorded` — durable orientation facts, each citing the observations whose meaning it preserves.
- `memory/observations-dropped` — tombstones. Dropping removes an observation from active memory but never from the log, so recall still resolves it.

The projection `observationalMemory` folds those events, and everything else reads that fold: the compaction renderer, the `memory_recall` tool, and the browser surface.

A background pass runs off the post-commit `session/event` feed when a `turn/end` lands, so a slow or failing memory pass can neither block nor fail the conversation. Each worker makes one `ctx.llm.stream()` call with a single tool schema, and every citation it returns is validated against the chunk it was given: an observation citing an entry outside its chunk is rejected whole, because a partially trusted citation set would corrupt provenance.

The compaction integration replaces the default engine with a subclass that overrides `summarize`. When folded memory is non-empty it returns the rendered text without calling a model; when memory is empty it delegates to the default summarizer, so real context is never replaced by nothing.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`docs/subsystems/compaction.md`](../../../docs/subsystems/compaction.md) — the compaction seam this plugin extends.
- [`docs/subsystems/session-projection.md`](../../../docs/subsystems/session-projection.md) — the fold the memory state lives in.
- [`dsh-session`](../../core/session/README.md) — the append-only log memory is written to.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The memory event vocabulary must be declared in this repository. `Session.append` gives a plugin no way to mark its events `ignorable`, and the persistence read path refuses an unknown required event type when a session is opened — so an out-of-tree producer would append successfully, flush successfully, and then make the session permanently unreadable on the next resume. `pnpm run gen-persistence-catalog` is what puts these event types into `KNOWN_SESSION_EVENT_TYPES`; `tests/vocabulary.spec.ts` is the gate that proves the round trip.

The browser half ships as its own artifact (`lib/client.js`) under the `./client` export, because the client module system reads that bundle as a unit and evaluates it in the page. It is built by the workspace client pass, not by the package's own host build, so a change to the strip requires that pass to run before the page will show it.

The client imports the shared vocabulary module rather than the logging one: the record shapes and the coverage rule are browser-safe, while id minting imports `node:crypto`.

`llm` is deliberately not in the plugin's `inject`. The ledger and its fold are useful without any model route, so a deployment with no LLM service keeps them instead of the plugin staying PENDING; only the observer waits for `llm`, through its own `ctx.inject`.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Memory snapshot and recall tool

#### What the model sees

Memory reaches the model through `ctx.systemPrompt.context()`, which the loop materializes as a durable, logged snapshot after retained history. The rendered block lists reflections and observations with their ids, and instructs the model to treat them as past records, to prefer the most recent observation when entries conflict, and not to redo work recorded as completed. The model also gains the generated [`memory_recall` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-observational-memory) for resolving one memory id back to its source conversation.

#### Token effect

The snapshot is deduplicated by exact text, so an unchanged memory block adds no tokens and produces no new message. Background worker calls consume tokens but are not part of the conversation's context; compaction renders folded memory instead of paying for a summarization call.

#### KV Cache effect

Because unchanged memory produces no new message, the request prefix stays stable and the provider's cached prefix survives. Memory growth is what changes the prefix, and it changes it once per memory pass rather than on every step.


## Known Limitations and Deferred Work

- **Memory work bills against the session model, and DSH's accounting does not show it.** Observer and reflector calls are ordinary chat requests on whatever model the session uses. A direct `ctx.llm.stream()` call is not the agent loop, so nothing appends its usage to the log and `ctx.tokenMeter` never sees it: the cost is real, appears on the same bill as the conversation, and produces no warning or line item. Configure `model` to route memory work somewhere cheaper.

- **A slow or rate-limited provider slows memory capture too.** There is no LLM-side concurrency limiter in DSH, so a saturated provider affects the conversation and the workers together. Direct `ctx.llm.stream()` callers also get no automatic retry; this plugin implements bounded backoff itself.

- **`purpose` cannot be used to hint the adapter.** It is a closed union, so worker calls are ordinary requests that take the adapter's default reasoning policy.

- **Token estimation is a character heuristic.** Pool pressure uses the same characters-per-token ratio as the harness estimator, which underprices CJK text. Cadence and drop budgets are therefore approximate on CJK-heavy sessions.

- **Memory is session-local.** Reflections and observations are not shared across sessions, and a fork carries the parent's memory forward without reconciling later divergence.

- **Rejected records are dropped, not repaired.** An observation whose citations fall outside its chunk is discarded rather than partially accepted. A model that misnumbers entries therefore loses those observations instead of recording them with suspect provenance.

- **The Memory tab is read-only.** Forcing a memory pass or dropping a selected record from the page would need a host Remote mutation surface, which this version does not expose; those actions are available to the model through its own tools, not to the user through the page.

- **The Memory tab shows only the history it has loaded.** Compactions are read from the browser's resident event window, so a compaction older than the loaded pages is not listed until the window pages back to it. Records themselves come from a projection covering the whole session and are always complete.

**Deferred.** Editing or dropping a record from the page; a docked right-sidebar presentation of the same explorer; a dedicated client card for the `memory_recall` tool result; and cross-session reflection sharing.

-----


