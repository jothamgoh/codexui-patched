#!/usr/bin/env node
// Live test of voice routing against a RUNNING CodexUI, with the user's real chats.
//
//   node scripts/voice-live-test.mjs [--base http://127.0.0.1:5999] [--repeat N] [--only <journey>] [--chats N]
//
// It only calls the in-app route POST /codex-api/voice/command with {"text": ...}. That route
// routes the words and returns the result: it sends no push notification and no chat message.
// This script never calls a /codex-api/voice/shortcut/ route, never confirms and never sends.
// Each call spends Jev (and sometimes LLM) credit.
//
// Phrases are generated at run time from the live chat list and project list, so no real chat
// title is ever written to the repository. The full results, titles included, go to
// output/voice-live/ (ignored by git). See docs/voice-commands-success.md for the targets.
import { mkdirSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback }
const base = option('--base', 'http://127.0.0.1:5999').replace(/\/+$/u, '')
const repeat = Number(option('--repeat', '1'))
const only = option('--only', '')
const chatCount = Number(option('--chats', '6'))
const COMMAND_URL = `${base}/codex-api/voice/command`
if (!new URL(COMMAND_URL).pathname.endsWith('/codex-api/voice/command')) throw new Error('refusing to call anything but the in-app command route')

async function command(text) {
  const started = performance.now()
  const response = await fetch(COMMAND_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  const ms = Math.round(performance.now() - started)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) return { error: payload.error ?? `HTTP ${response.status}`, ms }
  return { result: payload.data.result, meta: payload.data.meta ?? null, ms }
}

// --- What the live instance knows -------------------------------------------

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'chat', 'new', 'fix', 'add', 'this', 'that'])
const tokens = (value) => value.toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word.length >= 3 && !STOP.has(word))
const normalized = (value) => (value ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim()

const discovery = await command('show my recent chats')
if (discovery.error) throw new Error(`The live instance did not answer: ${discovery.error}`)
const sections = discovery.result.sections
const rows = [...new Map(['needs_you', 'running', 'unread', 'recent'].flatMap((type) => sections[type]).map((row) => [row.threadId, row])).values()]
const projectProbe = await command('new chat')
const projects = (projectProbe.result?.projectOptions ?? []).filter((project) => project.label.replace(/[^a-z0-9]/giu, '').length >= 3)

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
add('new chat', `new chat, ${TASKS[0]}`, { action: 'new_chat', project: null, message: TASKS[0] })
add('new chat', `new chat with claude: ${TASKS[1]}`, { action: 'new_chat', project: null, agent: 'claude', message: TASKS[1] })

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
for (const say of ['open spotify', 'what time is it', 'pause all the running agents', 'summarise what finished this morning', 'turn on dark mode', 'send yes to every chat', 'delete all my chats']) add('not understood', say, { action: 'none' })
if (first) add('not understood', `what did the ${spokenTitle(first)} chat say`, { action: 'none', allowChat: first.threadId })

// --- Grading ------------------------------------------------------------------

/**
 * right: the landing the phrase asked for. chooser: a chooser that offers the right chat
 * (safe, one extra tap). wrong: anything else. misroute: a different chat opened or readied.
 */
function gradeOne(result, expect) {
  if (expect.action === 'none') {
    if (result.outcome === 'not_understood') return 'right'
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

function grade(result, expect) {
  if (!expect.steps) return gradeOne(result, expect)
  if (result.outcome !== 'steps' || (result.steps ?? []).length !== expect.steps.length) return result.threadId ? 'misroute' : 'wrong'
  const grades = expect.steps.map((want, index) => gradeOne(result.steps[index], want))
  if (grades.includes('misroute')) return 'misroute'
  if (grades.includes('wrong')) return 'wrong'
  return grades.includes('chooser') ? 'chooser' : 'right'
}

// --- Run ------------------------------------------------------------------------

const selected = cases.filter((entry) => !only || entry.journey === only)
console.log(`Voice live test against ${base}: ${selected.length} phrases x ${repeat}, from ${rows.length} live chats (${chats.length} used) and ${projects.length} projects`)
const runs = []
for (let round = 0; round < repeat; round += 1) {
  for (const entry of selected) {
    const { result, meta, ms, error } = await command(entry.say)
    const verdict = error ? 'error' : grade(result, entry.expect)
    runs.push({ ...entry, verdict, ms, path: meta?.path ?? 'unknown', serverMs: meta?.totalMs ?? null, error, outcome: result?.outcome, reason: result?.reason, threadId: result?.threadId, message: result?.message, steps: result?.steps?.map((step) => ({ action: step.action, outcome: step.outcome, threadId: step.threadId })) })
    process.stdout.write(verdict === 'right' ? '.' : verdict === 'chooser' ? 'c' : verdict === 'misroute' ? 'M' : 'x')
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
  return `${String(count('right')).padStart(3)}/${String(entries.length).padEnd(3)} right ${String(Math.round((count('right') / entries.length) * 100)).padStart(3)}%  chooser ${count('chooser')}  wrong ${count('wrong') + count('error')}  misroute ${count('misroute')}  p50 ${percentile(ms, 50)} ms  p95 ${percentile(ms, 95)} ms`
}
const journeys = [...new Set(selected.map((entry) => entry.journey))]
console.log('\nBy journey:')
for (const journey of journeys) console.log(`  ${journey.padEnd(15)} ${tally(runs.filter((entry) => entry.journey === journey))}`)
console.log(`  ${'overall'.padEnd(15)} ${tally(runs)}`)
console.log('By path (latency is server time when the instance reports it, else round trip):')
for (const path of [...new Set(runs.map((entry) => entry.path))]) console.log(`  ${path.padEnd(15)} ${tally(runs.filter((entry) => entry.path === path))}`)
const misses = runs.filter((entry) => entry.verdict !== 'right')
if (misses.length > 0) {
  console.log('\nNot right:')
  for (const miss of misses) {
    console.log(`  [${miss.journey}] ${miss.verdict}: "${miss.say}"`)
    console.log(`      got ${miss.error ?? `${miss.outcome}${miss.reason ? `/${miss.reason}` : ''}`}${miss.message ? ` message "${miss.message}"` : ''}${miss.steps ? ` steps ${miss.steps.map((step) => `${step.action}:${step.outcome}`).join(', ')}` : ''} path ${miss.path} ${miss.serverMs ?? miss.ms} ms`)
  }
}
mkdirSync('output/voice-live', { recursive: true })
const file = `output/voice-live/${new Date().toISOString().replace(/[:.]/gu, '-')}.json`
writeFileSync(file, JSON.stringify({ base, chats: chats.map((row) => row.title), projects: projects.map((project) => project.label), runs }, null, 2))
console.log(`\nFull results (with real titles, not committed): ${file}`)
