/**
 * `memory_recall`: the model-facing way to resolve a memory id back to the
 * conversation it came from.
 *
 * Compaction replaces the exact record of what was said with condensed memory,
 * so the model can end up holding a fact without the evidence behind it. This
 * tool closes that gap for one id at a time. It is deliberately a lookup rather
 * than a search: it answers "what was actually said that produced this?", and
 * leaves browsing the transcript to the session-query tools.
 *
 * @module @deepseek-ai/dsh-tool-observational-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { citedSourceSeqs, conversationTextOf, MEMORY_ID_PATTERN, resolveMemoryId } from '@deepseek-ai/dsh-observational-memory'
import type { ObservationalMemoryState } from '@deepseek-ai/dsh-observational-memory'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-observational-memory'

/** Services the tool reads: the registry, the log reader, the fold, and prompt guidance. */
export const inject = ['tools', 'systemPrompt', 'sessionQuery', 'observationalMemoryStore']

/** Model-facing name of the recall tool. */
export const RECALL_TOOL_NAME = 'memory_recall'

/** At most this many source entries are returned for one recall. */
export const MAX_EVIDENCE_ENTRIES = 12

/** Longest text returned per source entry. */
export const MAX_EVIDENCE_CHARS = 2_000

/**
 * The canonical JSON value `memory_recall` returns.
 *
 * Records and evidence are pre-rendered lines rather than nested objects: the
 * tool schema DSL has no nested required fields, and the model reads this as
 * text anyway. Keeping the value flat means the same string reaches a text
 * renderer and a programmatic consumer.
 */
interface RecallOutput {
  id: string
  /** How the lookup ended: `ok` resolved, the others explain why not. */
  status: 'ok' | 'not_found' | 'invalid_id'
  /** One line describing what resolved. */
  note: string
  /** One line per resolved memory record, marked active or dropped. */
  observations: string[]
  /** One line per matched reflection. */
  reflections: string[]
  /** One `#seq role: text` line per resolved source entry. */
  evidence: string[]
  /** One line per provenance gap; empty when the chain resolved fully. */
  unresolved: string[]
  /** Cited sources that compaction has since shadowed, in citation order. */
  shadowedSourceSeqs: number[]
}

/** Clamp one evidence entry's text to the returned budget. */
function clampEvidence(text: string): string {
  if (text.length <= MAX_EVIDENCE_CHARS) return text
  return `${text.slice(0, MAX_EVIDENCE_CHARS)} … [truncated ${String(text.length - MAX_EVIDENCE_CHARS)} chars]`
}

/** Map one source event to its role label and text, or undefined when it is not conversation. */
function toEvidence(event: { type: string; seq: number; data: unknown }): { role: string; text: string } | undefined {
  return conversationTextOf(event)
}

/**
 * Resolve one memory id's cited sources into conversation evidence.
 *
 * Reading goes through the asynchronous query seam because arbitrary historical
 * reads are no longer available synchronously. Each source is also traced, so a
 * source that compaction has since shadowed reports the event that replaced it
 * instead of appearing to be missing.
 * @param ctx - context carrying the session query seam.
 * @param sessionId - the session that owns the sources.
 * @param seqs - the cited source seqs, in citation order.
 * @param signal - tool-call cancellation.
 * @returns the evidence entries plus the gaps that could not be resolved.
 */
async function collectEvidence(
  ctx: Context,
  sessionId: SessionId,
  seqs: readonly number[],
  signal: AbortSignal,
): Promise<{
  evidence: string[]
  missingSourceSeqs: number[]
  nonSourceSeqs: number[]
  shadowedSourceSeqs: number[]
}> {
  const query: SessionQueryEngine = ctx.sessionQuery
  const evidence: string[] = []
  const missingSourceSeqs: number[] = []
  const nonSourceSeqs: number[] = []
  const shadowedSourceSeqs: number[] = []

  for (const seq of seqs.slice(0, MAX_EVIDENCE_ENTRIES)) {
    let window
    try {
      window = await query.readEvent({ sessionId, seq: SessionSeq(seq) }, signal)
    } catch {
      // A seq the log does not hold is a provenance gap, not a tool failure.
      missingSourceSeqs.push(seq)
      continue
    }
    const target = window.target
    const resolved = toEvidence(target as { type: string; seq: number; data: unknown })
    if (resolved === undefined) {
      nonSourceSeqs.push(seq)
      continue
    }
    // Trace so a shadowed source reports its replacement rather than reading as
    // an ordinary entry that no longer reaches the model.
    let suffix = ''
    try {
      const trace = await query.traceEvent({ sessionId, seq: SessionSeq(seq) }, signal)
      if (trace.replacedBy !== undefined) {
        suffix = ` (a later checkpoint, #${String(trace.replacedBy)}, replaced it)`
        shadowedSourceSeqs.push(seq)
      }
    } catch {
      // A missing trace is not a missing source; the evidence already stands.
    }
    evidence.push(`#${String(seq)} ${resolved.role}: ${clampEvidence(resolved.text)}${suffix}`)
  }
  return { evidence, missingSourceSeqs, nonSourceSeqs, shadowedSourceSeqs }
}

/** Render a resolved recall as the model-facing text. */
function renderRecall(output: RecallOutput): string {
  if (output.status === 'invalid_id') {
    return `memory_recall: "${output.id}" is not a memory id. Ids are 12 lowercase hex characters, as printed in brackets next to a memory line.`
  }
  if (output.status === 'not_found') return `memory_recall: ${output.note}.`
  const lines: string[] = [output.note]
  if (output.reflections.length > 0) lines.push('', ...output.reflections)
  if (output.observations.length > 0) lines.push('', ...output.observations)
  if (output.evidence.length > 0) lines.push('', 'Sources:', ...output.evidence)
  if (output.unresolved.length > 0) lines.push('', `Unresolved: ${output.unresolved.join('; ')}.`)
  return lines.join('\n')
}

