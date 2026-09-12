/**
 * Serializable configuration for observational memory.
 *
 * Cadence is expressed as a fraction of the active model's context window with
 * an absolute token fallback, because the window is read from the durable
 * `request/context` event: a large-window model then gets memory passes at a
 * sensible granularity instead of the fixed counts a 128K-tuned default would
 * impose.
 *
 * @module @deepseek-ai/dsh-observational-memory/config
 */

import z from '@deepseek-ai/schemastery'

/** Fraction of the context window after which the observer runs. */
export const DEFAULT_OBSERVE_AFTER_RATIO = 0.05

/** Fraction of the context window after which the reflector runs. */
export const DEFAULT_REFLECT_AFTER_RATIO = 0.1

/** Absolute observer threshold used when the context window is unknown. */
export const DEFAULT_OBSERVE_AFTER_TOKENS = 10_000

/** Absolute reflector threshold used when the context window is unknown. */
export const DEFAULT_REFLECT_AFTER_TOKENS = 20_000

/** Active-observation pool budget at which compaction folds the whole ledger. */
export const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000

/** Share of the memory model's window one observer chunk may occupy. */
export const OBSERVER_CHUNK_CONTEXT_RATIO = 0.2

/** Smallest observer chunk budget, so a tiny window cannot stall coverage. */
export const OBSERVER_CHUNK_MIN_TOKENS = 256

/** Observer chunk budget used when the memory model's window is unknown. */
export const OBSERVER_CHUNK_FALLBACK_TOKENS = 60_000

/** Turn cap for one background worker run. */
export const DEFAULT_AGENT_MAX_TURNS = 16

/** Deployment-varying memory settings; every field is optional with a documented default. */
export interface Config {
  /** Fraction of the context window after which the observer runs. `0` disables the ratio and uses the absolute threshold. */
  observeAfterRatio?: number
  /** Fraction of the context window after which the reflector runs. `0` disables the ratio and uses the absolute threshold. */
  reflectAfterRatio?: number
  /** Absolute observer threshold in source tokens, used when no context window is known. */
  observeAfterTokens?: number
  /** Absolute reflector threshold in source tokens, used when no context window is known. */
  reflectAfterTokens?: number
  /** Active-observation pool budget in tokens. */
  observationsPoolMaxTokens?: number
  /** Active-observation target the dropper maintains; defaults to half of the maximum. */
  observationsPoolTargetTokens?: number
  /** Largest observer chunk in tokens; defaults to a fifth of the memory model's window. */
  observerChunkMaxTokens?: number
  /** Turn cap for one background worker run. */
  agentMaxTurns?: number
  /**
   * Model route for memory workers; leave both route fields empty to use the
   * session model. The schema always materializes this object, so it is
   * required here with optional members rather than optional as a whole.
   */
  model: {
    /** Registered provider route, or empty to use the session route. */
    provider?: string
    /** Provider-owned model id, or empty to use the session route. */
    model?: string
    /** Adapter-owned reasoning effort. */
    reasoningEffort?: string
  }
  /** Disable all background memory work and compaction rendering. */
  passive?: boolean
  /** Largest generation for one worker call. */
  workerMaxTokens?: number
  /**
   * Directory the memory ledger is stored in, one JSON document per session.
   *
   * Defaults to `observational-memory` inside the harness home (`$DSH_HOME`, or
   * `~/.dsh`). Memory lives outside the session log, so this directory — not the
   * log — is what a backup or a shared machine has to carry for a session to keep
   * its memory.
   */
  storageDir?: string
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  observeAfterRatio: z.number(),
  reflectAfterRatio: z.number(),
  observeAfterTokens: z.number(),
  reflectAfterTokens: z.number(),
  observationsPoolMaxTokens: z.number(),
  observationsPoolTargetTokens: z.number(),
  observerChunkMaxTokens: z.number(),
  agentMaxTurns: z.number(),
  model: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string(),
  }),
  passive: z.boolean(),
  workerMaxTokens: z.number(),
  storageDir: z.string(),
})

/** Worker cadence and budgets with every default applied. */
export interface ResolvedConfig {
  readonly observeAfterRatio: number
  readonly reflectAfterRatio: number
  readonly observeAfterTokens: number
  readonly reflectAfterTokens: number
  readonly observationsPoolMaxTokens: number
  readonly observationsPoolTargetTokens: number
  readonly observerChunkMaxTokens: number | undefined
  readonly agentMaxTurns: number
  readonly model: Config['model']
  readonly passive: boolean
  readonly workerMaxTokens: number | undefined
  /** Explicit ledger directory, or undefined to use the harness home. */
  readonly storageDir: string | undefined
}

