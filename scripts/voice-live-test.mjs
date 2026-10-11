#!/usr/bin/env node
// Live test of voice routing against a RUNNING CodexUI, with the user's real chats.
//
//   node scripts/voice-live-test.mjs [--base http://127.0.0.1:5999] [--repeat N] [--only <journey>] [--chats N]
//                                    [--local --env-file ~/.config/codexui/.env]
//
// It only calls the in-app route POST /codex-api/voice/command with {"text": ..., "dryRun": true}.
// A dry run routes the words and reports what would be sent without a tap (meta.autoSend), but
// schedules nothing: no push notification and no chat message. This script never calls a
// /codex-api/voice/shortcut/ route, never confirms and never sends. Each call spends Jev (and
// sometimes LLM) credit.
//
// --local reads the live chats and projects from the instance the same way, but routes each
// phrase in this process with this checkout's router (keys from --env-file). Use it to measure a
// router change before the service runs it. It never calls the command route for the phrases.
//
// Phrases are generated at run time from the live chat list and project list, so no real chat
// title is ever written to the repository. The full results, titles included, go to
// output/voice-live/ (ignored by git). See docs/voice-commands-success.md for the targets.
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const args = process.argv.slice(2)
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback }
const base = option('--base', 'http://127.0.0.1:5999').replace(/\/+$/u, '')
const repeat = Number(option('--repeat', '1'))
const only = option('--only', '')
const chatCount = Number(option('--chats', '6'))
const local = args.includes('--local')
const COMMAND_URL = `${base}/codex-api/voice/command`
if (!new URL(COMMAND_URL).pathname.endsWith('/codex-api/voice/command')) throw new Error('refusing to call anything but the in-app command route')

async function loadModule(path) {
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
}
const { decideAutoSendAll } = await loadModule('../src/server/voice/voiceAutoSend.ts')

/** Asks the instance. Always a dry run: nothing is ever scheduled or sent. */
async function remoteCommand(text) {
  const started = performance.now()
  const response = await fetch(COMMAND_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, dryRun: true }) })
  const ms = Math.round(performance.now() - started)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) return { error: payload.error ?? `HTTP ${response.status}`, ms }
  // An instance older than auto-send reports no decision; judge its result here instead.
  const meta = payload.data.meta ?? {}
  if (!meta.autoSend) meta.autoSend = decideAutoSendAll(payload.data.result, { autoSend: true }).map((decision) => (decision.auto ? decision.kind : `skip:${decision.skip}`))
  if (!meta.dryRun && meta.autoSend.some((entry) => !entry.startsWith('skip:'))) meta.olderInstance = true
  return { result: payload.data.result, meta, ms }
}
let command = remoteCommand

