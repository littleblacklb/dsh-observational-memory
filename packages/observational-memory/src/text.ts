/**
 * Conversation text extraction shared by the host fold and the browser view.
 *
 * The observer's source ledger and the memory view's detail pane must agree on
 * what a cited conversation entry says: one is what the model read when it
 * wrote an observation, the other is what a person reads when checking that
 * observation against its evidence. Keeping one implementation here is what
 * makes those two answers the same answer.
 *
 * This module is deliberately dependency-free — no schema library, no Node
 * built-in — because the browser bundle imports it directly.
 *
 * @module @deepseek-ai/dsh-observational-memory/text
 */

/** Longest text retained per entry; only the observer's input is affected. */
export const MAX_SOURCE_TEXT_CHARS = 20_000

/** Characters per token in the harness estimator, reused for entry sizing. */
export const CHARS_PER_TOKEN = 4

/** One message's role and flattened text, as the conversation surface sees it. */
export interface ConversationText {
  /** Which side of the conversation produced the entry. */
  readonly role: 'user' | 'assistant' | 'tool'
  /** The entry's flattened, clamped text. */
  readonly text: string
}

/**
 * Estimate one entry's token size from its retained text.
 * @param text - the entry text.
 * @returns estimated tokens.
 */
export function estimateSourceTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Flatten a message's content blocks into plain text, skipping non-text blocks.
 * @param content - the message content as stored on the event.
 * @returns the joined text, or an empty string when nothing textual is present.
 */
export function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const typed = block as { type?: unknown; text?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
  }
  return parts.join('\n').trim()
}

/** Keep assistant tool calls alongside their results, as in the Pi source transcript. */
function assistantText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const typed = block as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
    if (typed.type === 'tool-call' && typeof typed.name === 'string') {
      const args = typeof typed.arguments === 'string' ? typed.arguments : JSON.stringify(typed.arguments ?? {})
      parts.push(`[${typed.name}(${args})]`)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Clamp retained text to {@link MAX_SOURCE_TEXT_CHARS}.
 * @param text - the text to clamp.
 * @returns the text, truncated with a marker when it exceeded the cap.
 */
export function clampText(text: string): string {
  if (text.length <= MAX_SOURCE_TEXT_CHARS) return text
  return `${text.slice(0, MAX_SOURCE_TEXT_CHARS)} … [truncated ${text.length - MAX_SOURCE_TEXT_CHARS} chars]`
}

/**
 * Read one session event as conversation text.
 *
 * Plugin-injected user context is not conversation: the observer's own prompt
 * sections and other plugins' additions arrive as user messages, and counting
 * them as things the user said would let memory cite itself. The browser's
 * detail pane applies the same rule so it can never show a citation the
 * observer could not have made.
 * @param event - a session event, or any object carrying its type and data.
 * @returns the entry's role and text, or undefined when the event is not conversation.
 */
export function conversationTextOf(
  event: { readonly type: string; readonly data?: unknown },
): ConversationText | undefined {
  let content: unknown
  let role: ConversationText['role']
  if (event.type === 'user/message') {
    const message = event.data as { content?: unknown; source?: { kind?: string } } | undefined
    if (message?.source?.kind === 'plugin') return undefined
    content = message?.content
    role = 'user'
  } else if (event.type === 'assistant/message') {
    const data = event.data as { message?: { content?: unknown } } | undefined
    content = data?.message?.content
    role = 'assistant'
  } else if (event.type === 'tool/result') {
    const data = event.data as { message?: { content?: unknown } } | undefined
    content = data?.message?.content
    role = 'tool'
  } else {
    return undefined
  }
  const text = clampText(role === 'assistant'
    ? assistantText(content)
    : role === 'tool'
      ? Array.isArray(content)
        ? content.map(block => {
            if (typeof block !== 'object' || block === null || block.type !== 'tool-result') return ''
            return flattenContent(block.content)
          }).filter(Boolean).join('\n').trim()
        : ''
      : flattenContent(content))
  if (text.length === 0) return undefined
  return { role, text }
}
