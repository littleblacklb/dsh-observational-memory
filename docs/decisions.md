# Decisions — the standalone plugin line

This is the decision log for **`main`**: the two installable packages
(`@deepseek-ai/dsh-observational-memory` and `@deepseek-ai/dsh-tool-observational-memory`)
that work in any DeepSeek Harness from npm, with no change to the harness tree.

It exists because `main` had no place to record a decision. Until now the only
design document in the repository described the *other* line — the frozen
session-event line — so a `main` decision had nowhere to go but into that
document, where it read as a description of something else. That document is now
[`docs/design.md`](design.md): it records the memory model both lines share, with
the sections that are frozen-line-only marked inline. Why the other line was
parked is in [`FREEZE.md`](../FREEZE.md). This file is where `main` records what it
decided and why.

Each entry states the decision, the reasoning that is not obvious from the code,
and what it costs. Two of them (§ "Memory cadence" and § "Pool sizing") were
recovered from `DESIGN.md`, where they had been written over the frozen line's
opposite defaults.

---

## Storage: a per-session store this plugin owns, not session events

**Decision: the ledger is a JSON document per session under
`$DSH_HOME/observational-memory/<sessionId>.json` (`storageDir` overrides the
directory), not a set of `memory/*` session events.**

The alternative was tried first and is the reason the other line is frozen. The
mechanism is not that session events are slow or awkward — it is that they are
*unsafe for an out-of-tree producer*. `Session.append` offers no way to mark an
event `ignorable`, and the persistence read path refuses to interpret a log
containing a required event type it does not know. The failure is therefore
delayed rather than loud: the append succeeds, the flush succeeds, and the
session becomes permanently unreadable on the next resume. Declaring the types
inside the harness fixes it but makes the plugin a fork nobody else can install,
which fails the acceptance standard — **a normal user installs the plugin and
changes nothing else**.

What this costs, stated plainly because it is user-visible:

- Memory is **not** reconstructable from the session log. Copying or replaying a
  session elsewhere does not carry its memory; the storage directory is what a
  backup has to include.
- A fork starts with a new ledger, because the child gets a new session id.
- There is no browser memory surface. Status is read through `/om status|view|show`
  and the `memory_recall` tool, both public plugin seams.

## Source scope: tool calls and tool results are source

**Decision: the observer's source is user text, assistant text including its
tool calls, and the text of tool results. Each source entry is capped at 20,000
characters (`MAX_SOURCE_TEXT_CHARS`), and plugin-injected user context is
excluded.**

The first version of this package excluded `tool/result` deliberately, on the
argument that tool output is bulky, is already summarised by the assistant message
that requested it, and would crowd conversation out of a fixed-size chunk. That
argument was wrong on both counts (`6952302`):

1. **In tool-heavy sessions the tool output *is* the evidence.** A failure
   message, a stack trace, or a file listing is what the assistant reasons from,
   and an observation that cannot cite it cannot be recalled later. The
   assistant's own note about what it ran is not a substitute for what came back.
2. **Excluding it starves the clock.** Cadence is measured in *source* tokens, so
   dropping the bulkiest part of a tool-heavy session keeps the observer under its
   threshold while the context window fills up anyway — the memory pass then fires
   *later* than the pressure it exists to relieve.

The size cap, not exclusion, is what bounds a chunk. This also matches the
reference implementation, whose transcript carries tool results inline.

The consequence worth carrying forward: **source tokens are not provider-reported
request tokens.** They are this package's own estimate over the entries above, so
`/om status` and the configured thresholds count a different quantity than
`ctx.tokenMeter` does.

## Memory cadence: fixed absolute thresholds by default

**Decision: cadence is two fixed source-token thresholds — `observeAfterTokens: 10000`
and `reflectAfterTokens: 20000` — exactly as the reference plugin ships.
Window-proportional cadence stays available, but only when a deployment asks for
it by setting a non-zero ratio.**