// --- What the live instance knows -------------------------------------------

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'chat', 'new', 'fix', 'add', 'this', 'that'])
const tokens = (value) => value.toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word.length >= 3 && !STOP.has(word))
const normalized = (value) => (value ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim()

const discovery = await command('show my recent chats')
if (discovery.error) throw new Error(`The live instance did not answer: ${discovery.error}`)
const sections = discovery.result.sections
const rows = [...new Map(['needs_you', 'running', 'unread', 'recent'].flatMap((type) => sections[type]).map((row) => [row.threadId, row])).values()]
// A named project that matches nothing: the chooser lists every project, default or not.
const projectProbe = await command('new chat in the zzqx project')
const allProjects = projectProbe.result?.projectOptions ?? []
const projects = allProjects.filter((project) => project.label.replace(/[^a-z0-9]/giu, '').length >= 3)

let defaultProject = null
if (local) {
  if (option('--env-file', '')) {
    const { loadCodexUiEnv } = await loadModule('../src/server/envFile.ts')
    loadCodexUiEnv({ explicitPath: option('--env-file', '') })
  }
  const { routeVoiceCommand } = await loadModule('../src/server/voice/voiceRouter.ts')
  const { askJev } = await loadModule('../src/server/voice/jevClient.ts')
  const { extractMessageWithLlm } = await loadModule('../src/server/voice/voiceMessage.ts')
  const { decideWithLlm } = await loadModule('../src/server/voice/voiceLlmRouter.ts')
  const { resolveDefaultProject } = await loadModule('../src/server/voice/voiceRoutes.ts')
  const env = process.env
  const llmEnv = { anthropicApiKey: env.CODEXUI_VOICE_ANTHROPIC_API_KEY, anthropicWorkspaceId: env.CODEXUI_VOICE_ANTHROPIC_WORKSPACE_ID, deepseekApiKey: env.CODEXUI_VOICE_DEEPSEEK_API_KEY, kimiApiKey: env.CODEXUI_VOICE_KIMI_API_KEY }
  if (!env.CODEXUI_VOICE_TYPESAFE_API_KEY) throw new Error('--local needs the voice keys: pass --env-file')
  defaultProject = resolveDefaultProject({ autoSend: true, delaySeconds: 0, defaultProject: '' }, env, allProjects)
  const context = { sections: discovery.result.sections, otherChats: [], projects: allProjects, defaultProject, nowMs: Date.now() }
  const deps = {
    jev: (questions, state) => askJev(questions, state, { apiKey: env.CODEXUI_VOICE_TYPESAFE_API_KEY }),
    extractWithLlm: (kind, transcript) => extractMessageWithLlm(kind, transcript, llmEnv),
    decideWithLlm: (input) => decideWithLlm(input, llmEnv),
  }
  command = async (text) => {
    const started = performance.now()
    try {
      const { result, trace } = await routeVoiceCommand(text, { ...context, nowMs: Date.now() }, deps)
      const ms = Math.round(performance.now() - started)
      const autoSend = decideAutoSendAll(result, { autoSend: true }).map((decision) => (decision.auto ? decision.kind : `skip:${decision.skip}`))
      return { result, meta: { path: trace.path === 'llm' ? `llm:${trace.fallback?.provider}` : trace.path ?? 'none', totalMs: ms, autoSend }, ms }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), ms: Math.round(performance.now() - started) }
    }
  }
} else {
  const settings = await fetch(`${base}/codex-api/voice/settings`).then((response) => (response.ok ? response.json() : null)).catch(() => null)
  const chosen = settings?.data?.defaultProject
  defaultProject = chosen ? allProjects.find((project) => project.id === chosen) ?? { id: chosen, label: chosen.split('/').at(-1) } : settings?.fallbackProject ?? null
}

/** Chats whose title words are not shared by any other chat's title: one name, one chat. */
function distinctChats() {
  const picked = []
  for (const row of rows) {
    const words = tokens(row.title)
    if (words.length < 2 || row.title.length > 48) continue
    const clash = rows.some((other) => other !== row && words.filter((word) => tokens(other.title).includes(word)).length >= Math.min(2, words.length))
    if (!clash) picked.push(row)
    if (picked.length >= chatCount) break
  }
  return picked
}
const chats = distinctChats()
if (chats.length < 3) throw new Error(`Need at least 3 chats with distinct titles; found ${chats.length}.`)
const spokenTitle = (row) => row.title.replace(/[-_/:]+/gu, ' ').replace(/\s+/gu, ' ').trim()
/** A dictation slip: lower case, no punctuation, "codex" heard as "code x", short words spelled out. */
const slipTitle = (row) => spokenTitle(row).toLowerCase().replace(/\bcodex\b/gu, 'code x').replace(/\b(ui|ai|api)\b/gu, (word) => word.toUpperCase().split('').join(' '))
const spokenProject = (project) => project.label.replace(/[-_.]+/gu, ' ')

// --- Cases --------------------------------------------------------------------

const MESSAGES = ['run the tests again', 'add a short summary at the top', 'check the logs for errors', 'make the button bigger on mobile']
const TASKS = ['find out why the build is slow', 'tidy up the readme', 'add a dark mode toggle']
const cases = []
const add = (journey, say, expect) => cases.push({ journey, say, expect })
const [first, second, third] = chats
const [projectA, projectB] = projects

