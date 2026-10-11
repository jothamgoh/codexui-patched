#!/usr/bin/env node
// Live evaluation of the voice router against real Jev. Not part of `npm test`:
// it spends TypeSafe credit (and Anthropic tokens when a rule cannot cut a message).
//
//   node scripts/voice-eval.mjs --env-file ~/.config/codexui/.env [--set tuning|holdout|fresh|all] [--shuffle] [--repeat N] [--only <journey>] [--json]
//
// Uses the fictional chats and labelled phrases in tests/fixtures/voicePhrases.mjs.
// Prints accuracy per journey, every misfire, and p50/p95 latency per Jev call
// and per command. Never prints keys or response bodies.
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { CHATS, FRESH_PHRASES, HOLDOUT_PHRASES, PHRASES, buildContext } from '../tests/fixtures/voicePhrases.mjs'

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

function grade(result, phrase) {
  const { expect } = phrase
  const problems = []
  if (result.outcome !== expect.outcome) problems.push(`outcome ${result.outcome} (want ${expect.outcome})`)
  if (expect.reason && result.reason !== expect.reason) problems.push(`reason ${result.reason} (want ${expect.reason})`)
  if (expect.listType && result.listType !== expect.listType) problems.push(`list ${result.listType} (want ${expect.listType})`)
  if (expect.chat && result.threadId !== CHATS[expect.chat].threadId) problems.push(`chat ${keyOfThread[result.threadId] ?? result.threadId ?? '-'} (want ${expect.chat})`)
  if (expect.picker && result.outcome === 'picker') {
    const offered = new Set(result.candidates.map((row) => keyOfThread[row.threadId]))
    const missing = expect.picker.filter((key) => !offered.has(key))
    if (missing.length > 0) problems.push(`picker misses ${missing.join(', ')}`)
  }
  if ('message' in expect && (result.message ?? '') !== expect.message && result.outcome === expect.outcome) problems.push(`message "${result.message ?? ''}" (want "${expect.message}")`)
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
const source = { tuning: PHRASES, holdout: HOLDOUT_PHRASES, fresh: FRESH_PHRASES, all: [...PHRASES, ...HOLDOUT_PHRASES, ...FRESH_PHRASES] }[set] ?? PHRASES
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
    rows.push({ say: phrase.say, journey: phrase.journey, outcome: result.outcome, reason: result.reason, problems, trace })
    if (problems.length > 0) misfires.push({ say: phrase.say, journey: phrase.journey, problems, trace })
  }
}

if (flag('--json')) {
  console.log(JSON.stringify({ byJourney: Object.fromEntries(byJourney), misfires, rows, callLatencies, commandLatencies }, null, 2))
  process.exit(0)
}

const names = { 1: 'open (clear)', 2: 'open (close call)', 3: 'lists', 4: 'send', 5: 'new chat', 6: 'not understood' }
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
const failures = rows.flatMap((row) => row.trace.calls.filter((call) => !call.ok).map((call) => `${call.reason}${call.status ? ` ${call.status}` : ''}`))
if (failures.length > 0) console.log(`Jev call failures: ${failures.join(', ')}`)
if (misfires.length > 0) {
  console.log('\nMisfires:')
  for (const miss of misfires) {
    const p1 = miss.trace.pass1 ? `pass1 ${miss.trace.pass1.action}@${miss.trace.pass1.actionConfidence.toFixed(2)} list=${miss.trace.pass1.listType} compound=${miss.trace.pass1.compound.toFixed(2)}` : 'pass1 failed'
    const p2 = miss.trace.pass2 ? ` pass2 top=${keyOfThread[miss.trace.pass2.top] ?? miss.trace.pass2.top}@${miss.trace.pass2.topProbability.toFixed(2)} x${Number.isFinite(miss.trace.pass2.ratio) ? miss.trace.pass2.ratio.toFixed(1) : 'inf'}` : ''
    console.log(`  [${miss.journey}] "${miss.say}"\n      ${miss.problems.join('; ')}\n      ${p1}${p2}${miss.trace.extraction ? ` extraction=${miss.trace.extraction}` : ''}`)
  }
}
