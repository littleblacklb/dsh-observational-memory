/**
 * The shared one-shot worker call every memory pass makes.
 *
 * All three passes differ only in prompt, tool, and how they validate the
 * result; the transport behavior is identical and is also the part that is easy
 * to get subtly wrong. Keeping it in one place means a fix to failure handling
 * applies to the observer, the reflector, and the dropper together.
 *
 * @module @deepseek-ai/dsh-observational-memory/worker
 */

import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, ToolSchema } from '@deepseek-ai/dsh-llm'

/** Minimal surface a worker needs from the LLM service. */
export interface WorkerLlm {
  /** Stream one completion. */
  stream(options: {
    /** Registered provider route. */
    provider: string
    /** Provider-owned model id. */
    model: string
    /** The single user message carrying the pass input. */
    messages: Message[]
    /** Worker system prompt. */
    system?: string
    /** The one tool schema the pass may call. */
    tools?: ToolSchema[]
    /** Generation cap, when the deployment set one. */
    maxTokens?: number
    /** Cancellation, fused from the plugin lifetime. */
    signal?: AbortSignal
  }): AsyncIterable<unknown>
}

/** What one worker call produced. */
export type WorkerOutcome =
  | { readonly kind: 'blocks'; readonly blocks: ContentBlock[] }
  | { readonly kind: 'failed'; readonly reason: string }

/**
 * Run one worker completion and assemble its content blocks.
 *
 * An adapter failure arrives as a terminal `finish` chunk rather than a throw,
 * so this branches on the finish reason rather than relying on `for await` to
 * surface it. A clean finish with no tool call is a deliberate empty pass, not
 * a failure, and is reported as an empty block list.
 * @param request - the route, prompt, tool, and cancellation for this call.
 * @returns the assembled blocks, or the reason the call failed.
 */
export async function runWorker(request: {
  readonly llm: WorkerLlm
  readonly provider: string
  readonly model: string
  readonly system: string
  readonly messages: Message[]
  readonly tools: readonly ToolSchema[]
  readonly signal: AbortSignal
  readonly maxTokens?: number
}): Promise<WorkerOutcome> {
  const assembler = new BlockAssembler()
  try {
    for await (const chunk of request.llm.stream({
      provider: request.provider,
      model: request.model,
      system: request.system,
      messages: request.messages as Message[],
      tools: [...request.tools],
      ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
      signal: request.signal,
    })) {
      assembler.push(chunk as never)
    }
  } catch (error: unknown) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
  const finish = assembler.finish
  if (finish.kind === 'error') {
    return { kind: 'failed', reason: finish.failure?.message ?? 'stream error' }
  }
  if (finish.kind === 'aborted') return { kind: 'failed', reason: 'aborted' }
  return { kind: 'blocks', blocks: assembler.blocks() }
}

/**
 * Extract the parsed arguments of the first call to `toolName`.
 * @param blocks - the assembled content blocks.
 * @param toolName - the tool whose arguments to read.
 * @returns the parsed arguments, or undefined when the pass called no such tool.
 */
export function toolArguments(blocks: readonly ContentBlock[], toolName: string): unknown {
  for (const block of blocks) {
    if (block.type !== 'tool-call') continue
    if (block.name !== toolName) continue
    try {
      return JSON.parse(block.arguments) as unknown
    } catch {
      // An unparseable payload is treated as no call at all: the pass recorded
      // nothing usable, which is a deliberate empty result rather than a failure.
      return undefined
    }
  }
  return undefined
}
