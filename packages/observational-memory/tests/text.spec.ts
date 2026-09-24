/**
 * Behavior of the conversation-text extraction shared by the host fold and the
 * browser detail pane.
 *
 * These two consumers must agree on what a cited entry says, so the tests pin
 * the rules both rely on: which events count as conversation, how blocks are
 * flattened, and that text is clamped rather than refused.
 */

import { describe, expect, it } from 'vitest'
import {
  clampText,
  conversationTextOf,
  estimateSourceTokens,
  flattenContent,
  MAX_SOURCE_TEXT_CHARS,
} from '../src/text.ts'

/** One user message event carrying a single text block. */
function userEvent(text: string, source: unknown = { kind: 'user' }) {
  return { type: 'user/message', data: { content: [{ type: 'text', text }], source } }
}

/** One assistant message event carrying a single text block. */
function assistantEvent(text: string) {
  return { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
}

describe('flattenContent', () => {
  it('joins the text blocks of a message', () => {
    expect(flattenContent([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }]))
      .toBe('first\nsecond')
  })

  it('skips blocks that are not text', () => {
    expect(flattenContent([
      { type: 'text', text: 'kept' },
      { type: 'image', url: 'ignored' },
      { type: 'tool_use', name: 'ignored' },
    ])).toBe('kept')
  })

  it('skips entries that are not objects, and blocks without a string text', () => {
    expect(flattenContent([
      null,
      'bare string',
      7,
      { type: 'text' },
      { type: 'text', text: 42 },
      { type: 'text', text: 'kept' },
    ])).toBe('kept')
  })

  it('returns an empty string when the content is not a block list', () => {
    expect(flattenContent('a bare string')).toBe('')
    expect(flattenContent(undefined)).toBe('')
  })

  it('trims the joined text', () => {
    expect(flattenContent([{ type: 'text', text: '  padded  ' }])).toBe('padded')
  })
})

describe('clampText', () => {
  it('leaves text at or under the cap untouched', () => {
    const exact = 'x'.repeat(MAX_SOURCE_TEXT_CHARS)
    expect(clampText(exact)).toBe(exact)
  })

  it('truncates past the cap and states how much was removed', () => {
    const text = clampText('x'.repeat(MAX_SOURCE_TEXT_CHARS + 250))
    expect(text.startsWith('x'.repeat(MAX_SOURCE_TEXT_CHARS))).toBe(true)
    expect(text.endsWith('[truncated 250 chars]')).toBe(true)
  })
})

describe('estimateSourceTokens', () => {
  it('prices text at the harness ratio, rounding up', () => {
    expect(estimateSourceTokens('x'.repeat(8))).toBe(2)
    expect(estimateSourceTokens('x'.repeat(9))).toBe(3)
    expect(estimateSourceTokens('')).toBe(0)
  })
})

describe('conversationTextOf', () => {
  it('reads a user message as user text', () => {
    expect(conversationTextOf(userEvent('hello'))).toEqual({ role: 'user', text: 'hello' })
  })

  it('reads an assistant message as assistant text', () => {
    expect(conversationTextOf(assistantEvent('hi there'))).toEqual({ role: 'assistant', text: 'hi there' })
  })

  it('refuses plugin-injected user context', () => {
    // The observer's own prompt sections arrive as user messages; counting them
    // as conversation would let memory cite itself.
    expect(conversationTextOf(userEvent('injected', { kind: 'plugin', plugin: 'x' }))).toBeUndefined()
  })

  it('accepts a user message whose source is absent or not a plugin', () => {
    expect(conversationTextOf({ type: 'user/message', data: { content: [{ type: 'text', text: 'ok' }] } }))
      .toEqual({ role: 'user', text: 'ok' })
    expect(conversationTextOf(userEvent('ok', { kind: 'user' }))).toEqual({ role: 'user', text: 'ok' })
  })

  it('reads tool results through their nested text blocks', () => {
    expect(conversationTextOf({ type: 'tool/result', data: { message: { content: [
      { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'file contents' }, { type: 'image' }] },
    ] } } })).toEqual({ role: 'tool', text: 'file contents' })
    expect(conversationTextOf({ type: 'tool/result', data: {} })).toBeUndefined()
    expect(conversationTextOf({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'not a result' }] } } })).toBeUndefined()
  })

  it('includes assistant tool calls even when there is no prose', () => {
    expect(conversationTextOf({ type: 'assistant/message', data: { message: { content: [
      { type: 'tool-call', name: 'read', arguments: '{"path":"a.ts"}' },
      { type: 'text', text: 'Checking the file.' },
      { type: 'tool-call', name: 'bash', arguments: { command: 'pwd' } },
    ] } } })).toEqual({ role: 'assistant', text: '[read({"path":"a.ts"})]\nChecking the file.\n[bash({"command":"pwd"})]' })
  })

  it('renders a tool call with missing arguments as empty arguments', () => {
    expect(conversationTextOf({ type: 'assistant/message', data: { message: { content: [
      { type: 'tool-call', name: 'status' }, null,
    ] } } })).toEqual({ role: 'assistant', text: '[status({})]' })
  })

  it('refuses unrelated events', () => {
    expect(conversationTextOf({ type: 'assistant/attempt', data: {} })).toBeUndefined()
  })

  it('refuses a message with no usable text', () => {
    expect(conversationTextOf({ type: 'user/message', data: { content: [] } })).toBeUndefined()
    expect(conversationTextOf({ type: 'user/message', data: undefined })).toBeUndefined()
    expect(conversationTextOf({ type: 'assistant/message', data: {} })).toBeUndefined()
  })

  it('clamps long text rather than refusing it, including tool results', () => {
    const text = conversationTextOf(userEvent('y'.repeat(MAX_SOURCE_TEXT_CHARS + 5)))
    expect(text?.text.endsWith('[truncated 5 chars]')).toBe(true)
    const result = conversationTextOf({ type: 'tool/result', data: { message: { content: [
      { type: 'tool-result', content: [{ type: 'text', text: 'z'.repeat(MAX_SOURCE_TEXT_CHARS + 5) }] },
    ] } } })
    expect(result?.text.endsWith('[truncated 5 chars]')).toBe(true)
  })
})
