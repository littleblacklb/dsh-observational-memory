/**
 * Active-observation pool accounting and dropper candidate selection.
 *
 * Observation tokens are re-derived from the rendered summary line rather than
 * from any stored field, because that line is what compaction actually pays
 * for. Reflections deliberately carry no token accounting at all; the pool
 * metric is observation-only, so adding reflection tokens here would change
 * when compaction and dropping trigger.
 *
 * @module @deepseek-ai/dsh-observational-memory/pool
 */

import { RELEVANCE_ORDER } from './vocabulary.ts'
import type { CoverageTier, Observation, Reflection } from './vocabulary.ts'
import { coverageOf } from './vocabulary.ts'

/**
 * Characters per token in the harness token meter's own estimator.
 *
 * Memory's pool metric is measured locally rather than through `ctx.tokenMeter`
 * so that scheduling stays a pure function of memory state: the meter prices a
 * whole request surface, and calling it per observation would couple cadence to
 * unrelated context growth. The ratio matches the harness heuristic, so pool
 * pressure is at least expressed in the same unit as context pressure.
 */
const CHARS_PER_TOKEN = 4

/** Per-block overhead the harness estimator adds to one content block. */
const BLOCK_OVERHEAD = 4

/**
 * Estimate the tokens one rendered observation line occupies.
 * @param observation - the observation to price.
 * @returns estimated tokens of its rendered summary line.
 */
export function observationLineTokens(observation: Observation): number {
  const line = `[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`
  return Math.ceil(line.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/** Ascending drop preference: strongly covered observations leave active memory first. */
const COVERAGE_DROP_RANK: Record<CoverageTier, number> = { strong: 0, partial: 1, none: 2 }

/** Active-pool pressure and the drop budget it implies. */
export interface PoolMetrics {
  /** Estimated tokens of the active observation pool. */
  readonly activeTokens: number
  /** Configured active-pool target. */
  readonly targetTokens: number
  /** Whether the pool exceeds the target and therefore permits dropper work. */
  readonly overTarget: boolean
  /** Hard upper bound on how many observations this pass may drop. */
  readonly maxDrops: number
}

/**
 * Measure the active observation pool against its target.
 *
 * `maxDrops` is a bound, never a target: the dropper may drop fewer or none.
 * @param observations - the active observations.
 * @param targetTokens - the configured active-pool target.
 * @returns the pool metrics for this pass.
 */
export function poolMetrics(
  observations: readonly Observation[],
  targetTokens: number,
): PoolMetrics {
  let activeTokens = 0
  const sizes: number[] = []
  for (const observation of observations) {
    const tokens = observationLineTokens(observation)
    activeTokens += tokens
    sizes.push(tokens)
  }
  const overTarget = activeTokens > targetTokens
  if (!overTarget) {
    return { activeTokens, targetTokens, overTarget, maxDrops: 0 }
  }
  // Convert the token excess into a count from the smallest observations
  // upward, so the bound stays conservative rather than optimistic.
  let excess = activeTokens - targetTokens
  let maxDrops = 0
  for (const tokens of [...sizes].sort((left, right) => left - right)) {
    if (excess <= 0) break
    excess -= tokens
    maxDrops += 1
  }
  return { activeTokens, targetTokens, overTarget, maxDrops }
}

/** One dropper candidate with the evidence the model judges it by. */
export interface DropCandidate {
  readonly observation: Observation
  readonly coverage: CoverageTier
}

/**
 * Order dropper candidates so the safest removals come first.
 *
 * The order is deterministic — coverage, then relevance, then age, then pool
 * position — so the same pool always yields the same candidate list. It is used
 * only to pick which candidates to offer the dropper when the pool exceeds the
 * cap, never to drop anything by itself.
 * @param observations - the active observations.
 * @param reflections - the active reflections supplying coverage evidence.
 * @returns candidates ordered by ascending resistance to removal.
 */
export function dropCandidates(
  observations: readonly Observation[],
  reflections: readonly Reflection[],
): DropCandidate[] {
  return observations
    .map((observation, index) => ({
      candidate: { observation, coverage: coverageOf(observation.id, reflections) },
      index,
    }))
    // Position first so the comparison chain below never needs an index
    // fallback: Array.prototype.sort is stable, so equal keys keep pool order.
    .sort((left, right) => left.index - right.index)
    .sort((left, right) => {
      const byCoverage = COVERAGE_DROP_RANK[left.candidate.coverage] - COVERAGE_DROP_RANK[right.candidate.coverage]
      if (byCoverage !== 0) return byCoverage
      const byRelevance = RELEVANCE_ORDER.indexOf(left.candidate.observation.relevance)
        - RELEVANCE_ORDER.indexOf(right.candidate.observation.relevance)
      if (byRelevance !== 0) return byRelevance
      return left.candidate.observation.timestamp.localeCompare(right.candidate.observation.timestamp)
    })
    .map(entry => entry.candidate)
}
