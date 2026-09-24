/**
 * Behavior of the conversation-surface fold the observer reads.
 *
 * The fold decides which entries an observation may cite, so these tests pin
 * what counts as conversation, how text is extracted, and that compaction
 * rewrites are reflected rather than duplicated.
 */

import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import {
  applySourceEvent,
  createObservationSourceProjection,
  observationSourceEntrySchema,
} from '../src/source.ts'
import { estimateSourceTokens, MAX_SOURCE_TEXT_CHARS } from '../src/text.ts'
import type { ObservationSourceState } from '../src/source.ts'

const empty = (): ObservationSourceState => ({ entries: [] })

function userEvent(seq: number, text: string, source: unknown = { kind: 'user' }) {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    data: { content: [{ type: 'text', text }], source },
  }
}

function assistantEvent(seq: number, content: unknown) {
  return { type: 'assistant/message', seq: SessionSeq(seq), data: { message: { content } } }
}

describe('source fold', () => {
  it('records a user message as conversation', () => {
    const state = applySourceEvent(empty(), userEvent(1, 'switch the API to GraphQL'))
    expect(state.entries).toEqual([
      { seq: 1, role: 'user', text: 'switch the API to GraphQL', tokens: estimateSourceTokens('switch the API to GraphQL') },
    ])
  })

  it('records an assistant message as conversation', () => {
    const state = applySourceEvent(empty(), assistantEvent(2, [{ type: 'text', text: 'Understood.' }]))
    expect(state.entries).toEqual([{ seq: 2, role: 'assistant', text: 'Understood.', tokens: 3 }])
  })

  it('excludes plugin-injected context, which is not conversation', () => {
    const injected = userEvent(3, 'current time is 14:30', { kind: 'plugin', plugin: 'time-context' })
    expect(applySourceEvent(empty(), injected)).toEqual({ entries: [] })
  })

  it('records tool output with its own citable seq and token count', () => {
    const state = applySourceEvent(empty(), { type: 'tool/result', seq: SessionSeq(4), data: {
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'result text' }] }] },
    } })
    expect(state.entries).toEqual([{ seq: 4, role: 'tool', text: 'result text', tokens: 3 }])
  })

  it('skips an entry whose content has no text', () => {
    expect(applySourceEvent(empty(), userEvent(5, ''))).toEqual({ entries: [] })
    expect(applySourceEvent(empty(), assistantEvent(6, 'not an array'))).toEqual({ entries: [] })
    expect(applySourceEvent(empty(), { type: 'user/message', seq: SessionSeq(7), data: undefined })).toEqual({ entries: [] })
  })

  it('joins text and tool calls while ignoring unsupported blocks', () => {
    const state = applySourceEvent(empty(), assistantEvent(8, [
      { type: 'text', text: 'first' },
      { type: 'tool-call', id: 'c', name: 'read', arguments: '{}' },
      { type: 'text', text: 'second' },
      null,
      'stray',
    ]))
    expect(state.entries[0]?.text).toBe('first\n[read({})]\nsecond')
  })

  it('rewrites an entry in place when a later event reuses its seq', () => {
    const first = applySourceEvent(empty(), userEvent(9, 'original wording'))
    const rewritten = applySourceEvent(first, userEvent(9, 'replaced wording'))
    expect(rewritten.entries).toHaveLength(1)
    expect(rewritten.entries[0]?.text).toBe('replaced wording')
  })

  it('clamps oversized text and records how much was dropped', () => {
    const state = applySourceEvent(empty(), userEvent(10, 'x'.repeat(MAX_SOURCE_TEXT_CHARS + 250)))
    const text = state.entries[0]?.text ?? ''
    expect(text).toContain('… [truncated 250 chars]')
    expect(text.startsWith('x'.repeat(MAX_SOURCE_TEXT_CHARS))).toBe(true)
  })

  it('keeps the same state reference for an unrelated event', () => {
    const state = applySourceEvent(empty(), userEvent(11, 'kept'))
    expect(applySourceEvent(state, { type: 'turn/end', seq: SessionSeq(12), data: {} })).toBe(state)
  })

  it('estimates tokens from the retained text', () => {
    expect(estimateSourceTokens('x'.repeat(8))).toBe(2)
    expect(estimateSourceTokens('')).toBe(0)
  })

  it('exposes a projection definition with a wire-invisible key', () => {
    const definition = createObservationSourceProjection()
    expect(definition.key).toBe('observationSource')
    expect(definition.init()).toEqual({ entries: [] })
    expect(definition.apply).toBe(applySourceEvent)
    expect(definition.stateSchema.parse({ entries: [] })).toEqual({ entries: [] })
  })

  it('validates one entry through its schema', () => {
    expect(observationSourceEntrySchema.parse({ seq: 1, role: 'user', text: 'hi', tokens: 1 }))
      .toEqual({ seq: 1, role: 'user', text: 'hi', tokens: 1 })
    expect(observationSourceEntrySchema.parse({ seq: 2, role: 'tool', text: 'result', tokens: 2 }).role).toBe('tool')
    expect(() => observationSourceEntrySchema.parse({ seq: 1, role: 'system', text: 'hi', tokens: 1 })).toThrow()
  })
})
