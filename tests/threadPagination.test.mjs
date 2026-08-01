import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const sourceUrl = new URL('../src/server/threadPagination.ts', import.meta.url)
const source = await readFile(sourceUrl, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
const {
  MAX_THREAD_PAGE_SIZE,
  paginateThreadReadResult,
  stripThreadTurnsFromResumeResult,
} = await import(moduleUrl)

function makeThread(turnCount) {
  return {
    thread: {
      id: 'thread-1',
      turns: Array.from({ length: turnCount }, (_, index) => ({ id: `turn-${index}` })),
    },
  }
}

test('returns the latest turns and absolute page metadata by default', () => {
  const result = paginateThreadReadResult(makeThread(45))
  assert.deepEqual(
    result.thread.turns.map((turn) => turn.id),
    Array.from({ length: 20 }, (_, index) => `turn-${index + 25}`),
  )
  assert.deepEqual(result.page, {
    startTurnIndex: 25,
    endTurnIndex: 45,
    totalTurns: 45,
    hasEarlier: true,
  })
})

test('returns an earlier page ending at the supplied absolute turn index', () => {
  const result = paginateThreadReadResult(makeThread(45), {
    beforeTurnIndex: 25,
    limit: 10,
  })
  assert.equal(result.thread.turns[0].id, 'turn-15')
  assert.equal(result.thread.turns.at(-1).id, 'turn-24')
  assert.deepEqual(result.page, {
    startTurnIndex: 15,
    endTurnIndex: 25,
    totalTurns: 45,
    hasEarlier: true,
  })
})

test('clamps malformed cursors and oversized pages safely', () => {
  const result = paginateThreadReadResult(makeThread(75), {
    beforeTurnIndex: 10_000,
    limit: 10_000,
  })
  assert.equal(result.thread.turns.length, MAX_THREAD_PAGE_SIZE)
  assert.equal(result.thread.turns[0].id, 'turn-25')
  assert.equal(result.thread.turns.at(-1).id, 'turn-74')
})

test('removes historical turns from thread resume responses', () => {
  const result = stripThreadTurnsFromResumeResult({
    model: 'gpt-5',
    thread: {
      id: 'thread-1',
      turns: [{ id: 'turn-1' }],
    },
  })
  assert.deepEqual(result, {
    model: 'gpt-5',
    thread: {
      id: 'thread-1',
      turns: [],
    },
  })
})
