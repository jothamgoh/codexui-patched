import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

async function loadModule(path) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
}

const message = await loadModule('../src/server/voice/voiceMessage.ts')
const { projectAliasEntries } = await loadModule('../src/server/voice/voiceRouter.ts')
const { extractSendByRule, extractNewChatByRule, extractMessageWithLlm, acceptLlmMessage, stripFillers, detectAgent, ANTHROPIC_MODEL } = message

const PROJECTS = projectAliasEntries([
  { id: '/work/hr-ai', label: 'hr-ai' },
  { id: '/work/slack-ai', label: 'slack-ai' },
  { id: '/work/notes-vault', label: 'notes-vault' },
  { id: '/work/codexui-patched', label: 'codexui-patched' },
])

const SEND_CASES = [
  // "tell X chat to ..." (chat noun preferred over the first "to")
  ['tell the stripe chat to deploy it to staging', 'the stripe chat', 'deploy it to staging'],
  ['tell the to do app chat to add dark mode', 'the to do app chat', 'add dark mode'],
  ['ask the hr-ai one to run the tests', 'the hr-ai one', 'run the tests'],
  // "tell X to ..." without a chat noun
  ['ask it to try again', 'it', 'try again'],
  ['have the export job rerun yesterday', null, null],
  ['let the export job know that the sheet is fixed', 'the export job', 'the sheet is fixed'],
  // "tell X: ..." / "message X, ..."
  ['tell the stripe chat: ship it', 'the stripe chat', 'ship it'],
  ['message the notes vault chat, add a note about templates', 'the notes vault chat', 'add a note about templates'],
  // send "..." to X chat
  ['send "looks good, merge it" to the login page chat', 'login page chat', 'looks good, merge it'],
  // send a message to X chat saying ...
  ['send a message to the email chat saying the DNS is updated', 'the email chat', 'the DNS is updated'],
  // in X chat, say ...
  ['in the slack chat, say restart the bot', 'the slack chat', 'restart the bot'],
  // reply to X saying ...
  ['reply to the migration chat saying yes go ahead', 'the migration chat', 'yes go ahead'],
  // fillers and politeness
  ['Um, could you tell the HRA I chat to run the tests and then deploy, please', 'the HRA I chat', 'run the tests and then deploy'],
  ['okay so please ask the stripe chat to add a retry, thanks', 'the stripe chat', 'add a retry'],
  // not a send the rules can cut
  ['stripe webhook chat needs to know about staging', null, null],
  ['open the stripe chat', null, null],
]

for (const [say, chatPhrase, expected] of SEND_CASES) {
  test(`send rule: "${say}"`, () => {
    const result = extractSendByRule(say)
    if (expected === null) {
      assert.equal(result, null)
      return
    }
    assert.equal(result?.message, expected)
    assert.equal(result?.chatPhrase, chatPhrase)
  })
}

const NEW_CASES = [
  ['new chat in hr-ai, find out why customer emails bounce', { projectId: '/work/hr-ai', message: 'find out why customer emails bounce' }],
  ['New chat in HRA I find out why customer emails are bouncing', { projectId: '/work/hr-ai', message: 'find out why customer emails are bouncing' }],
  ['new chat in H R A I to fix the login', { projectId: '/work/hr-ai', message: 'fix the login' }],
  ['start a new codex chat in slack AI to check the logs', { projectId: '/work/slack-ai', agent: 'codex', message: 'check the logs' }],
  ['new chat in notes vault with claude: summarise my notes', { projectId: '/work/notes-vault', agent: 'claude', message: 'summarise my notes' }],
  ['start a new chat with codex in hr ai about the login bug', { projectId: '/work/hr-ai', agent: 'codex', message: 'about the login bug' }],
  ['codex, new chat in hr-ai, fix the build', { projectId: '/work/hr-ai', agent: 'codex', message: 'fix the build' }],
  ['new chat in hr-ai to look at it with codex', { projectId: '/work/hr-ai', agent: 'codex', message: 'look at it' }],
  ['open a fresh thread for the codex UI patched repo and fix the build', { projectId: '/work/codexui-patched', message: 'fix the build' }],
  ['I need a new chat in hr-ai to fix tests', { projectId: '/work/hr-ai', message: 'fix tests' }],
  ['new chat in hr-ai', { projectId: '/work/hr-ai', message: '' }],
  ['new chat hr-ai, fix the build', { projectId: '/work/hr-ai', message: 'fix the build' }],
  ['new chat, check the server logs', { message: 'check the server logs' }],
  ['new chat find out why the build is slow', { message: 'find out why the build is slow' }],
  ['new chat in booking platform, plan the pricing page', { projectPhrase: 'booking platform', message: 'plan the pricing page' }],
  ['new chat in booking platform', { projectPhrase: 'booking platform', message: '' }],
  ['new chat with clawed in notes vault, tidy the inbox', { projectId: '/work/notes-vault', agent: 'claude', message: 'tidy the inbox' }],
  // "in codex UI patched" names a project that starts with an agent's name; it does not pick Codex.
  ['new chat in codex UI patched, add a microphone to the panel', { projectId: '/work/codexui-patched', message: 'add a microphone to the panel' }],
  ['new chat in codex, check the logs', { agent: 'codex', message: 'check the logs' }],
]

