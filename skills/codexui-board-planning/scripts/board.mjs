import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

// No credentials, runtime database access, shell execution, or execution actions.
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  url: { type: 'string' }, thread: { type: 'string' }, board: { type: 'string' },
  feature: { type: 'string' }, file: { type: 'string' },
  offset: { type: 'string' }, 'full-plan': { type: 'boolean' },
} })

try {
  const origin = new URL(values.url || '')
  if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname)
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Use the exact local HTTP connection supplied by CodexUI.')
  }
  if (!values.thread?.trim()) throw new Error('Use the planning chat ID supplied by CodexUI.')
  const action = positionals[0]
  if (positionals.length !== 1 || !['context', 'save'].includes(action)) throw new Error('Choose context or save. This helper does not start work.')
  const endpoint = new URL('/codex-api/project-board-planning', origin)
  let body
  if (action === 'save') {
    if (!values.file) throw new Error('save requires --file with the reviewed draft JSON.')
    const raw = await readFile(values.file, 'utf8')
    if (Buffer.byteLength(raw) > 800_000) throw new Error('Keep the feature plan under 800 KB.')
    const input = JSON.parse(raw)
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The draft must be a JSON object.')
    body = JSON.stringify({ ...input, sourceThreadId: values.thread })
  } else {
    endpoint.searchParams.set('sourceThreadId', values.thread)
    if (values.board) endpoint.searchParams.set('boardId', values.board)
    if (values.feature) endpoint.searchParams.set('featureId', values.feature)
    if (values.offset) endpoint.searchParams.set('offset', values.offset)
    if (values['full-plan']) endpoint.searchParams.set('fullPlan', 'true')
  }
  const response = await fetch(endpoint, {
    method: action === 'save' ? 'POST' : 'GET', redirect: 'error',
    headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(15_000),
  })
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('The local bridge is unavailable or needs its updated build restarted.')
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || `Board request failed (${response.status}).`)
  if (!result.data || typeof result.data !== 'object') throw new Error('The bridge returned an invalid board response.')
  process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${error.message}\nIf a save was attempted, read context before retrying with the same IDs.\n`)
  process.exitCode = 1
}
