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
import type { Session } from '@deepseek-ai/dsh-session'
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
    const state = readMemory(this.ctx.observationalMemoryStore, agent.session)
    const text = renderCheckpoint(state, input)
    if (text === undefined) return await super.summarize(input, agent, signal)
    return {
      summary: [{ type: 'text', text }],
      provider: MEMORY_PROVIDER,
      model: MEMORY_MODEL,
    }
  }
}