An earlier revision of this port inverted that default — ratios primary,
absolutes as fallback — on the argument that DSH can always learn the window, so
the reference's fixed counts were leaving capability on the table. The mechanism
behind that argument is real and still used: the window is available
synchronously from a projection, with no async call and no provider round trip,
and it survives reload because it is in the log.

```ts
ctx.sessionProjections.stateOf(session, 'contextPressure').contextWindow
```

What changed in `b26db28` is the **default**, on two grounds:

1. **Alignment.** Ordinary users install this plugin as a drop-in for the
   reference extension. A session's memory rhythm must not silently differ from
   it, and 10 000/20 000 source tokens is the cadence those users already expect.
2. **Stability.** A ratio makes cadence a function of whichever model the session
   runs on, so the same conversation observes at different points after a model
   switch. A fixed threshold is reproducible and easier to reason about when
   reading `/om status`.

| Setting | Default | Meaning |
|---|---|---|
| `observeAfterTokens` | `10000` | Observer fires after 10000 new source tokens — the default cadence |
| `reflectAfterTokens` | `20000` | Reflector fires after 20000 |
| `observeAfterRatio` | `0` | Disabled; a non-zero fraction switches the observer to `floor(window * ratio)` |
| `reflectAfterRatio` | `0` | Disabled; same for the reflector |

A ratio must be in `[0, 1)`; anything else fails plugin load rather than
degrading silently, which is the repository rule for misconfiguration. The
absolute threshold keeps a second role as the guaranteed fallback:
`ContextPressureState.contextWindow` is genuinely optional, so a ratio of `0`, an
unknown window, and a window too small to yield a usable threshold all resolve to
the absolute count. A deployment that wants window-proportional cadence sets a
ratio in `(0, 1)` — a 1M-token model with `observeAfterRatio: 0.05` then observes
every 50 000 tokens.

Bounding the observer chunk is a separate question and **stays dynamic**, because
it is a safety cap rather than a cadence: `observerChunkMaxTokens` derives from a
fraction of the memory model's own window (`floor(window * 0.2)`, minimum `256`),
with the reference's 60 000 constant as the unknown-window fallback.

> Note the deliberate divergence from the parked line, which defaults to
> `observeAfterRatio: 0.05` / `reflectAfterRatio: 0.10`. The two lines disagree
> here on purpose; neither number is a typo for the other.

## Pool sizing: `observationsPoolMaxTokens` is a bound, not a trigger

**Decision: `observationsPoolMaxTokens` exists to derive and validate
`observationsPoolTargetTokens`, and nothing reads it at runtime.**

The dropper and the pool metrics work against the *target*, which defaults to
`floor(max / 2)` — so `20000` yields a `10000` target. A configured target must be
a positive integer strictly below the maximum, or plugin load fails. The
consequence worth knowing: **lowering the maximum alone changes cadence only
through the derived target**, and raising it without also setting a target changes
nothing at all.

This line has **no pool-max full-fold trigger**. Folding the whole ledger when the
pool hits its maximum is a rule of the frozen session-event line, where the fold
was the only way to bound what the log carried. Here the store is already bounded
by the dropper, so a second trigger would be a scheduler nobody asked for.

(Corrected in `aca1853`, which fixed the config docs and README that had described
the maximum as if it were a live trigger.)

## Worker cost: memory work bills the session model and is invisible to the meter

**Decision: workers use the session model by default, with an optional `model`
override as the documented escape hatch — and the cost caveat is stated
prominently in the README rather than buried.**

All of the following are verified against source, not inferred:

- **Memory work bills against the session model.** Observer and reflector calls
  are ordinary chat requests on whatever model the session uses. On a premium
  model that is real money on the same bill as the conversation.
- **It is invisible to DSH's own accounting.** A direct `ctx.llm.stream()` call is
  not the agent loop, so nothing appends its usage to the log and `ctx.tokenMeter`
  never sees it. The user gets no warning and no line item.
