# dsh-observational-memory — Design & Layout

A DeepSeek Harness port of [`pi-observational-memory`](https://github.com/elpapi42/pi-observational-memory), plus a
**Memory Traceability** UI panel with traceable compaction.

Status: Phases 0–2 implemented; see [Implementation status](#implementation-status).

## Implementation status

Landed in `packages/context/observational-memory/` — 102 tests, 100% per-file coverage, typecheck clean, and the
`gen-persistence-catalog`, `verify-export-jsdoc`, `check-workspace-constraints`, and package-README gates all pass.

| Phase | State | Notes |
|---|---|---|
| 0 — vocabulary & reopen gate | ✅ done | Three `memory/*` events declared, catalog regenerated, round trip proven |
| 1 — records, pool, render, fold | ✅ done | Builders validate every citation against an allowlist |
| 2 — observer worker | ✅ done | Cadence gating, chunking, single-flight, teardown |
| 3 — reflector + dropper | ✅ done | Sequential consolidation; the dropper needs a same-run reflection |
| 4 — compaction engine | ✅ done | A real compaction renders from memory with **zero model calls**; boots in a live profile |
| 5 — recall + `/om` | ✅ done | `memory_recall` resolves through the async query seam; `/om status\|view\|show` |
| 6–7 | ✅ done | Memory tab in the conversation view ring, beside Chat and Trajectory; model-visible channel |
| 8 | ✅ done | Tab relocated from the composer strip to the view ring on user feedback; Compactions tab added |

Two packages, 263 tests, 100% per-file coverage, and every applicable gate green
(`gen-persistence-catalog`, `gen-tool-catalog`, `verify-export-jsdoc`, `check-workspace-constraints`, and the three
package-README gates).

Deviations from the plan above, all recorded where they were discovered:

- **`llm` is not in `inject`.** The ledger and its fold are useful with no model route, so the plugin must not stay
  PENDING on a deployment that has none. Only the observer waits for `llm`, through its own `ctx.inject`.
- **A second projection was needed.** The observer reads a conversation surface, and `Session.snapshotEvents()` is
  deprecated for new production calls, so `observationSource` folds that surface from the log.
- **Pool accounting is local.** `ctx.tokenMeter` is a concrete service, not a seam, and pricing per observation through
  it would couple cadence to unrelated context growth; the pool uses the same chars-per-token ratio directly.
- **A patch cannot re-point a row's module.** `name` on an id-targeted patch is a **match assertion**, not an
  assignment: `applyEntryPatches` warns `name mismatch … skipping` and never writes it. §4.5's original
  `- id: compaction-basic` + `name: …/startup` shape was therefore wrong, and the boot-time diagnostic is what exposed
  it. The working shape is *disable the shipped row, insert the engine under a distinct id*.
- **The engine is mounted, not constructed.** Because compaction is a singleton that Cordis refuses to provide twice, a
  second engine fails the whole tree with `service "compaction" has been registered`. The replacement row must be the
  only provider, which is why the patch disables the original rather than adding beside it.
- **The engine declares `sessionProjections`.** It reads the memory fold, so the registry is a real dependency; without
  it the row would activate and fail at the first compaction instead of waiting.
- **`tests/vocabulary.spec.ts` folds a seeded session through the registered definition**, not through `stateOf`: the
  projection registry eagerly initializes a cell for a `session/created` carry, which a seeded session fires at full
  seed length, so `stateOf` on a seeded session reports the initial state. Durability is proven by the persistence read,
  and the fold by direct unit tests.

---

**Read §4.1b first.** The investigation turned up one hard constraint that shapes everything else: the memory ledger
cannot be *durably* written by an out-of-tree plugin. `Session.append` gives a plugin no way to mark its events
`ignorable`, and the persistence layer refuses unknown required event types when a session is opened. The consequence is
a delayed brick rather than a loud failure, which is worse. The packages therefore live in the DSH repository, and that
pulls in the repo's gates (generated catalogs, 100% per-file coverage, bilingual docs, an Agent Note). The
two-package split, the mounting steps, and the roadmap all follow from that one fact.

The plugin *mechanism* is unaffected — external plugins work, and one (`dsh-better-sidebar`) runs in this very
installation. It is specifically the session-event vocabulary that has to be declared in-repo.

---

## 1. The one-sentence idea

Keep the reference plugin's *memory model* (observations → reflections → drops, folded from an append-only ledger,
rendered deterministically at compaction time) and replace its *plumbing* with the DSH primitives that do the same job
natively — because DSH already has a durable append-only log, an incremental fold engine, a replaceable compaction
backend, and a browser UI slot system.

The port is not a rewrite. It is roughly: **the ledger becomes session events, the fold becomes a session projection,
the compaction hook becomes a `CompactionEngine` subclass, and the `/om:view` command becomes a Memory tab in the
conversation view ring.**

---

## 2. What the reference plugin does (the part worth keeping)

Three background LLM workers run *during* the session so that compaction never has to think:

| Worker | Trigger | Writes | Purpose |
|---|---|---|---|
| **Observer** | `observeAfterTokens` (10k) of new source tokens | `om.observations.recorded` | Timestamped, source-cited events |
| **Reflector** | `reflectAfterTokens` (20k) | `om.reflections.recorded` | Durable, scarce orientation facts |
| **Dropper** | only after a *same-run* non-empty reflection, when the active pool exceeds `observationsPoolTargetTokens` | `om.observations.dropped` | Tombstones to bound active memory |

At compaction time the hook does **zero** model work: it folds the ledger to the cut point and renders Markdown. If the
projection is empty it declines, and Pi's native summarizer runs instead. That single rule — *never replace real context
with an empty summary* — is the most important behavioral invariant in the whole design.

Memory ids are content-addressed: `sha256(content).hex.slice(0, 12)`. Ids are what make memory **traceable**: an
observation carries `sourceEntryIds`, a reflection carries `supportingObservationIds`, and the agent-facing `recall`
tool walks `reflection → observations → raw source entries`.

---

## 3. What DSH gives us for free

This is why the port is smaller than it looks.

| Reference concept | DSH native equivalent | Evidence |
|---|---|---|
| Pi branch entry log, `pi.appendEntry(customType, data)` | `ctx.sessions` append-only event log + `SessionEventMap` declaration merging | `packages/core/session/src/types.ts:269` |
| `om.observations.recorded` / `reflections` / `dropped` ledger entries | Three new session event types, declared by merge | `packages/todo/tool-todo/src/types.ts:28` is the exact template |
| `foldLedger` / `fullProjection` / `visibleProjection` / `diffProjection` | `ctx.sessionProjections.register(definition)` — incremental fold, persisted, and **automatically streamed to the browser** | `packages/goal/goal/src/index.ts:258` |
| `session_before_compact` hook returning a summary | Subclass `BasicCompactionEngine` and override its single documented hook `summarize()` | `packages/compaction/compaction-basic/src/index.ts:231` |
| `turn_end` / `agent_settled` triggers | `session/event` is a post-commit, fire-and-forget feed — watch `turn/end` there. There is **no** `agent/turn-end` and no `agent_settled` | `packages/core/session/src/index.ts:61-72`; `packages/core/agent/src/runtime-types.ts:246-404` |
| `pi.registerTool(recall)` | `ctx.tools` registry | `docs/cookbook/adding-a-tool.md` |
| `/om:status`, `/om:view` | `/om` command family via the commands seam | `docs/subsystems/commands.md` |
| Worker `agentLoop` + `streamSimple` + ~200 lines of Pi auth logic | **One call:** `ctx.llm.stream({ provider, model, messages, system, tools })` + `BlockAssembler` — routing, auth and prefix-cache handling are the adapter's job | `packages/llm/llm/src/types.ts:419` |
| `/om:view` clipboard dump | **A real UI**: a Memory tab in the conversation view ring reading `useProjection('observationalMemory')` | `docs/subsystems/slots.md` |
| Pi settings JSON + `PI_OBSERVATIONAL_MEMORY_PASSIVE` | Schemastery `Config` + the Settings → Plugins config card | `packages/client/ui-settings-plugins/README.md` |
| Token clocks (`estimateTokens`, `ctx.getContextUsage()`) | `ctx.tokenMeter.measure()` / `estimateMessage()`, or the `contextPressure` projection for the cheap read | `packages/llm/token-meter/src/index.ts:100` |

Three consequences worth stating plainly:

1. **The viewer needs almost no new data plumbing.** Because memory lives in a session projection, the host folds it and
   the browser already receives it over the existing `session/projection` frames. No custom RPC, no polling, no
   bespoke WebSocket route.
2. **The compaction worker's auth problem disappears.** The reference plugin's most fragile module
   (`runtime.ts` — provider registry lookup, OAuth, Bedrock/Vertex ambient auth, opencode headers) has no analogue here.
3. **But the ledger cannot be injected into a model request by hand.** "Model-visible ⟺ logged" is enforced by a runtime
   invariant that diff-compares every dispatched request against `session.deriveMessages()`
   (`packages/core/agent-loop/src/invariant.ts:19-56`), and loop requests are deep-frozen. There is no way to splice
   memory text into the outgoing request. See §4.6 for the three legal channels.

Things DSH does **not** give us, which the plan must therefore own:

- **No `purpose` for auxiliary calls.** `GenerateOptions.purpose` is a closed union `'compaction' | 'session-title'` and
  is not merge-extensible — memory workers omit it.
- **No retry on direct `ctx.llm.stream()` calls**, and no global LLM concurrency limiter. Adapter failures arrive as a
  terminal `finish` chunk rather than a throw, so the worker must branch on `assembler.finish` explicitly. We bound and
  back off ourselves.
- **`ctx.tokenMeter` is a concrete service, not a seam** — no provider registry, no swap point. Its estimator is a flat
  4-chars-per-token heuristic that underprices CJK. Fine for our clocks; worth knowing when tuning thresholds.

---

## 4. Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│ packages/context/observational-memory  (host half + client half)      │
│                                                                       │
│  session events (durable, the ledger)                                 │
│    memory/observations-recorded { observations[], coversUpToSeq }     │
│    memory/reflections-recorded  { reflections[],  coversUpToSeq }     │
│    memory/observations-dropped  { observationIds[], coversUpToSeq }   │
│                     │                                                 │
│                     ▼  ctx.sessionProjections.register(...)           │
│  projection 'observationalMemory'   ← also the browser's data source  │
│    { observations[], reflections[], dropped[],                        │
│      compactionTraces[], clocks{}, poolTokens }                       │
│                     │                                                 │
│      ┌──────────────┼────────────────┬─────────────────────┐          │
│      ▼              ▼                ▼                     ▼          │
│  recall tool   /om commands   MemoryCompactionEngine   browser panel  │
│  (evidence)    (status/view)  (deterministic render)   (sidebar tab)  │
│                                                                       │
│  model-visible channel (⩽ logged):                                    │
│    ctx.systemPrompt.context()  |  agent/pre-step injection            │
│                                                                       │
│  background workers (off session/event turn/end, non-blocking)        │
│    observer → reflector → dropper   via ctx.llm.stream()              │
└───────────────────────────────────────────────────────────────────────┘
```

### 4.1 Ledger = session events

Three event types, `coversUpToSeq` replacing `coversUpToId` (DSH ids are `SessionSeq`):

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One observer pass over a closed turn. Log-only; never joins the surface. */
    'memory/observations-recorded': { observations: Observation[]; coversUpToSeq: SessionSeq }
    /** One reflector pass. Log-only. */
    'memory/reflections-recorded':  { reflections: Reflection[];  coversUpToSeq: SessionSeq }
    /** Tombstones; they remove ids from active memory but never delete history. */
    'memory/observations-dropped':  { observationIds: string[];   coversUpToSeq: SessionSeq }
  }
}
```

`coversUpToSeq` stays what it is in the reference: a **progress watermark and projection boundary, not provenance**.
Provenance is `sourceEntryIds` / `supportingObservationIds`, and it is what makes the UI traceable.

Each member must be a bare `'scope/name'` property signature with JSDoc prose and **no `@mode` tag**
(`gen-persistence-catalog.ts:200-240` validates exactly this). Append is log-only, so exactly two arguments:
`session.append('memory/observations-recorded', { observations, coversUpToSeq })`.

**No `SESSION_FORMAT_VERSION` bump is required.** `packages/core/session/src/types.ts:79-92`: adding an ordinary event
type does not bump; the per-event `ignorable` guard covers vocabulary growth. Only header shape, the `SessionEvent`
envelope, core event semantics, or the surface mechanism bump it.

### 4.1b ⚠️ The hard constraint: this package must live in this repository

This is the single most consequential finding of the investigation, and it overrides the obvious "write it as an
out-of-tree plugin" plan.

`Session.append` builds the event envelope itself and **cannot set `ignorable`** — its `opts` parameter is typed
`T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []`, and `SurfaceIntent` carries only `surfaceOp` /
`sourceEventSeqs` (`packages/core/session/src/index.ts:710-738`, `types.ts:442-450`). There is no route by which a
plugin can mark its own appended events ignorable.

Meanwhile the persistence read path refuses any event type outside the repository-generated vocabulary:

```ts
// packages/session/session-persistence/src/storage-contract.ts:75
if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw unsupported(...)
```

and `KNOWN_SESSION_EVENT_TYPES` is generated by `scripts/gen-persistence-catalog.ts` over the glob
**`packages/*/*/src/**/*.ts`**. Its own JSDoc states: *"Downstream (out-of-repo) plugin events are outside this list by
construction."*

Consequence: **the ledger must be declared in this repository.** The precise failure sequence matters, because it is
what dictates the workflow:

| Step | Out-of-repo plugin |
|---|---|
| plugin code loads | ✅ works — external bundles are fully supported (§2.9 note below) |
| `session.append('memory/…')` in memory | ✅ succeeds (`Session.append` validates payload JSON, not vocabulary) |
| flush to disk | ✅ succeeds — `appendLines` writes without a vocabulary check (`session-persistence-jsonl/src/index.ts:1246-1274`) |
| **session reopen** (resume, reload, restart, fork) | ❌ **throws** — `validateStoredEvents` runs on the read/open path (`index.ts:627,758`, `generation.ts:524`) and refuses the log |

So it is not an immediate crash; it is a **delayed, persistent brick**. The live process keeps working and keeps
appending, and the session becomes permanently unreadable the next time it is opened. That is worse than a loud
failure, not better — it fails after you have accumulated memory you care about.

Two notes so this is not over-read:

- **The plugin mechanism itself is fine out-of-repo.** A verified third-party plugin (`dsh-better-sidebar`, from npm)
  runs against this installation today, and unbuilt TypeScript bundles load under the `pnpm dsh` source launch. The
  blocker is specifically *session-event vocabulary*, not plugin loading.
- **`open()` is the gate, not `append()`**, so a plugin that stores nothing in the session log is unaffected. We are not
  taking that route: keeping memory in the log out-of-band would forfeit both reload durability and the
  `sessionQuery.traceEvent` replacement chain that makes cross-compaction traceability work (§4.7).

So the packages are sited at `packages/context/…`, which makes the generator emit the three event types into
`known-event-types.ts` and `docs/persistence-catalog.md`.

This also retires the "prototype in a scratch directory behind a `--patch` overlay" idea from the tooling report: the
tool-catalog gate would not see such a package, but the ledger would still brick the session. Phase 0 must land the
event declarations in-repo.

The design rationale is in
`.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`. It rejected
"register mounted plugin event names as known" precisely because *"event-name registration alone does not classify
whether absence is safe"* — omission safety must be a stored-record property, not a composition-dependent one. Our
events are **not** safe to omit (they *are* the memory), so `ignorable` would be the wrong marker for them even if it
were reachable. Required-on-read is correct.

Cost of the in-repo decision: the package must satisfy repo conventions — `pnpm run gen-persistence-catalog`,
`doc-sync`, per-file 100% coverage in `test:coverage`, JSDoc on every export, an Agent Note, bilingual README.

### 4.2 Fold = session projection

`ctx.sessionProjections.register({ key: 'observationalMemory', ... })` folds those three events plus `compaction/*`
events into one client-visible value. This single registration replaces four hand-written projection functions in the
reference (`fold`, `fullProjection`, `visibleProjection`, `diffProjection`) and is the direct data source for the panel.

Verified this is a first-class plugin extension point, not an internal (`packages/session/session-projection/src/index.ts:233`):
a registrant supplies `key`, `stateVersion`, `init(header)`, and a pure synchronous `apply(state, event)`. The registry
subscribes to `session/event` once and eagerly drives **every** registered unit, including replaying the in-memory log
for a unit registered after events already flowed — so a plugin mounted mid-session still sees full history.
Registration is an effect on the calling fiber, the key's client-visible value must be plain JSON, and `apply` must
return the **same state reference** when uninterested. Read host-side with
`ctx.sessionProjections.stateOf(session, 'observationalMemory')`.

This gets crash-resume, fork, and cold-read for free — the reference's hand-rolled fold had none of that.

Projected value (wire-JSON, plain data only):

```ts
type ObservationalMemoryState = {
  observations: Observation[]     // active only, chronological
  dropped: Observation[]          // tombstoned, kept for recall + UI
  reflections: Reflection[]
  compactions: CompactionTrace[]  // see 4.5
  clocks: { observer: number; reflector: number; dropper: number; compaction: number }
  poolTokens: { active: number; visible: number; reflections: number }
  worker: { inFlight: boolean; lastError?: string }
}
```

### 4.3 Workers = one LLM call each

**Decision: workers use the session model by default**, with an optional `model` override. The README must state the
cost caveat prominently rather than burying it — this is a real, user-visible consequence.

One module per worker, mirroring the reference's prompt/tool/validation split:

```
src/workers/observer.ts    + prompts/observer.ts
src/workers/reflector.ts   + prompts/reflector.ts
src/workers/dropper.ts     + prompts/dropper.ts
```

Each worker: build an oldest-first, size-capped chunk of uncovered source entries → `ctx.llm.stream()` with **one tool
schema** (`record_observations` / `record_reflections` / `drop_observations`) → assemble with `BlockAssembler` → collect
the structured call → validate against an allowlist in code → append the event only if non-empty.

Structured output is taken from the **tool call**, never parsed out of assistant text — same as the reference, and it is
the right call: schema validation comes free.

Three mechanical details that differ from the reference's worker loop and must be handled:

1. **No `sessionId`, no `purpose`.** Passing `sessionId` forces a `ctx.sessions.flush()` of the main session before the
   worker dispatches (`session-checkpoint-policy/src/index.ts:64-67`); `purpose` is a closed union. Omit both.
2. **Failures are a chunk, not a throw.** Branch on `assembler.finish`. The observer must distinguish *deliberate empty*
   from *stream error* — the reference needed `ObserverStreamError` for exactly this, and it remains necessary.
3. **No retry, no concurrency cap.** Wrap the call in our own bounded retry with backoff, and keep the in-flight lock.

The worker-model caveats the README must carry (all verified against source, not guessed):

- **Memory work bills against the session model.** Observer and reflector calls are ordinary chat requests on whatever
  model the session uses — no separate cheaper route unless one is configured. On a premium model this is a real cost
  that appears on the same bill as the conversation.
- **And it is invisible to DSH's own accounting.** A direct `ctx.llm.stream()` call is not the agent loop, so nothing
  appends its usage to the log; `ctx.tokenMeter` never sees it. The user gets no warning and no line item. Say so
  plainly, and point at the `model` override as the mitigation.
- **Worker latency inherits the session model's latency.** A slow or rate-limited primary model slows memory capture
  too. There is no LLM-side concurrency limiter in DSH, so a saturated provider affects both the conversation and the
  workers.
- **No automatic retry.** `dsh-llm-retry` only covers the loop's `agent/request-error`; direct `ctx.llm.stream()`
  callers are single-attempt. We implement bounded backoff ourselves and honour `LlmFailure.providerRetryAfterMs`.
- **`purpose` cannot be used to hint the adapter.** It is a closed union (`'compaction' | 'session-title'`), so worker
  calls are ordinary requests that take the adapter's default reasoning policy.

Setting a dedicated cheap model is a single settings field (`model`), which is the documented escape hatch.

### 4.3b Window-proportional thresholds (a headline feature)

**Decision: memory cadence scales with the active model's real context window, rather than using fixed absolute token
counts.**

The reference plugin defaults to fixed counts (`observeAfterTokens: 10000`, `reflectAfterTokens: 20000`) and only offers
a ratio mode as an *opt-in escape hatch*, because Pi cannot reliably learn the active model's context window — its own
README calls the ratio mode the choice for "a large-context model (e.g. 1M tokens)" where the calibrated default
"preempts compaction at ~81K, wasting most of the window."

DSH removes that limitation. The context window is available **synchronously from a projection**:

```ts
ctx.sessionProjections.stateOf(session, 'contextPressure').contextWindow
```

backed by the durable `request/context` event (`packages/core/session/src/types.ts:242-251`). No async call, no
provider round-trip, and the value survives reload because it is in the log. (`ctx.llm.resolveModelInfo(...)` is the
other route, but it is async and can throw `NO_ADAPTER`.)

So the port inverts the default: **ratios are primary, absolute tokens are the fallback.**

| Setting | Default | Meaning |
|---|---|---|
| `observeAfterRatio` | `0.05` | observer fires after 5% of the window in new source tokens |
| `reflectAfterRatio` | `0.10` | reflector fires after 10% |
| `observeAfterTokens` | `10000` | absolute fallback, used only when `contextWindow` is unknown |
| `reflectAfterTokens` | `20000` | absolute fallback |

This is worth stating plainly in the README as a feature, because it is a real behavioural improvement rather than a
detail:

> **Memory cadence scales with your model's context window.** Rather than fixed token counts tuned for a 128K window,
> observation and reflection cadence is a fraction of whatever window your model actually has — so a 1M-token model
> gets memory passes at a sensible granularity instead of either firing far too often or hogging the window.

The fallback matters and must not be an afterthought: `contextWindow` is genuinely optional
(`ContextPressureState.contextWindow?: number`), and an adapter that declines to advertise one leaves it absent. In that
case the absolute thresholds apply, which is exactly the reference's calibrated behaviour. A deployment that wants
fixed behaviour unconditionally can simply set the ratios to `0` and rely on the fallback.

Bounding the observer chunk is the same story: `observerChunkMaxTokens` derives from a **fraction of the memory model's
own window** (`floor(contextWindow * 0.2)`, minimum `256`) rather than the reference's hardcoded 60 000 fallback — but
keeps the same fallback constant when the window is unknown.

### 4.4 How memory becomes model-visible

Because of the "Model-visible ⟺ logged" invariant (§3), memory text reaches the model through a logged channel.
**Decision: `ctx.systemPrompt.context()`.**

`context()` contributions are materialized by the loop as a durable, logged user-role snapshot appended after retained
history — but only when the text actually changed or compaction removed it (`agent-loop/src/runtime-context.ts:147-158`).
Dedup is by exact text, and the rendered node is prefixed *"Current runtime context. This snapshot supersedes earlier
runtime-context snapshots."*

That is a better fit than injection for three reasons:

1. **No prefix churn.** An unchanged memory block costs zero new tokens and produces no new message, so the provider's
   KV cache survives. `agent/pre-step` injection appends a fresh `user/message` on every step that reloads it.
2. **Supersede semantics are built in.** The snapshot framing already tells the model that the newest block replaces the
   earlier one, which is exactly memory semantics and maps onto the reference's `CONTEXT_USAGE_INSTRUCTIONS` preamble.
3. **It is logged by construction**, so the invariant holds without us threading a new event type.

The rejected alternative, for the record: `agent/pre-step` appending
`createUserMessage({ source: { kind: 'plugin', form: 'snapshot', … } })` (the pattern all four `packages/context/*`
plugins use). It works and has the most explicit supersede vocabulary, but it reloads the block every step and churns
the request prefix. Revisit only if `context()` proves too coarse — for instance if we need different memory at
different steps within one turn.

**Never append our own `system/message`** — the loop's `SystemPromptProjection` owns every system node and will
reconcile a foreign one away (`runtime-context.ts:60-106`).

### 4.5 Compaction = the `summarize()` subclass hook
`BasicCompactionEngine` documents `summarize()` as *"the sole subclass customization hook"*. So:

```ts
class MemoryCompactionEngine extends BasicCompactionEngine {
  protected override async summarize(input, agent, signal): Promise<SummaryResult> {
    const rendered = renderMemory(this.ctx, agent)      // model-free, deterministic
    if (rendered.length === 0) return super.summarize(input, agent, signal)  // ← the invariant
    return { summary: [{ type: 'text', text: rendered }], provider: 'observational-memory', model: 'deterministic' }
  }
}
```

Confirmed against source: the hook is `protected async summarize(input, agent, signal): Promise<SummaryResult>`
(`packages/compaction/compaction-basic/src/index.ts:236`), so `agent.session` — the whole ledger — is directly in
scope. Subclassing is the supported path, not a hack; the package's own test suite subclasses it four times
(`compaction-basic.spec.ts:255`, `:1228`, `compaction-loop-repro.spec.ts:27`, `manual-compaction.spec.ts:41`).

`SummaryResult` has an explicit **model-free variant**: return without `llmStreamCall` (optionally with `rawOutput`) and
the `compaction/summary` event is recorded unmarked, i.e. "produced by a template or other summarizer". `provider` and
`model` are still required strings — stamp `provider: 'observational-memory'`, `model: 'deterministic'`.

Everything else is inherited from `compactSurfaceRegion` (`region.ts:173-275`): the
`compaction/start → compaction/summary → compaction/end` lock bracket, the shrink check, and the `user/message`
replacement carrying `surfaceOp: { op: 'replace', startSeq, endSeq }` + `compactCheckpointSource(compactionId)`.

**Mounting it is a row replacement, and that is mandatory — not optional.** `CompactionEngine` is
`export abstract class … extends Service { super(ctx, 'compaction') }`, and Cordis `provide()` **throws when the name is
already provided** (`vendor/cordis/src/reflect.ts:33-38`). So a second provider cannot be mounted alongside
`@deepseek-ai/dsh-compaction-basic`; the base bundle's row must be re-pointed. A `PatchOptions` row carries both `id`
and `name` (`vendor/include/src/index.ts:145`), so our patch does exactly that:

```yaml
# our cordis.patch.yml
- insert:
    - id: observational-memory
      name: 'dsh-observational-memory'
- id: compaction-basic
  name: 'dsh-observational-memory/compaction-engine'
```

`anchorInsertedPluginNames` resolves a relative `name` against the patch file's own directory
(`packages/boot/app-boot/src/index.ts:325`).

Two inheritance traps to design around:

1. **A pure-deterministic backend must also override `compactIfNeeded`.** The automatic pressure path requires
   `await ctx.llm.resolveModelInfo(provider, model, signal)).context` to exist or it throws
   `TargetPressureConfigError` (`index.ts:294-305`) — a memory-only engine must not depend on a routed summarization
   model being resolvable.
2. **The replacement must be strictly smaller.** `region.ts:402-407` throws when the checkpoint is not smaller than the
   shadowed route token count. A long memory render over a short shadowed span would throw, so the renderer needs a
   size guard that falls back to `super.summarize(...)`.

### 4.5b Proactive compaction: inherit DSH's, do not add our own

The reference plugin drives its own compaction trigger because *Pi has no automatic compaction*. **DSH does**, and it
ships enabled.

`BasicCompactionEngine` defaults `auto: true` (`config.ts:95`) and registers, in its own constructor
(`index.ts:138-166`):

| Trigger | Mechanism | Covers |
|---|---|---|
| step pressure | `ctx.on('agent/pre-step')` → `compactIfNeeded(agent, 'pressure', signal)` | normal context pressure, between steps |
| overflow recovery | `ctx.on('agent/request-error')` → `compactIfNeeded(agent, 'context-overflow', signal)` | provider-confirmed context overflow |

Pressure is computed against the **live context window**: `thresholdTokens = floor(contextWindow * thresholdRatio)`
and `retainTokens = floor(contextWindow * retainRatio)` (`config.ts:144-147`). On the configured 1M-token model that is
a window-proportional trigger, not the reference's fixed 81k estimate — strictly more correct.

Two consequences:

1. **Our engine inherits the trigger for free.** We override `summarize()`; the scheduler that decides *when* to call it
   is already running. Every automatic compaction in the session immediately becomes memory-rendered and model-free.
   This is the moment the plugin pays for itself, and it needs no trigger work from us at all.
2. **`autoCompact` is dropped from the config surface.** There is nothing to add. A second autonomous compactor driven
   from `turn/end` would call `compactIfNeeded` again against the same engine and can only produce redundant work.

The only residual difference is *timing*: DSH compacts before the **next** model request; the reference compacts at
`agent_settled`, i.e. the moment the turn ends. Since our renderer is deterministic and touches no model, the pre-step
trigger does not make the user wait — the original motivation for early compaction is already satisfied. Compacting at
pre-step is also the safer moment: the agent is provably between steps, so there is no chance of mutating the surface
mid-turn.

Revisit only if measurement shows a real problem — for example a very large memory render at pre-step adding latency to
the next request. The mitigation then is to keep the *render* small (the pool caps already bound it), not to add a
second trigger.

An **escape hatch** worth recording: `SurfaceOp`'s `replace` variant is not compaction-exclusive —
`docs/subsystems/session.md:311` says *"Used by compaction; any surface-replacing producer may use it."* A memory plugin
could emit its own replacing `user/message` without owning `ctx.compaction` at all. Rejected for v1: automatic pressure
triggering would then be absent and the result would not be recognized as a compaction checkpoint.

### 4.6 Traceable compaction

This is the user-requested feature, and DSH makes it nearly free. `compaction/summary` already records
`shadowedSeqs` and `shadowedRange`. So a compaction trace is:

```ts
type CompactionTrace = {
  compactionId: string
  at: string                     // ISO timestamp
  shadowedSeqs: SessionSeq[]     // which messages this compaction replaced
  memorySeqs: SessionSeq[]       // which om/* events were folded in
  observationIds: string[]       // which memory lines went into the rendered summary
  reflectionIds: string[]
  fullFold: boolean
  modelFree: boolean             // false ⇒ native summarizer ran (empty projection)
  shadowedTokenCount: number
}
```

Which yields exactly the three traceability questions a user actually asks:

- *"Why does the agent believe X?"* → memory line → `sourceEntryIds` → jump to the source message.
- *"What did this compaction hide?"* → `shadowedSeqs`.
- *"What is currently visible vs. recorded?"* → the drift delta the projection computes.

### 4.7 The recall tool

Recall is what makes memory *traceable* for the agent rather than just for the panel, so its constraints matter.

**It must read history asynchronously.** `Session.eventAt()`, `snapshotEvents()`, and `ownEvents()` are deprecated and
*"new calls are prohibited"* — including *"new aliases or wrappers that expose the same synchronous historical access"*
(`.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md:15`), and CI lint
enforces it. Recall therefore resolves evidence through the sanctioned seam:

```ts
ctx.sessionQuery.readEvent({ sessionId, seq, before?, after? }, signal)  // bounded raw-log window
ctx.sessionQuery.traceEvent({ sessionId, seq }, signal)                  // replacement chain
```

`SessionEventTrace` returns `replacedBy`, `replacementChain`, and `sourceEventSeqs` — which is exactly what lets a memory
id still resolve to its origin **after compaction has shadowed that origin**. That is the traceability property we want,
and it comes from the harness rather than from us.

**Naming.** `'recall'` is already a `ContextForm` value and the chat UI renders a "recall" context body
(`llm/src/message.ts:96`). The tool name is a separate namespace so it is not blocked, but to avoid vocabulary collision
we name the tool **`memory_recall`** and keep `recall` for the source-form meaning.

**Relationship to in-flight work.** `.agents/notes/proposed/feature/2026-07-06-recallable-compaction.md` proposes a
`dsh-tool-recall` exposing `history_read` / `history_search` over `compaction/summary.shadowedRange` — i.e. *raw-log*
recall. Ours is *memory-layer* recall: a content-addressed memory id resolves through its provenance chain to source
messages. They are complementary, not duplicative, and they share a substrate (`shadowedSeqs` + `sessionQuery`). Worth
reading before implementation; if the proposed design lands first, our evidence renderer should reuse its paged
transcript renderer rather than writing a second one.

**Concrete pattern to copy:** `packages/session-query/tool-session-query` — five read-only tools over `ctx.sessionQuery`
with `isConcurrencySafe: () => true`, a shared string-output renderer, and a four-step caller/authorization invariant
(capture the calling identity, `authorizeTarget` before the read, thread `exec.signal`, then
`assertObservedTargetAuthorized` after the read against the returned header). It also registers its own guidance
`systemPrompt.section`, which is good precedent for teaching the model when to call `memory_recall`.

---

## 5. The Memory tab & explorer

**Decision (revised): a Memory tab in the conversation view ring is the surface**, beside Chat and Trajectory.

This section originally chose a composer strip, on the argument that memory is **ambient state, not a destination**.
That argument is wrong for the question the UI actually has to answer. Reading "12 active observations, 4 reflections"
is ambient, but the reason to open memory at all is **traceability** — the model was shown a line like
`[a1b2c3d4e5f6] high …`, and you want to check that line against the conversation it came from. That check needs room
for the record, its provenance, and the cited entries at once, which a one-line strip cannot give: it either truncates
the evidence or expands into an overlay covering the very conversation it is explaining.

Placement and shape:

- **Tab** registered into the `conversation.view` slot (`ctx.slots.register({ name: 'conversation.view', id: 'memory',
  order: 20 })`), after Chat (0) and Trajectory (10). It reuses the frame the Trajectory view already occupies, so
  choosing it is a view switch rather than permanent layout.
- **Master-detail**, not an overlay: a ledger of every observation, reflection, and tombstone, and a details panel
  carrying the selected record's full text, state, and cited conversation.
- **Trajectory's design language, not a look-alike of its own.** Memory is the same kind of surface as Trajectory — a
  dense ledger of a long session, scanned by column and then inspected one row at a time — so it is built from the same
  parts: a 32px sticky toolbar of `aria-pressed` pills, a sticky column header over 30px hairline-separated rows that
  answer hover and selection with `interactive-bg-hover` / `interactive-bg-active`, `Tag` capsules for signal, a 42px
  details header with a monospace id, a 94px label/value overview grid, and a `clamp(340px, 46%, 640px)` details panel
  behind a 0.5px `border-l2` rule. Every row is one line that ellipsizes; only the details panel wraps. The view also
  declares `data-conversation-composer-overlay` so the shell floats the composer over it and both scroll regions reserve
  `--dsh-composer-height`, which is the contract Trajectory follows for a full-height view.
- **A fourth Compactions tab** lists each `compaction/summary` the resident event window still holds, showing the route
  that wrote it and the exact seqs it replaced. This is the traceable-compaction view the feature was asked for, and it
  is where "this checkpoint cost no model call" becomes visible rather than asserted.
- **Read-only.** Forcing a pass or dropping a record would need a host Remote mutation surface; more importantly, a page
  that could edit a record would make "where did this come from" unanswerable.
- **A second, ambient surface in the composer dock.** The tab answers "what is in memory"; the dock reading answers "how
  much" without a view switch. It registers into `conversation.composer.dock` beside ui-chat's turn and token pills and
  mirrors their design — a 24px-radius transparent pill at the tertiary text tier that opens the same anchored,
  viewport-clamped panel on click — so the status area reads as one region rather than two unrelated strips. It renders
  nothing at all until a pass has recorded something, and it carries `data-composer-stats`, the dock's own contract for
  "a statistics row is mounted here", so the composer's bottom clearance accounts for it.
  - **One row, not one row per contribution.** A list slot renders its entries as bare siblings, so the dock's entries
    would have stacked: two block-level rows, one per plugin. The container therefore had to change, and it changed in
    the right place — `InputBar` now wraps the whole dock in `.dockRow` (flex row, centered, `gap: 12px`, wrap, and
    `:empty` collapse) and owns the geometry the first contribution used to carry alone. Both the session pills and this
    reading are plain flex items on that row, so any later contribution joins the line instead of starting a new one.
    The contract is pinned by `input-bar.client.spec.tsx` ("one shared row rather than one row each").

**Client half:** React, `useProjection('observationalMemory')` for records, the session's resident event window
(`binding.eventSource`, injected through the slot's inject face) for citations, `ctx.slots.register` for the tab, and the
locale dictionary for all copy (`verify-client-ui-i18n` rejects hardcoded text).

Explorer layout:

```
┌ Observational Memory ─────────── 4.2k / 20k active ─┐
│ [Observations] [Reflections] [Dropped] [Compactions]│
│                                                      │
│ ▸ 14:30 [high] Switched REST → GraphQL; motivation   │
│    was mobile over-fetching.          ← 3 sources    │
│ ▸ 14:50 [medium] Migration validated.                │
│                                                      │
│ ── selected: d4e5f6a1b2c3 ─────────────────────────  │
│   Observation  ·  high  ·  active  ·  14:30          │
│   Supporting reflections: [a1b2c3…]                  │
│   Sources ─────────────────────────────────────────  │
│     #412  user      "switch to GraphQL for the API"  │
│     #415  assistant "reduces over-fetching on …"     │
└──────────────────────────────────────────────────────┘
```

Design rules: read-only except for two actions (force a memory run now, drop a selected observation). Everything else is
derived. Row click → evidence; evidence → jump to that message in the conversation.

---

## 6. Config surface

DSH separates two seams, and memory needs both:

- **Load-time `Config`** (schemastery, validated by Cordis through Standard Schema) is the *composition* surface —
  deployment-varying choices set from `cordis.patch.yml`. Editing it hot-replaces the plugin.
- **Runtime `ctx.settings`** is the *user* surface — the Settings → Plugins card, backed by `$DSH_HOME/settings.yaml`.
  The canonical pattern is the optional-service `installSection`, read through a `current()` indirection at every use
  site so user edits take effect without a reload:

```ts
ctx.inject(['settings'], (settingsCtx) => {
  settingsCtx.settings.installSection(ctx, 'observational-memory', Config, config, {
    setSource: source => { current = source },
    onChange: () => { /* re-judge derived state */ },
  })
})
```

Not every field belongs on both: thresholds the user tunes at runtime (`passive`, `showWorkerNotifications`) go in the
settings schema; boot-time-only wiring (the compaction row, chunk caps) stays `Config`-only.

The field set, carrying the reference keys where they still mean the same thing:

| Key | Default | Surface | Notes |
|---|---|---|---|
| `observeAfterRatio` | `0.05` | settings | Observer clock, fraction of the window (§4.3b) |
| `reflectAfterRatio` | `0.10` | settings | Reflector clock |
| `observeAfterTokens` | `10000` | settings | Absolute fallback when `contextWindow` is unknown |
| `reflectAfterTokens` | `20000` | settings | Absolute fallback |
| `observationsPoolMaxTokens` / `…TargetTokens` | `20000` / half | settings | |
| `observerChunkMaxTokens` | derived | config | `floor(window * 0.2)`, min `256`, else `60000` |
| `agentMaxTurns` | `16` | config | |
| `model` | session model | settings | `{ provider, id, reasoningEffort }` — the cost escape hatch |
| `passive` | `false` | settings | |
| `showWorkerNotifications` | `true` | settings | |
| `debugLog` | `false` | settings | |
| `memory.tab.visible` | `true` | settings | Memory-tab preference |

Per DSH convention there are **no hardcoded tunables**: every one of these is a validated schema field, and a
`DEFAULT_*` constant or test hook is not configurability. Registering the settings namespace also makes the plugin appear
in Settings → Plugins automatically, keyed by the namespace.

Proactive-compaction tuning is **not** on this list. Threshold and retention are `compaction-basic`'s own
`thresholdRatio` / `retainRatio` config, already window-proportional, and we inherit them (§4.5b). Adding
`autoCompact` / `compactAfterTokens` here would duplicate a scheduler we do not own.

---

## 7. Package layout & mounting

**Site: `packages/context/`** — in-repo, because §4.1b makes that mandatory. The `context` group is the correct home:
its members (`time-context`, `agent-instructions`, `session-reference`) are exactly this kind of plugin —
session-event-driven producers of model-visible context.

**Two packages, not one.** This is a repo convention, not a preference: `assertManifestComplete`
(`scripts/gen-tool-catalog.ts:633-640`) globs `packages/*/tool-*` and fails the `doc-sync` gate when a tool package is
missing from the generator's boot manifest, *"so a new tool cannot be silently undocumented."* A model-facing tool
therefore lives in a package literally named `tool-*`. Splitting also matches how the repo already separates
`packages/session-query/tool-session-query` from its seam, and lets the UI half follow the proven dual-half shape.

```
packages/context/
  observational-memory/            # @deepseek-ai/dsh-observational-memory — domain + UI
    package.json                   # dsh.client manifest for the browser half
    cordis.patch.yml               # our rows + the compaction-basic re-point
    README.md / README.zh.md / README.i18n.yaml
    src/
      index.ts                     # plugin: name, inject, Config, apply()
      config.ts                    # schemastery schema + resolve()
      types.ts                     # SessionEventMap + SessionProjectionMap augmentation
      events.ts                    # builders + allowlist validators
      projection.ts                # the fold definition
      render.ts                    # deterministic summary renderer (+ shrink guard)
      clocks.ts                    # token progress, watermarks, empty-backoff
      workers/{observer,reflector,dropper}/   # agent.ts + prompts.ts each
      compaction-engine.ts         # BasicCompactionEngine subclass → exported subpath
      commands/om.ts               # /om status|view|drop
      invariant.ts                 # only if an owned relationship can actually diverge
      client/                      # React half: panel, trace view, locales
    tests/
  tool-observational-memory/       # @deepseek-ai/dsh-tool-observational-memory — recall
    src/index.ts                   # defineTool('recall', …) over ctx.sessionQuery
    tests/
```

Registering the tool in the second package means it must also be added to `TOOL_PACKAGES` in
`scripts/gen-tool-catalog.ts`, then `pnpm run gen-tool-catalog` regenerates `docs/tool-catalog.md`.

**Mounting** — in-repo, no Harness-home path juggling:

```sh
pnpm run gen-persistence-catalog   # 1. the three event types enter the generated vocabulary
dsh plugin --profile web add @deepseek-ai/dsh-observational-memory
dsh plugin --profile web add @deepseek-ai/dsh-tool-observational-memory
```

Verified composition mechanics worth knowing during development:

- **Layer order** (`apps/cli/src/profile-boot.ts:206-213`): each bundle patch in `dsh.profile.bundles` order → the
  profile's `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays. Later layers win per row, applied as
  one `applyEntryPatches` call. `--dump-config` shows the composed tree without booting.
- **Hot reload:** bundle *membership* changes need a restart, but edits to either `cordis.patch.yml` layer hot-apply
  under the `web` profile (`patchReload: live`). Editing our own bundle patch therefore reloads the plugin.
- **Relative plugin paths work in `insert` rows.** `anchorInsertedPluginNames` rewrites a relative or absolute `name`
  to a `file://` URL anchored beside the patch file (`app-boot/src/index.ts:325-336`), including group children. So
  `name: './src/index.ts'` is correct in our bundle patch, and raw TypeScript loads under the `pnpm dsh` source launch
  (tsx is registered process-wide) with bare peer imports resolving to the host's single copies.
- **Config edits hot-replace the plugin**, unwinding its effects — so every registration must be `ctx.effect`-scoped, and
  nothing may be captured at module scope.
- `dsh plugin add link:<path>` symlinks for a fast dev loop; `file:`/npm installs a real directory and is required for
  the built CLI (a `.ts` entry inside `node_modules` is refused by Node's type stripping).

`pnpm run verify-persistence-catalog` and `verify-tool-catalog` (both part of `doc-sync`) guard freshness.

**Repo-convention obligations this placement incurs** (budget for them, they are not optional):

| Gate | Obligation |
|---|---|
| `gen-persistence-catalog` | Regenerate after declaring events; `doc-sync` verifies freshness |
| `gen-tool-catalog` | Add the tool package to `TOOL_PACKAGES`; the guard fails on omission |
| `test:coverage` | Per-file **100%** on `packages/*/*/src` |
| `doc-sync` | Bilingual README, one physical line per paragraph, generated-catalog freshness |
| Agent Note | Required for a non-trivial change (`.agents/notes/`) |
| `verify-export-jsdoc` | JSDoc with `@param`/`@returns` on every function-like export |
| `verify-cordis-config` | Bare plugins in `cordis.yml` must appear in the resolver manifest's `dependencies` |
| Client i18n | `verify-client-ui-i18n` rejects hardcoded UI copy — route through the locale dictionary |

A **trade-off worth naming**: this makes the plugin a first-party package, not a distributable third-party extension.
That is the correct call — it buys durable, reloadable memory and full harness support at the cost of living in the
monorepo. A genuinely out-of-tree variant remains possible later, but it must either accept memory that dies with the
process or carry the `ignorable` cutover the rationale note describes, neither of which is worth doing now.

---

## 8. Phased roadmap

Deliberately ordered so each phase is independently useful and verifiable.

**Phase 0 — skeleton & vocabulary.** Package at `packages/context/observational-memory/`, `Config`, `apply()`, the three
event declarations, and `pnpm run gen-persistence-catalog`. **Gate: append one `memory/*` event, reload the session, and
confirm it reads back** — this is the phase that proves the whole in-repo ledger decision, so it comes first and alone.

**Phase 1 — ledger & projection, no model.** Builders, allowlist validators, projection registration. Tests prove
fold / dedupe / tombstone / watermark semantics and that `apply` returns the same reference when uninterested.

**Phase 2 — observer.** One worker, `ctx.llm.stream()` + `BlockAssembler`, tool-call extraction, allowlist validation,
deliberate-empty backoff, bounded retry. *First real value: observations start accumulating.*

**Phase 3 — reflector + dropper.** Reflection support ids, coverage tiers, dropper only after same-run reflection.

**Phase 4 — compaction engine.** `summarize()` subclass, deterministic renderer with the size guard, empty-projection
delegation, `compactIfNeeded` override. **This is the point where the plugin pays for itself** — and because DSH's
automatic trigger is inherited rather than built (§4.5b), this phase is smaller than it looks.

**Phase 5 — recall tool + `/om` commands.** `packages/context/tool-observational-memory` + `memory_recall` over
`ctx.sessionQuery`; `/om status|view|drop` for the human.

**Phase 6 — Memory tab.** The Memory tab registered into the `conversation.view` ring beside Chat and Trajectory, a
master-detail page over the projection plus the session's event window, with a Compactions tab for traceable
compaction. In v1, originally built as a composer strip and relocated to the view ring on user feedback (§5).

**Phase 7 — model-visible memory + polish.** Wire `ctx.systemPrompt.context()`, worker notifications, debug log, docs,
snapshots.

Risk is concentrated in Phase 0 (the reopen gate), Phase 4 (engine replacement + shrink guard) and Phase 6 (client-half
build + slot registration); all three have working local precedents to copy.

---

## 9. Settled decisions

1. **In-repo packages.** Forced by §4.1b: the ledger's event types must be declared in this repository or the session
   cannot be reopened.
2. **Full scope in v1**, including the UI (Phase 6).
3. **Model-visible channel: `ctx.systemPrompt.context()`** — cache-friendly, deduped by exact text, logged by
   construction (§4.4).
4. **No custom compaction trigger.** DSH's `agent/pre-step` pressure trigger is already enabled and our engine inherits
   it; `autoCompact` is dropped from the config surface entirely (§4.5b).
5. **UI: a Memory tab in the conversation view ring** (revised from a composer strip — §5), master-detail explorer, read-only.
6. **Workers use the session model by default**, with an optional `model` override. The README must state the cost
   caveats prominently — memory work bills against the session model *and is invisible to DSH's own token accounting*
   (§4.3).
7. **Window-proportional thresholds are the default**, not an opt-in escape hatch. Absolute token counts remain as the
   fallback for when `contextWindow` is absent. The README states this as a headline feature (§4.3b).

No open questions remain. Implementation can start at Phase 0.

---

## 10. Implementation notes / gotchas carried over

Things the reference source taught us that a naive port would get wrong:

- **Port the code, not the docs.** The reference's own docs claim "observer has priority; reflect/drop does not run when
  observer is due." The code has no such gate — it runs one sequential pipeline, so an observer append can unblock the
  reflector in the *same* pass. Follow the code.
- **The reflector has no deliberate-empty backoff.** Once over threshold with no append it re-fires every turn boundary.
  Worth fixing in the port rather than reproducing.
- **Content-addressed ids collapse identical text.** Good for idempotency, but recall must report `collision`.
- **Token accounting is asymmetric.** Observations carry a `tokenCount`; reflections do not. The pool-pressure metric
  depends on that asymmetry — do not "fix" it accidentally.
- **Normal compaction holds reflections and drops stable** at the last full-fold boundary and advances only observations.
  Consequence: the first-ever compaction contains observations and no reflections. That is intended.
- **Empty projection must always delegate.** Never persist an empty summary over real context.
- **Never block compaction on background workers.** Compact whatever is already folded.

Things the DSH side adds, verified against source:

- **The ledger must be in-repo** (§4.1b). Out-of-tree, the first written session cannot be reloaded. Prove the round-trip
  in Phase 0 before writing any worker.
- **`CompactionEngine` cannot be mounted twice.** `provide()` throws on a duplicate name; the base bundle's row is
  re-pointed, not joined.
- **The replacement must be strictly smaller** than the shadowed route token count (`region.ts:402-407`) — the renderer
  needs a size guard that falls back to `super.summarize(...)`.
- **Override `compactIfNeeded` too**, or the automatic pressure path throws `TargetPressureConfigError` when no
  summarization model resolves.
- **No retry on direct `ctx.llm.stream()`**, and failures arrive as a terminal `finish` chunk rather than a throw.
- **`session.append` cannot set `ignorable`** — and for our events it shouldn't; omission is not safe.
- **Never append our own `system/message`.** The loop's `SystemPromptProjection` owns every system node and reconciles
  foreign ones away.
