/**
 * The memory-compaction engine: the same automatic pressure policy and region
 * transaction as the shipped backend, with one substitution — when folded
 * memory exists, the checkpoint is rendered from it instead of asking a model
 * to rewrite the past.
 *
 * That substitution is the point of this plugin. Compaction stops being a
 * summarization event and becomes a fold, so a long session's memory is written
 * while the work is still live rather than reconstructed under time pressure.
 *
 * Two properties are load-bearing and are enforced here rather than trusted:
 * a render that would not actually shrink the request delegates to the default
 * summarizer, and an empty projection always delegates, so real context is
 * never replaced by nothing.
 *
 * @module @deepseek-ai/dsh-observational-memory/compaction-engine
 */

import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { compactThreshold, defaultTail, MemoryCompactionSchema, splitCompactionConfig } from './compaction-policy.ts'
import type { MemoryCompactionConfig, ResolvedMemoryPolicy } from './compaction-policy.ts'
import { isSourceEvent, selectRecentRange, sourceTokens } from './compaction-source.ts'
import { MEMORY_CONTEXT_NAME } from './context.ts'
import type {} from './vocabulary.ts'
import type { Observation, Reflection } from './vocabulary.ts'
import type { ObservationalMemoryState } from './vocabulary.ts'
import { renderMemory } from './render.ts'

/**
 * The region a compaction is replacing, as the backend's summarize hook sees it.
 *
 * Derived from the base class rather than imported from its internal summarizer
 * module, so this package depends only on the backend's public surface while
 * still failing to compile if that hook's input changes.
 */
type SummarizationInput = Parameters<BasicCompactionEngine['summarize']>[0]

/** Provider name stamped on a checkpoint this engine rendered without a model. */
export const MEMORY_PROVIDER = 'observational-memory'

/** Model name stamped on a checkpoint this engine rendered without a model. */
export const MEMORY_MODEL = 'deterministic'

/** Characters per token, matching the harness estimator this engine measures with. */
const CHARS_PER_TOKEN = 4

/** Per-block overhead the harness estimator adds to one content block. */
const BLOCK_OVERHEAD = 4

/**
 * Fixed framing the region transaction wraps around a summary, in characters.
 *
 * Only the guard uses this: the real framing is applied by the region, and it is
 * fixed text, so measuring it here keeps this module free of a dependency on the
 * backend's private constants.
 */
const FRAMING_CHARS = '<compacted-summary>\n\n</compacted-summary>'.length + 320

/**
 * Estimate the tokens one text block costs under the harness heuristic.
 * @param text - the text to price.
 * @returns the estimated tokens, including per-block overhead.
 */
function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/**
 * Read one session's memory ledger.
 *
 * The store is published on the context by the ledger row, which the same bundle
 * patch mounts beside this one. A session with nothing recorded yields empty
 * memory and the caller delegates.
 * @param store - the published ledger store.
 * @param session - the session being compacted.
 * @returns the ledger, or undefined when nothing has been recorded yet.
 */
export function readMemory(
  store: { state(sessionId: string): ObservationalMemoryState },
  session: Session,
): ObservationalMemoryState | undefined {
  const state = store.state(session.id)
  const recorded = state.observations.length + state.reflections.length + state.dropped.length
  return recorded === 0 ? undefined : state
}

/**
 * Render the checkpoint text for one session's folded memory.
 *
 * Returns `undefined` when there is nothing to render, or when the render plus
 * its framing would not be strictly smaller than the region it replaces. Both
 * cases mean "leave this compaction to the default summarizer": the first
 * because replacing real context with nothing is a regression, the second
 * because the region transaction would reject a non-shrinking checkpoint
 * anyway.
 * @param state - the folded memory state.
 * @param input - the region being replaced, used to price it.
 * @returns the rendered summary text, or undefined to delegate.
 */
export function renderCheckpoint(
  state: ObservationalMemoryState | undefined,
  input: SummarizationInput,
): string | undefined {
  if (state === undefined) return undefined
  const text = renderMemory(
    state.reflections as Reflection[],
    state.observations as Observation[],
  )
  if (text.length === 0) return undefined

  // The shadowed side is priced the same way the region prices it: text blocks
  // under the harness heuristic. A conservative floor is correct here, because
  // delegating costs a model call while a rejected checkpoint costs the pass.
  let shadowed = 0
  for (const message of input.messages) {
    for (const block of message.content) {
      if (block.type === 'text') shadowed += estimateTextTokens(block.text)
    }
  }
  const replacement = estimateTextTokens(text) + estimateTextTokens('x'.repeat(FRAMING_CHARS))
  return replacement < shadowed ? text : undefined
}

/**
 * Compaction backend that renders prepared memory instead of summarizing.
 *
 * Everything except the summary source is inherited: pressure policy, retention,
 * the durable `compaction/start|summary|end` bracket, the surface replacement,
 * and overflow recovery all behave exactly as the shipped backend does.
 */
