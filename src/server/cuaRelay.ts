// Claude Code starts this relay as its `cua_repl` MCP server. It starts Codex's
// real cua_repl server and passes newline-delimited JSON-RPC through unchanged,
// except that each tool call gains the Codex turn metadata the Chrome browser
// surface requires. Claude Code cannot attach that metadata itself.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, unwatchFile, watchFile } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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
 * default timeout to `js` calls that run code; leave every other line as it is.
 * A `js` call that only reports a `completion_summary` accepts no other field.
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
  const timed = params.name === 'js' && typeof args?.code === 'string' && typeof args.timeout_ms !== 'number'
    ? { arguments: { ...args, timeout_ms: CUA_JS_DEFAULT_TIMEOUT_MS } }
    : {}
  return JSON.stringify({
    ...message,
    params: { ...params, ...timed, _meta: { ...meta, 'x-codex-turn-metadata': { session_id: sessionId, turn_id: turnId } } },
  })
}

/**
 * The wrapper Codex's computer-use plugin starts cua_repl through. It exports
 * the browser access executor id, empty when unset, and any executor id makes
 * cua_repl check each browser call with an access host. Codex gives that
 * host's pipe and key only to the sessions it starts, so under CodexUI every
 * check fails with "The browser access host is unavailable".
 */
export const CODEX_ACCESS_WRAPPER = 'export BROWSER_USE_ACCESS_EXECUTOR_ID="${BROWSER_USE_ACCESS_EXECUTOR_ID-}"; exec "$@"'
const ACCESS_EXECUTOR_ENV = 'BROWSER_USE_ACCESS_EXECUTOR_ID'

export type ServerCommand = { command: string; args: string[]; env: Record<string, string> }

/**
 * The program to start for the configured server command. Codex's access
 * wrapper around `node_repl` is replaced by Codex's own launcher for it,
 * `cua-repl.mjs` run by Codex's bundled node, which is how CodexUI started
 * cua_repl before the wrapper existed:
 * - with no executor id, cua_repl skips the browser access check;
 * - `node_repl` opens the Computer Use pipe only when Codex's node starts it,
 *   so started by this relay directly, every native app call fails with
 *   "Sky Computer Use native pipe startup failed".
 * Without that launcher the wrapped program runs directly, and any other
 * command, including a changed wrapper, runs as configured.
 */
export function serverCommand(command: string, args: string[], fileExists: (path: string) => boolean = existsSync): ServerCommand {
  if (command !== '/bin/sh' || args[0] !== '-c' || args[1] !== CODEX_ACCESS_WRAPPER || !args[3]) return { command, args, env: {} }
  const [program, ...programArgs] = args.slice(3)
  const bin = dirname(program)
  const node = join(bin, 'node')
  const launcher = join(bin, '..', 'lib', 'node_modules', '@oai', 'cua-repl', 'bin', 'cua-repl.mjs')
  if (basename(program) === 'node_repl' && programArgs.length === 0 && fileExists(node) && fileExists(launcher)) {
    return { command: node, args: [launcher], env: { CUA_REPL_NODE_REPL_PATH: program } }
  }
  return { command: program, args: programArgs, env: {} }
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

  const server = serverCommand(command, args)
  const env = { ...process.env, ...server.env }
  delete env[ACCESS_EXECUTOR_ENV]
  const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'inherit'], env })
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
