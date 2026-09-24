import { describe, expect, it } from 'vitest'
import { compactThreshold, defaultTail, splitCompactionConfig } from '../src/compaction-policy.ts'

describe('compaction defaults and overrides', () => {
  it('uses the Pi calibrated trigger and a unified 20K DSH retention default', () => {
    const { base, policy } = splitCompactionConfig()
    expect(base).toEqual({ retainTokens: 20_000 })
    expect(compactThreshold(policy, 1_000_000)).toBe(81_000)
    expect(defaultTail(1_000_000, 81_000)).toBe(20_000)
    expect(defaultTail(128_000, 81_000)).toBe(20_000)
    expect(defaultTail(50_000, 81_000)).toBe(8_000)
    expect(defaultTail(undefined, 10_000)).toBe(9_999)
  })

  it('resolves ratio mode and falls back to absolute threshold with no window', () => {
    const { policy } = splitCompactionConfig({ compactAfterTokensMode: 'ratio', compactAfterTokensRatio: 0.68 })
    expect(compactThreshold(policy, 1_000_000)).toBe(680_000)
    expect(compactThreshold(policy, 0)).toBe(81_000)
  })

  it('passes explicit retention and model policy through unchanged', () => {
    const { base, policy } = splitCompactionConfig({ retainRatio: 0.1, modelPolicies: [{ provider: 'p', model: 'm', retainTokens: 1000 }] })
    expect(base).toEqual({ retainRatio: 0.1, modelPolicies: [{ provider: 'p', model: 'm', retainTokens: 1000 }] })
    expect(policy.explicitRetention).toBe(true)
  })

  it('rejects malformed knobs rather than silently resetting them', () => {
    expect(() => splitCompactionConfig({ compactAfterTokens: 0 })).toThrow(/positive integer/)
    expect(() => splitCompactionConfig({ compactAfterTokensMode: 'other' as never })).toThrow(/Mode/)
    expect(() => splitCompactionConfig({ compactAfterTokensRatio: 1 })).toThrow(/Ratio/)
    expect(() => splitCompactionConfig({ autoCompact: 1 as never })).toThrow(/autoCompact/)
  })
})
