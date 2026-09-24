import z from '@deepseek-ai/schemastery'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'

/** Pi's calibrated source-entry threshold and the host's recent-history budget. */
export const DEFAULT_COMPACT_AFTER_TOKENS = 81_000
export const DEFAULT_COMPACT_AFTER_RATIO = 0.68
export const DEFAULT_RETAIN_TOKENS = 20_000

export interface MemoryCompactionConfig extends BasicCompactionConfig {
  autoCompact?: boolean
  compactAfterTokens?: number
  compactAfterTokensMode?: 'calibrated' | 'ratio'
  compactAfterTokensRatio?: number
}

/** Keep the base schema intact for loader UIs and reject unknown policy fields in the constructor. */
export const MemoryCompactionSchema = z.object({
  ...(BasicCompactionEngine.Config.dict as Record<string, z>),
  autoCompact: z.boolean(),
  compactAfterTokens: z.number(),
  compactAfterTokensMode: z.union(['calibrated', 'ratio']),
  compactAfterTokensRatio: z.number(),
} as Record<keyof MemoryCompactionConfig, z>) as unknown as z<MemoryCompactionConfig>

export interface ResolvedMemoryPolicy {
  readonly autoCompact: boolean
  readonly compactAfterTokens: number
  readonly compactAfterTokensMode: 'calibrated' | 'ratio'
  readonly compactAfterTokensRatio: number
  readonly explicitRetention: boolean
}

/** Resolve the plugin's own knobs before passing only base keys to the parent. */
export function splitCompactionConfig(input: MemoryCompactionConfig = {}): {
  base: BasicCompactionConfig
  policy: ResolvedMemoryPolicy
} {
  const {
    autoCompact = true,
    compactAfterTokens = DEFAULT_COMPACT_AFTER_TOKENS,
    compactAfterTokensMode = 'calibrated',
    compactAfterTokensRatio = DEFAULT_COMPACT_AFTER_RATIO,
    ...base
  } = input
  if (!Number.isInteger(compactAfterTokens) || compactAfterTokens <= 0) {
    throw new Error('observational-memory: compactAfterTokens must be a positive integer')
  }
  if (compactAfterTokensMode !== 'calibrated' && compactAfterTokensMode !== 'ratio') {
    throw new Error('observational-memory: compactAfterTokensMode must be calibrated or ratio')
  }
  if (!Number.isFinite(compactAfterTokensRatio) || compactAfterTokensRatio <= 0 || compactAfterTokensRatio >= 1) {
    throw new Error('observational-memory: compactAfterTokensRatio must be in (0, 1)')
  }
  if (typeof autoCompact !== 'boolean') throw new Error('observational-memory: autoCompact must be a boolean')
  const explicitRetention = base.retainTokens !== undefined || base.retainRatio !== undefined
  return {
    base: explicitRetention ? base : { ...base, retainTokens: DEFAULT_RETAIN_TOKENS },
    policy: { autoCompact, compactAfterTokens, compactAfterTokensMode, compactAfterTokensRatio, explicitRetention },
  }
}

export function compactThreshold(policy: ResolvedMemoryPolicy, window: number | undefined): number {
  return policy.compactAfterTokensMode === 'ratio' && window !== undefined && Number.isFinite(window) && window > 0
    ? Math.max(1, Math.floor(window * policy.compactAfterTokensRatio))
    : policy.compactAfterTokens
}

/** DSH adaptation: do not reserve 20K in a smaller window or above the trigger itself. */
export function defaultTail(window: number | undefined, threshold: number): number {
  return Math.max(0, Math.min(DEFAULT_RETAIN_TOKENS,
    window !== undefined && Number.isFinite(window) && window > 0 ? Math.floor(window * 0.16) : DEFAULT_RETAIN_TOKENS,
    threshold - 1))
}