export default class MemoryCompactionEngine extends BasicCompactionEngine {
  /**
   * The inherited services, plus the ledger store this engine renders from.
   *
   * The store is required rather than optional: this engine's whole difference is
   * reading memory, and the row that publishes it is mounted beside this one by
   * the same bundle patch. Declaring the dependency means this row activates on
   * the same services the original row declared PLUS the one it actually reads,
   * instead of failing at the first compaction with an undefined store.
   */
  static override inject = ['llm', 'tokenMeter', 'sessions', 'observationalMemoryStore']
  static override Config = MemoryCompactionSchema

  private readonly policy: ResolvedMemoryPolicy
  private readonly attemptedTurns = new WeakMap<Session, number>()
  private readonly lastAttempts = new WeakMap<Session, string>()
  private readonly running = new WeakSet<Session>()

  constructor(ctx: Context, config: MemoryCompactionConfig = {}) {
    const resolved = splitCompactionConfig(config)
    super(ctx, resolved.base)
    this.policy = resolved.policy
  }

  /** Status is process-local; thresholds use the last durable route context, if known. */
  statusOf(session: Session): string[] {
    const route = session.requestHeader()?.config
    const context = [...session.snapshotEvents()].reverse().find(event =>
      event.type === 'request/context' && event.data.provider === route?.provider && event.data.model === route.model)
    const window = context?.type === 'request/context' ? context.data.contextWindow : undefined
    const threshold = compactThreshold(this.policy, window)
    const override = this.config.modelPolicies.find(item => item.provider === route?.provider && item.model === route.model)
    const tail = override?.retainTokens ?? (override?.retainRatio === undefined
      ? this.policy.explicitRetention
        ? this.config.retainTokens ?? (window === undefined ? undefined : Math.floor(window * this.config.retainRatio!))
        : defaultTail(window, threshold)
      : window === undefined ? undefined : Math.floor(window * override.retainRatio))
    return [
      `  auto compact: ${this.config.auto && this.policy.autoCompact && !this.ctx.observationalMemoryPolicy?.passive ? 'on' : 'off'} (${this.policy.compactAfterTokensMode})`,
      `  compact source: ~${String(sourceTokens(session, this.ctx.tokenMeter))}/${String(threshold)} tokens`,
      `  compact tail: ${tail === undefined ? 'unknown window' : `~${String(tail)} tokens`}`,
      `  request pressure: ~${String(this.ctx.tokenMeter.measure(session).totalTokens)} tokens`,
      `  last compact attempt: ${this.lastAttempts.get(session) ?? 'not in this process'}`,
    ]
  }