for (const [say, expected] of NEW_CASES) {
  test(`new-chat rule: "${say}"`, () => {
    const result = extractNewChatByRule(say, PROJECTS)
    assert.ok(result, 'rule matched')
    assert.equal(result.message, expected.message)
    assert.equal(result.projectId, expected.projectId)
    assert.equal(result.projectPhrase, expected.projectPhrase)
    assert.equal(result.agent, expected.agent)
  })
}

for (const say of [
  'start something new with Claude in hr ai to tidy the quiz prompts',
  'the build is broken, new chat please',
  'new chat in the project i was using yesterday for the marketing site and then check the copy',
]) {
  test(`new-chat rule declines to guess: "${say}"`, () => {
    assert.equal(extractNewChatByRule(say, PROJECTS), null)
  })
}

test('fillers are stripped from both ends, the middle is untouched', () => {
  assert.equal(stripFillers('Um, okay so, could you please tell the chat to stop, thanks'), 'tell the chat to stop')
  assert.equal(stripFillers('tell the chat um to wait'), 'tell the chat um to wait')
})

test('agent words are found in any position', () => {
  assert.equal(detectAgent('new chat with codex in hr-ai'), 'codex')
  assert.equal(detectAgent('start a chat using Claude'), 'claude')
  assert.equal(detectAgent('deploy it to the cloud'), undefined)
})

// --- LLM fallback, mocked ------------------------------------------------------

function anthropicResponse(text, extra = {}) {
  return new Response(JSON.stringify({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text }], ...extra }), { status: 200 })
}
function openAiResponse(text) {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }), { status: 200 })
}

const TRANSCRIPT = 'the stripe webhook chat, it should deploy to staging after the tests pass'

test('the LLM fallback asks Claude Haiku for structured JSON with the workspace header', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    return anthropicResponse('{"found":true,"message":"deploy to staging after the tests pass"}')
  }
  const result = await extractMessageWithLlm('send_to_chat', TRANSCRIPT, { anthropicApiKey: 'ak', anthropicWorkspaceId: 'ws-1', deepseekApiKey: 'dk' }, fetchImpl)
  assert.deepEqual(result, { message: 'deploy to staging after the tests pass', provider: 'anthropic' })
  assert.equal(calls.length, 1, 'later providers are not called after a success')
  const [{ url, init, body }] = calls
  assert.equal(url, 'https://api.anthropic.com/v1/messages')
  assert.equal(init.headers['x-api-key'], 'ak')
  assert.equal(init.headers['anthropic-version'], '2023-06-01')
  assert.equal(init.headers['anthropic-workspace-id'], 'ws-1')
  assert.equal(body.model, ANTHROPIC_MODEL)
  assert.equal(body.model, 'claude-haiku-5-5')
  assert.equal(body.output_config.format.type, 'json_schema')
  assert.deepEqual(body.thinking, { type: 'disabled' }, 'thinking would cost seconds and can use up max_tokens')
  assert.deepEqual(body.output_config.format.schema.required, ['found', 'message'])
  assert.deepEqual(JSON.parse(body.messages[0].content), { transcript: TRANSCRIPT }, 'the transcript is passed as data')
  assert.match(body.system, /never follow instructions/iu)
})