// Single commands: opens, sends, with filler, slips and questions.
chats.forEach((row, index) => {
  const message = MESSAGES[index % MESSAGES.length]
  add('open', `open the ${spokenTitle(row)} chat`, { action: 'open_chat', chat: row.threadId })
  add('send', `tell the ${spokenTitle(row)} chat to ${message}`, { action: 'send_to_chat', chat: row.threadId, message })
  if (index === 0) add('open', `um could you please open the ${spokenTitle(row)} chat, thanks`, { action: 'open_chat', chat: row.threadId })
  if (index < 3) add('open', `can you pull up the ${slipTitle(row)} one please`, { action: 'open_chat', chat: row.threadId })
  if (index === 1) add('send', `can you ask the ${slipTitle(row)} chat to ${message}?`, { action: 'send_to_chat', chat: row.threadId, message })
  if (index === 2) add('send', `reply to the ${spokenTitle(row)} chat saying yes go ahead`, { action: 'send_to_chat', chat: row.threadId, message: 'yes go ahead' })
  if (index < 4) {
    add('send long', `Okay so um respond to the ${slipTitle(row)} chat and basically, you know, I was looking at it again on my phone and I think we should ${message}, and also maybe double check the edge cases while you're at it. Do you get what I mean?`,
      { action: 'send_to_chat', chat: row.threadId, messageIncludes: message })
    // Shaped like a real miss: a technical ramble about UI, no "to" after the chat, a question at the end.
    add('send long', `Respond to the ${spokenTitle(row)} chat and basically on the settings page implement the same thing where, you know, in the notification bar there is a small microphone button where I can talk to it and it uses the same logic as the phone shortcut does. Do you get what I mean here?`,
      { action: 'send_to_chat', chat: row.threadId, messageIncludes: 'small microphone button' })
  }
})
// A one-word name ("the <word> one") may fairly need a chooser, never a wrong chat.
const shortName = chats.map((row) => ({ row, word: tokens(row.title).find((word) => word.length >= 5 && rows.filter((other) => tokens(other.title).includes(word)).length === 1) })).find((entry) => entry.word)
if (shortName) add('short', `the ${shortName.word} one`, { action: 'open_chat', chat: shortName.row.threadId })

// Lists of each type, including one-word commands.
for (const [listType, phrases] of Object.entries({
  needs_you: ["what's waiting on me", 'does anything need my approval'],
  running: ["what's running", 'which agents are still working', 'running'],
  unread: ['show unread', 'anything new?', 'unread'],
  recent: ['recent chats', 'show my last few chats'],
})) for (const say of phrases) add(say.split(' ').length === 1 ? 'short' : 'list', say, { action: 'list_chats', listType })

// New chats with and without a project or agent.
projects.slice(0, 3).forEach((project, index) => {
  const task = TASKS[index % TASKS.length]
  add('new chat', `new chat in ${spokenProject(project)}, ${task}`, { action: 'new_chat', project: project.id, message: task })
  if (index === 0) add('new chat', `start a new codex chat in ${spokenProject(project)} to ${task}`, { action: 'new_chat', project: project.id, agent: 'codex', message: task })
  if (index === 1) {
    add('new chat long', `um so I want a new chat in ${spokenProject(project)} and basically, you know, ${task}, because it keeps annoying me every time I open it on my phone`,
      { action: 'new_chat', project: project.id, messageIncludes: task })
  }
})
// No project named: the default project when there is one, else the chooser.
add('new chat', `new chat, ${TASKS[0]}`, { action: 'new_chat', project: defaultProject?.id ?? null, message: TASKS[0] })
add('new chat', `new chat with claude: ${TASKS[1]}`, { action: 'new_chat', project: defaultProject?.id ?? null, agent: 'claude', message: TASKS[1] })
// A project said but not one of them: the chooser, never the default.
add('new chat', 'new chat in the zebra garden repo, plan the launch emails', { action: 'new_chat', project: null })