  /** Keep the host's overflow policy and pressure fallback; add a once-per-turn source clock. */
  override async compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
    if (trigger === 'context-overflow') return super.compactIfNeeded(agent, trigger, signal)
    const session = agent.session
    if (this.running.has(session)) return null
    this.running.add(session)
    let stage = 'pressure'
    try {
      signal.throwIfAborted()
      const events = session.snapshotEvents()
      let turnStart: number | undefined
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === 'turn/start') { turnStart = events[i]!.seq; break }
      }
      // Pre-step callbacks own the open turn. A direct/manual pressure check does
      // not make a completed turn eligible for proactive compaction.
      const firstStep = turnStart !== undefined && !events.some(event => event.seq > turnStart! && event.type === 'step/start')
      const attempt = this.config.auto && this.policy.autoCompact && firstStep && turnStart !== undefined
        && this.attemptedTurns.get(session) !== turnStart && !this.ctx.observationalMemoryPolicy?.passive
      if (attempt) this.attemptedTurns.set(session, turnStart!)

      const route = session.requestHeader()?.config ?? agent.options
      const info = route.provider && route.model
        ? await this.ctx.llm.resolveModelInfo(route.provider, route.model, signal)
        : undefined
      const window = info?.context?.contextWindow
      const threshold = compactThreshold(this.policy, window)
      const override = this.config.modelPolicies.find(item => item.provider === route.provider && item.model === route.model)
      const retentionRatio = override?.retainRatio ?? (this.policy.explicitRetention && this.config.retainTokens === undefined
        ? this.config.retainRatio : undefined)
      const tail = override?.retainTokens ?? (retentionRatio === undefined
        ? this.policy.explicitRetention ? this.config.retainTokens! : defaultTail(window, threshold)
        : window === undefined ? undefined : Math.floor(window * retentionRatio))
      // An explicit ratio without model capacity cannot safely become zero tail.
      if (tail === undefined) return super.compactIfNeeded(agent, trigger, signal)
      if (window !== undefined && tail >= threshold && this.policy.autoCompact) {
        throw new Error(`observational-memory: retainTokens (${String(tail)}) must be below compactAfterTokens (${String(threshold)})`)
      }

      // The parent's default is a fixed 20K. Below 125K the agreed adaptive
      // tail is smaller; use the same public region transaction with that budget.
      let normal: CompactionResult | null
      if (window !== undefined && !this.policy.explicitRetention && override?.retainTokens === undefined
        && override?.retainRatio === undefined && defaultTail(window, threshold) < 20_000) {
        const ratio = override?.thresholdRatio ?? this.config.thresholdRatio
        const pressureLimit = Math.floor(window * ratio)
        const meter = this.ctx.tokenMeter
        let measurement = meter.measure(session)
        normal = null
        if (measurement.totalTokens >= pressureLimit) {
          // Do not prune ahead of another transaction's durable start marker.
          const boundary = session.snapshotEvents().reduce((state, event) =>
            event.type === 'session/end-seed' || event.type === 'compaction/end' ? false
              : event.type === 'compaction/start' ? true : state, false)
          if (boundary) throw new Error('observational-memory: compaction already in progress')
          const pruner = this.ctx.get('toolResultPruner')
          if (pruner !== undefined) {
            pruner.pruneSession(session)
            measurement = meter.measure(session)
          }
          for (let i = 0; measurement.totalTokens >= pressureLimit && i <= (override?.compactionRetries ?? this.config.compactionRetries); i++) {
            const range = selectRecentRange(session, measurement, defaultTail(window, threshold))
            if (range === null) break
            normal = await this.compactRegion(range.start, range.end, agent, signal)
            measurement = meter.measure(session)
          }
          if (normal !== null && measurement.totalTokens >= pressureLimit) {
            throw new Error(`compaction still above threshold after retries (${String(measurement.totalTokens)} >= ${String(pressureLimit)})`)
          }
        }
      } else {
        normal = await super.compactIfNeeded(agent, trigger, signal)
      }
      if (normal !== null) {
        this.lastAttempts.set(session, 'native pressure compacted')
        return normal
      }
      if (!attempt || signal.aborted) return null
      if (sourceTokens(session, this.ctx.tokenMeter) < threshold) {
        this.lastAttempts.set(session, 'below source threshold')
        return null
      }
      const range = selectRecentRange(session, this.ctx.tokenMeter.measure(session), tail)
      if (range === null) {
        this.lastAttempts.set(session, 'no safe range')
        return null
      }
      stage = 'proactive'
      const result = await this.compactRegion(range.start, range.end, agent, signal)
      this.lastAttempts.set(session, 'proactive compacted')
      return result
    } catch (error) {
      this.lastAttempts.set(session, `${stage} failed`)
      throw error
    } finally {
      this.running.delete(session)
    }
  }

  /**
   * Produce the checkpoint content for one region.
   *
   * When folded memory renders to something that shrinks the region, the result
   * is unmarked — it records no `ctx.llm.stream()` call because no model ran.
   * Otherwise the default summarizer runs, so the checkpoint is never worse than
   * the shipped backend's.
   * @param input - the replayed conversation prefix being replaced.
   * @param agent - supplies the session whose memory is rendered.
   * @param signal - optional cancellation forwarded to a fallback summarization.
   * @returns safe summary blocks plus the exact call envelope recorded with them.
   */
  protected override async summarize(
    ...args: Parameters<BasicCompactionEngine['summarize']>
  ): ReturnType<BasicCompactionEngine['summarize']> {
    const [input, agent, signal] = args
    const state = this.ctx.observationalMemoryPolicy?.passive
      ? undefined
      : readMemory(this.ctx.observationalMemoryStore, agent.session)
    // The input includes the system head and the exact region about to be
    // shadowed. Refuse a memory-only checkpoint unless the observer's committed
    // watermark covers every ordinary source in it. A prior fallback checkpoint
    // is not proven to be represented in the ledger either.
    const visible = new Map(agent.session.surface.nodes.map(seq => {
      const event = agent.session.eventAt(seq)!
      const message = deriveEventMessage(event)
      return [message?.id, event] as const
    }))
    const covered = state?.coverage.observer
    const safe = covered !== null && covered !== undefined && input.messages.every(message => {
      const event = visible.get(message.id)
      if (event === undefined) return false
      if (event.type === 'system/message') return true
      if (message.source.kind === 'plugin') {
        // A runtime snapshot made solely of this ledger's contribution already
        // exists in the ledger; an arbitrary plugin snapshot may carry unrelated
        // context and must instead be preserved by the native summarizer.
        return message.source.plugin === '@deepseek-ai/dsh-system-prompt'
          && message.source.form === 'snapshot'
          && message.source.sections.length === 1
          && message.source.sections[0]?.name === MEMORY_CONTEXT_NAME
      }
      return !isSourceEvent(event.type) || event.seq <= covered
    })
    const text = safe ? renderCheckpoint(state, input) : undefined
    if (text === undefined) return await super.summarize(input, agent, signal)
    return {
      summary: [{ type: 'text', text }],
      provider: MEMORY_PROVIDER,
      model: MEMORY_MODEL,
    }
  }
}
