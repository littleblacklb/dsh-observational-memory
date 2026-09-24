/**
 * The source surface the observer reads: the model-visible conversation
 * entries that memory is drawn from.
 *
 * The observer's input is a size-capped chunk of these entries, and an
 * observation's `sourceSeqs` are indices into it. This fold exists so that
 * input is derivable from the log rather than from process-local buffers, which
 * is what lets a resumed session keep observing from where it left off.
 *
 * Tool results are source entries too: in tool-heavy sessions their text is
 * often the evidence the assistant uses, and excluding it would keep the
 * observer below its source-token threshold. Each entry is size-capped.
 *
 * @module @deepseek-ai/dsh-observational-memory/source
 */

import { z as zod } from 'zod'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { conversationTextOf, estimateSourceTokens } from './text.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** The durable conversation surface the observer chunks. */
    observationSource: ObservationSourceState
  }
}

const sourceEntrySchema = zod.object({
  seq: zod.number().int().nonnegative(),
  role: zod.enum(['user', 'assistant', 'tool']),
  text: zod.string(),
  tokens: zod.number().int().nonnegative(),
})

/** Fold schema of one conversation entry the observer may cite. */
export const observationSourceEntrySchema = sourceEntrySchema

/** One conversation entry eligible as observer input and as an observation source. */
export type ObservationSourceEntry = zod.infer<typeof sourceEntrySchema>

const observationSourceStateSchema = zod.object({
  entries: zod.array(sourceEntrySchema),
})

/** Folded conversation surface for the observer. */
export type ObservationSourceState = zod.infer<typeof observationSourceStateSchema>

/**
 * Fold the conversation surface. Entry text is replaced when a later event
 * rewrites the same seq, which is how compaction keeps this view truthful.
 *
 * Text extraction is shared with the browser's detail pane
 * ({@link conversationTextOf}), so a citation the observer could make and a
 * citation the page can render are the same set of entries.
 * @param state - the projection covering all prior events.
 * @param event - the event to apply.
 * @returns the next state, or the same reference when the event is unrelated.
 */
export function applySourceEvent(
  state: ObservationSourceState,
  event: { readonly type: string; readonly seq: SessionSeq; readonly data?: unknown },
): ObservationSourceState {
  const conversation = conversationTextOf(event)
  if (conversation === undefined) return state
  const entry: ObservationSourceEntry = {
    seq: event.seq,
    role: conversation.role,
    text: conversation.text,
    tokens: estimateSourceTokens(conversation.text),
  }
  const existing = state.entries.findIndex(candidate => candidate.seq === entry.seq)
  if (existing === -1) return { entries: [...state.entries, entry] }
  const entries = [...state.entries]
  entries[existing] = entry
  return { entries }
}

/**
 * The source-surface fold. Host-only: the observer reads it in-process, and
 * nothing in the browser needs raw conversation.
 * @returns the projection definition folding the conversation surface.
 */
export function createObservationSourceProjection(): {
  key: 'observationSource'
  stateVersion: number
  stateSchema: typeof observationSourceStateSchema
  init: () => ObservationSourceState
  apply: typeof applySourceEvent
} {
  return {
    key: 'observationSource',
    stateVersion: 1,
    stateSchema: observationSourceStateSchema,
    init: () => ({ entries: [] }),
    apply: applySourceEvent,
  }
}