// A task or question on its own: a new chat in the default project with the request as its message.
for (const say of [
  'find me the best hotels in Johor Bahru', "what's a good laptop under 2k", 'summarise the latest news on OpenAI',
  'draft an email to my landlord about the leak', 'how do I reverse a linked list in python', 'plan a three day trip to Penang with good hawker food',
  'what are the best chicken rice stalls near Tiong Bahru', 'explain how CPF top ups work for self employed people', 'find cheap flights from Singapore to Tokyo in December',
  'recommend a good ergonomic chair under 500 dollars', 'why does my React useEffect run twice in development', 'give me a recipe for laksa that takes under an hour',
  'compare the iPhone 17 Pro and the Pixel 11 cameras', 'is it cheaper to take the bus or the train to Kuala Lumpur', 'write a short birthday message for my mum',
]) add('query', say, { action: 'new_chat', project: defaultProject?.id ?? null, message: say })
// Not new chats: fragments, questions about chats, unsupported actions.
for (const say of ['deploy it', 'try that again', 'stop the export job', 'pause all the running agents', 'turn on dark mode']) add('not a new chat', say, { action: 'none' })
for (const [say, listType] of [["what's running", 'running'], ['anything new?', 'unread']]) add('not a new chat', say, { action: 'list_chats', listType })
if (first) add('not a new chat', `what did the ${spokenTitle(first)} chat say`, { action: 'none', allowChat: first.threadId })

// Compound requests become steps; a condition inside one message is still one send.
if (first && second) {
  add('steps', `tell the ${spokenTitle(first)} chat to ${MESSAGES[0]} and open the ${spokenTitle(second)} chat`,
    { steps: [{ action: 'send_to_chat', chat: first.threadId }, { action: 'open_chat', chat: second.threadId }] })
  add('steps', `tell the ${spokenTitle(first)} chat to ${MESSAGES[1]}, and ask the ${spokenTitle(second)} chat to ${MESSAGES[2]}`,
    { steps: [{ action: 'send_to_chat', chat: first.threadId }, { action: 'send_to_chat', chat: second.threadId }] })
  add('send', `if the tests passed, tell the ${spokenTitle(second)} chat to deploy it`, { action: 'send_to_chat', chat: second.threadId, messageIncludes: 'deploy' })
}
if (third && projectA) {
  add('steps', `open the ${spokenTitle(third)} chat and start a new chat in ${spokenProject(projectA)} to ${TASKS[2]}`,
    { steps: [{ action: 'open_chat', chat: third.threadId }, { action: 'new_chat', project: projectA.id }] })
}
add('steps', 'show unread and running', { steps: [{ action: 'list_chats', listType: 'unread' }, { action: 'list_chats', listType: 'running' }] })
if (projectA && projectB) {
  add('steps', `new chat in ${spokenProject(projectA)} to ${TASKS[0]}, and another one in ${spokenProject(projectB)} to ${TASKS[1]}`,
    { steps: [{ action: 'new_chat', project: projectA.id }, { action: 'new_chat', project: projectB.id }] })
}

// Outside scope: "didn't catch that", or at most the chat the words name; never another chat.
for (const say of ['open spotify', 'pause all the running agents', 'summarise what finished this morning', 'turn on dark mode', 'send yes to every chat', 'delete all my chats']) add('not understood', say, { action: 'none' })
// A question, so a new chat is as right as "didn't catch that".
add('not understood', 'what time is it', { action: 'none', allowNewChat: true })
if (first) add('not understood', `what did the ${spokenTitle(first)} chat say`, { action: 'none', allowChat: first.threadId })

// --- Grading ------------------------------------------------------------------

/**
 * right: the landing the phrase asked for. chooser: a chooser that offers the right chat
 * (safe, one extra tap). wrong: anything else. misroute: a different chat opened or readied.
 */
