/**
 * The observer: a background pass that turns newly appended conversation into
 * timestamped, source-cited observations.
 *
 * The pass is deliberately narrow. It reads a size-capped chunk of the
 * conversation surface, asks the memory model for observations through one tool
 * schema, and validates every citation against the chunk before anything is
 * written. A pass that produces nothing writes nothing and leaves coverage
 * where it was, so the unconsumed range simply grows and the next eligible pass
 * sees more context rather than a partial record.
 *
 * @module @deepseek-ai/dsh-observational-memory/observer
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from './vocabulary.ts'
import { buildObservation, type Rejection } from './records.ts'
import type { ObservationSourceEntry } from './source.ts'
import type { Observation } from './vocabulary.ts'
import { OBSERVER_SYSTEM_PROMPT } from './prompts.ts'
import { runWorker, toolArguments, type WorkerLlm } from './worker.ts'

/** Name of the single tool an observer pass may call. */
export const OBSERVER_TOOL_NAME = 'record_observations'

/** Tool schema the observer calls; the only structured output channel it has. */
export const OBSERVER_TOOL: ToolSchema = {
  name: OBSERVER_TOOL_NAME,
  description: 'Record the observations extracted from the conversation chunk. Call once with every observation worth keeping; call with an empty list when nothing is worth recording.',
  parameters: {
    type: 'object',
    properties: {
      observations: {
        type: 'array',
        description: 'Observations drawn from the chunk, in chronological order.',
        items: {
          type: 'object',
          properties: {
            timestamp: { type: 'string', description: 'Local time of the event as YYYY-MM-DD HH:MM.' },
            content: { type: 'string', description: 'One line of plain prose describing what happened or was established.' },
            relevance: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            sourceSeqs: {
              type: 'array',
              description: 'The entry numbers from this chunk that support the observation. Never invent a number.',
              items: { type: 'number' },
            },
          },
          required: ['timestamp', 'content', 'relevance', 'sourceSeqs'],
          additionalProperties: false,
        },
      },
    },
    required: ['observations'],
    additionalProperties: false,
  },
}

/** Result of one observer pass. */
export interface ObserverRun {
  /** Accepted observations, empty when the model recorded nothing usable. */
  readonly observations: Observation[]
  /** Records the model proposed that validation rejected, for diagnostics. */
  readonly rejections: Rejection[]
  /** Coverage watermark this pass would advance to when it records anything. */
  readonly coversUpToSeq: number
  /** Whether the model call itself failed, as opposed to recording nothing. */
  readonly failure?: string
}

/**
 * Select the oldest size-capped chunk of entries that no pass has covered yet.
 *
 * The oldest entry is always included even when it alone exceeds the budget, so
 * a single oversized entry cannot stall coverage forever.
 * @param entries - the full conversation surface, in log order.
 * @param coveredUpToSeq - the observer's current coverage watermark, if any.
 * @param maxTokens - the chunk budget in tokens.
 * @returns the entries to send, and the watermark a successful pass would reach.
 */
export function selectObserverChunk(
  entries: readonly ObservationSourceEntry[],
  coveredUpToSeq: SessionSeq | null,
  maxTokens: number,
): { chunk: ObservationSourceEntry[]; coversUpToSeq: number | null } {
  const uncovered = coveredUpToSeq === null
    ? entries
    : entries.filter(entry => (entry.seq as number) > (coveredUpToSeq as number))
  if (uncovered.length === 0) return { chunk: [], coversUpToSeq: null }

  const chunk: ObservationSourceEntry[] = []
  let tokens = 0
  for (const entry of uncovered) {
    if (chunk.length > 0 && tokens + entry.tokens > maxTokens) break
    chunk.push(entry)
    tokens += entry.tokens
  }
  return { chunk, coversUpToSeq: chunk[chunk.length - 1]!.seq as number }
}

/**
 * Count source tokens after a watermark, the observer's progress clock.
 * @param entries - the full conversation surface, in log order.
 * @param coveredUpToSeq - the observer's current coverage watermark, if any.
 * @returns the total tokens in entries the observer has not yet covered.
 */
