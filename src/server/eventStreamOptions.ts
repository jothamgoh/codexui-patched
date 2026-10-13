/**
 * Options a client may put on GET /codex-api/events. A phone that only shows "finished" and
 * "needs you" asks for a handful of notification methods and a slow keep-alive ping, so its
 * radio can sleep instead of waking for every streamed word and a ping every five seconds.
 *
 *   ?methods=turn/completed,server/request*   exact names, or a prefix with a trailing "*"
 *   ?ping=60                                  seconds between pings, clamped to 5–300
 *
 * With neither parameter the stream is unchanged: every notification, a ping every 5 s.
 */
export type EventStreamOptions = {
  matches: (method: string) => boolean
  pingMs: number
}

export const DEFAULT_EVENT_PING_MS = 5_000
const MIN_EVENT_PING_MS = 5_000
const MAX_EVENT_PING_MS = 300_000

export function parseEventStreamOptions(params: URLSearchParams): EventStreamOptions {
  const wanted = (params.get('methods') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
  const exact = new Set(wanted.filter((entry) => !entry.endsWith('*')))
  const prefixes = wanted.filter((entry) => entry.endsWith('*')).map((entry) => entry.slice(0, -1))
  const matches = wanted.length === 0
    ? () => true
    : (method: string) => exact.has(method) || prefixes.some((prefix) => method.startsWith(prefix))
  const seconds = Number(params.get('ping'))
  const pingMs = Number.isFinite(seconds) && seconds > 0
    ? Math.min(MAX_EVENT_PING_MS, Math.max(MIN_EVENT_PING_MS, Math.round(seconds * 1000)))
    : DEFAULT_EVENT_PING_MS
  return { matches, pingMs }
}
