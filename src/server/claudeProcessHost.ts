import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { basename, dirname } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

/**
 * Runs Claude Code processes inside the signed-in user's login session.
 *
 * On macOS the Claude CLI keeps its sign-in in the login keychain, which a
 * LaunchDaemon cannot unlock. A small host started as a LaunchAgent listens on
 * a private Unix socket and spawns `claude` on the bridge's behalf, relaying
 * stdin, stdout, stderr and exit status. Everything else, including session
 * files, stays with the bridge process.
 *
 * Frames are `[type:1][length:4 BE][payload]`. Client to host: `S` spawn
 * (JSON), `I` stdin bytes, `E` stdin end, `K` kill (JSON). Host to client:
 * `O` stdout bytes, `R` stderr bytes, `X` exit (JSON), `F` failure (JSON).
 */

const HEADER_BYTES = 5
const MAX_FRAME_BYTES = 64 * 1024 * 1024
const KILL_GRACE_MS = 5_000

type FrameHandler = (type: string, payload: Buffer) => void

function encodeFrame(type: string, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const header = Buffer.alloc(HEADER_BYTES)
  header.write(type, 0, 1, 'latin1')
  header.writeUInt32BE(body.length, 1)
  return Buffer.concat([header, body])
}

function createFrameReader(onFrame: FrameHandler): (chunk: Buffer) => void {
  let buffer: Buffer = Buffer.alloc(0)
  return (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    while (buffer.length >= HEADER_BYTES) {
      const length = buffer.readUInt32BE(1)
      if (length > MAX_FRAME_BYTES) throw new Error('Claude host frame is too large.')
      if (buffer.length < HEADER_BYTES + length) return
      const type = buffer.toString('latin1', 0, 1)
      const payload = buffer.subarray(HEADER_BYTES, HEADER_BYTES + length)
      buffer = buffer.subarray(HEADER_BYTES + length)
      onFrame(type, payload)
    }
  }
}

function parseJson(payload: Buffer): Record<string, unknown> {
  const value = JSON.parse(payload.toString('utf8')) as unknown
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export type HostSpawnRequest = {
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string | undefined>
}

/** Only the Claude CLI may be started through the host. */
export function isAllowedClaudeCommand(command: string): boolean {
  if (!command.startsWith('/') || basename(command) !== 'claude') return false
  try {
    return statSync(command).isFile()
  } catch {
    return false
  }
}

function readSpawnRequest(payload: Buffer): HostSpawnRequest {
  const record = parseJson(payload)
  const command = typeof record.command === 'string' ? record.command : ''
  const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === 'string') : []
  const cwd = typeof record.cwd === 'string' && record.cwd ? record.cwd : undefined
  const env: Record<string, string> = {}
  const rawEnv = record.env !== null && typeof record.env === 'object' ? record.env as Record<string, unknown> : {}
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value === 'string') env[key] = value
  }
  return { command, args, cwd, env }
}

