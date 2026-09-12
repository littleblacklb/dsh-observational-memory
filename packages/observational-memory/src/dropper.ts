/**
 * The dropper: a background pass that removes observations from active memory
 * once the pool exceeds its budget.
 *
 * Dropping is a tombstone, never a deletion: a dropped observation stays in the
 * log and remains resolvable by id, so the pass trades retrieval depth for a
 * bounded active pool rather than discarding anything. It runs only as
 * maintenance after a reflection pass actually recorded something, because
 * reflections are the evidence that makes removal safe — without fresh coverage
 * there is nothing new to justify a drop.
 *
 * @module @deepseek-ai/dsh-observational-memory/dropper
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Observation, Reflection } from './vocabulary.ts'
import { observationLine } from './render.ts'
import { normalizeDropIds } from './records.ts'
import { dropCandidates, poolMetrics, type PoolMetrics } from './pool.ts'
import { DROPPER_SYSTEM_PROMPT } from './prompts.ts'
import { runWorker, toolArguments, type WorkerLlm } from './worker.ts'

/** Name of the single tool a dropper pass may call. */
export const DROPPER_TOOL_NAME = 'drop_observations'

/** Tool schema the dropper calls; the only structured output channel it has. */
export const DROPPER_TOOL: ToolSchema = {
  name: DROPPER_TOOL_NAME,
  description: 'Choose which observations may leave active memory. Call with an empty list to keep everything.',
  parameters: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        description: 'Ids of the observations to drop, taken from the provided list.',
        items: { type: 'string' },
      },
      reason: { type: 'string', description: 'One short line explaining the choice.' },
    },
    required: ['ids'],
    additionalProperties: false,
  },
}

/** Result of one dropper pass. */
export interface DropperRun {
  /** Observation ids to tombstone, already bounded by the pool budget. */
  readonly droppedIds: string[]
  /** Whether the model call itself failed, as opposed to choosing to keep everything. */
  readonly failure?: string
}

/**
 * Render the dropper's input: the over-budget candidates, then the reflections
 * that justify removing them.
 * @param candidates - candidate lines, ordered by ascending resistance.
 * @param reflections - the current reflections.
 * @param metrics - the pool measurements the drop budget came from.
 * @returns the block handed to the dropper model.
 */
export function renderDropperInput(
  candidates: readonly { observation: Observation; coverage: string }[],
  reflections: readonly Reflection[],
  metrics: PoolMetrics,
): string {
  const sections = [
    `The active observation pool holds ~${String(metrics.activeTokens)} tokens against a target of ~${String(metrics.targetTokens)}.`,
    `You may drop at most ${String(metrics.maxDrops)} observation(s).`,
    '',
    '## Candidates',
    ...candidates.map(candidate => `${observationLine(candidate.observation)} [coverage: ${candidate.coverage}]`),
  ]
  if (reflections.length > 0) {
    sections.push('', '## Reflections already preserving them', ...reflections.map(reflection => `[${reflection.id}] ${reflection.content}`))
  }
  return sections.join('\n')
}

/** Everything one dropper pass needs. */
export interface DropperRequest {
  readonly llm: WorkerLlm
  readonly provider: string
  readonly model: string
  /** Active observations eligible for dropping. */
  readonly observations: readonly Observation[]
  /** Current reflections, which are the evidence for removal. */
  readonly reflections: readonly Reflection[]
  /** Active-observation target the pool is maintained against. */
  readonly targetTokens: number
  readonly signal: AbortSignal
  readonly maxTokens?: number
}

/**
 * Run one dropper pass.
 *
 * The model's selection is intersected with the eligible ids, then truncated to
 * the budget the excess implies. The budget is a hard upper bound and never a
 * target: dropping fewer, or nothing, is a valid answer.
 * @param request - the active pool, its evidence, and the model route.
 * @returns the ids to tombstone, in the order the model proposed them.
 */
export async function runDropper(request: DropperRequest): Promise<DropperRun> {
  const metrics = poolMetrics(request.observations, request.targetTokens)
  if (!metrics.overTarget || metrics.maxDrops === 0) return { droppedIds: [] }

  const candidates = dropCandidates(request.observations, request.reflections)
  const text = renderDropperInput(candidates, request.reflections, metrics)
  const messages: Message[] = [createUserMessage({
    content: [{
      type: 'text',
      text: `${text}\n\nDrop at most ${String(metrics.maxDrops)} observation(s) using the ${DROPPER_TOOL_NAME} tool.`,
    }],
    source: { kind: 'plugin', plugin: 'observational-memory', form: 'instructions' },
  })]

  const outcome = await runWorker({
    llm: request.llm,
    provider: request.provider,
    model: request.model,
    system: DROPPER_SYSTEM_PROMPT,
    messages,
    tools: [DROPPER_TOOL],
    signal: request.signal,
    ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
  })
  if (outcome.kind === 'failed') return { droppedIds: [], failure: outcome.reason }

  const args = toolArguments(outcome.blocks, DROPPER_TOOL_NAME)
  const proposed = (args as { ids?: unknown } | undefined)?.ids
  const eligible = normalizeDropIds(proposed, request.observations.map(observation => observation.id))
  return { droppedIds: eligible.slice(0, metrics.maxDrops) }
}

/**
 * Read the dropper's coverage watermark for one session.
 * @param state - the folded memory state.
 * @returns the watermark, or null when no pass has dropped anything.
 */
export function dropperCoverage(state: { coverage: { dropper: number | null } }): SessionSeq | null {
  return state.coverage.dropper === null ? null : SessionSeq(state.coverage.dropper)
}