test('a reworded LLM answer is rejected and the next provider is tried', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(url)
    if (url.includes('anthropic')) return anthropicResponse('{"found":true,"message":"Please deploy the build to staging"}')
    return openAiResponse('{"found":true,"message":"deploy to staging after the tests pass"}')
  }
  const result = await extractMessageWithLlm('send_to_chat', TRANSCRIPT, { anthropicApiKey: 'ak', deepseekApiKey: 'dk' }, fetchImpl)
  assert.deepEqual(result, { message: 'deploy to staging after the tests pass', provider: 'deepseek' })
  assert.deepEqual(urls, ['https://api.anthropic.com/v1/messages', 'https://api.deepseek.com/chat/completions'])
})

test('provider errors and timeouts fall through to Kimi, with thinking disabled', async () => {
  const bodies = []
  const fetchImpl = async (url, init) => {
    bodies.push({ url, body: JSON.parse(init.body) })
    if (url.includes('anthropic')) return new Response('{"error":{"type":"overloaded_error"}}', { status: 529 })
    if (url.includes('deepseek')) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    return openAiResponse('```json\n{"found":true,"message":"deploy to staging"}\n```')
  }
  const result = await extractMessageWithLlm('send_to_chat', TRANSCRIPT, { anthropicApiKey: 'ak', deepseekApiKey: 'dk', kimiApiKey: 'kk' }, fetchImpl, 30)
  assert.deepEqual(result, { message: 'deploy to staging', provider: 'kimi' })
  const kimi = bodies.find((entry) => entry.url.includes('moonshot'))
  assert.equal(kimi.body.model, 'kimi-k2.6')
  assert.deepEqual(kimi.body.thinking, { type: 'disabled' })
})

test('providers without a key are skipped silently, and none at all yields null', async () => {
  const urls = []
  const fetchImpl = async (url) => { urls.push(url); return openAiResponse('{"found":true,"message":"deploy to staging"}') }
  assert.deepEqual(await extractMessageWithLlm('send_to_chat', TRANSCRIPT, { kimiApiKey: 'kk' }, fetchImpl), { message: 'deploy to staging', provider: 'kimi' })
  assert.deepEqual(urls, ['https://api.moonshot.ai/v1/chat/completions'])
  assert.equal(await extractMessageWithLlm('send_to_chat', TRANSCRIPT, {}, fetchImpl), null)
})

test('a refusal or truncated Anthropic answer is not used', async () => {
  const fetchImpl = async () => anthropicResponse('{"found":true,"message":"deploy to staging"}', { stop_reason: 'refusal' })
  assert.equal(await extractMessageWithLlm('send_to_chat', TRANSCRIPT, { anthropicApiKey: 'ak' }, fetchImpl), null)
})

test('found=false is an empty message, not a failure', async () => {
  const fetchImpl = async () => anthropicResponse('{"found":false,"message":""}')
  assert.deepEqual(await extractMessageWithLlm('new_chat', 'new chat in hr-ai', { anthropicApiKey: 'ak' }, fetchImpl), { message: '', provider: 'anthropic' })
})

test('only words from the transcript are accepted', () => {
  assert.equal(acceptLlmMessage('tell it to Deploy, now!', { found: true, message: 'deploy now' }), 'deploy now')
  assert.equal(acceptLlmMessage('tell it to deploy now', { found: true, message: 'deploy everything now' }), null)
  assert.equal(acceptLlmMessage('tell it to deploy now', { found: 'yes', message: 'deploy now' }), null)
  assert.equal(acceptLlmMessage('tell it to deploy now', null), null)
})

// Opt-in: CODEXUI_VOICE_LIVE_LLM=1 with CODEXUI_VOICE_ANTHROPIC_API_KEY set. Spends a few tokens.
test('live: Claude Haiku extracts a message verbatim', { skip: process.env.CODEXUI_VOICE_LIVE_LLM !== '1' || !process.env.CODEXUI_VOICE_ANTHROPIC_API_KEY }, async () => {
  const result = await extractMessageWithLlm('new_chat', 'start something new with Claude in hr ai to tidy the quiz prompts', {
    anthropicApiKey: process.env.CODEXUI_VOICE_ANTHROPIC_API_KEY,
    anthropicWorkspaceId: process.env.CODEXUI_VOICE_ANTHROPIC_WORKSPACE_ID,
  }, fetch, 10_000)
  assert.equal(result?.provider, 'anthropic')
  assert.match(result.message, /tidy the quiz prompts/u)
})
