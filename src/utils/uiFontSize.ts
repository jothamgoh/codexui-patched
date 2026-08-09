export const UI_FONT_SIZES = [14, 15, 16] as const

export type UiFontSize = (typeof UI_FONT_SIZES)[number]

export const DEFAULT_UI_FONT_SIZE: UiFontSize = 14

export function normalizeUiFontSize(value: unknown): UiFontSize {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim().length > 0
      ? Number(value)
      : Number.NaN

  if (!Number.isFinite(parsed)) return DEFAULT_UI_FONT_SIZE

  const rounded = Math.round(parsed)
  if (rounded <= UI_FONT_SIZES[0]) return UI_FONT_SIZES[0]
  if (rounded >= UI_FONT_SIZES[UI_FONT_SIZES.length - 1]) {
    return UI_FONT_SIZES[UI_FONT_SIZES.length - 1]
  }
  return rounded as UiFontSize
}

export function uiFontScale(fontSize: UiFontSize): number {
  return fontSize / DEFAULT_UI_FONT_SIZE
}