function serveConnection(socket: Socket): void {
  let child: ChildProcessWithoutNullStreams | null = null
  let finished = false
  let killTimer: ReturnType<typeof setTimeout> | null = null

  const send = (type: string, payload?: Buffer | string): void => {
    if (!socket.destroyed) socket.write(encodeFrame(type, payload))
  }
  const fail = (message: string): void => {
    if (finished) return
    finished = true
    send('F', JSON.stringify({ message }))
    socket.end()
  }

  const start = (request: HostSpawnRequest): void => {
    if (!isAllowedClaudeCommand(request.command)) {
      fail(`The Claude host only starts the Claude CLI, not ${request.command || 'an empty command'}.`)
      return
    }
    if (request.cwd && !existsSync(request.cwd)) {
      fail(`The working directory does not exist: ${request.cwd}`)
      return
    }
    const proc = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child = proc
    proc.stdout.on('data', (chunk: Buffer) => {
      if (socket.destroyed) return
      if (!socket.write(encodeFrame('O', chunk))) {
        proc.stdout.pause()
        socket.once('drain', () => proc.stdout.resume())
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => send('R', chunk))
    proc.stdin.on('error', () => undefined)
    proc.on('error', (error) => fail(error.message))
    proc.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer)
      if (finished) return
      finished = true
      send('X', JSON.stringify({ code, signal }))
      socket.end()
    })
  }

  const read = createFrameReader((type, payload) => {
    if (type === 'S') {
      if (child || finished) return
      try {
        start(readSpawnRequest(payload))
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
      }
      return
    }
    if (!child) return
    if (type === 'I') child.stdin.write(payload)
    else if (type === 'E') child.stdin.end()
    else if (type === 'K') {
      const signal = parseJson(payload).signal
      child.kill(typeof signal === 'string' ? signal as NodeJS.Signals : 'SIGTERM')
    }
  })

  socket.on('data', (chunk: Buffer) => {
    try {
      read(chunk)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  })
  socket.on('error', () => undefined)
  socket.on('close', () => {
    const proc = child
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
    // The bridge went away mid-run; do not leave an orphaned Claude process.
    proc.kill('SIGTERM')
    killTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    }, KILL_GRACE_MS)
    killTimer.unref?.()
  })
}

export async function startClaudeProcessHost(socketPath: string): Promise<Server> {
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
  if (existsSync(socketPath)) rmSync(socketPath, { force: true })
  const server = createServer(serveConnection)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  chmodSync(socketPath, 0o600)
  return server
}

/** A ChildProcess-shaped handle for a process running in the host. */
export class HostedProcess extends EventEmitter {
  readonly stdin: Writable
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  private readonly socket: Socket
  private settled = false

  constructor(socketPath: string, request: HostSpawnRequest, signal?: AbortSignal) {
    super()
    this.socket = connect(socketPath)
    this.socket.write(encodeFrame('S', JSON.stringify(request)))
    const socket = this.socket
    this.stdin = new Writable({
      write(chunk: Buffer | string, encoding, callback) {
        const data = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
        if (socket.destroyed) {
          callback()
          return
        }
        socket.write(encodeFrame('I', data), () => callback())
      },
      final(callback) {
        if (!socket.destroyed) socket.write(encodeFrame('E'))
        callback()
      },
    })
    this.stdin.on('error', () => undefined)

    const read = createFrameReader((type, payload) => {
      if (type === 'O') this.stdout.write(payload)
      else if (type === 'R') this.stderr.write(payload)
      else if (type === 'X') {
        const result = parseJson(payload)
        this.finish(
          typeof result.code === 'number' ? result.code : null,
          typeof result.signal === 'string' ? result.signal as NodeJS.Signals : null,
        )
      } else if (type === 'F') {
        const message = parseJson(payload).message
        this.fail(new Error(typeof message === 'string' ? message : 'The Claude host could not start Claude.'))
      }
    })
    socket.on('data', (chunk: Buffer) => {
      try {
        read(chunk)
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code
      this.fail(code === 'ENOENT' || code === 'ECONNREFUSED'
        ? new Error('The Claude session host is not running. Start it in your login session to use Claude.')
        : error)
    })
    socket.on('close', () => {
      if (!this.settled) this.finish(1, null)
    })
    signal?.addEventListener('abort', () => this.kill('SIGTERM'), { once: true })
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.settled) return false
    this.killed = true
    if (!this.socket.destroyed) this.socket.write(encodeFrame('K', JSON.stringify({ signal })))
    return true
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.settled) return
    this.settled = true
    this.exitCode = code
    this.signalCode = signal
    this.stdout.end()
    this.stderr.end()
    this.socket.end()
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }

  private fail(error: Error): void {
    if (this.settled) return
    this.stderr.write(`${error.message}\n`)
    if (this.listenerCount('error') > 0) this.emit('error', error)
    this.finish(1, null)
  }
}

export function spawnThroughHost(socketPath: string, request: HostSpawnRequest, signal?: AbortSignal): HostedProcess {
  return new HostedProcess(socketPath, request, signal)
}
