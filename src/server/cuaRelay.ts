// Claude Code starts this relay as its `cua_repl` MCP server. It starts Codex's
// real cua_repl server and passes newline-delimited JSON-RPC through unchanged,
// except that each tool call gains the Codex turn metadata the Chrome browser
// surface requires. Claude Code cannot attach that metadata itself.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

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

function currentTurnId(turnFile: string, fallback: string): string {
  try {
    return readFileSync(turnFile, 'utf8').trim() || fallback
  } catch {
    return fallback
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
  child.stdout.pipe(process.stdout)
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
  child.on('error', (error) => {
    process.stderr.write(`cua relay: ${error.message}\n`)
    process.exit(1)
  })

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', (line) => {
    const turnId = turnFile ? currentTurnId(turnFile, sessionId) : sessionId
    child.stdin.write(`${withTurnMetadata(line, sessionId, turnId)}\n`)
  })
  lines.on('close', () => child.stdin.end())
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
