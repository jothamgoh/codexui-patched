import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'esbuild'

const run = promisify(execFile)
const compiled = await build({ entryPoints: [new URL('../src/server/projectBoardPlanning.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' })
// Import-meta asset location needs a file URL, like the deployed server.
const temporary = await mkdtemp(join(tmpdir(), 'codexui-board-planning-tests-'))
await writeFile(join(temporary, 'planning.mjs'), compiled.outputFiles[0].text)
const { boardPlanningContext, withBoardPlanningContext } = await import(`file://${temporary}/planning.mjs`)
test.after(() => rm(temporary, { recursive: true, force: true }))

test('optional planning context preserves ordinary turn settings and existing application context', () => {
  const params = { threadId: 'current-chat', input: [{ type: 'text', text: 'Fix a typo' }], model: 'chosen-model', effort: 'medium', additionalContext: { original: { kind: 'application', value: 'Retain this' } } }
  const augmented = withBoardPlanningContext(params, 12345)
  assert.equal(augmented.input, params.input)
  assert.equal(augmented.model, params.model)
  assert.equal(augmented.effort, params.effort)
  assert.deepEqual(augmented.additionalContext.original, params.additionalContext.original)
  assert.equal(augmented.additionalContext.codexui_optional_board_planning.kind, 'application')
  assert.equal(Object.keys(params.additionalContext).length, 1, 'Does not mutate the request')
  assert.equal(withBoardPlanningContext(params, undefined), params)
})

test('compact planning reads stay in the source project and expand only requested feature details', () => {
  const card = { id: 'a', boardId: 'one', type: 'feature', status: 'backlog', description: 'x'.repeat(1000), acceptanceCriteria: 'y'.repeat(900), summary: '', dependencyIds: [], threadId: '', lastRunId: '' }
  const snapshot = { version: 9, boards: [{ id: 'one', name: 'One', projectPath: '/project', sourceThreadId: 'chat', agentIds: ['lead'], plan: 'Reviewed scope' }, { id: 'foreign', projectPath: '/elsewhere', sourceThreadId: 'chat' }], cards: [card], agents: [{ id: 'lead', instructions: 'Lengthy private instructions' }, { id: 'disabled' }], questions: [], artifacts: [] }
  const context = boardPlanningContext(snapshot, '/project', 'chat')
  assert.equal(context.board.id, 'one')
  assert.equal(context.features[0].description, undefined)
  assert.equal(context.features[0].editableDraft, true)
  card.lastRunId = 'board-plan-run'
  snapshot.runs = [{ id: 'board-plan-run', cardId: '', kind: 'board_plan' }]
  assert.equal(boardPlanningContext(snapshot, '/project', 'chat').features[0].editableDraft, true, 'A board planner receipt is not feature execution')
  snapshot.runs.push({ id: 'feature-plan-run', cardId: card.id, kind: 'plan' })
  assert.equal(boardPlanningContext(snapshot, '/project', 'chat').features[0].editableDraft, false)
  assert.equal(context.agents.length, 1)
  assert.ok(!('instructions' in context.agents[0]))
  assert.deepEqual(context.boards.map(board => board.id), ['one'])
  assert.equal(boardPlanningContext(snapshot, '/project', 'chat', 'one', 'a').feature.description, card.description)
  snapshot.cards.push({ id: 'task-a', boardId: 'one', type: 'task', parentCardId: 'a' })
  snapshot.questions.push({ id: 'needs-answer', cardId: 'task-a', status: 'open' }, { id: 'elsewhere', cardId: 'other', status: 'open' })
  assert.deepEqual(boardPlanningContext(snapshot, '/project', 'chat', 'one', 'a').questions.map(question => question.id), ['needs-answer'])
  assert.throws(() => boardPlanningContext(snapshot, '/project', 'chat', 'foreign'), /this chat/u)
  assert.throws(() => boardPlanningContext(snapshot, '/project', 'chat', 'one', 'missing'), /this board/u)
  snapshot.boards.push({ ...snapshot.boards[0], id: 'two' })
  assert.equal(boardPlanningContext(snapshot, '/project', 'chat').board, null, 'Multiple linked boards require an explicit choice')
  const otherChat = boardPlanningContext(snapshot, '/project', 'another-chat')
  assert.deepEqual(otherChat.boards.map(board => board.id), ['one', 'two'], 'Any chat in the folder can discover its independent boards')
  assert.equal(otherChat.board, null, 'An unrelated chat must not silently reuse the default board')
  assert.equal(boardPlanningContext(snapshot, '/project', 'another-chat', 'two').board.id, 'two', 'The user can name an existing board from another chat')
  snapshot.cards = Array.from({ length: 65 }, (_, index) => ({ ...card, id: `card-${index}` }))
  snapshot.boards[0].plan = 'z'.repeat(10_000)
  const firstPage = boardPlanningContext(snapshot, '/project', 'chat', 'one')
  assert.equal(firstPage.features.length, 30)
  assert.equal(firstPage.nextOffset, 30)
  assert.equal(firstPage.board.summaryTruncated, true)
  const lastPage = boardPlanningContext(snapshot, '/project', 'chat', 'one', '', { offset: 60, fullPlan: true })
  assert.equal(lastPage.features.length, 5)
  assert.equal(lastPage.nextOffset, null)
  assert.equal(lastPage.board.summary.length, 10_000)
})

test('bundled helper reads and saves exact chat identity, rejects unsupported actions, and preserves failed-save input', async (t) => {
  const requests = []
  let rejectSave = false
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const part of req) raw += part
    requests.push({ url: req.url, method: req.method, body: raw ? JSON.parse(raw) : null })
    res.writeHead(rejectSave ? 409 : 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(rejectSave ? { error: 'Board changed; read the current version.' } : { data: { version: 7 } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const script = new URL('../skills/codexui-board-planning/scripts/board.mjs', import.meta.url).pathname
  const connection = ['--url', `http://127.0.0.1:${server.address().port}`, '--thread', 'source-chat']
  assert.equal(JSON.parse((await run(process.execPath, [script, ...connection, 'context', '--board', 'one'])).stdout).version, 7)
  assert.match(requests[0].url, /sourceThreadId=source-chat&boardId=one/u)
  const draft = join(temporary, 'draft.json')
  const text = JSON.stringify({ boardId: 'stable-board', features: [{ id: 'stable-card' }], sourceThreadId: 'wrong' })
  await writeFile(draft, text)
  await run(process.execPath, [script, ...connection, 'save', '--file', draft])
  assert.equal(requests[1].body.sourceThreadId, 'source-chat')
  assert.equal(requests[1].body.features[0].id, 'stable-card')
  rejectSave = true
  await assert.rejects(run(process.execPath, [script, ...connection, 'save', '--file', draft]), error => error.stderr.includes('Board changed') && error.stderr.includes('same IDs'))
  assert.equal(await readFile(draft, 'utf8'), text)
  const before = requests.length
  await assert.rejects(run(process.execPath, [script, ...connection, 'run']))
  await assert.rejects(run(process.execPath, [script, '--url', 'https://example.com', '--thread', 'source', 'context']))
  assert.equal(requests.length, before)
})
