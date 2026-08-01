export function formatCompactRelativeTime(value: string, nowMs: number): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'n/a'

  const diffMs = Math.max(0, nowMs - timestamp)
  if (diffMs < 60000) return 'now'

  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 60) return `${minutes.toString()}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours.toString()}h`

  return `${Math.floor(hours / 24).toString()}d`
}