export function uncoveredTokens(
  entries: readonly ObservationSourceEntry[],
  coveredUpToSeq: SessionSeq | null,
): number {
  let total = 0
  for (const entry of entries) {
    if (coveredUpToSeq !== null && (entry.seq as number) <= (coveredUpToSeq as number)) continue
    total += entry.tokens
  }
  return total
}

/**
 * Render the chunk as the transcript the observer reads.
 * @param chunk - the entries to render, in log order.
 * @returns the numbered transcript handed to the observer model.
 */
export function renderObserverChunk(chunk: readonly ObservationSourceEntry[]): string {
  return chunk
    .map(entry => `[${entry.seq}] ${entry.role === 'user' ? 'User' : entry.role === 'tool' ? 'Tool result' : 'Assistant'}: ${entry.text}`)
    .join('\n\n')
}

/** Minimal surface the observer needs from the LLM service. */
export type ObserverLlm = WorkerLlm

/** Everything one observer pass needs beyond the transcript. */
export interface ObserverRequest {
  readonly llm: ObserverLlm
  readonly provider: string
  readonly model: string
  readonly chunk: readonly ObservationSourceEntry[]
  readonly coversUpToSeq: number
  readonly signal: AbortSignal
  readonly maxTokens?: number
  /** Observation time used when the model supplies no usable timestamp. */
  readonly nowMs: number
}

/**
 * Run one observer pass over a chunk.
 *
 * Adapter failures arrive as a terminal `finish` chunk rather than a throw, so
 * the pass inspects the finish reason: a stream error is reported as a failure
 * while a clean finish with no usable records is a deliberate empty pass.
 * @param request - the transcript, the model route, and the chunk's watermark.
 * @returns the accepted observations and the watermark to advance to.
 */
export async function runObserver(request: ObserverRequest): Promise<ObserverRun> {
  const text = renderObserverChunk(request.chunk)
  const messages: Message[] = [createUserMessage({
    content: [{
      type: 'text',
      text: `${text}\n\nRecord the observations from the chunk above using the ${OBSERVER_TOOL_NAME} tool.`,
    }],
    source: { kind: 'plugin', plugin: 'observational-memory', form: 'instructions' },
  })]
  const outcome = await runWorker({
    llm: request.llm,
    provider: request.provider,
    model: request.model,
    system: OBSERVER_SYSTEM_PROMPT,
    messages,
    tools: [OBSERVER_TOOL],
    signal: request.signal,
    ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
  })
  if (outcome.kind === 'failed') {
    return { observations: [], rejections: [], coversUpToSeq: request.coversUpToSeq, failure: outcome.reason }
  }

  const args = toolArguments(outcome.blocks, OBSERVER_TOOL_NAME)
  const proposed = (args as { observations?: unknown } | undefined)?.observations
  if (!Array.isArray(proposed)) {
    // A clean finish with no tool call is a deliberate empty pass.
    return { observations: [], rejections: [], coversUpToSeq: request.coversUpToSeq }
  }

  const allowed = request.chunk.map(entry => entry.seq as number)
  const observations: Observation[] = []
  const rejections: Rejection[] = []
  const seen = new Set<string>()
  for (const candidate of proposed) {
    const built = buildObservation(candidate as never, allowed, request.nowMs)
    if ('rejection' in built) {
      rejections.push(built.rejection)
      continue
    }
    if (seen.has(built.observation.id)) continue
    seen.add(built.observation.id)
    observations.push(built.observation)
  }
  return { observations, rejections, coversUpToSeq: request.coversUpToSeq }
}

/**
 * Read the observer's current coverage watermark for one session.
 * @param state - the folded memory state.
 * @returns the watermark, or null when no pass has covered anything.
 */
export function observerCoverage(state: { coverage: { observer: number | null } }): SessionSeq | null {
  return state.coverage.observer === null ? null : SessionSeq(state.coverage.observer)
}
