#!/usr/bin/env node
// Live evaluation of the voice router against real Jev. Not part of `npm test`:
// it spends TypeSafe credit (and Anthropic tokens when a rule cannot cut a message).
//
//   node scripts/voice-eval.mjs --env-file ~/.config/codexui/.env [--set tuning|holdout|fresh|hard|all] [--shuffle] [--repeat N] [--only <journey>] [--json] [--json-out <file>]
//
// Uses the fictional chats and labelled phrases in tests/fixtures/voicePhrases.mjs.
// Prints accuracy per journey, every misfire, and p50/p95 latency per Jev call
// and per command. Never prints keys or response bodies.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { CHATS, FRESH_PHRASES, HOLDOUT_PHRASES, HARD_PHRASES, PHRASES, buildContext } from '../tests/fixtures/voicePhrases.mjs'

async function loadModule(path) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
}

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback }
const repeat = Number(option('--repeat', '1'))
const only = option('--only', '')

if (option('--env-file', '')) {
  const { loadCodexUiEnv } = await loadModule('../src/server/envFile.ts')
  loadCodexUiEnv({ explicitPath: option('--env-file', '') })
}
const apiKey = process.env.CODEXUI_VOICE_TYPESAFE_API_KEY ?? ''
if (!apiKey) {
  console.error('Set CODEXUI_VOICE_TYPESAFE_API_KEY to run the live evaluation.')
  process.exit(2)
}

const { routeVoiceCommand } = await loadModule('../src/server/voice/voiceRouter.ts')
const { askJev } = await loadModule('../src/server/voice/jevClient.ts')
const { extractMessageWithLlm } = await loadModule('../src/server/voice/voiceMessage.ts')
const { decideWithLlm } = await loadModule('../src/server/voice/voiceLlmRouter.ts')

const llmEnv = {
  anthropicApiKey: process.env.CODEXUI_VOICE_ANTHROPIC_API_KEY,
  anthropicWorkspaceId: process.env.CODEXUI_VOICE_ANTHROPIC_WORKSPACE_ID,
  deepseekApiKey: process.env.CODEXUI_VOICE_DEEPSEEK_API_KEY,
  kimiApiKey: process.env.CODEXUI_VOICE_KIMI_API_KEY,
}

const callLatencies = []
const commandLatencies = []
const deps = {
  jev: async (questions, state) => {
    const outcome = await askJev(questions, state, { apiKey })
    callLatencies.push(outcome.elapsedMs)
    return outcome
  },
  extractWithLlm: (kind, transcript) => extractMessageWithLlm(kind, transcript, llmEnv),
  decideWithLlm: (input) => decideWithLlm(input, llmEnv),
}

function shuffled(rows, seed) {
  const copy = [...rows]
  let state = seed
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648
    const swap = state % (index + 1)
    ;[copy[index], copy[swap]] = [copy[swap], copy[index]]
  }
  return copy
}

function contextFor(round) {
  const context = buildContext()
  if (!flag('--shuffle')) return context
  return {
    ...context,
    sections: Object.fromEntries(Object.entries(context.sections).map(([key, rows]) => [key, shuffled(rows, round + key.length)])),
    projects: shuffled(context.projects, round + 7),
  }
}

const keyOfThread = Object.fromEntries(Object.entries(CHATS).map(([key, row]) => [row.threadId, key]))

function gradeSteps(result, expected) {
  const steps = result.steps ?? []
  if (steps.length !== expected.length) return [`${steps.length} steps (want ${expected.length})`]
  return expected.flatMap((want, index) => {
    const step = steps[index]
    const problems = []
    if (step.action !== want.action) problems.push(`step ${index + 1} ${step.action} (want ${want.action})`)
    if (want.listType && step.listType !== want.listType) problems.push(`step ${index + 1} list ${step.listType} (want ${want.listType})`)
    if (want.chat && step.threadId && step.threadId !== CHATS[want.chat].threadId) problems.push(`step ${index + 1} chat ${keyOfThread[step.threadId] ?? step.threadId} (want ${want.chat})`)
    if (want.chat && step.outcome === 'picker' && !step.candidates.some((row) => row.threadId === CHATS[want.chat].threadId)) problems.push(`step ${index + 1} picker misses ${want.chat}`)
    if ('project' in want && (step.project?.label ?? null) !== want.project) problems.push(`step ${index + 1} project ${step.project?.label ?? null} (want ${want.project})`)
    return problems
  })
}