function gradeOne(result, expect) {
  if (expect.action === 'none') {
    if (result.outcome === 'not_understood') return 'right'
    if (expect.allowNewChat && result.outcome === 'new_chat') return 'right'
    if (expect.allowChat && [result.threadId, ...result.candidates.map((row) => row.threadId)].includes(expect.allowChat) && (!result.threadId || result.threadId === expect.allowChat)) return 'right'
    return result.threadId ? 'misroute' : 'wrong'
  }
  if (expect.action === 'list_chats') return result.action === 'list_chats' && result.listType === expect.listType ? 'right' : result.threadId && result.action !== 'list_chats' ? 'misroute' : 'wrong'
  if (expect.action === 'new_chat') {
    if (result.outcome !== 'new_chat') return 'wrong'
    if ('project' in expect && (result.project?.id ?? null) !== expect.project) return 'wrong'
    if (expect.agent && result.agent !== expect.agent) return 'wrong'
    if (expect.message && normalized(result.message) !== normalized(expect.message)) return 'wrong'
    if (expect.messageIncludes && !normalized(result.message).includes(normalized(expect.messageIncludes))) return 'wrong'
    return 'right'
  }
  if (result.threadId && result.threadId !== expect.chat) return 'misroute'
  const wantOutcome = expect.action === 'send_to_chat' ? 'send_ready' : 'open_chat'
  if (result.outcome === wantOutcome && result.threadId === expect.chat) {
    if (expect.message && normalized(result.message) !== normalized(expect.message)) return 'wrong'
    if (expect.messageIncludes && !normalized(result.message).includes(normalized(expect.messageIncludes))) return 'wrong'
    return 'right'
  }
  if (result.outcome === 'picker' && result.candidates.some((row) => row.threadId === expect.chat)) return 'chooser'
  return 'wrong'
}

function stepAsResult(step) {
  const candidates = step.candidates ?? []
  const target = step.outcome === 'send_ready' || step.outcome === 'open_chat' ? candidates[0]?.threadId : undefined
  return { ...step, candidates, threadId: step.threadId ?? target }
}

function grade(result, expect) {
  if (!expect.steps) return gradeOne(result, expect)
  if (result.outcome !== 'steps' || (result.steps ?? []).length !== expect.steps.length) return result.threadId ? 'misroute' : 'wrong'
  // A step names its chat through candidates; only a top-level result carries threadId.
  const grades = expect.steps.map((want, index) => gradeOne(stepAsResult(result.steps[index]), want))
  if (grades.includes('misroute')) return 'misroute'
  if (grades.includes('wrong')) return 'wrong'
  return grades.includes('chooser') ? 'chooser' : 'right'
}

/**
 * Which parts would go out without a tap, and whether any would go to a chat or project the
 * phrase did not name (the target is 0); and whether a command that is not a new chat would
 * start one.
 */
function judgeAuto(result, decisions, expect) {
  const parts = result.outcome === 'steps' ? result.steps.map(stepAsResult) : [result]
  const wants = expect.steps ?? [expect]
  let would = false
  let wrong = 0
  decisions.forEach((decision, index) => {
    if (decision.startsWith('skip:')) return
    would = true
    const part = parts[index] ?? {}
    const want = wants[index] ?? {}
    if (decision === 'send' && (want.action !== 'send_to_chat' || part.threadId !== want.chat)) wrong += 1
    if (decision === 'new_chat' && (want.action !== 'new_chat' || ('project' in want && (part.project?.id ?? null) !== want.project))) wrong += 1
  })
  const misstart = parts.some((part, index) => part.outcome === 'new_chat' && (wants[index]?.action ?? expect.action) !== 'new_chat' && !expect.allowNewChat)
  return { would, wrong, misstart }
}

// --- Run ------------------------------------------------------------------------

