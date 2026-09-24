# `pi-observational-memory` V3 — Internal Architecture Report

Source analyzed: `/tmp/pi-observational-memory` (read-only), package version `3.0.4`,
peer deps `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui` (dev `^0.81.0`).

Everything below is from the actual source, not the docs. Where the docs contradict the code I say so explicitly.

---

## 0. Module map and extension entry point

`src/index.ts` (whole file):

```ts
export default function observationalMemory(pi: ExtensionAPI) {
	const runtime = new Runtime();

	registerConsolidationTrigger(pi, runtime);
	registerCompactionTrigger(pi, runtime);
	registerCompactionHook(pi, runtime);

	registerStatusCommand(pi, runtime);
	registerViewCommand(pi, runtime);
	registerRecallTool(pi);
}
```

One `Runtime` object per extension instance holds all mutable state (config, in-flight flags, last errors, empty-backoff).

Host surfaces actually used:

| Host call | File:line |
|---|---|
| `pi.on("agent_start", launch)` | `hooks/consolidation-trigger.ts:158` |
| `pi.on("turn_end", launch)` | `hooks/consolidation-trigger.ts:159` |
| `pi.on("agent_settled", …)` | `hooks/compaction-trigger.ts:9` |
| `pi.on("session_before_compact", async (event, ctx) => …)` | `hooks/compaction-hook.ts:20` |
| `pi.appendEntry(customType, data)` | `hooks/consolidation-trigger.ts:62-64` |
| `pi.registerCommand("om:status" / "om:view", { description, handler })` | `commands/status.ts:38`, `commands/view.ts:44` |
| `pi.registerTool(recallObservationTool)` | `tools/recall-observation.ts:482` |
| `defineTool`, `Text` (pi-tui) | `tools/recall-observation.ts:4-5, 438` |
| `agentLoop`, `AgentTool`, `AgentContext`, `AgentLoopConfig` | all three worker agents |
| `Type` (from `@earendil-works/pi-ai`), `Static` (from `typebox`) | all three worker agents |
| `getAgentDir()` | `config.ts:231`, `debug-log.ts:48` |
| `estimateTokens` (from `pi-coding-agent`) | `tokens.ts:1` |
| `streamSimple` (from `@earendil-works/pi-ai/compat`) | `agents/worker-stream.ts:2` |

`ctx` properties used, complete list (grep-verified): `ctx.cwd`, `ctx.hasUI`, `ctx.ui.notify(msg, type)`,
`ctx.model`, `ctx.model.contextWindow`, `ctx.modelRegistry`, `ctx.getContextUsage()`,
`ctx.sessionManager.getBranch()`, `.getSessionId()`, `.getSessionFile()`, `ctx.isIdle()`,
`ctx.compact({ onComplete, onError })`; registry: `ctx.modelRegistry.find(provider, id)`,
`.getApiKeyAndHeaders(model)`, `.isUsingOAuth(model)`, `.hasConfiguredAuth(model)`, `.refresh(opts)`,
`.streamSimple`, `.getRegisteredProviderIds()`, `.getRegisteredProviderConfig(id)`.

---

## 1. Data model

### 1.1 Ledger entry type constants (`src/session-ledger/types.ts:1-4`)

```ts
export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
export const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
export const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
export const OM_FOLDED = "om.folded";
```

### 1.2 Core records

```ts
export const RELEVANCE_VALUES = ["low", "medium", "high", "critical"] as const;
export type Relevance = (typeof RELEVANCE_VALUES)[number];

export const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;

export type Observation = {
	id: string;
	content: string;
	timestamp: string;
	relevance: Relevance;
	sourceEntryIds: string[];
	tokenCount: number;
};

export type Reflection = {
	id: string;
	content: string;
	supportingObservationIds: string[];
	tokenCount: number;
};
```

### 1.3 Ledger `data` payloads

```ts
export type ObservationsRecordedEntryData = { observations: Observation[]; coversUpToId: string };
export type ReflectionsRecordedEntryData  = { reflections: Reflection[];  coversUpToId: string };
export type ObservationsDroppedEntryData  = { observationIds: string[];  coversUpToId: string };
```

Builders refuse to create empty payloads (`buildObservationsRecordedData` etc. return `undefined` when the array is empty or `coversUpToId` is empty) — this is the "no empty ledger entries" invariant.

### 1.4 Compaction details

```ts
export type MemoryDetails = {
	type: typeof OM_FOLDED;   // "om.folded"
	version: 1;
	fullFold: boolean;
	observations: Observation[];
	reflections: Reflection[];
};
```

### 1.5 The host `Entry` shape the extension folds over

```ts
export type Entry = {
	type: string;
	id: string;
	timestamp?: string;
	message?: unknown;
	content?: unknown;
	customType?: string;
	summary?: unknown;
	fromId?: string;
	data?: unknown;
	details?: unknown;
	firstKeptEntryId?: string;
};
```

Conventions: ledger entries are `type === "custom"` with `customType` ∈ the three `om.*` values and `data` = the payload above. Compaction entries are `type === "compaction"` with `firstKeptEntryId` and `details` (= `MemoryDetails` when written by this extension). Source entries are `type ∈ { "message", "custom_message", "branch_summary" }` (`progress.ts:10`, duplicated in `recall.ts:10`).

V2 artifacts (`customType: "om.observation"`, `details.type: "observational-memory"`, `version: 4`) are ignored everywhere by construction — no predicate accepts them.

### 1.6 Id generation — 12-char ids

`src/ids.ts` (whole file):

```ts
import { createHash } from "node:crypto";

export function hashId(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 12);
}
```

So: **`id = sha256(content).hex.slice(0, 12)`** — 48 bits, lowercase hex, content-addressed (no salt, no timestamp, no source ids).

Consequences that matter for a port:

* Calling `record_observations` twice with identical `content` yields the same id; both agents dedup on it (`accumulated` map in the observer, `existingReflectionIds` ∪ `accumulated` in the reflector). Re-running a worker is therefore idempotent at the id level.
* Two *different* facts that happen to share identical content collapse into one record — fold is first-valid-wins (`fold.ts:63-65`, `projection.ts:98-100`).
* Recall reports `collision: true` when an id matches more than one ledger record.
* The reflector's `id` is derived from reflection `content` only, so rewording creates a new reflection (the prompt explicitly warns about this).

### 1.7 Timestamps

* Observed format: `YYYY-MM-DD HH:MM`, local time, 24-hour, minute precision.
* Schema-enforced for the observer only: `OBSERVATION_TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$"` (`observer/agent.ts:38`).
* `nowTimestamp()` uses `fmtLocal(new Date())` (`serialize.ts:98-100`), which is also used to format `message.timestamp` (`number | string`) in the serialized chunk and `formatTimestamp` falls back to `"????-??-?? ??:??"` for unparsable values.
* Reflections carry **no** timestamp field.

### 1.8 Token counts

`src/tokens.ts`:

```ts
export function estimateStringTokens(text: string): number { return Math.ceil(text.length / 4); }

export function observationLineTokenCount(observation: {id;timestamp;relevance;content}): number {
	return estimateStringTokens(`[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`);
}

export function estimateEntryTokens(entry): number {
	if (entry.type === "message" && entry.message) return estimateMessageTokens(entry.message); // host pi-coding-agent estimateTokens
	if (entry.type === "custom_message" && entry.content) { /* string → len/4; array → sum of text blocks */ }
	if (entry.type === "branch_summary" && typeof entry.summary === "string") return estimateStringTokens(entry.summary);
	return 0;
}
```

Key asymmetry: an `Observation.tokenCount` counts the **whole rendered line** (`[id] timestamp [relevance] content`), while a `Reflection.tokenCount` counts **content only** (`estimateStringTokens(content)`, `reflector/agent.ts:157`). The dropper's pool math recomputes observation tokens with `observationLineTokenCount` (`dropper/pool.ts:20`), so it agrees with what was stored for observations but would disagree for reflections (reflections aren't pooled by tokens anywhere).

Both counts are computed in **code**, never accepted from the model. The model's tool schema has no token fields.

### 1.9 Validation predicates (all in `types.ts`)

* `isRelevance`, `isNonEmptyString`, `isNonEmptyStringArray`, `isMemoryId` (`MEMORY_ID_PATTERN`), `isTokenCount` (finite, `>= 0`).
* `isObservation`: id/isMemoryId + non-empty content + non-empty timestamp + relevance + non-empty `sourceEntryIds` + tokenCount.
* `isReflection`: same plus **`!/\r|\n/.test(value.content)`** — single-line is enforced in code for reflections.
* `isObservationsRecordedData` / `isReflectionsRecordedData` require a **non-empty** array plus non-empty `coversUpToId`; `isObservationsDroppedData` requires non-empty `observationIds` + non-empty `coversUpToId`.
* `isMemoryDetails`: `type === OM_FOLDED && version === 1 && typeof fullFold === "boolean" && arrays valid`.
* `isObservationsRecordedEntry` / `isReflectionsRecordedEntry` / `isObservationsDroppedEntry`: `entry.type === "custom" && entry.customType === … && is…Data(entry.data)`.

Content hygiene: `truncateRecordContent` (`serialize.ts:102-109`) caps at `MAX_RECORD_CONTENT_CHARS = 10_000` and appends `" … [truncated N chars]"`. The reflector additionally rejects any content containing `\r`/`\n` after trimming.

### 1.10 Dropped tombstones

`ObservationsDroppedEntryData.observationIds` is a **tombstone list**, not a deletion. Folding behavior:

* `foldLedger` adds every dropped id to `droppedObservationIds` **even if the observation is unknown at fold time** (`fold.ts:80-85`, and it does not `continue`, so it can fall through). `activeObservations = observations.filter(o => !dropped.has(o.id))`.
* `foldProjection` applies drops only from drop entries whose own `coversUpToId` is at/before the drops boundary, then filters observations at the very end.
* Recall still resolves dropped observations and marks `status: "dropped"`; the ledger history is never erased.

### 1.11 Relevance levels and coverage tiers

Relevance: `low | medium | high | critical`, assigned by the observer model, used by the dropper as resistance ordering (`RELEVANCE_DROP_RANK = {low:0, medium:1, high:2, critical:3}`, `dropper/agent.ts:56-61`).

