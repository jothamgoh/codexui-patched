import compression from 'compression'
import type { RequestHandler } from 'express'

/**
 * Gzip for clients that ask for it (browsers and mobile HTTP clients do): a chat page of two
 * turns goes from about 120 KB to 38 KB for roughly 2 ms of CPU, and the web app's scripts shrink
 * the same way on a direct LAN connection (a proxy in front may already compress public traffic).
 *
 * The live event stream is never compressed: gzip would hold each event back until its buffer
 * fills. The stream also sends Cache-Control: no-transform, which this middleware honours;
 * the content type is checked as well, so a future stream without that header stays live.
 */
export function createResponseCompression(): RequestHandler {
  return compression({
    filter: (req, res) => {
      const contentType = String(res.getHeader('Content-Type') ?? '')
      if (contentType.startsWith('text/event-stream')) return false
      return compression.filter(req, res)
    },
  }) as unknown as RequestHandler
}