- **Worker latency inherits the session model's latency.** There is no LLM-side
  concurrency limiter in DSH, so a saturated provider affects the conversation and
  the workers together.
- **No automatic retry.** `dsh-llm-retry` covers only the loop's
  `agent/request-error`; direct `ctx.llm.stream()` callers are single-attempt, so
  the plugin implements its own bounded backoff and honours
  `LlmFailure.providerRetryAfterMs`.
- **`purpose` cannot hint the adapter.** It is a closed union
  (`'compaction' | 'session-title'`), so worker calls take the adapter's default
  reasoning policy.

Setting a dedicated cheaper model is a single settings field, which is why the
override is the mitigation rather than a promise to account for the spend.

## Package split: the ledger and the recall tool ship as separate bundles

**Decision: two packages, and the tool is optional — but the tool requires the
ledger to be installed as a direct profile dependency.**

`@deepseek-ai/dsh-observational-memory` owns the ledger, the background workers,
the `/om` commands, and the compaction integration. It must be installed first.
`@deepseek-ai/dsh-tool-observational-memory` adds the `memory_recall` model tool
and declares `observationalMemoryStore`, so it never mounts where the ledger does
not.

The verified installation shapes, which the README states as fact because they
were measured:

| Installed | Result |
|---|---|
| ledger only | 2 ACTIVE rows, store ready |
| ledger + tool | 3 ACTIVE rows |
| tool only | **fails to start** — `pending (waiting for service: observationalMemoryStore)` |

## Smaller decisions worth not re-litigating

- **`llm` is not in the plugin's `inject`.** The ledger and its fold are useful
  with no model route, so a deployment without an LLM service keeps the plugin
  instead of it staying PENDING. Only the observer waits for `llm`, through its
  own `ctx.inject`.
- **The store is published on the context (`ctx.reflect.provide`), not exported
  as a module singleton.** The compaction engine is mounted as its own loader row
  and cannot see this plugin's closure; a per-context value is also what keeps two
  applications in one process from sharing a ledger.
- **Reads are synchronous.** `ctx.systemPrompt.context()` takes a callback that
  must return a string, and compaction reads the ledger while the agent is between
  steps, so the store does one `readFileSync` per session and stays memory-resident
  after that.
- **Proactive compaction (replaces the earlier no-custom-trigger decision).**
  Pi 3.1.4's 81K calibrated source clock starts with the retained tail after
  compaction. This standalone plugin now checks that clock on the first pre-step
  of the next turn, after DSH's existing pressure check; unlike Pi's idle-after-
  turn trigger it cannot compact until another turn begins. It uses the public
  `compactRegion` transaction (never an emulated open turn or private bundle
  import) and a single-flight guard. Current surface messages are priced in
  full, without the observer's 20K-character clipping; system/plugin/checkpoint
  messages are excluded. Both proactive and native pressure compaction now keep
  a default recent tail capped at 20K (smaller on small windows) instead of the
  base backend's 16%-of-window default. Overflow and manual paths are unchanged.
  If committed observation coverage does not reach the entire selected region,
  a prior plugin checkpoint needs preservation, or memory cannot shrink it,
  `summarize` delegates to the native summarizer. Ledger `passive` also disables
  early triggering and memory-rendered checkpoints, not native pressure.
- **The compaction render must be strictly smaller** than the region it replaces,
  or it delegates to the default summarizer. Real context is never replaced by
  nothing, and an empty projection always delegates.
- **Bilingual READMEs carry equal authority, with Chinese as the default.**
  `pnpm run check:readme-pairing` enforces structural equivalence (heading tree,
  code blocks, list and table shapes, link targets) between every `README.md`
  (Chinese — the page a reader lands on) and its `README.en.md`. Wording
  differences are the point; structure differences are drift — so an edit to one
  side is incomplete until the other side is brought along.