Coverage tiers (`dropper/coverage.ts:3`):

```ts
export const REFLECTION_COVERAGE_TIERS = ["none", "partial", "strong"] as const;
export const REFLECTION_COVERAGE_DROP_RANK: Record<ReflectionCoverageTier, number> = { strong: 0, partial: 1, none: 2 };
```

Derivation: `reflectionSupportCounts` counts, per observation id, how many **distinct reflections** cite it (ids deduped inside each reflection). `count <= 0 → "none"`, `=== 1 → "partial"`, `>= 2 → "strong"`. Coverage is *derived at call time* from the current reflection set (`reflectionCoverageMap(observations, reflections)`) and is never persisted.

---

## 2. State machine / clocks

### 2.1 Triggers and the launch gate

`hooks/consolidation-trigger.ts:154-201`:

```ts
export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const launch = (_event: unknown, ctx: ConsolidationCtx) => { maybeLaunchConsolidation(pi, runtime, ctx); };
	pi.on("agent_start", launch);
	pi.on("turn_end", launch);
}
```

`maybeLaunchConsolidation` order:

1. `runtime.ensureConfig(ctx.cwd)` — loads config **once**; `configLoaded` latch means settings changes require a restart/reload.
2. `if (runtime.config.passive === true) return;`
3. `if (runtime.consolidationInFlight) return;` — shared lock for both events, set synchronously inside `launchConsolidationTask` before any await, so a second event in the same tick is skipped.
4. `const entries = ctx.sessionManager.getBranch() as Entry[];`
5. `if (!anyStageDue(entries, runtime, realContextTokens(ctx))) return;`
6. `void runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({ … runId … }, () => runConsolidationPipeline(pi, runtime, consolidationCtx)))`.

`runId` format: `` `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}` ``.

`launchConsolidationTask` resets `consolidationPhase`, `lastObserverError`, `lastReflectorError`, `lastDropperError`, then clears them on settle. Stage errors are recorded by `recordConsolidationStageError` (sets `last<Phase>Error` + one `ui.notify(…, "warning")`).

### 2.2 The two clocks per stage

`stageDue` (`consolidation-trigger.ts:89-105`):

```ts
function stageDue(entries, runtime, currentTokens, customType, rawEstimateFn, threshold): boolean {
	if (currentTokens !== undefined) {
		const real = realTokensSinceAnchor(entries, customType, currentTokens);
		if (real !== undefined) return real >= threshold;
	}
	// Real delta unmeasurable (no usage baseline, or accounting basis changed) or
	// old pi host without getContextUsage — fall back to the raw estimate…
	return rawEstimateFn(entries) >= threshold;
}
```

* `currentTokens` comes from `realContextTokens(ctx)` = `ctx.getContextUsage()?.tokens` if it's a finite number, else `undefined`.
* raw fallbacks: `rawTokensSinceObservationCoverage` and `rawTokensSinceReflectionCoverage`.
* `anyStageDue` = observer-due `||` reflector-due. Note both calls pass `runtime` but `stageDue` never uses it (dead parameter).

`realTokensSinceAnchor(entries, customType, currentContextTokens)` (`progress.ts:198-218`):

```ts
const coverageIdx = customType ? latestCoverageIndex(entries, customType) : -1;
const compactionIdx = findLastCompactionIndex(entries);
if (compactionIdx > coverageIdx) {
	const baseline = realContextTokensAfterCompaction(entries, compactionIdx);
	if (baseline === undefined) return undefined;
	const delta = currentContextTokens - baseline;
	return delta >= 0 ? delta : undefined;
}
if (coverageIdx >= 0) {
	const baseline = realContextTokensAtCoverage(entries, coverageIdx);
	if (baseline === undefined) return undefined;
	const delta = currentContextTokens - baseline;
	return delta >= 0 ? delta : undefined;
}
return Math.max(0, currentContextTokens);
```

Baseline rules:

* `realContextTokensAfterCompaction` = first valid assistant usage **after** the compaction entry. The compaction entry's own usage is deliberately *not* used (it is the summarizer call's pre-compaction usage).
* `realContextTokensAtCoverage` = last valid assistant usage **at or before** the covered entry, scanning backwards.
* `validAssistantContextTokens`: entry is a `message` whose `message.role === "assistant"`, `stopReason` not `"aborted"`/`"error"`, and `contextTokensFromUsage(usage)` resolves — preferring `usage.totalTokens > 0`, else the sum of `input + output + cacheRead + cacheWrite` when *all four* are finite numbers and the sum is `> 0`.
* `delta < 0` (context shrank → accounting basis changed, e.g. mid-session model switch) → `undefined` → raw fallback. This is explicitly to avoid both starvation and over-firing.
* No compaction and no coverage at all → `Math.max(0, currentContextTokens)` (everything in context is "growth").

Raw clock (`progress.ts:89-111`):

```ts
export function rawTokensAfterIndex(entries: Entry[], index: number): number {
	let total = 0;
	for (let i = Math.max(0, index + 1); i < entries.length; i++) {
		if (isSourceEntry(entries[i])) total += estimateEntryTokens(entries[i]);
	}
	return total;
}
export function rawTokensSinceCoverage(entries, customType) {
	return rawTokensAfterIndex(entries, latestCoverageIndex(entries, customType));
}
```

Only `message` / `custom_message` / `branch_summary` count; ledger entries, compaction entries and everything else contribute 0.

### 2.3 `coversUpToId` / watermarks

`coversUpToId` is simultaneously (a) the progress watermark for the producing worker and (b) the projection watermark that decides whether a ledger entry is inside a bounded projection. It is explicitly **not** provenance.

Resolution helpers (`progress.ts:36-87`):

* `isValidCoverageEntry(entry, customType)` — `type === "custom"`, matching `customType`, `data.coversUpToId` is a string, and the payload array (`observations` / `reflections` / `observationIds`) is non-empty.
* `latestCoverageIndex(entries, customType)` — for every valid coverage entry, resolve `coversUpToId` → branch index via `entryIndexById`; **ignore dangling markers** (`undefined` index); keep the **maximum** index, not the last written entry. (There is a dedicated test: "chooses the max covered branch position, not merely latest ledger entry order".)
* `latestCoverageMarkerId(entries, customType)` — same scan, returns the winning `coversUpToId` string (`undefined` if none).
* `earlierCoverageMarkerId(entries, firstId, secondId)` — returns whichever of two marker ids sits earlier in the branch (falling back to the non-dangling one; `undefined` when both are dangling).

Who writes what watermark:

| Producer | watermark written | Source |
|---|---|---|
| `om.observations.recorded` | `sourceEntryIds.at(-1)` — the **last source entry actually serialized into the chunk** | `consolidation-trigger.ts:292` |
| `om.reflections.recorded` | `latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED)` — the reflection is "covered through" observation coverage | `consolidation-trigger.ts:389, 413` |
| `om.observations.dropped` | `earlierCoverageMarkerId(entries, observationCoverageId, sameRunReflectionCoverageId)` — the *earlier* of the two | `consolidation-trigger.ts:486` |

### 2.4 Stage-by-stage skip conditions

**Observer** (`runObserverStage`, lines 237-375):

1. `tokens = real ?? rawTokensSinceObservationCoverage(entries)`; `if (tokens < observeAfterTokens) return "continue";`
2. Deliberate-empty backoff check (below); if still active → `debugLog("observer.empty_backoff", …)`, return `"continue"`.
3. `resolved = await resolveModel("observer")`; `if (!resolved) return "abort";`
4. `lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED)`; `backlogEntries = sourceEntriesAfter(entries, lastCoverageIdx)` (strictly after the watermark, filtered to source entries).
5. `maxChunkTokens = resolveObserverChunkMaxTokens(runtime.config, resolved.model.contextWindow)`; serialize with `serializeSourceAddressedBranchEntries(backlogEntries, { maxTokens })`.
6. Empty text or zero source ids → `"continue"`.
7. `coversUpToId = sourceEntryIds.at(-1)`.
8. Prior memory for the prompt = `fullProjection(entries)` → `priorReflections` / `priorObservations` summary lines.
9. Run the worker. `ObserverStreamError` → `recordConsolidationStageError` and `return "abort"` (kills the rest of the pass). Other throws propagate to the pipeline catch → same abort.
10. `!observations || observations.length === 0` → **deliberate empty**: `debugLog("observer.empty")`, set backoff, info notification, `"continue"`.
11. Otherwise clear backoff, `buildObservationsRecordedData`, `appendEntry(pi, OM_OBSERVATIONS_RECORDED, data)`.

**Reflector** (`runReflectorStage`, lines 377-421):

1. `reflectionTokens = real ?? rawTokensSinceReflectionCoverage(entries)`; `< reflectAfterTokens` → `"continue"`.
2. `observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED)`; missing → `"continue"` (**no observation coverage ⇒ no reflections and no drops**).
3. `resolveModel("reflector")` failure → `"abort"`.
4. `folded = foldLedger(entries)`; worker gets `folded.reflections` (all reflections, including ones only visible at a full fold) and `folded.activeObservations`.
5. `!reflections` (undefined/empty) → `"continue"`, and `sameRunReflections` stays `[]`, which will block the dropper.
6. Append `om.reflections.recorded` with `coversUpToId = observationCoverageId`; return `{ outcome:"continue", sameRunReflections, effectiveReflectionCoverageId: data.coversUpToId }`.

**Dropper** (`runDropperStage`, lines 423-495):

1. `if (!sameRunReflectionCoverageId || sameRunReflections.length === 0) return "continue";` — this is the hard gate: **the dropper never runs on its own**, only as post-reflection maintenance in the same pass.
2. `observationCoverageId` must exist.
3. `metrics = observationPoolMetrics(folded.activeObservations, config.observationsPoolTargetTokens)`; `if (!metrics.ready) return "continue";` where `ready = overTarget && maxDropsAllowed > 0` (and `overTarget = observationTokens > targetTokens`).
4. `resolveModel("dropper")` failure → `"abort"` (does not roll back the already-appended reflections).
5. Run worker with `mergeReflections(folded.reflections, sameRunReflections)` (dedup by id) and `folded.activeObservations`.
6. Append `om.observations.dropped` only if both `droppedIds` and `coversUpToId` are truthy.