const selected = cases.filter((entry) => !only || entry.journey === only)
console.log(`Voice live test against ${base}${local ? ' (routed locally with this checkout)' : ' (dry run)'}: ${selected.length} phrases x ${repeat}, from ${rows.length} live chats (${chats.length} used) and ${projects.length} projects; default project ${defaultProject ? 'set' : 'none'}`)
const runs = []
for (let round = 0; round < repeat; round += 1) {
  for (const entry of selected) {
    const { result, meta, ms, error } = await command(entry.say)
    const verdict = error ? 'error' : grade(result, entry.expect)
    const auto = error ? { would: false, wrong: 0, misstart: false } : judgeAuto(result, meta?.autoSend ?? [], entry.expect)
    runs.push({ ...entry, verdict, ms, path: meta?.path ?? 'unknown', serverMs: meta?.totalMs ?? null, error, outcome: result?.outcome, reason: result?.reason, threadId: result?.threadId, message: result?.message, project: result?.project?.label ?? null, autoSend: meta?.autoSend, wouldAuto: auto.would, wrongAuto: auto.wrong, misstart: auto.misstart, steps: result?.steps?.map((step) => ({ action: step.action, outcome: step.outcome, threadId: stepAsResult(step).threadId })) })
    process.stdout.write(auto.wrong ? 'W' : verdict === 'right' ? '.' : verdict === 'chooser' ? 'c' : verdict === 'misroute' ? 'M' : 'x')
  }
}
process.stdout.write('\n')

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}
function tally(entries) {
  const count = (verdict) => entries.filter((entry) => entry.verdict === verdict).length
  const ms = entries.map((entry) => entry.serverMs ?? entry.ms)
  const auto = entries.filter((entry) => entry.wouldAuto).length
  const wrongAuto = entries.reduce((sum, entry) => sum + (entry.wrongAuto ?? 0), 0)
  return `${String(count('right')).padStart(3)}/${String(entries.length).padEnd(3)} right ${String(Math.round((count('right') / entries.length) * 100)).padStart(3)}%  chooser ${count('chooser')}  wrong ${count('wrong') + count('error')}  misroute ${count('misroute')}  auto ${auto}/${entries.length} (${Math.round((auto / entries.length) * 100)}%) wrong-auto ${wrongAuto}  p50 ${percentile(ms, 50)} ms  p95 ${percentile(ms, 95)} ms`
}
const journeys = [...new Set(selected.map((entry) => entry.journey))]
console.log('\nBy journey:')
for (const journey of journeys) console.log(`  ${journey.padEnd(15)} ${tally(runs.filter((entry) => entry.journey === journey))}`)
console.log(`  ${'overall'.padEnd(15)} ${tally(runs)}`)
console.log('By path (latency is server time when the instance reports it, else round trip):')
for (const path of [...new Set(runs.map((entry) => entry.path))]) console.log(`  ${path.padEnd(15)} ${tally(runs.filter((entry) => entry.path === path))}`)
const wrongAutos = runs.filter((entry) => entry.wrongAuto > 0)
const misstarts = runs.filter((entry) => entry.misstart)
console.log(`\nWould auto-send to a wrong chat or project: ${wrongAutos.length}${wrongAutos.length ? ` (${wrongAutos.map((entry) => `[${entry.journey}] "${entry.say.slice(0, 50)}"`).join(', ')})` : ''}`)
console.log(`Not new chats, but would start one: ${misstarts.length}${misstarts.length ? ` (${misstarts.map((entry) => `[${entry.journey}] "${entry.say.slice(0, 50)}"`).join(', ')})` : ''}`)
const misses = runs.filter((entry) => entry.verdict !== 'right')
if (misses.length > 0) {
  console.log('\nNot right:')
  for (const miss of misses) {
    console.log(`  [${miss.journey}] ${miss.verdict}: "${miss.say}"`)
    console.log(`      got ${miss.error ?? `${miss.outcome}${miss.reason ? `/${miss.reason}` : ''}`}${miss.project ? ` project ${miss.project}` : ''}${miss.message ? ` message "${miss.message}"` : ''}${miss.steps ? ` steps ${miss.steps.map((step) => `${step.action}:${step.outcome}`).join(', ')}` : ''} path ${miss.path} ${miss.serverMs ?? miss.ms} ms`)
  }
}
mkdirSync('output/voice-live', { recursive: true })
const file = `output/voice-live/${new Date().toISOString().replace(/[:.]/gu, '-')}.json`
writeFileSync(file, JSON.stringify({ base, chats: chats.map((row) => row.title), projects: projects.map((project) => project.label), runs }, null, 2))
console.log(`\nFull results (with real titles, not committed): ${file}`)