function grade(result, phrase) {
  const { expect } = phrase
  const problems = []
  const outcomes = [expect.outcome].flat()
  if (!outcomes.includes(result.outcome)) problems.push(`outcome ${result.outcome} (want ${outcomes.join(' or ')})`)
  if (expect.steps && result.outcome === 'steps') problems.push(...gradeSteps(result, expect.steps))
  if (expect.reason && result.reason !== expect.reason) problems.push(`reason ${result.reason} (want ${expect.reason})`)
  if (expect.listType && result.listType !== expect.listType) problems.push(`list ${result.listType} (want ${expect.listType})`)
  if (expect.chat && result.outcome !== 'steps' && result.threadId !== CHATS[expect.chat].threadId) problems.push(`chat ${keyOfThread[result.threadId] ?? result.threadId ?? '-'} (want ${expect.chat})`)
  if (expect.picker && result.outcome === 'picker') {
    const offered = new Set(result.candidates.map((row) => keyOfThread[row.threadId]))
    const missing = expect.picker.filter((key) => !offered.has(key))
    if (missing.length > 0) problems.push(`picker misses ${missing.join(', ')}`)
  }
  if ('message' in expect && (result.message ?? '') !== expect.message && outcomes.includes(result.outcome)) problems.push(`message "${result.message ?? ''}" (want "${expect.message}")`)
  if ('project' in expect && (result.project?.label ?? null) !== expect.project) problems.push(`project ${result.project?.label ?? null} (want ${expect.project})`)
  if ('agent' in expect && (result.agent ?? null) !== expect.agent) problems.push(`agent ${result.agent ?? null} (want ${expect.agent})`)
  return problems
}

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

const set = option('--set', 'tuning')
const source = { tuning: PHRASES, holdout: HOLDOUT_PHRASES, fresh: FRESH_PHRASES, hard: HARD_PHRASES, all: [...PHRASES, ...HOLDOUT_PHRASES, ...FRESH_PHRASES, ...HARD_PHRASES] }[set] ?? PHRASES
const phrases = source.filter((phrase) => !only || String(phrase.journey) === only)
const byJourney = new Map()
const misfires = []
const rows = []
for (let round = 0; round < repeat; round += 1) {
  for (const phrase of phrases) {
    const started = performance.now()
    const { result, trace } = await routeVoiceCommand(phrase.say, contextFor(round), deps)
    commandLatencies.push(Math.round(performance.now() - started))
    const problems = grade(result, phrase)
    const tally = byJourney.get(phrase.journey) ?? { total: 0, correct: 0 }
    tally.total += 1
    if (problems.length === 0) tally.correct += 1
    byJourney.set(phrase.journey, tally)
    // A chat opened or readied for sending that the phrase did not name is the costly mistake.
    const wrongChat = Boolean(result.threadId) && result.threadId !== (phrase.expect.chat ? CHATS[phrase.expect.chat].threadId : undefined)
    const wrongStepChat = (result.steps ?? []).some((step, index) => {
      const want = phrase.expect.steps?.[index]?.chat
      return Boolean(step.threadId) && step.action !== 'list_chats' && (!want || step.threadId !== CHATS[want].threadId)
    })
    const ms = commandLatencies.at(-1)
    rows.push({ say: phrase.say, journey: phrase.journey, outcome: result.outcome, reason: result.reason, wrongChat: wrongChat || wrongStepChat, problems, trace, ms })
    if (problems.length > 0) misfires.push({ say: phrase.say, journey: phrase.journey, problems, trace })
  }
}

if (option('--json-out', '')) {
  writeFileSync(option('--json-out', ''), JSON.stringify({ byJourney: Object.fromEntries(byJourney), misfires, rows, callLatencies, commandLatencies }, null, 2))
}
if (flag('--json')) {
  console.log(JSON.stringify({ byJourney: Object.fromEntries(byJourney), misfires, rows, callLatencies, commandLatencies }, null, 2))
  process.exit(0)
}