### 2.5 Deliberate-empty backoff (observer only)

State (`runtime.ts:113-118`):

```ts
observerEmptyBackoff: {
	sessionIdentity: string | undefined;
	coverageId: string | undefined;
	tokensAtEmpty: number;
} | undefined;
```

Set on a deliberate empty result (`consolidation-trigger.ts:352`), keyed by
`sessionIdentity = ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager.getSessionFile?.()`.
Released (`consolidation-trigger.ts:258-268`) when **any** of:

* `sessionIdentity !== backoff.sessionIdentity` (different session),
* `coverageId !== backoff.coverageId` (coverage advanced for any reason),
* `tokens >= backoff.tokensAtEmpty + runtime.config.observeAfterTokens` (another threshold's worth of new source tokens arrived).

Cleared on any successful append (`:359`). Debug event: `observer.empty_backoff` with `{ tokens, resumeAtTokens }`.

**Porting note (real asymmetry):** there is **no** equivalent backoff for the reflector. If the reflector returns nothing, no watermark advances, so the reflection clock stays ≥ threshold and the reflector is re-invoked on **every** `agent_start`/`turn_end` (each one a real LLM call) until it produces something. The observer explicitly avoids this; the reflector does not.

### 2.6 Priority between workers — docs vs code (important)

`docs/how-it-works.md:60` says *"The observer has priority. Reflect/drop does not run on a turn where observer work is due."* and `docs/concepts.md:79` says the reflector runs *"when its raw-token clock reaches `reflectAfterTokens` and the observer is not due"*.

**The code does not implement this.** `maybeLaunchConsolidation` only asks `anyStageDue` (observer OR reflector), then `runConsolidationPipeline` runs the three stages strictly in order:

```ts
runtime.consolidationPhase = "observer";
const observerOutcome = await runObserverStage(...);   // "continue" when merely not due
if (observerOutcome === "abort") return;
runtime.consolidationPhase = "reflector";
reflectorResult = await runReflectorStage(...);
if (reflectorResult.outcome === "abort") return;
runtime.consolidationPhase = "dropper";
await runDropperStage(...);
```

Each stage re-reads the branch (`ctx.sessionManager.getBranch()` is called *inside* each stage function), so an observation appended by the observer can unblock the reflector **in the same pass** — this is asserted by the test *"re-reads branch so observer append can unblock reflector in the same consolidation run"* (`tests/consolidation-trigger.test.ts:522-537`).

Effective priority/coupling, as implemented:

* observer → reflector → dropper, always in that order within one pass.
* `"abort"` from the observer (model resolution failure or `ObserverStreamError`) skips the reflector and dropper.
* `"abort"` from the reflector (model resolution failure) skips the dropper.
* `"continue"` never aborts; it just means that stage did nothing.
* A dropper failure is swallowed (`runConsolidationPipeline` catches it and logs `dropper.error`) — reflections stay.

### 2.7 Auto-compaction clock (`hooks/compaction-trigger.ts`)

Trigger: `pi.on("agent_settled", …)` — pi emits this only after retries, automatic compaction, and queued continuation have finished, "so retry policy stays owned by Pi".

`rawTokensSinceLastCompaction(entries)` (`progress.ts:220-229`):

```ts
const compactionIndex = findLastCompactionIndex(entries);
if (compactionIndex === -1) return rawTokensAfterIndex(entries, -1);          // whole branch
const firstKeptEntryId = entries[compactionIndex].firstKeptEntryId;
const firstKeptIndex = entryIndexForId(entries, firstKeptEntryId);
if (firstKeptIndex === -1) return rawTokensAfterIndex(entries, compactionIndex); // dangling → after the compaction entry
return rawTokensAfterIndex(entries, firstKeptIndex - 1);                          // from firstKeptEntryId inclusive
```

Threshold: `resolveCompactAfterTokens(config, typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined)`.

Sequence: notify → `runtime.compactInFlight = true` → `setTimeout(…, 0)` → `if (!ctx.isIdle()) { compactInFlight = false; notify "compaction deferred — agent became busy"; return; }` → re-read branch and re-check the *same raw metric*; if below, skip with *"compaction skipped — another compaction already ran before deferred compaction"* → else `ctx.compact({ onComplete, onError })`. `onError` ignores `error.message === "Compaction cancelled"` (the hook already explained the real reason via `{ cancel: true }`). Pi's provider context usage is deliberately **not** used for this threshold. The trigger never awaits consolidation promises.

---

## 3. Worker execution

### 3.1 API abstraction

Workers do **not** call a model directly and `pi.registerProvider` is **never called by this extension** (it only appears in comments/docs as a *source* of custom provider `api` ids). The call path is:

```
runObserver/runReflector/runDropper
  → agentLoop(prompts, context, config, signal, streamSimple)   // @earendil-works/pi-agent-core
      → resolveWorkerStreamSimple(model, modelRegistry, override)  // agents/worker-stream.ts
```

`agents/worker-stream.ts` (whole file, 65 lines) is a **provider-stream resolver**. Its doc comment explains why:

> Direct `@earendil-works/pi-ai/compat` `streamSimple` only knows built-in API ids. Custom providers (`cursor-sdk`, `cliproxyapi-*`, commandcode, …) live on Pi's composed runtime. Using compat after a successful foreground turn is what crashes Pi with `No API provider registered for api: …` (#30).

Resolution order:

```ts
export function resolveWorkerStreamSimple(model, modelRegistry?, override?): WorkerStreamSimple {
	if (override) return override;
	const registryStream = modelRegistry?.streamSimple;
	if (typeof registryStream === "function") return (m, c, o) => registryStream(m, c, o);
	try {
		if (typeof modelRegistry?.getRegisteredProviderIds === "function"
			&& typeof modelRegistry?.getRegisteredProviderConfig === "function") {
			for (const providerId of modelRegistry.getRegisteredProviderIds()) {
				const config = modelRegistry.getRegisteredProviderConfig(providerId);
				const composed = config?.streamSimple;
				if (config?.api === model.api && typeof composed === "function") return composed;
			}
		}
	} catch { /* Incomplete host/test doubles still use the built-in compat dispatcher. */ }
	return compatStreamSimple;   // from "@earendil-works/pi-ai/compat"
}
```

`StreamableModelRegistry` is a duck-typed subset: `{ streamSimple?, getRegisteredProviderIds?, getRegisteredProviderConfig? }`.

### 3.2 Model + auth resolution (`runtime.ts:126-220`)

`Runtime.resolveModel(ctx)`:

1. If `config.model` set → `ctx.modelRegistry.find(config.model.provider, config.model.id)`; if not found, warn once (UI) and fall back to the session model. If no model at all → `{ ok:false, reason:"no model available (session has no model and no observational-memory model configured)" }`.
2. `auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)`; `provider = model.provider ?? "unknown"`; `isOAuth = ctx.modelRegistry.isUsingOAuth?.(model) === true`.
3. Auth acceptance:
   * `hasUsableAuth(auth)` = non-empty string `apiKey` **or** ≥1 non-empty-string header.
   * `resolvedEmptyApiKey` = `typeof auth.apiKey === "string" && auth.apiKey.length === 0`.
   * `providerCredentialConfigured = ctx.modelRegistry.hasConfiguredAuth(model) === true` (defensively try/catch'd).
   * If `auth.ok === true && !usable && !isOAuth && !resolvedEmptyApiKey && !providerCredentialConfigured` → `recheckProviderCredential(...)` (see below).
   * `signsAtRequestTime = auth.ok === true && !isOAuth && !resolvedEmptyApiKey && providerCredentialConfigured`.
   * Failure iff `!auth.ok || (!usable && !signsAtRequestTime)`. Reason string is either the OAuth message `` `authentication failed for provider "${provider}" — OAuth credentials may have expired; run '/login ${provider}' to re-authenticate` `` or `` `no API key or auth headers for provider "${provider}"` ``; a `resolve.rejected` debug event records booleans/counts only (never values).
4. Success → `{ ok:true, model, apiKey, headers, env, baseUrl }`.

`recheckProviderCredential` (`runtime.ts:229-281`): rate-limited per provider by `AVAILABILITY_RECHECK_REARM_MS = 60_000`, bounded by `AVAILABILITY_RECHECK_TIMEOUT_MS = 5_000` via `Promise.race` against an `AbortController` (the abort is a *race*, because pi 0.81's `refresh()` ignores the signal), calls `registry.refresh({ allowNetwork:false, providers:[provider], signal })`, then re-reads `hasConfiguredAuth(model)`. Covers Amazon Bedrock SigV4 / Google Vertex ADC where pi hands the caller an empty auth payload but signs requests itself. Emits `resolve.availability_recheck` and `resolve.request_time_signing` debug events.

Model resolver memoization in the pipeline (`makeModelResolver`, `consolidation-trigger.ts:116-152`): one `ResolveResult` is cached for the whole pass and reused by all three stages; on failure it logs `<stage>.model_unavailable` and notifies **once** per pass (`runtime.resolveFailureNotified`).

Special case: opencode hosts reject calls without a session header, so when `model.provider === "opencode" || "opencode-go" || model.baseUrl.includes("opencode.ai")` and `ctx.sessionManager.getSessionId?.()` exists, the resolver injects:

```ts
headers: { ...(cached.headers ?? {}), "x-opencode-session": sessionId, "x-opencode-client": "pi" }
```

### 3.3 Prompt construction, tools, schema, loop config

Common shape for all three agents (`observer/agent.ts:177-221`, `reflector/agent.ts:172-197`, `dropper/agent.ts:239-264`):

```ts
interface RunWorkerArgs {
	model: Model<any>;
	apiKey?: string; headers?: Record<string,string>; env?: Record<string,string>;
	// stage-specific inputs…
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;      // test seam
	maxTurns?: number;
	thinkingLevel?: ModelThinkingLevel;
	modelRegistry?: StreamableModelRegistry;
	streamSimple?: WorkerStreamSimple; // test seam
}
```

* `prompts`: exactly **one** synthetic user message — `[{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }]`.
* `context`: `{ systemPrompt: <STAGE>_SYSTEM, messages: [], tools: [<one tool> as AgentTool<any>] }` — the worker starts with an empty conversation and exactly one tool.
* Tool definition: `{ name, label, description, parameters: <TypeBox object>, execute: async (_id, params) => ({ content: [{ type:"text", text: ack }], details: {…counts} }) }`. The tool name is the only "API" the model gets: `record_observations`, `record_reflections`, `drop_observations`.
* `AgentLoopConfig`:

```ts
{
	model, apiKey, headers, env,
	maxTokens: boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),  // AGENT_LOOP_MAX_TOKENS = 32_000, min(model.maxTokens, 32000)
	convertToLlm: (msgs) => msgs as Message[],
	toolExecution: "sequential",
	...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
	...(effectiveMaxTurns !== undefined ? { shouldStopAfterTurn: … } : {}),
}
```

* `reasoning` is `(model as {reasoning?: unknown}).reasoning` — thinking is only forwarded for models that advertise reasoning support.
* `effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined`; the cap is applied as `shouldStopAfterTurn: () => { turnCount++; return turnCount >= effectiveMaxTurns; }` (observer/reflector/dropper; observer spells it with a body, the other two use `++turnCount >= effectiveMaxTurns`).
* `signal` is accepted by every agent but **no caller passes one** — background workers are not cancellable through the current triggers.
* The thinking level passed by the pipeline is `runtime.config.model?.thinking ?? "low"` (i.e. the *configured override model's* thinking, or `"low"` — note it does not consult the session model).

### 3.4 Structured output: collection + validation

The model's structured output is **never parsed from assistant text**. Each tool's `execute` closure accumulates into a local collection; the final assistant message ("a short plain-text confirmation") is discarded.

**Observer** — `record_observations` schema:

```ts
const RecordObservationsSchema = Type.Object({
	observations: Type.Array(Type.Object({
		timestamp: Type.String({ pattern: OBSERVATION_TIMESTAMP_PATTERN, description: "Observation time in local 'YYYY-MM-DD HH:MM' format." }),
		content: Type.String({ minLength: 1, description: "Single-line plain prose. No markdown, no tags, no embedded timestamp." }),
		relevance: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]),
		sourceEntryIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Exact source entry ids from the chunk … never invent ids." }),
	})),
});
```

`execute` per observation: `normalizeSourceEntryIds(obs.sourceEntryIds, allowedSourceEntryIds)` → rejects the *whole* observation if any id is outside the allowlist (`if (!allowedOrder.has(id)) return undefined;`), then dedups and **sorts by chunk order**; on success `truncateRecordContent(content)`, `id = hashId(content)`, skip if already accumulated, else store `{ id, content, timestamp, relevance, sourceEntryIds, tokenCount: observationLineTokenCount({id,timestamp,relevance,content}) }`. Ack text reports `added / duplicates / rejected / total so far`. Rejections are also independently counted and aggregated in the debug log as `observer.records` etc.

**Reflector** — `record_reflections` schema:

```ts
Type.Object({
	reflections: Type.Array(Type.Object({
		content: Type.String({ minLength: 1 }),
		supportingObservationIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	}), { minItems: 1 }),
});
```

`execute`: `normalizeReflectionContent` (trim → truncate → reject if empty or contains `\r`/`\n`), `normalizeSupportingObservationIds(ids, allowedObservationIds = observations.map(o => o.id))` (reject-all if any id unknown, dedupe, order by observation order), dedupe against `existingReflectionIds` and `accumulated`, then `{ id: hashId(content), content, supportingObservationIds, tokenCount: estimateStringTokens(content) }`. Ack: `Recorded N reflections; D duplicates; R rejected. Total this run: T.`

**Dropper** — `drop_observations` schema:

```ts
Type.Object({ ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), reason: Type.Optional(Type.String()) });
```

`execute` filters to ids present in the active observation map (unknown → `missingIdsCount++`), skips in-request and in-run duplicates, and appends to `proposedDropIds` in proposal order. Ack reports queued count, total candidates, and `maxDropsAllowed`.

**Selection after the loop** (`selectDropCandidates`, `dropper/agent.ts:104-134`): deterministic re-ranking of the model's proposals:

```ts
.sort((a, b) => {
	const coverageDelta = REFLECTION_COVERAGE_DROP_RANK[tier(a)] - REFLECTION_COVERAGE_DROP_RANK[tier(b)];
	const relevanceDelta = RELEVANCE_DROP_RANK[a.relevance] - RELEVANCE_DROP_RANK[b.relevance];
	const ageDelta = timestampRank(a.timestamp) - timestampRank(b.timestamp);   // Date.parse, NaN → +Infinity
	return coverageDelta || relevanceDelta || ageDelta || a.index - b.index;
})
.slice(0, maxDrops)
```

i.e. **strong coverage first, then partial, then none; then low → critical; then oldest first; then proposal order**. The model cannot exceed `maxDropsAllowed`.

### 3.5 Turn capping, draining, and error handling

```ts
const loop = args.agentLoop ?? agentLoop;
const stream = loop(prompts, context, config, signal, resolveWorkerStreamSimple(model, args.modelRegistry, args.streamSimple));
for await (const event of stream) {
	logAgentStreamError("<stage>", event);   // debug-logs message_end with stopReason error/aborted
}
await stream.result();
```

* Nothing in the stream is consumed for content — events are drained so the loop can run; the tool closures hold the output.
* `stream-errors.ts:13-22` logs `<stage>.stream_error` with `{ stopReason, errorMessage }` for any assistant `message_end` with `stopReason === "error" | "aborted"`.
* **Observer** keeps a `streamError` snapshot from the same events and, if nothing accumulated, throws:

```ts
export class ObserverStreamError extends Error {
	readonly stopReason: string;
	constructor(stopReason: string, errorMessage?: string) {
		super(`observer stream ended with stopReason "${stopReason}"${errorMessage ? `: ${errorMessage}` : ""}`);
		this.name = "ObserverStreamError";
		this.stopReason = stopReason;
	}
}
```

This is the *only* stage that distinguishes "API failed" from "model deliberately recorded nothing" (issue #32). The pipeline turns it into `recordConsolidationStageError(ctx, "observer", …)` + `"abort"` — coverage stays put, and the reflector/dropper do not run.
* **Reflector and dropper** treat a stream error as no output (`undefined`) — they log it, return nothing, and the caller sees `"continue"`. No exception, no retry, no abort.
* Pipeline-level catch (`runConsolidationPipeline`) records the stage error and returns; it never rethrows into the host. `runtime.launchConsolidationTask` additionally wraps everything in try/catch/finally with a `ui.notify("Observational memory: consolidation failed: …", "warning")`.

---

## 4. Fold / projection algebra

There are **two** folding implementations with different boundary semantics, plus a diff operator.

### 4.1 `fold.ts` — physical-order fold (used at branch tip)

```ts
export type FoldLedgerOptions = { upToEntryId?: string };  // "Fold entries from branch root through this entry id, inclusive."

export type FoldedLedger = {
	observations: Observation[];            // incl. dropped
	activeObservations: Observation[];      // not tombstoned
	droppedObservationIds: Set<string>;     // incl. ids with no folded observation
	reflections: Reflection[];
	observationsById: Map<string, Observation>;
	reflectionsById: Map<string, Reflection>;
};
```

`foldLedger`:

* `foldEndIndex(entries, upToEntryId)` = `entries.findIndex(e => e.id === upToEntryId)`, **falling back to the last index when the id is not found** (`:33-37`). This is a physical stop index.
* Iterates `i = 0 … endIdx`; for each observations/reflections payload it keeps **first-valid-record-wins** (`if (!observationsById.has(id)) set(...)`) and `continue`s (so a memory entry can be only one kind).
* Drop entries add tombstones and fall through (no `continue` at the end of that branch).
* Invalid payloads (`!isObservationsRecordedData(entry.data)` etc.), unknown customTypes, V2 entries and compaction `details` are simply skipped.
* `observations = [...observationsById.values()]` (Map preserves insertion = first-seen order), `activeObservations = observations.filter(o => !dropped.has(o.id))`, `reflections = [...reflectionsById.values()]`.

Callers: the reflector (input pools), the dropper (input pools + pool metrics), `/om:status` (counts). These all want "current branch truth", so the physical-tip fold is right for them.

### 4.2 `projection.ts` — watermark-boundary fold

Boundary model:

```ts
type ProjectionBoundary = { kind: "entry"; entryId: string } | { kind: "tip" } | { kind: "none" };
type ProjectionFoldOptions = {
	observationsBoundary: ProjectionBoundary;
	reflectionsBoundary: ProjectionBoundary;
	dropsBoundary: ProjectionBoundary;
};

function boundaryIndex(entries, indexes, boundary) {
	if (boundary.kind === "tip") return entries.length - 1;
	if (boundary.kind === "none") return -1;
	return indexes.get(boundary.entryId) ?? -1;        // dangling entry id → -1
}
function coverageIndex(entry, indexes) { return indexes.get(entry.data.coversUpToId) ?? -1; }  // dangling watermark → -1
function isAtOrBefore(index, boundaryIndex) { return index >= 0 && boundaryIndex >= 0 && index <= boundaryIndex; }
```

So a memory entry is included **iff its `coversUpToId` resolves to an entry that exists in the same branch array at or before the boundary**. `none` (index `-1`) excludes everything; a dangling watermark excludes that entry; the *physical position* of the `om.*` entry itself is irrelevant — an `om.observations.recorded` entry appended after the boundary is still included if its watermark points before the boundary.

`foldProjection(entries, options)` walks the whole array once, and for each kind applies its own boundary:

```ts
if (isObservationsRecordedEntry(entry) && isCoveredAtOrBefore(entry, indexes, observationsBoundary)) { …dedupe by id, push… ; continue; }
if (isReflectionsRecordedEntry(entry)  && isCoveredAtOrBefore(entry, indexes, reflectionsBoundary))  { … ; continue; }
if (isObservationsDroppedEntry(entry)  && isCoveredAtOrBefore(entry, indexes, dropsBoundary))       { …add tombstones…; }
…
return { observations: observations.filter(o => !droppedObservationIds.has(o.id)), reflections };
```

Drops are collected **during** the same pass and applied at the end, so ordering between a drop entry and the observation it kills does not matter beyond their coverage markers.

### 4.3 The four projections

| Function | Observations boundary | Reflections boundary | Drops boundary | Meaning |
|---|---|---|---|---|
| `fullProjection(entries, upToEntryId?)` | `entryBoundary(upTo)` or `tip` | same | same | full ledger truth through a boundary; drops applied |
| `visibleProjection(entries)` (no boundary) | — (no fold) | — | — | reads `latestV3CompactionDetails(entries)` and returns copies of its arrays; `{[],[]}` when there is no valid `om.folded` compaction |
| `visibleProjection(entries, boundary)` | delegates to `buildCompactionProjection(entries, boundary, { observationsPoolMaxTokens: Number.POSITIVE_INFINITY })` | | | "what compaction *would* write at this boundary" (fullFold forced false) |
| `buildCompactionProjection(entries, firstKeptEntryId, { observationsPoolMaxTokens })` | see §5 | | | the actual compaction projection |
| `foldLedger(entries)` (fold.ts) | physical tip | physical tip | physical tip | branch truth for workers/status |

`latestV3CompactionDetails` scans **backwards** for `entry.type === "compaction" && isMemoryDetails(entry.details)` and returns the first hit. `projectionFromMemoryDetails` copies the arrays (`[...details.observations]`).

`diffProjection(visible, full)`:

```ts
{
	observationsOnlyInFull: full.observations.filter(o => !visibleIds.has(o.id)),
	reflectionsOnlyInFull:  full.reflections.filter(r => !visibleReflectionIds.has(r.id)),
	droppedOnlyInFull:      visible.observations.filter(o => !fullObservationIds.has(o.id)),  // visible but now dropped
}
```

Used by `/om:status` to print `+N` / `-N` drift suffixes.

### 4.4 Full fold vs normal compaction — exact rule

`buildCompactionProjection` (`projection.ts:173-208`), verbatim logic:

```ts
const fullFoldBoundaryId = latestFullFoldBoundaryId(entries);
const maintenanceBoundary = fullFoldBoundaryId ? entryBoundary(fullFoldBoundaryId) : noneBoundary();
const normalProjection = foldProjection(entries, {
	observationsBoundary: entryBoundary(firstKeptEntryId),
	reflectionsBoundary: maintenanceBoundary,
	dropsBoundary: maintenanceBoundary,
});
const observationTokens = normalProjection.observations.reduce((t, o) => t + o.tokenCount, 0);
const fullFold = observationTokens >= config.observationsPoolMaxTokens;
const projection = fullFold ? fullProjection(entries, firstKeptEntryId) : normalProjection;
const details: MemoryDetails = { type: OM_FOLDED, version: 1, fullFold, observations: projection.observations, reflections: projection.reflections };
```

with

```ts
export function latestFullFoldBoundaryId(entries: Entry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "compaction") continue;
		if (!isMemoryDetails(entry.details)) continue;
		if (!entry.details.fullFold) continue;
		if (!entry.firstKeptEntryId) continue;
		if (!indexes.has(entry.firstKeptEntryId)) continue;
		return entry.firstKeptEntryId;
	}
	return undefined;
}
```

Consequences:

* **Normal compaction** advances *observations* to the new boundary, but **holds reflections and drops stable at the previous full fold's `firstKeptEntryId`** (or at `none` — no reflections, no drops — if there has never been a full fold). That is why the first compaction can contain observations with no reflections at all.
* **Full fold** folds all three streams through the new `firstKeptEntryId`, so reflections/drops "catch up".
* The trigger for a full fold is *observation token pressure in the normal projection*, `>= observationsPoolMaxTokens` (note `>=`, tested explicitly), not the dropper target.
* `firstKeptEntryId` used as the boundary is Pi's compaction cut point — the same id returned to Pi in the hook, and the id Pi persists on the compaction entry.

### 4.5 Coverage markers in the pipeline vs the fold

The observer uses `fullProjection(entries)` at the **branch tip** for the "prior memory" preamble, while the compaction hook uses a **bounded** projection. `latestCoverageIndex` (max covered index) drives the chunk window (`sourceEntriesAfter(entries, lastCoverageIdx)`), not the projection.

---

## 5. Compaction integration

### 5.1 The hook

```ts
pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
	if (runtime.compactHookInFlight) {
		if (ctx.hasUI) ctx.ui.notify("Observational memory: another compaction is already in progress; cancelling duplicate", "warning");
		return { cancel: true };
	}
	runtime.compactHookInFlight = true;
	try {
		runtime.ensureConfig(ctx.cwd);
		const { preparation, branchEntries } = event;
		const { firstKeptEntryId, tokensBefore } = preparation;
		const projection = buildCompactionProjection(branchEntries as Entry[], firstKeptEntryId, {
			observationsPoolMaxTokens: observationsPoolMaxTokens(runtime),
		});
		const summary = renderSummary(projection.reflections, projection.observations);
		if (summary.length === 0) {
			// Decline ownership so Pi's native summarizer preserves the pre-cut context.
			return;
		}
		return { compaction: { summary, firstKeptEntryId, tokensBefore, details: projection.details } };
	} finally {
		runtime.compactHookInFlight = false;
	}
});
```

Inbound contract used: `event.preparation.firstKeptEntryId`, `event.preparation.tokensBefore`, `event.branchEntries`.
Outbound contract:

* `{ cancel: true }` — duplicate in-flight hook.
* `undefined` — no extension compaction; Pi's native summarizer runs (this is the "empty projection" delegation).
* `{ compaction: { summary: string, firstKeptEntryId: string, tokensBefore: number, details: MemoryDetails } }`.

`observationsPoolMaxTokens(runtime)` falls back to `DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000` if the config value isn't a finite positive number.

### 5.2 Deterministic summary rendering (`session-ledger/render-summary.ts`)

```ts
export function observationToSummaryLine(o: Observation): string {
	return `[${o.id}] ${o.timestamp} [${o.relevance}] ${o.content}`;
}
export function reflectionToSummaryLine(r: Reflection): string {
	return `[${r.id}] ${r.content}`;
}

export function renderSummary(reflections: Reflection[], observations: Observation[]): string {
	if (reflections.length === 0 && observations.length === 0) return "";
	const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];
	if (reflections.length > 0) parts.push(`## Reflections\n${reflections.map(reflectionToSummaryLine).join("\n")}`);
	if (observations.length > 0) parts.push(`## Observations\n${observations.map(observationToSummaryLine).join("\n")}`);
	return parts.join("\n\n");
}
```

`CONTEXT_USAGE_INSTRUCTIONS` (verbatim, `render-summary.ts:3-10`):

```text
These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the recall tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. Do not use recall as broad search or inject raw source unless it is needed.
```

No model call, no paraphrase, no truncation at render time. The empty-summary signal (`length === 0`) is the delegation switch, so a projection with only reflections still produces a summary.

### 5.3 Concurrency guards

* `runtime.compactHookInFlight` — re-entrancy guard for `session_before_compact` only. It is set/reset inside a `try/finally` around a body with **no awaits**, so it protects against a synchronous re-entrant hook (and against a second hook that starts before the first microtask resolves), not against overlapping long work.
* `runtime.compactInFlight` — set before the deferred `setTimeout(0)` in the auto-compaction trigger; cleared in every exit path (`onComplete`, `onError`, `!ctx.isIdle()`, below-threshold re-check, throw).
* `runtime.consolidationInFlight` + `runtime.consolidationPromise` — the observer/reflector/dropper pipeline lock, shared by `agent_start` and `turn_end`.
* The three guards are independent: compaction does not wait for consolidation and vice versa. Status reports all three.

---

## 6. Recall

### 6.1 Pure resolution (`session-ledger/recall.ts`)

`recallMemorySources(entries, memoryId)`:

1. `indexLedger(entries)` scans the **whole branch array** (no boundary) and produces `observations: IndexedObservation[]` (`{observation, entryId, entryIndex, recordIndex}`), the same for reflections, and `droppedIds: Set<string>`.
2. `directObservationMatches` = every indexed observation with `id === memoryId`; `reflectionMatches` likewise. If both empty → `not_found` result literal.
3. `observationsById` keeps the **first** indexed record per observation id (first-valid-wins, mirroring the fold) — this is the index used for reflection→supporting-observation resolution.
4. `addObservation(indexed)` keyed by `` `${entryId}:${recordIndex}` `` so multiple colliding records are all returned, but the same record is never added twice. It calls `resolveObservationSources`, then overrides `status` with `"dropped"` when the id is in `droppedIds`.
5. For every matched reflection, each `uniqueStrings(supportingObservationIds)` is looked up in `observationsById`; unresolved ids go to `missingSupportingObservationIds` (the reflection may cite observations not present on this branch, e.g. from a pruned/other branch).
6. `resolveObservationSources`: `sourceEntryIds = uniqueStrings(observation.sourceEntryIds)`; builds `byId = new Map(entries.map(e => [e.id, e]))`; for each id:
   * not found → `missingSourceEntryIds`
   * found but `type ∉ {"message","custom_message","branch_summary"}` → `nonSourceEntryIds`
   * otherwise → `sourceEntries` (original branch order of `sourceEntryIds`).
7. Aggregation: `sourceEntries = uniqueById(recalled.flatMap(sourceEntries))`; `kind` = `"mixed"` if both kinds matched, else `"reflection"` / `"observation"`; `collision = matchCount > 1`; `partial = missingSourceEntryIds.length > 0 || nonSourceEntryIds.length > 0 || missingSupportingObservationIds.length > 0`.

The reflection chain is therefore exactly: **reflection id → `supportingObservationIds` (first-valid observation record per id) → `Observation.sourceEntryIds` → raw branch entries rendered by `renderRecallSourceEntry`**. `Reflection` itself has no direct source-entry link.

### 6.2 The `recall` tool (`tools/recall-observation.ts`)

* `RECALL_OBSERVATION_TOOL_NAME = "recall"`; label `"Recall memory evidence"`; parameters `Type.Object({ id: Type.String({ pattern: "^[a-f0-9]{12}$", … }) })`.
* `promptSnippet` + six `promptGuidelines` (including *"Do not use recall as semantic search or transcript browsing; you must already have a specific 12-character memory id."*).
* `execute` re-validates with its own `MEMORY_ID_PATTERN` → `invalid_id`; reads `ctx.sessionManager.getBranch()`; `not_found` message otherwise.
* Rendering: for `kind === "observation"`, the text is the raw source transcript (`renderRecallSourceEntries`), with notes for dropped/collision/missing/non-source; otherwise memory lines (`Reflections:` / `Observations:` with `[id] [dropped] timestamp [relevance] content`) plus `Unavailable supporting observations:` / `Unavailable source entries:` / `Sources:`.
* `details.status` aggregation: `partial` → `"partial"`; observation-only with a `source_unavailable` match → `"source_unavailable"`; observation-only with zero resolvable sources → `"no_source"`; else `"ok"`.
* TUI: `renderCall` → `recall <id>`; `renderResult` → aligned rows (`✓ source`, `✓ observation`, `✓ reflection`, `• note`), indented source content when expanded, otherwise `(Ctrl+O to expand)`; header `✓ success · N observations · N sources · ~N tokens` or `× failure`.

---

## 7. Prompts

All three system prompts share the same opening rhetorical device — *"These records are the ONLY information the assistant will have about past interactions once the raw conversation is compacted out of context. Anything you do not capture here will be forgotten. Anything you distort here will be remembered wrong. Take this seriously."* (observer) / *"Anything you fail to preserve may be forgotten. Anything you distort may be remembered wrong."* (reflector, which adds *"Over-reflection is also memory distortion"*) / *"Dropping the wrong observation can make future work repeat, contradict, or misremember the user."* (dropper).

### 7.1 Observer — `OBSERVER_SYSTEM` (119 lines) + tool `record_observations`

Receives: current reflections, current observations (as `[id] YYYY-MM-DD HH:MM [relevance] content`), the new chunk with `[Source entry id: <id>]` labels and inline `[User @ …]` / `[Assistant @ …]` / `[Tool result for <name> @ …]` timestamps, and a current-local-time fallback.

Key instructions (quoted):

> 3. Call record_observations with a batch covering part (or all) of the chunk.
> 4. Read the progress receipt. If content remains uncovered, call again. You may call the tool many times.
> 5. When the chunk is fully covered, STOP calling the tool and reply with a brief plain-text confirmation (one short sentence). That ends the run.

> Never invent source entry ids. Use only ids printed in the chunk. If an observation spans multiple turns or tool results, include every supporting source entry id.

> Observations with missing, empty, or invalid sourceEntryIds will be rejected and not recorded, so do not call record_observations until you can cite valid source ids.

> Skip routine, low-information events. It is fine to emit zero observations if the chunk carries no new information — in that case, simply do not call the tool and end with a plain-text confirmation.

Content rules: single line of plain prose, no markdown/bullets/code fences/tags/emojis, no timestamp or relevance inside `content`, no `key: value`/JSON. Plus a long list of "why this matters" rules with BAD/GOOD pairs:

> Preserve user assertions exactly. … if the user says "I use Postgres" and later asks "what db am I on?", downstream agents must treat the assertion as the answer, not the question.
> Preserve unusual phrasing. … User stated they did a "movement session" (their term) yesterday.
> Use precise action verbs. … BAD: User got the library. GOOD: User installed the zod package via pnpm.
> Frame state changes as supersession so the old state is explicit. … GOOD: User will use React Query (switching from SWR).
> Mark concrete completions explicitly. Use "completed:", "resolved:", "confirmed working", … GOOD: completed: implemented login handler at src/auth/login.ts; user confirmed tests pass.
> Split compound statements into separate observations. … One observation per line is what enables downstream retrieval and dropping to operate at fact granularity.
> Group repeated similar tool calls into a single observation rather than one per call.
> Detail preservation. … File/location: full path + line number (src/auth.ts:45, not "the auth file"). … Error messages: quote verbatim. … Numerical results: exact values, units, and direction.

Relevance guidance (this field drives future dropping):

> - critical: user assertions about identity, role, or persistent preferences; explicit corrections ("no, don't do X"); concrete completions that future runs MUST NOT redo. …
> - high: non-trivial technical decisions, architectural direction, unresolved blockers, key constraints. …
> - medium: task-level context that helps within the current work but isn't durable. The default when you are unsure between medium and high.
> - low: routine tool-call acks, repetitive status updates, content trivially re-derivable from recent messages. The dropper will drop these first.
>
> Do NOT default to "critical" or "high". Most observations are medium or low. Reserve "critical" for things that would cause real damage if forgotten.

> Timestamp format: "YYYY-MM-DD HH:MM" (local time, 24-hour, to the minute). This goes in the timestamp field, not the content.

User message template (`observer/agent.ts:164-175`):

```text
Current local time: ${now}

CURRENT REFLECTIONS:
${priorReflections.join("\n") | "(none yet)"}

CURRENT OBSERVATIONS:
${priorObservations.join("\n") | "(none yet)"}

Compress the following new conversation chunk into observations by calling record_observations one or more times. Do not restate facts already present in current reflections or current observations. Prefer inline conversation timestamps when assigning times; fall back to the current local time above only if no message timestamp applies. Stop calling the tool and reply with a short plain-text confirmation once the chunk is fully covered.

NEW CONVERSATION CHUNK:
${conversation}
```

### 7.2 Reflector — `REFLECTOR_SYSTEM` (81 lines) + tool `record_reflections`

> Your task is different from the observer's: you are not recording events, you are distilling stable, long-lived facts and patterns from active observations into new reflections by calling record_reflections. Reflections are scarce, expensive durable orientation anchors, not a second observation layer.

Coverage tiers are explicitly framed as review context:

> Coverage tiers are review context: none means no current reflection supports the observation id, partial means exactly one current reflection supports it, and strong means two or more current reflections support it. Coverage is not a quota, target, priority score, or instruction to emit reflections.

Abstraction gate:

> - Do not turn each observation into a reflection. Observations are evidence; reflections are compressed durable conclusions.
> - A reflection should usually do at least one of these: combine multiple observations into one durable pattern, preserve a user preference/constraint/correction/decision, record a completed outcome future runs must not redo, or capture durable rationale …
> - Prefer fewer, higher-value reflections. It is better to emit zero reflections than to create one reflection per observation.

Decision procedure (5 steps, ending *"If unsure, emit no reflection."*), plus:

> supportingObservationIds are a coverage/provenance set and downstream dropper coverage evidence: include all current observation ids whose durable meaning is preserved by the reflection with equivalent fidelity and can later be treated as redundant active-memory detail.
> False or inflated support ids can cause unsafe downstream dropper pruning, including removal of high-resistance active observations whose meaning was not actually preserved.
> Never invent observation ids. Proposals with missing, empty, or invalid supportingObservationIds are rejected.

> User assertions are authoritative. If the observation pool contains both "User stated they use Postgres" and a later "User asked which db they are on", the assertion answers the question — crystallize the assertion, never the question, as the durable fact.

Content rules: single line, no markdown/tags/timestamp/priority marker/`key: value`/JSON; lead with the fact; preserve named identifiers/paths/commands/errors/dates/rationale; plus ~10 GOOD/BAD examples including two explicit `ZERO REFLECTIONS:` examples. Note the prompt contains an example referencing the extension's own implementation (*"completed: V3 reflect/drop coverage now uses raw progress watermarks…"*).

Observation line format fed to the reflector (`observationToReflectorLine`, `reflector/agent.ts:53-58`):

```ts
`[${observation.id}] ${observation.timestamp} [${observation.relevance}] [coverage: ${coverage}] ${observation.content}`
```

User message:

```text
CURRENT REFLECTIONS:
${reflections.map(reflectionToSummaryLine) | "(none yet)"}

CURRENT OBSERVATIONS:
${observations.map(o => observationToReflectorLine(o, coverageTierForObservation(o, coverageById))) | "(none yet)"}

Crystallize any missing durable facts or patterns into new reflections. If nothing is stable enough, do not call the tool.
```

The reflector also emits extensive diagnostics: `reflector.agent_start` (coverage summary by relevance), `reflector.result` with `reason ∈ {"accepted_nonempty","no_tool_call","all_filtered"}`, `acceptedSupportIdCounts` (min/max/avg/histogram of support-id counts) and `coverageTransitionsByRelevance` (`none->partial`, `partial->strong`, … count+tokens per relevance).

### 7.3 Dropper — `DROPPER_SYSTEM` (48 lines) + tool `drop_observations`

> Your job is to identify only the safest active observations to remove from compacted memory by calling drop_observations with their ids. Default action is KEEP. When uncertain, keep the observation.
> Active-memory framing. Dropping an observation removes it from active compacted memory; it does not erase the ledger history or source evidence.

> The maximum is a hard upper bound sized to move the pool toward the target if every proposed drop is clearly safe. It is not a target. Do not try to fill it.

What to drop, in priority order: redundant-with-reflection → superseded → repeated routine acks/low-signal progress → older observations no longer carrying working context.

> Age-gradient rule. Recent observations carry working context the assistant may still need; older observations have usually been summarized elsewhere or are no longer load-bearing. Prefer older safe drops before newer working context, but age alone is not enough to drop important or uniquely load-bearing observations.

Coverage guidance maps 1:1 to the tiers (`none` → be cautious, especially high/critical; `partial` → compare; `strong` → stronger evidence but still keep uniquely load-bearing/uncertain items). Relevance guidance: `low` consider first but only if no unique detail; `medium` drop when redundant/obsolete; `high` only when clearly superseded or captured with equivalent fidelity; `critical` only with *"strong semantic evidence such as age plus partial/strong reflection coverage, supersession by newer memory, redundancy, or clear obsolescence."*

Preservation floor — *"Regardless of relevance label, budget pressure, coverage, or age, do not drop observations that uniquely carry any of the following:"* user preferences/constraints/corrections/identity; concrete completions; **named identifiers, file paths, function names, package names, tickets, commit SHAs, handles, or exact commands**; exact error messages/diagnostic output/test failure names; architectural decisions and rationale; dates; current unresolved blockers/TODOs/partial work; non-standard user terminology.

> What you cannot do:
> - You cannot merge observations.
> - You cannot rewrite or edit observations.
> - You cannot add new observations or reflections.
> - You can only call drop_observations with ids from the current observations list.

> Do not force drops you do not believe in. If no observations are safe to drop, do not call the tool and reply briefly.

Observation line format (`observationToDropperLine`, `dropper/coverage.ts:116-121`) is identical to the reflector's, including `[coverage: …]`.

User message (`dropper/agent.ts:237-238`):

```text
CURRENT REFLECTIONS:
${reflections.map(reflectionToSummaryLine) | "(none yet)"}

CURRENT OBSERVATIONS:
${observations.map(o => observationToDropperLine(o, coverage)) | "(none yet)"}

Active observation pool: ~${observationTokens} tokens; target: ~${targetTokens} tokens; fullness against target: ~${fullnessPercent}%; over target by ~${tokensOverTarget} tokens.
Maximum drops allowed this run: ${maxDropsAllowed} observation(s). This maximum is sized to move the active pool toward the target if every proposed drop is clearly safe.
This maximum is a hard upper bound, not a target. Drop fewer or none if fewer observations are clearly safe.
```

### 7.4 Shared prompt inputs

* Observer `priorReflections` / `priorObservations` come from `fullProjection(entries)` mapped through `reflectionToSummaryLine` / `observationToSummaryLine` — i.e. the *full* branch-tip memory, not the visible projection.
* Reflector/dropper use `foldLedger(entries)` results (all reflections; active observations) and, for the dropper, `mergeReflections(folded.reflections, sameRunReflections)`.

---

## 8. Config surface

### 8.1 Interface + defaults (`src/config.ts:33-66`)

```ts
export interface Config {
	observeAfterTokens: number;
	reflectAfterTokens: number;
	observerChunkMaxTokens?: number;
	compactAfterTokens: number;
	compactAfterTokensMode: CompactAfterTokensMode;   // "calibrated" | "ratio"
	compactAfterTokensRatio: number;
	observationsPoolMaxTokens: number;
	observationsPoolTargetTokens: number;
	agentMaxTurns: number;
	model?: ConfiguredModel;                          // { provider, id, thinking? }
	showWorkerNotifications: boolean;
	passive: boolean;
	debugLog: boolean;
}

export const DEFAULTS: Config = {
	observeAfterTokens: 10_000,
	reflectAfterTokens: 20_000,
	compactAfterTokens: 81_000,
	compactAfterTokensMode: "calibrated",
	compactAfterTokensRatio: 0.68,
	observationsPoolMaxTokens: 20_000,
	observationsPoolTargetTokens: 10_000,
	agentMaxTurns: 16,
	showWorkerNotifications: true,
	passive: false,
	debugLog: false,
};
```

Other constants: `THINKING_LEVEL_VALUES = ["off","minimal","low","medium","high","xhigh","max"]`,
`OBSERVER_CHUNK_FALLBACK_MAX_TOKENS = 60_000`, `OBSERVER_CHUNK_MIN_TOKENS = 256`,
`OBSERVER_CHUNK_CONTEXT_RATIO = 0.2`, `SETTINGS_KEY = "observational-memory"`,
`PASSIVE_ENV = "PI_OBSERVATIONAL_MEMORY_PASSIVE"`.

### 8.2 Sources and precedence (`loadConfig`)

```ts
const globalPath  = join(getAgentDir(), "settings.json");
const projectPath = join(cwd, ".pi", "settings.json");
const merged = { ...DEFAULTS, observationsPoolTargetTokens: undefined, ...globalConfig, ...projectConfig, ...envConfig };
```

Per-file parsing: `readNamespacedConfig` → `JSON.parse` → take `raw["observational-memory"]` → `normalizeSettingsConfig`. Malformed JSON or a missing/non-object namespace → `{}` (silent). Unknown keys are dropped; there are no V2 aliases.

Validators: `positiveIntegerOrUndefined` (finite integer > 0) for the numeric keys `observeAfterTokens`, `reflectAfterTokens`, `observerChunkMaxTokens`, `compactAfterTokens`, `observationsPoolMaxTokens`, `observationsPoolTargetTokens`, `agentMaxTurns`; booleans must be literal booleans; `isThinkingLevel` against the 7-value list; `validRatioOrUndefined` = finite `0 < r < 1`; `normalizeModel` requires non-empty string `provider` **and** `id`.

Env override (`readEnvConfig`): only `PI_OBSERVATIONAL_MEMORY_PASSIVE`; truthy `1|true|yes|on` → `{passive:true}`, falsy `0|false|no|off` → `{passive:false}`, anything else ignored.

Derived values:

* `observationsPoolTargetTokens`: `validTargetOrUndefined(merged.observationsPoolTargetTokens, merged.observationsPoolMaxTokens) ?? Math.floor(merged.observationsPoolMaxTokens / 2)` — i.e. an explicit target is only accepted when it is a positive integer **strictly below the final max**.
* `resolveCompactAfterTokens(config, contextWindow)`: in `"ratio"` mode `Math.max(1, Math.floor(contextWindow * compactAfterTokensRatio))` when `contextWindow` is a positive number, else `compactAfterTokens`.
* `resolveObserverChunkMaxTokens(config, contextWindow)`: explicit `config.observerChunkMaxTokens > 0` wins, clamped up to `256`; else `max(256, floor(contextWindow * 0.2))`; else `60_000`.

### 8.3 Full key reference

| Key | Type / validation | Default | Meaning |
|---|---|---|---|
| `observeAfterTokens` | positive int | `10000` | Observer clock threshold (real provider-token delta since the observation watermark, else raw source-token estimate). Also the deliberate-empty backoff step. |
| `reflectAfterTokens` | positive int | `20000` | Reflector clock threshold (same measurement, reflection watermark). |
| `observerChunkMaxTokens` | positive int, min clamp `256` | derived: `20% × model.contextWindow`, else `60000` | Max estimated tokens serialized into one observer chunk. |
| `compactAfterTokens` | positive int | `81000` | Auto-compaction threshold when mode is `calibrated`. |
| `compactAfterTokensMode` | `"calibrated" \| "ratio"` | `"calibrated"` | How the compaction threshold is derived. |
| `compactAfterTokensRatio` | finite `0 < r < 1` | `0.68` | Multiplier on `ctx.model.contextWindow` in ratio mode. |
| `observationsPoolMaxTokens` | positive int | `20000` | Full-fold pressure: normal-projection observation tokens `>=` this ⇒ compaction does a full fold. Also the denominator for `/om:status` visible-pool %. |
| `observationsPoolTargetTokens` | positive int `< observationsPoolMaxTokens` | `floor(max/2)` = `10000` | Dropper active-observation target and `maxDropsAllowed` basis. |
| `agentMaxTurns` | positive int | `16` | Shared nested-agent turn cap (model response cycles) for observer/reflector/dropper. |
| `model` | `{ provider, id, thinking? }` | unset | Worker model override; falls back to the session model (with a one-time warning) if unresolvable. |
| `model.thinking` | enum | unset → workers use `"low"` | Forwarded as `reasoning` only when the model advertises `reasoning`. |
| `showWorkerNotifications` | boolean | `true` | Routine worker progress notifications; warnings/errors always show. |
| `passive` | boolean (env-overridable) | `false` | Disables consolidation trigger + auto-compaction; hooks/commands/recall still work. |
| `debugLog` | boolean | `false` | Per-session NDJSON debug log under `getAgentDir()/observational-memory/debug/<sessionId>.ndjson` (fallback `debug.ndjson`), rotated at 10 MiB to `.1`. |

---

## 9. Porting risks — Pi-specific dependencies

### 9.1 Hard API dependencies (must be re-implemented)

1. **Extension event surface.** `pi.on("agent_start" | "turn_end" | "agent_settled" | "session_before_compact", handler)` + `ExtensionContext`. The whole scheduling model assumes two different "turn boundary" events, a "settled" event that fires *after* retries/auto-compaction/queued continuation, and a pre-compaction hook that can return a compaction payload. A harness without a settled-equivalent cannot safely defer `ctx.compact()`.
2. **`pi.appendEntry(customType, data)`** — append a custom ledger entry to the current branch and (in tests) return its id. The ledger *is* the memory; there is no side database. Requires branch-ordered, id-stable, session-persisted custom entries.
3. **Branch entry model.** `type: "custom"` + `customType` + `data`; `type: "compaction"` + `firstKeptEntryId` + `details` + `summary`; `type: "custom_message"`; `type: "branch_summary"`; `type: "message"` carrying a pi-ai `Message` (`role`, `content` blocks of `text`/`thinking`/`toolCall`, `timestamp`, `toolName`, `usage`, `stopReason`, `errorMessage`). `serialize.ts`, `tokens.ts`, `progress.ts` and `recall.ts` all encode these shapes.
4. **`ctx.sessionManager.getBranch()` / `getSessionId()` / `getSessionFile()`** — a materialized branch path (not the whole session tree), used for every fold, clock, watermark and recall. Session identity is the backoff key and debug-log filename.
5. **`ctx.getContextUsage()`** — provider-reported current context tokens; the entire "real clock" (`realTokensSinceAnchor`) degrades to raw estimates without it. Note the auto-compaction clock never uses it.
6. **`ctx.compact({ onComplete, onError })` and `ctx.isIdle()`**, plus the magic error string `"Compaction cancelled"` for the cancelled-by-hook path.
7. **`session_before_compact` contract** — `event.preparation.firstKeptEntryId` / `tokensBefore`, `event.branchEntries`; return `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }`, `{ cancel: true }`, or `undefined` (which must mean "native summarizer runs"). Pi persists `details` onto the resulting compaction entry, which is what `visibleProjection` later reads — a port must persist that field or visible memory is always empty.
8. **`agentLoop` from `@earendil-works/pi-agent-core`** with `AgentContext { systemPrompt, messages, tools }`, `AgentLoopConfig { model, apiKey, headers, env, maxTokens, convertToLlm, toolExecution, reasoning, shouldStopAfterTurn }`, `AgentTool<T>` with TypeBox `parameters`, an event `AsyncIterable` with `message_end` events carrying `stopReason`/`errorMessage`, and `stream.result()`. Plus `Type` from `pi-ai` and `Static` from `typebox`.
9. **`resolveWorkerStreamSimple` (worker-stream.ts)** — the composed-provider streaming path. `registerProvider` is *not* called here, but the registry's `streamSimple` / `getRegisteredProviderIds` / `getRegisteredProviderConfig` (matched by `config.api === model.api`) is what makes custom provider APIs work. Falling back to `@earendil-works/pi-ai/compat` reproduces bug #30 (`No API provider registered for api: …`).
10. **Model registry + auth.** `find(provider,id)`, `getApiKeyAndHeaders(model) → {ok, apiKey, headers, env, baseUrl}`, `isUsingOAuth(model)`, `hasConfiguredAuth(model)`, `refresh({allowNetwork, providers, signal})`. `runtime.ts` is ~200 lines of pi-auth semantics (OAuth header-only auth, Bedrock SigV4 / Vertex ADC ambient credentials that resolve to *empty* auth, the stale availability snapshot workaround). A port with a simple API-key model can delete most of it, but must keep the "OAuth header instead of apiKey" path if it supports OAuth providers.
11. **opencode header injection** — `x-opencode-session` / `x-opencode-client: "pi"` for `provider ∈ {opencode, opencode-go}` or `baseUrl.includes("opencode.ai")`. Provider-specific hack; drop or re-target.
12. **`getAgentDir()`** — global settings path (`<agentDir>/settings.json`) and debug-log root (`<agentDir>/observational-memory/debug/<sessionId>.ndjson`, size-rotated at 10 MiB). Project config path `<cwd>/.pi/settings.json` and env var `PI_OBSERVATIONAL_MEMORY_PASSIVE` are similarly Pi-shaped.
13. **`defineTool` + `@earendil-works/pi-tui` `Text`** — the recall tool's `renderCall`/`renderResult`, `promptSnippet`, `promptGuidelines`, and `AgentToolResult.details` styling (`(Ctrl+O to expand)`). Tool *semantics* port easily; the TUI renderers do not.
14. **Clipboard** (`clipboard.ts`) — hard-coded per-platform commands `pbcopy` / `clip` / `wl-copy` / `xclip -selection clipboard` / `xsel --clipboard --input` / `termux-clipboard-set`, spawned with a 2 s timeout; used only by `/om:view`.
15. **`estimateTokens` from `pi-coding-agent`** (`tokens.ts`) — the only host tokenizer; everything else is `ceil(chars/4)`. A port can substitute any estimator, but be aware the observer chunk cap (`0.2 × contextWindow`) is calibrated for the 4-chars/token assumption (the source comments say it can undercount ~4× on non-ASCII).
16. **`ctx.ui.notify(message, "info" | "warning" | "error")`** and `ctx.hasUI` — every notification path, including the "notify once" model-resolution failure.
17. **Command registration** `pi.registerCommand(name, { description, handler })` and the arg shape (`handler(args, ctx)`; `view.ts` defensively accepts array/string/`{mode}`), plus the `om:status` / `om:view` names.

### 9.2 Behavioral risks independent of the API

* **Docs/code mismatch on priority.** `how-it-works.md:60` and `concepts.md:79` describe observer priority ("reflect/drop does not run when observer work is due"); the code runs observer → reflector → dropper in one pass and re-reads the branch between them. Port the *code*, not the doc, and decide which behavior you want.
* **Reflector has no deliberate-empty backoff.** Once `reflectAfterTokens` is crossed with no successful append, the reflector re-runs on every turn boundary (each run = a model call). The observer's backoff mechanism is right there to be copied.
* **Content-addressed ids** (`sha256(content)[0:12]`) mean dedupe-by-content across the whole branch *and* across sessions merged into one branch; two distinct facts with identical text collapse. `MEMORY_ID_PATTERN /^[a-f0-9]{12}$/` is validated at three layers (types, recall tool schema, recall tool execute).
* **Two fold semantics.** `foldLedger` stops at a *physical index* (dangling `upToEntryId` falls back to the branch tip — silently wider than requested); `foldProjection` includes by *resolved watermark*. Mixing them up changes what the workers see. `latestCoverageIndex` is a **max**, not "the last written entry", so out-of-order appends are tolerated.
* **Abort semantics inside a pass.** Observer stream failure kills the reflector and dropper for that pass; reflector resolution failure kills the dropper; dropper failure is swallowed. Also, `ObserverStreamError` is the only failure/empty discriminator — the reflector and dropper cannot distinguish "model chose nothing" from "API error".
* **No cancellation.** Every worker accepts an `AbortSignal`, but no caller passes one; a hung provider stalls the consolidation lock for the session.
* **Config is loaded once** (`configLoaded` latch) and never re-read; `/om:status` and workers all read `runtime.config` for the process lifetime.
* **`compactHookInFlight` is effectively synchronous-only** (no awaits inside the guarded body); if you add async work to the hook, the duplicate-cancel guard no longer covers it.
* **Token accounting asymmetry:** observations count their rendered line, reflections count content only; `observationPoolMetrics` recomputes from `observationLineTokenCount`, so a reflection-heavy pool has no token accounting at all (reflections are only bounded indirectly, via full-fold pressure on observations).
* **Notification volume:** worker notifications default to on (`showWorkerNotifications: true`) and the observer/reflector/dropper each notify on start; a port with a different UX should default these off or batch them.
* **Stage prompts reference the harness's own concepts** ("session", "compaction", "the recall tool", `src/auth/login.ts` style paths, and one example referencing this extension's V3 internals). They need light rewording when the surrounding vocabulary changes.
* **`/om:view` copies to the OS clipboard** — a surprising side effect for a read-only command; and clipboard failure only downgrades the notice.
* **Debug log schema** (`debug.ndjson` with `ts`, `event`, `cwd`, `sessionId`, `sessionFile`, `runId`, `data`) is a stable-ish contract consumed by the docs' `grep '"event":"dropper'` recipes; a port that keeps the event names (`observer.start/records/empty/chunk_capped/empty_backoff`, `reflector.agent_start/result`, `dropper.agent_start/tool_call/result/not_ready/waiting_for_reflection/stage_start/append`, `resolve.rejected`, `resolve.availability_recheck`, `resolve.request_time_signing`, `<stage>.stream_error`) keeps the operational playbook.

---

## Appendix: exact identifier index

Types/consts: `Observation`, `Reflection`, `MemoryDetails`, `Entry`, `FoldedLedger`, `FoldLedgerOptions`, `Projection`, `ProjectionDiff`, `CompactionProjection`, `CompactionProjectionConfig`, `RecallResult`, `RecalledObservation`, `RecalledReflection`, `RecallObservationToolDetails`, `ObservationPoolMetrics`, `ReflectionCoverageTier`, `CoverageSummaryByRelevance`, `CoverageTransitionSummaryByRelevance`, `Config`, `ConfiguredModel`, `CompactAfterTokensMode`, `ResolveResult`, `ResolveCtx`, `LaunchCtx`, `Runtime`, `ConsolidationPhase`, `SourceAddressedSerialization`, `WorkerStreamSimple`, `StreamableModelRegistry`, `OBSERVER_SYSTEM`, `REFLECTOR_SYSTEM`, `DROPPER_SYSTEM`, `OBSERVATION_TIMESTAMP_PATTERN`, `ObserverStreamError`.

Functions: `hashId`, `estimateStringTokens`, `observationLineTokenCount`, `estimateEntryTokens`, `truncateRecordContent`, `nowTimestamp`, `serializeBranchEntries`, `serializeSourceAddressedBranchEntries`, `renderRecallSourceEntry`, `renderRecallSourceEntries`, `foldLedger`, `fullProjection`, `visibleProjection`, `buildCompactionProjection`, `latestFullFoldBoundaryId`, `diffProjection`, `observationToSummaryLine`, `reflectionToSummaryLine`, `renderSummary`, `isSourceEntry`, `entryIndexById`, `entryIndexForId`, `latestCoverageIndex`, `latestCoverageMarkerId`, `earlierCoverageMarkerId`, `rawTokensAfterIndex`, `rawTokensSinceCoverage`, `rawTokensSinceObservationCoverage`, `rawTokensSinceReflectionCoverage`, `rawTokensSinceDropCoverage`, `findLastCompactionIndex`, `contextTokensFromUsage`, `realContextTokensAfterCompaction`, `realContextTokensAtCoverage`, `realTokensSinceAnchor`, `rawTokensSinceLastCompaction`, `recallMemorySources`, `registerConsolidationTrigger`, `runConsolidationPipeline`, `registerCompactionTrigger`, `registerCompactionHook`, `registerStatusCommand`, `registerViewCommand`, `registerRecallTool`, `recallObservationTool`, `runObserver`, `normalizeSourceEntryIds`, `runReflector`, `normalizeSupportingObservationIds`, `observationToReflectorLine`, `summarizeSupportIdCounts`, `runDropper`, `normalizeDropObservationIds`, `selectDropCandidates`, `observationPoolMetrics`, `observationPoolFullness`, `maxDropCountForPool`, `droppableObservationCount`, `observationTokenSum`, `reflectionCoverageMap`, `reflectionSupportCounts`, `reflectionCoverageTierForCount`, `coverageTierForObservation`, `observationToDropperLine`, `summarizeCoverageByRelevance`, `summarizeCoverageByRelevanceForIds`, `summarizeCoverageTransitionsByRelevance`, `resolveCompactAfterTokens`, `resolveObserverChunkMaxTokens`, `loadConfig`, `readEnvConfig`, `resolveWorkerStreamSimple`, `logAgentStreamError`, `boundedMaxTokens`, `debugLog`, `withDebugLogContext`, `debugLogRelativePath`, `safeDebugLogSessionId`, `copyTextToClipboard`.
