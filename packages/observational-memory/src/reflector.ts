/**
 * The reflector: a background pass that distills durable orientation facts from
 * the active observations.
 *
 * Reflections are deliberately scarce and expensive. Each one cites the exact
 * observations whose durable meaning it preserves, and that citation set is
 * what later lets the dropper remove an observation from active memory safely.
 * Because of that, a reflection citing anything that is not an active
 * observation is rejected whole rather than repaired: an inflated citation set
 * would make the dropper's judgment look better-founded than it is.
 *
 * @module @deepseek-ai/dsh-observational-memory/reflector
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { CoverageTier, Observation, Reflection } from './vocabulary.ts'
import { coverageOf } from './vocabulary.ts'
import { observationLine } from './render.ts'
import { buildReflection, type Rejection } from './records.ts'
import { REFLECTOR_SYSTEM_PROMPT } from './prompts.ts'
import { runWorker, toolArguments, type WorkerLlm } from './worker.ts'

/** Name of the single tool a reflector pass may call. */
export const REFLECTOR_TOOL_NAME = 'record_reflections'

/** Tool schema the reflector calls; the only structured output channel it has. */
export const REFLECTOR_TOOL: ToolSchema = {
  name: REFLECTOR_TOOL_NAME,
  description: 'Record the durable reflections distilled from the observations. Call with an empty list when nothing is durable enough to record.',
  parameters: {
    type: 'object',
    properties: {
      reflections: {
        type: 'array',
        description: 'Durable orientation facts, most important first.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'One line of plain prose stating a standing fact.' },
            supportingObservationIds: {
              type: 'array',
              description: 'The ids of the observations whose meaning this reflection preserves. Use only ids printed in the observation list.',
              items: { type: 'string' },
            },
          },
          required: ['content', 'supportingObservationIds'],
          additionalProperties: false,
        },
      },
    },
    required: ['reflections'],
    additionalProperties: false,
  },
}

/** One active observation presented to the reflector, with its coverage evidence. */
export interface ReflectorInput {
  readonly observation: Observation
  readonly coverage: CoverageTier
}

/** Result of one reflector pass. */
export interface ReflectorRun {
  /** Accepted reflections that were not already recorded. */
  readonly reflections: Reflection[]
  /** Records the model proposed that validation rejected, for diagnostics. */
  readonly rejections: Rejection[]
  /** Whether the model call itself failed, as opposed to recording nothing. */
  readonly failure?: string
}

/**
 * Render one observation line annotated with its current reflection coverage.
 *
 * The annotation is review context for the model, never a quota: the reflector
 * uses it to notice durable facts nothing yet records.
 * @param input - the observation and its coverage tier.
 * @returns the annotated summary line.
 */
export function renderReflectorLine(input: ReflectorInput): string {
  return `${observationLine(input.observation)} [coverage: ${input.coverage}]`
}

/**
 * Render the reflector's input: every active observation, then the reflections
 * already recorded so the model can avoid restating them.
 * @param inputs - active observations with their coverage.
 * @param existing - reflections already recorded.
 * @returns the block handed to the reflector model.
 */
export function renderReflectorInput(
  inputs: readonly ReflectorInput[],
  existing: readonly Reflection[],
): string {
  const sections = ['## Observations', ...inputs.map(renderReflectorLine)]
  if (existing.length > 0) {
    sections.push('', '## Already recorded', ...existing.map(reflection => `[${reflection.id}] ${reflection.content}`))
  }
  return sections.join('\n')
}

/** Everything one reflector pass needs beyond its input. */
export interface ReflectorRequest {
  readonly llm: WorkerLlm
  readonly provider: string
  readonly model: string
  /** Active observations, in the order they were recorded. */
  readonly inputs: readonly ReflectorInput[]
  /** Reflections already recorded, so the pass does not restate them. */
  readonly existing: readonly Reflection[]
  readonly signal: AbortSignal
  readonly maxTokens?: number
}

/**
 * Run one reflector pass.
 *
 * Only reflections that are new relative to {@link ReflectorRequest.existing}
 * are returned, so a pass that re-proposes a recorded fact writes nothing.
 * @param request - the observations, existing reflections, and model route.
 * @returns the new reflections this pass accepted.
 */
export async function runReflector(request: ReflectorRequest): Promise<ReflectorRun> {
  const activeIds = request.inputs.map(input => input.observation.id)
  const existingIds = new Set(request.existing.map(reflection => reflection.id))
  const text = renderReflectorInput(request.inputs, request.existing)
  const messages: Message[] = [createUserMessage({
    content: [{
      type: 'text',
      text: `${text}\n\nRecord the durable reflections using the ${REFLECTOR_TOOL_NAME} tool.`,
    }],
    source: { kind: 'plugin', plugin: 'observational-memory', form: 'instructions' },
  })]

  const outcome = await runWorker({
    llm: request.llm,
    provider: request.provider,
    model: request.model,
    system: REFLECTOR_SYSTEM_PROMPT,
    messages,
    tools: [REFLECTOR_TOOL],
    signal: request.signal,
    ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
  })
  if (outcome.kind === 'failed') return { reflections: [], rejections: [], failure: outcome.reason }

  const args = toolArguments(outcome.blocks, REFLECTOR_TOOL_NAME)
  const proposed = (args as { reflections?: unknown } | undefined)?.reflections
  if (!Array.isArray(proposed)) {
    // A clean finish with no tool call is a deliberate empty pass.
    return { reflections: [], rejections: [] }
  }

  const reflections: Reflection[] = []
  const rejections: Rejection[] = []
  const seen = new Set<string>()
  for (const candidate of proposed) {
    const built = buildReflection(candidate as never, activeIds)
    if ('rejection' in built) {
      rejections.push(built.rejection)
      continue
    }
    const { id } = built.reflection
    // A restated fact is already recorded; re-appending it would only grow the log.
    if (existingIds.has(id) || seen.has(id)) continue
    seen.add(id)
    reflections.push(built.reflection)
  }
  return { reflections, rejections }
}

/**
 * Annotate active observations with their current reflection coverage.
 * @param observations - the active observations.
 * @param reflections - the current reflections.
 * @returns one input per observation, in the given order.
 */
export function reflectorInputs(
  observations: readonly Observation[],
  reflections: readonly Reflection[],
): ReflectorInput[] {
  return observations.map(observation => ({
    observation,
    coverage: coverageOf(observation.id, reflections),
  }))
}

/**
 * Read the reflector's current coverage watermark for one session.
 * @param state - the folded memory state.
 * @returns the watermark, or null when no pass has covered anything.
 */
export function reflectorCoverage(state: { coverage: { reflector: number | null } }): SessionSeq | null {
  return state.coverage.reflector === null ? null : SessionSeq(state.coverage.reflector)
}