/**
 * Apply defaults and validate cross-field constraints.
 *
 * Invalid values fail plugin load rather than degrading silently, which is the
 * repository rule for misconfiguration.
 * @param config - the loader-validated configuration.
 * @returns the resolved configuration.
 */
export function resolveConfig(config: Config = { model: {} }): ResolvedConfig {
  const observeAfterRatio = requireRatio(config.observeAfterRatio, DEFAULT_OBSERVE_AFTER_RATIO, 'observeAfterRatio')
  const reflectAfterRatio = requireRatio(config.reflectAfterRatio, DEFAULT_REFLECT_AFTER_RATIO, 'reflectAfterRatio')
  const observeAfterTokens = requirePositive(config.observeAfterTokens, DEFAULT_OBSERVE_AFTER_TOKENS, 'observeAfterTokens')
  const reflectAfterTokens = requirePositive(config.reflectAfterTokens, DEFAULT_REFLECT_AFTER_TOKENS, 'reflectAfterTokens')
  const observationsPoolMaxTokens = requirePositive(
    config.observationsPoolMaxTokens,
    DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS,
    'observationsPoolMaxTokens',
  )
  const requestedTarget = config.observationsPoolTargetTokens
  if (requestedTarget !== undefined && (!Number.isInteger(requestedTarget) || requestedTarget <= 0)) {
    throw new Error(`observational-memory: observationsPoolTargetTokens must be a positive integer, got ${String(requestedTarget)}`)
  }
  if (requestedTarget !== undefined && requestedTarget >= observationsPoolMaxTokens) {
    throw new Error(
      `observational-memory: observationsPoolTargetTokens (${String(requestedTarget)}) must be below observationsPoolMaxTokens (${String(observationsPoolMaxTokens)})`,
    )
  }
  const observerChunkMaxTokens = config.observerChunkMaxTokens === undefined
    ? undefined
    : Math.max(OBSERVER_CHUNK_MIN_TOKENS, config.observerChunkMaxTokens)
  return {
    observeAfterRatio,
    reflectAfterRatio,
    observeAfterTokens,
    reflectAfterTokens,
    observationsPoolMaxTokens,
    observationsPoolTargetTokens: requestedTarget ?? Math.floor(observationsPoolMaxTokens / 2),
    observerChunkMaxTokens,
    agentMaxTurns: requirePositive(config.agentMaxTurns, DEFAULT_AGENT_MAX_TURNS, 'agentMaxTurns'),
    model: config.model,
    passive: config.passive ?? false,
    workerMaxTokens: config.workerMaxTokens === undefined
      ? undefined
      : requirePositive(config.workerMaxTokens, 1, 'workerMaxTokens'),
    storageDir: config.storageDir === undefined || config.storageDir.length === 0
      ? undefined
      : config.storageDir,
  }
}

/** Require an integer greater than zero. */
function requirePositive(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`observational-memory: ${field} must be a positive integer, got ${String(value)}`)
  }
  return value
}

/** Require a fraction within `[0, 1)`, where `0` means "ratio disabled". */
function requireRatio(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`observational-memory: ${field} must be a finite number in [0, 1), got ${String(value)}`)
  }
  return value
}

/**
 * Resolve a worker's token threshold against the active context window.
 *
 * A zero ratio, an unknown window, or a window too small to yield a usable
 * threshold all fall back to the absolute count, so cadence stays defined even
 * when an adapter declines to advertise a window.
 * @param ratio - the configured window fraction.
 * @param absolute - the configured absolute fallback.
 * @param contextWindow - the active window in tokens, when known.
 * @returns the threshold in source tokens.
 */
export function resolveThreshold(ratio: number, absolute: number, contextWindow: number | undefined): number {
  if (ratio <= 0 || contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) return absolute
  return Math.max(1, Math.floor(contextWindow * ratio))
}

/**
 * Resolve the observer's chunk budget in tokens.
 * @param configured - an explicit cap, when the deployment set one.
 * @param contextWindow - the memory model's window, when known.
 * @returns the chunk budget in tokens.
 */
export function resolveObserverChunkTokens(
  configured: number | undefined,
  contextWindow: number | undefined,
): number {
  // The floor applies to any source of the value, so an explicit deployment
  // budget cannot disable chunking by being smaller than one entry.
  if (configured !== undefined) return Math.max(OBSERVER_CHUNK_MIN_TOKENS, configured)
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return OBSERVER_CHUNK_FALLBACK_TOKENS
  }
  return Math.max(OBSERVER_CHUNK_MIN_TOKENS, Math.floor(contextWindow * OBSERVER_CHUNK_CONTEXT_RATIO))
}