/**
 * Build the recall tool over the seams its plugin context holds.
 *
 * The seams live in the closure rather than on the execution object because a
 * tool run carries only its caller and cancellation, not a service context.
 * @param ctx - context carrying the log reader and the memory fold.
 * @returns the tool definition to register.
 */
export function createRecallTool(ctx: Context): ToolDefinition {
  return defineTool({
  name: RECALL_TOOL_NAME,
  description:
    'Resolve one memory id printed in brackets next to a memory line back to the exact conversation it came from. '
    + 'Use it when a compacted memory record affects a decision and the exact wording, number, path, or error string matters. '
    + 'This is a lookup for a known id, not a search: ids come from memory lines, never from guessing.',
  parameters: {
    id: {
      type: 'string',
      required: true,
      description: 'The 12-character memory id, exactly as printed in brackets.',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        status: { type: 'string', required: true, enum: ['ok', 'not_found', 'invalid_id'] },
        note: { type: 'string', required: true },
        // One line per resolved memory record, rendered by `render` below.
        observations: {
          type: 'array',
          required: true,
          items: { type: 'string' },
        },
        reflections: { type: 'array', required: true, items: { type: 'string' } },
        // One line per source entry, already clamped and attributed.
        evidence: { type: 'array', required: true, items: { type: 'string' } },
        // One line per provenance gap, or empty when the chain resolved fully.
        unresolved: { type: 'array', required: true, items: { type: 'string' } },
        shadowedSourceSeqs: { type: 'array', required: true, items: { type: 'number' } },
      },
    },
    render: (_args, value) => [{ type: 'text', text: renderRecall(value) }],
  },
  isConcurrencySafe: () => true,
  async execute(args, exec): Promise<RecallOutput> {
    const id = args.id.trim()
    const nothing = (status: RecallOutput['status'], note: string): RecallOutput => ({
      id,
      status,
      note,
      observations: [],
      reflections: [],
      evidence: [],
      unresolved: [],
      shadowedSourceSeqs: [],
    })
    if (!MEMORY_ID_PATTERN.test(id)) {
      return nothing('invalid_id', 'Not a memory id')
    }

    // Recall answers about the caller's own session, so an unbound caller has
    // no memory to resolve.
    const agent = exec.agent
    if (agent === undefined) {
      throw new HarnessError('memory_recall requires an agent-bound caller', 'MEMORY_RECALL_MISSING_AGENT')
    }
    // An empty ledger and an unknown id are the same answer to the model: there
    // is nothing under that id. The store always answers, so there is no
    // "no ledger" case to report — a deployment without the ledger plugin does
    // not get this tool at all, which is what the inject list below enforces.
    const state = ctx.observationalMemoryStore.state(agent.session.id) as ObservationalMemoryState

    const resolved = resolveMemoryId(id, state)
    if (resolved.kind === 'none') return nothing('not_found', 'No memory record has this id')

    const { evidence, missingSourceSeqs, nonSourceSeqs, shadowedSourceSeqs } = await collectEvidence(
      ctx,
      agent.session.id,
      citedSourceSeqs(resolved),
      exec.signal,
    )
    const unresolved: string[] = []
    if (resolved.missingSupportingObservationIds.length > 0) {
      unresolved.push(`supporting observations no longer in the ledger: ${resolved.missingSupportingObservationIds.join(', ')}`)
    }
    if (missingSourceSeqs.length > 0) {
      unresolved.push(`source entries absent from the log: ${missingSourceSeqs.map(String).join(', ')}`)
    }
    if (nonSourceSeqs.length > 0) {
      unresolved.push(`cited entries that are not conversation: ${nonSourceSeqs.map(String).join(', ')}`)
    }

    return {
      id,
      status: 'ok',
      note: resolved.kind === 'reflection'
        ? 'Resolved a reflection through the observations it preserves'
        : resolved.kind === 'mixed'
          ? 'Resolved an id that matches both an observation and a reflection'
          : 'Resolved a memory record',
      observations: resolved.observations.map(record =>
        `[${record.observation.id}] ${record.observation.timestamp} [${record.observation.relevance}] (${record.status}) ${record.observation.content}`),
      reflections: resolved.reflections.map(reflection => `[${reflection.id}] ${reflection.content}`),
      evidence,
      unresolved,
      shadowedSourceSeqs,
    }
  },
  })
}

/** Prompt guidance teaching the model when recall is worth a call. */
export const RECALL_GUIDANCE = [
  'Memory lines carry an id in brackets. When a compacted memory record affects a decision and the exact wording,',
  'number, path, or error string matters, call memory_recall with that id to read the conversation it came from.',
  'Recall is a lookup for a known id, not a search: never guess an id, and do not use it to browse history.',
].join(' ')

/**
 * Plugin body: register the recall tool and its guidance.
 * @param ctx - context carrying the tool registry, the log reader, and the prompt.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(createRecallTool(ctx))
  // Recall answers the same question the session-query tools answer — what
  // actually happened — so its guidance sits beside theirs rather than claiming
  // a new central prompt position.
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'tool:memory-recall',
      order: ctx.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY') + 1,
      text: RECALL_GUIDANCE,
    }),
    'tool-observational-memory: guidance',
  )
}

export type { RecallOutput }
