// Claude Code starts this relay as its `cua_repl` MCP server. It starts Codex's
// real cua_repl server and passes newline-delimited JSON-RPC through unchanged,
// except that each tool call gains the Codex turn metadata the Chrome browser
// surface requires. Claude Code cannot attach that metadata itself.
import { spawn } from 'node:child_process'
import { readFileSync, realpathSync, unwatchFile, watchFile } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

/**
 * The first `js` call starts the Computer Use and browser services, which can
 * take a minute on a busy Mac. cua_repl's own 30 s default then resets the
 * kernel mid-start, so every retry starts over. Calls that set no timeout get
 * this one; the MCP timeout in claudeComputerUse.ts must stay above it.
 */
export const CUA_JS_DEFAULT_TIMEOUT_MS = 120_000

/**
 * Add `x-codex-turn-metadata` to a `tools/call` request line, and a longer
 * default timeout to `js` calls; leave every other line as it is.
 */
export function withTurnMetadata(line: string, sessionId: string, turnId: string): string {
  let message: JsonRecord | null
  try {
    message = asRecord(JSON.parse(line))
  } catch {
    return line
  }
  if (message?.method !== 'tools/call') return line
  const params = asRecord(message.params) ?? {}
  const meta = asRecord(params._meta) ?? {}
  const args = asRecord(params.arguments)
  const timed = params.name === 'js' && args && typeof args.timeout_ms !== 'number'
    ? { arguments: { ...args, timeout_ms: CUA_JS_DEFAULT_TIMEOUT_MS } }
    : {}
  return JSON.stringify({
    ...message,
    params: { ...params, ...timed, _meta: { ...meta, 'x-codex-turn-metadata': { session_id: sessionId, turn_id: turnId } } },
  })
}

/** Request ids the relay itself sends; their responses are not Claude's to see. */
const RELAY_REQUEST_PREFIX = 'codexui-relay-'

/** CodexUI's turn file: the current turn id, then `ended` once that reply finishes. */
export function parseTurnFile(text: string): { turnId: string; ended: boolean } {
  const [turnId = '', state = ''] = text.split('\n').map((line) => line.trim())
  return { turnId, ended: state === 'ended' }
}

function readTurnFile(turnFile: string): { turnId: string; ended: boolean } {
  try {
    return parseTurnFile(readFileSync(turnFile, 'utf8'))
  } catch {
    return { turnId: '', ended: false }
  }
}

/**
 * The `turn_ended` call Codex's own plugin hook makes on Stop. It lets the
 * browser surface detach from its tabs and close the ones it opened; without
 * it, agent tabs stay attached and stale attachments stop responding.
 */
export function turnEndedRequest(requestId: number, sessionId: string, turnId: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: `${RELAY_REQUEST_PREFIX}${requestId}`,
    method: 'tools/call',
    params: {
      name: 'turn_ended',
      arguments: { hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId },
      _meta: { 'x-codex-turn-metadata': { session_id: sessionId, turn_id: turnId } },
    },
  })
}

/** Whether a server line answers a request the relay made itself. */
export function isRelayResponse(line: string): boolean {
  try {
    const id = asRecord(JSON.parse(line))?.id
    return typeof id === 'string' && id.startsWith(RELAY_REQUEST_PREFIX)
  } catch {
    return false
  }
}

/** Arguments: `<session id> <turn file> -- <command> [args...]`. */
function main(): void {
  const separator = process.argv.indexOf('--')
  const [sessionId = '', turnFile = ''] = process.argv.slice(2, separator >= 0 ? separator : undefined)
  const [command, ...args] = separator >= 0 ? process.argv.slice(separator + 1) : []
  if (!command || !sessionId) {
    process.stderr.write('cua relay: usage: <session id> <turn file> -- <command> [args...]\n')
    process.exit(2)
  }

  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] })
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (!isRelayResponse(line)) process.stdout.write(`${line}\n`)
  })
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
  child.on('error', (error) => {
    process.stderr.write(`cua relay: ${error.message}\n`)
    process.exit(1)
  })

  let initialized = false
  let nextRequestId = 1
  let lastEndedTurn = ''
  // Checked on every change and once the server is ready, so an end written
  // before the relay started watching is not missed.
  const endTurnIfDone = (): void => {
    if (!turnFile || !initialized) return
    const { turnId, ended } = readTurnFile(turnFile)
    if (!ended || !turnId || turnId === lastEndedTurn) return
    lastEndedTurn = turnId
    child.stdin.write(`${turnEndedRequest(nextRequestId++, sessionId, turnId)}\n`)
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', (line) => {
    const turnId = turnFile ? readTurnFile(turnFile).turnId || sessionId : sessionId
    child.stdin.write(`${withTurnMetadata(line, sessionId, turnId)}\n`)
    if (!initialized && line.includes('"notifications/initialized"')) {
      initialized = true
      endTurnIfDone()
    }
  })
  lines.on('close', () => {
    if (turnFile) unwatchFile(turnFile)
    child.stdin.end()
  })
  if (turnFile) watchFile(turnFile, { interval: 500 }, endTurnIfDone)
}

// Compare real paths: macOS temp and home paths can reach this file through symlinks.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) main()
