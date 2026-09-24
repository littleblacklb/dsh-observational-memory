import type { Session } from '@deepseek-ai/dsh-session'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'

/** Estimate complete, currently visible source messages, never observer-clipped text. */
export function sourceTokens(session: Session, meter: TokenMeter): number {
  let sum = 0
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)!
    if (!isSourceEvent(event.type)) continue
    const message = deriveEventMessage(event)
    if (message === null || message.source.kind === 'plugin') continue
    sum += meter.estimateMessage(message)
  }
  return sum
}

export function isSourceEvent(type: string): boolean {
  return type === 'user/message' || type === 'assistant/message' || type === 'tool/result'
}

/** Model-visible surface positions are not necessarily ordered by numeric seq. */
export function selectRecentRange(session: Session, measurement: TokenMeasurement, tailTokens: number): {
  start: (typeof session.surface.nodes)[number]
  end: (typeof session.surface.nodes)[number]
} | null {
  const nodes = session.surface.nodes
  if (nodes.length !== measurement.nodes.length || nodes.some((seq, index) => seq !== measurement.nodes[index]?.seq)) {
    throw new Error('observational-memory: token meter surface disagrees with session')
  }
  const first = nodes[0] !== undefined && session.eventAt(nodes[0])?.type === 'system/message' ? 1 : 0
  let keep = nodes.length
  let tokens = 0
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    tokens += measurement.nodes[index]!.tokens
    keep = index
    if (tokens >= tailTokens) break
  }
  if (keep <= first) return null
  while (keep > first && !toolPairingBalancedBefore(session, nodes[keep]!)) keep--
  return keep <= first ? null : { start: nodes[first]!, end: nodes[keep - 1]! }
}
