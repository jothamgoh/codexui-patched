import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'

// Real app-server, disposable configuration, local scripted Responses provider.
// No authentication, model network calls, bridge, or notification settings.
const home = await mkdtemp(join(tmpdir(), 'codexui-question-probe-'))
const captures = []
const provider = createServer(async (req, res) => {
  let raw = ''
  for await (const part of req) raw += part
  const body = JSON.parse(raw)
  captures.push(body)
  const id = `resp_probe_${captures.length}`
  const input = body.input || []
  const hasToolOutput = input.findLastIndex(item => item.type === 'function_call_output') > input.findLastIndex(item => item.role === 'user')
  const output = hasToolOutput
    ? [{ id: `msg_${captures.length}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Probe complete.', annotations: [] }] }]
    : [{ id: `fc_${captures.length}`, type: 'function_call', call_id: `call_${captures.length}`, namespace: 'functions', name: 'request_user_input', arguments: JSON.stringify({ questions: [{ id: 'scope', header: 'Scope', question: 'Which scope?', options: [{ label: 'Small (Recommended)', description: 'Focused change' }, { label: 'Large', description: 'Broad change' }] }] }) }]
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of [
    { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 0, item: output[0] },
    { type: 'response.completed', response: { id, status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]) res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.end()
})
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
await writeFile(join(home, 'config.toml'), `model = "gpt-6-astra"
model_provider = "probe"
[features]
apps = false
plugins = false
browser_use = false
[model_providers.probe]
name = "Isolated question probe"
base_url = "http://127.0.0.1:${provider.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
`)
const proc = spawn(process.env.CODEXUI_CODEX_COMMAND || 'codex', ['app-server', '--stdio'], {
  cwd: home, env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: '', CODEX_API_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe'],
})
let seq = 0
const pending = new Map(), events = []
let stderr = ''
proc.stderr.on('data', part => { stderr = (stderr + part).slice(-2000) })
const exited = new Promise(resolve => { proc.once('exit', resolve); proc.once('error', resolve) })
const lines = createInterface({ input: proc.stdout })
lines.on('line', raw => {
  let message
  try { message = JSON.parse(raw) } catch { return }
  if (message.id != null && pending.has(message.id)) {
    const { resolve, reject, timer } = pending.get(message.id)
    clearTimeout(timer); pending.delete(message.id)
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
  } else {
    events.push(message)
    if (message.method === 'item/tool/requestUserInput') {
      proc.stdin.write(`${JSON.stringify({ id: message.id, result: { answers: { scope: { answers: ['Small (Recommended)'] } } } })}\n`)
    }
  }
})
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)) }, 15000)
    pending.set(id, { resolve, reject, timer })
    proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
}
async function waitTurn(threadId, turnId) {
  const end = Date.now() + 15000
  while (Date.now() < end) {
    const event = events.find(event => event.method === 'turn/completed' && event.params.threadId === threadId && event.params.turn.id === turnId)
    if (event) return event.params.turn
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Turn timeout: ${stderr}`)
}
try {
  await once(proc, 'spawn')
  await rpc('initialize', { clientInfo: { name: 'codexui-question-probe', version: '1' }, capabilities: { experimentalApi: true } })
  proc.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
  const features = await rpc('experimentalFeature/list', { limit: 200 })
  assert.ok(features.data.some(feature => feature.name === 'default_mode_request_user_input'), 'This native regression requires a runtime advertising default_mode_request_user_input')
  let previous
  for (const [scenario, enabled] of [['new-off', false], ['loaded-resume-on', true], ['new-on', true]]) {
    const config = { 'features.default_mode_request_user_input': enabled }
    const started = scenario === 'loaded-resume-on'
      ? await rpc('thread/resume', { threadId: previous.thread.id, excludeTurns: true, config })
      : await rpc('thread/start', { cwd: home, model: 'gpt-6-astra', modelProvider: 'probe', approvalPolicy: 'never', sandbox: 'read-only', config })
    const before = captures.length, eventsBefore = events.length
    const turnStart = await rpc('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'Run the local question fixture.' }], effort: 'low' })
    const turn = await waitTurn(started.thread.id, turnStart.turn.id)
    previous = started
    assert.equal(turn.status, 'completed', scenario)
    const requests = events.slice(eventsBefore).filter(event => event.method === 'item/tool/requestUserInput')
    const outputs = captures.slice(before).flatMap(call => call.input || []).filter(item => item.type === 'function_call_output').map(item => item.output)
    if (scenario === 'new-on') {
      assert.equal(requests.length, 1)
      assert.ok(outputs.some(output => output.includes('Small (Recommended)')))
    } else {
      assert.equal(requests.length, 0)
      assert.ok(outputs.some(output => output.includes('request_user_input is unavailable in Default mode')))
    }
    console.log(JSON.stringify({ scenario, completed: true, questionRequests: requests.length }))
  }
} finally {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  proc.kill('SIGTERM')
  await exited
  lines.close()
  provider.closeAllConnections()
  await new Promise(resolve => provider.close(resolve))
  await rm(home, { recursive: true, force: true })
}
