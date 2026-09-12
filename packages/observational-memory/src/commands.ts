/**
 * `/om`: the human-facing view of observational memory.
 *
 * The background passes are invisible by design, so without this the only way
 * to know whether memory is being recorded is to wait for a compaction and
 * inspect its checkpoint. These commands answer the two questions that matter
 * — what is in memory right now, and what the workers are doing — plus the
 * *why* behind a record, which is the same traceability `memory_recall` gives
 * the model.
 *
 * @module @deepseek-ai/dsh-observational-memory/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { coverageOf, MEMORY_ID_PATTERN } from './vocabulary.ts'
import type { Observation, Reflection } from './vocabulary.ts'
import { poolMetrics } from './pool.ts'
import { citedSourceSeqs, resolveMemoryId } from './recall.ts'
import { renderMemory } from './render.ts'
import type { ObservationalMemoryState } from './vocabulary.ts'
import { renderWorkerStatus } from './status.ts'
import type { MemoryStatus } from './status.ts'

/** Command registration surface the `/om` family needs. */
export interface OmCommandsHost {
  /** Folded memory for one agent's session. */
  readonly memoryOf: (agent: Agent) => ObservationalMemoryState
  /** Active-pool budget the dropper maintains. */
  readonly targetTokens: number
  /** Observer cadence threshold in source tokens, for the status clock. */
  readonly observeAfterTokens: number
  /** Reflector cadence threshold in source tokens. */
  readonly reflectAfterTokens: number
  /** Whether background work is disabled. */
  readonly passive: boolean
  /** Resolve one conversation seq as the observer saw it, when the fold has it. */
  readonly sourceEntry?: (agent: Agent, seq: number) => { role: string; text: string } | undefined
  /** Process-local worker outcomes, so "idle" and "broken" read differently. */
  readonly status: MemoryStatus
}

/** Render the observation-pool line for `/om status`. */
function poolLine(state: ObservationalMemoryState, targetTokens: number): string {
  const metrics = poolMetrics(state.observations, targetTokens)
  const percent = targetTokens === 0 ? 0 : Math.round((metrics.activeTokens / targetTokens) * 100)
  return `active observations: ${String(state.observations.length)} (~${String(metrics.activeTokens)} tokens, ${String(percent)}% of the ~${String(targetTokens)} target)`
}

/** Render the drift between what memory holds and what is active. */
function driftLine(state: ObservationalMemoryState): string {
  if (state.dropped.length === 0) return 'dropped: 0'
  return `dropped: ${String(state.dropped.length)} (still resolvable by id via /om show)`
}

/**
 * Render `/om status`: what memory holds, how full the pool is, and what the
 * workers have covered.
 * @param state - the folded memory state.
 * @param host - the cadence and budget the plugin resolved.
 * @returns the status text.
 */
export function renderStatus(state: ObservationalMemoryState, host: OmCommandsHost): string {
  const coverage = state.coverage
  const mark = (value: number | null): string => value === null ? 'not yet' : `through #${String(value)}`
  return [
    'Observational memory',
    host.passive ? '  mode: passive (background work disabled)' : '  mode: active',
    `  reflections: ${String(state.reflections.length)}`,
    `  ${poolLine(state, host.targetTokens)}`,
    `  ${driftLine(state)}`,
    `  observer coverage: ${mark(coverage.observer)} (every ~${String(host.observeAfterTokens)} source tokens)`,
    `  reflector coverage: ${mark(coverage.reflector)} (every ~${String(host.reflectAfterTokens)} source tokens)`,
    `  dropper coverage: ${mark(coverage.dropper)}`,
    ...renderWorkerStatus(host.status.snapshot()),
  ].join('\n')
}

/** Render the memory block exactly as a compaction checkpoint would carry it. */
function renderView(state: ObservationalMemoryState): string {
  return renderMemory(state.reflections as Reflection[], state.observations as Observation[])
}

/**
 * Render `/om show <id>`: one record plus the sources it came from.
 *
 * The source text is read from the observer's own fold of the conversation, so
 * this reports exactly what the observer saw rather than re-reading the log
 * through a different lens.
 * @param id - the memory id to show.
 * @param state - the folded memory state.
 * @param sourceText - resolves one source seq to its role and text, when available.
 * @returns the rendered record and its evidence.
 */
export function renderShow(
  id: string,
  state: ObservationalMemoryState,
  sourceText: (seq: number) => { role: string; text: string } | undefined,
): string {
  if (!MEMORY_ID_PATTERN.test(id)) {
    return `"${id}" is not a memory id. Ids are 12 lowercase hex characters, as printed in brackets next to a memory line.`
  }
  const resolved = resolveMemoryId(id, state)
  if (resolved.kind === 'none') return `No memory record has id "${id}".`

  const lines: string[] = []
  for (const reflection of resolved.reflections) lines.push(`Reflection [${reflection.id}] ${reflection.content}`)
  for (const record of resolved.observations) {
    const dropped = record.status === 'dropped'
    const coverage = coverageOf(record.observation.id, state.reflections)
    lines.push(
      `Observation [${record.observation.id}] ${record.observation.timestamp} [${record.observation.relevance}]`
      + ` [coverage: ${coverage}]${dropped ? ' [dropped]' : ''}`,
      `  ${record.observation.content}`,
    )
  }
  const sources = citedSourceSeqs(resolved)
  if (sources.length > 0) {
    lines.push('', 'Sources:')
    for (const seq of sources) {
      const found = sourceText(seq)
      if (found === undefined) {
        lines.push(`  #${String(seq)} (not in the observed conversation)`)
        continue
      }
      lines.push(`  #${String(seq)} ${found.role}: ${found.text}`)
    }
  }
  if (resolved.missingSupportingObservationIds.length > 0) {
    lines.push('', `Unresolved: supporting observations no longer in the ledger: ${resolved.missingSupportingObservationIds.join(', ')}.`)
  }
  return lines.join('\n')
}

/**
 * Register the `/om` command family.
 *
 * Registration is effect-scoped, so unloading the plugin removes the commands
 * with the rest of its contributions.
 * @param ctx - context carrying the command registry.
 * @param host - the state reader and resolved configuration the handlers use.
 */
export function registerOmCommands(ctx: Context, host: OmCommandsHost): void {
  const memoryOf = (invocation: CommandInvocation): ObservationalMemoryState => host.memoryOf(invocation.agent)

  ctx.commands.register({
    name: 'om',
    description: 'Observational memory: status, the rendered memory view, or one record with its sources',
    input: { hint: 'status | view | show <id>' },
    handler: (invocation): CommandResult => {
      const input = invocation.rawInput.trim()
      const state = memoryOf(invocation)
      if (input === '' || input === 'status') {
        return { kind: 'success', text: renderStatus(state, host) }
      }
      if (input === 'view') {
        const text = renderView(state)
        return {
          kind: 'success',
          text: text.length === 0 ? 'Memory is empty: no observation or reflection has been recorded yet.' : text,
        }
      }
      if (input.startsWith('show')) {
        const id = input.slice('show'.length).trim()
        if (id.length === 0) return { kind: 'error', text: 'Usage: /om show <memory-id>' }
        // The human view reads the observer's own surface, so a source is
        // reported as the observer saw it rather than re-derived here.
        return {
          kind: 'success',
          text: renderShow(id, state, seq => {
            const entry = host.sourceEntry?.(invocation.agent, seq)
            return entry === undefined ? undefined : { role: entry.role, text: entry.text }
          }),
        }
      }
      return { kind: 'error', text: 'Usage: /om [status | view | show <memory-id>]' }
    },
  })
}
