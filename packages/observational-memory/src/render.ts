/**
 * Deterministic rendering of folded memory into the text a compaction
 * checkpoint carries.
 *
 * The renderer never calls a model and never paraphrases: kept observations and
 * reflections are emitted verbatim, so the text a compaction persists is a pure
 * function of the log. An empty render is a deliberate signal to delegate to
 * the native summarizer rather than replace real context with nothing.
 *
 * @module @deepseek-ai/dsh-observational-memory/render
 */

import type { Observation, Reflection } from './vocabulary.ts'

/**
 * Instructions prefixed to every rendered memory block.
 *
 * These tell the model how to treat the records — past records, newest wins,
 * completed work is not redone — and when the exact evidence is worth a
 * `memory_recall` call.
 */
export const MEMORY_USAGE_INSTRUCTIONS = [
  'These are condensed memories from earlier in this session.',
  '',
  '- Reflections: stable, long-lived facts about the user, project, decisions, and constraints.',
  '- Observations: timestamped events from the conversation history, in chronological order.',
  '',
  'Treat these as past records. When entries conflict, the most recent observation reflects the latest known state.',
  'Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.',
  '',
  'When exact source context is needed for precision or traceability, use the memory_recall tool with the relevant',
  'observation or reflection id. This is especially useful when a reflection materially affects a decision or is too',
  'compressed to continue confidently. Do not use memory_recall as broad search.',
].join('\n')

/**
 * Render one observation as its summary line.
 * @param observation - the observation to render.
 * @returns the `[id] timestamp [relevance] content` line.
 */
export function observationLine(observation: Observation): string {
  return `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`
}

/**
 * Render one reflection as its summary line.
 * @param reflection - the reflection to render.
 * @returns the `[id] content` line.
 */
export function reflectionLine(reflection: Reflection): string {
  return `[${reflection.id}] ${reflection.content}`
}

/**
 * Render folded memory as the summary a compaction checkpoint carries.
 * @param reflections - the reflections to include.
 * @param observations - the observations to include.
 * @returns the rendered block, or an empty string when there is nothing to carry.
 */
export function renderMemory(
  reflections: readonly Reflection[],
  observations: readonly Observation[],
): string {
  if (reflections.length === 0 && observations.length === 0) return ''
  const sections: string[] = [MEMORY_USAGE_INSTRUCTIONS]
  if (reflections.length > 0) {
    sections.push(['## Reflections', ...reflections.map(reflectionLine)].join('\n'))
  }
  if (observations.length > 0) {
    sections.push(['## Observations', ...observations.map(observationLine)].join('\n'))
  }
  return sections.join('\n\n')
}
