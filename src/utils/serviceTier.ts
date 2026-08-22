export const FAST_SERVICE_TIER_CONFIG_VALUE = 'fast'

const FAST_SERVICE_TIER_ALIASES = new Set(['fast', 'priority'])

export type FastServiceTierByModel = Record<string, string>

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function isFastServiceTier(value: unknown): boolean {
  return FAST_SERVICE_TIER_ALIASES.has(readString(value).toLowerCase())
}

export function readFastServiceTierByModel(models: unknown): FastServiceTierByModel {
  if (!Array.isArray(models)) return {}

  const result: FastServiceTierByModel = {}
  for (const rawModel of models) {
    const model = asRecord(rawModel)
    if (!model) continue

    const modelId = readString(model.id) || readString(model.model)
    if (!modelId) continue

    const serviceTiers = Array.isArray(model.serviceTiers) ? model.serviceTiers : []
    for (const rawTier of serviceTiers) {
      const tier = asRecord(rawTier)
      if (!tier) continue
      const tierId = readString(tier.id)
      const tierName = readString(tier.name)
      if (!tierId || (!isFastServiceTier(tierId) && !isFastServiceTier(tierName))) continue
      result[modelId] = tierId
      break
    }

    if (result[modelId]) continue
    const legacyTiers = Array.isArray(model.additionalSpeedTiers)
      ? model.additionalSpeedTiers
      : []
    const legacyFastTier = legacyTiers.find(isFastServiceTier)
    if (typeof legacyFastTier === 'string' && legacyFastTier.trim()) {
      result[modelId] = legacyFastTier.trim()
    }
  }

  return result
}

export function serviceTierForModel(
  fastModeEnabled: boolean,
  modelId: string,
  fastServiceTierByModel: FastServiceTierByModel,
): string | null {
  if (!fastModeEnabled) return null
  return fastServiceTierByModel[modelId.trim()] ?? null
}