const names = { 1: 'open (clear)', 2: 'open (close call)', 3: 'lists', 4: 'send', 5: 'new chat', 6: 'not understood', 7: 'steps' }
let total = 0
let correct = 0
console.log(`Voice router live eval (${set} set): ${phrases.length} phrases x ${repeat}${flag('--shuffle') ? ', shuffled option order' : ''}`)
for (const [journey, tally] of [...byJourney].sort((left, right) => left[0] - right[0])) {
  total += tally.total
  correct += tally.correct
  console.log(`  journey ${journey} ${names[journey].padEnd(18)} ${tally.correct}/${tally.total}  ${Math.round((tally.correct / tally.total) * 100)}%`)
}
console.log(`  overall                      ${correct}/${total}  ${Math.round((correct / total) * 100)}%`)
console.log(`Jev call latency ms: p50 ${percentile(callLatencies, 50)}  p95 ${percentile(callLatencies, 95)}  max ${Math.max(...callLatencies)}  (${callLatencies.length} calls)`)
console.log(`Command latency ms:  p50 ${percentile(commandLatencies, 50)}  p95 ${percentile(commandLatencies, 95)}  max ${Math.max(...commandLatencies)}`)
console.log('By path (who decided the action):')
for (const path of ['jev', 'jev+llm', 'llm', 'none']) {
  const taken = rows.filter((row) => (row.trace.path ?? 'none') === path)
  if (taken.length === 0) continue
  const right = taken.filter((row) => row.problems.length === 0).length
  const ms = taken.map((row) => row.ms)
  console.log(`  ${path.padEnd(8)} ${String(right).padStart(3)}/${String(taken.length).padEnd(4)} ${String(Math.round((right / taken.length) * 100)).padStart(3)}%  command p50 ${percentile(ms, 50)} ms  p95 ${percentile(ms, 95)} ms`)
}
const llmCalls = rows.filter((row) => row.trace.fallback).map((row) => row.trace.fallback)
if (llmCalls.length > 0) {
  const reasons = Object.entries(Object.groupBy(llmCalls, (call) => call.reason)).map(([reason, calls]) => `${reason} ${calls.length}`).join(', ')
  console.log(`LLM fallback: ${llmCalls.length} calls (${reasons}); ${llmCalls.filter((call) => !call.ok).length} failed; p50 ${percentile(llmCalls.map((call) => call.elapsedMs), 50)} ms  p95 ${percentile(llmCalls.map((call) => call.elapsedMs), 95)} ms`)
}
const wrongChats = rows.filter((row) => row.wrongChat)
console.log(`Wrong chat opened or readied: ${wrongChats.length}${wrongChats.length ? ` (${wrongChats.map((row) => `"${row.say.slice(0, 40)}"`).join(', ')})` : ''}`)
const failures = rows.flatMap((row) => row.trace.calls.filter((call) => !call.ok).map((call) => `${call.reason}${call.status ? ` ${call.status}` : ''}`))
if (failures.length > 0) console.log(`Jev call failures: ${failures.join(', ')}`)
if (misfires.length > 0) {
  console.log('\nMisfires:')
  for (const miss of misfires) {
    const p1 = miss.trace.pass1 ? `pass1 ${miss.trace.pass1.action}@${miss.trace.pass1.actionConfidence.toFixed(2)} (p=${(miss.trace.pass1.actionProbabilities[miss.trace.pass1.action] ?? 0).toFixed(2)} other=${(miss.trace.pass1.actionProbabilities.other ?? 0).toFixed(2)}) list=${miss.trace.pass1.listType} compound=${miss.trace.pass1.compound.toFixed(2)}` : 'pass1 failed'
    const p2 = miss.trace.pass2 ? ` pass2 top=${keyOfThread[miss.trace.pass2.top] ?? miss.trace.pass2.top}@${miss.trace.pass2.topProbability.toFixed(2)} x${Number.isFinite(miss.trace.pass2.ratio) ? miss.trace.pass2.ratio.toFixed(1) : 'inf'}` : ''
    const fb = miss.trace.fallback ? ` llm(${miss.trace.fallback.reason})=${miss.trace.fallback.ok ? `${miss.trace.fallback.provider}:${miss.trace.fallback.steps} steps` : 'failed'}` : ''
    console.log(`  [${miss.journey}] "${miss.say}"\n      ${miss.problems.join('; ')}\n      ${p1}${p2}${fb}${miss.trace.extraction ? ` extraction=${miss.trace.extraction}` : ''}`)
  }
}
