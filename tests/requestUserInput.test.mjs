import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/api/requestUserInput.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
const moduleUnderTest = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const { readRequestQuestions, requestQuestionAnswerValues, normalizeAsyncQuestions, encodeAsyncQuestionReply, readAsyncQuestionReplies } = moduleUnderTest

test('native async questions preserve source indices and support legacy free-text messages', () => {
  const item = { id: 'question-call', delivery: 'async', text: 'Fallback', questions: [null, { title: 'Choose an approach', options: ['Small', null, 'Large'] }] }
  assert.deepEqual(normalizeAsyncQuestions(item), [{ id: JSON.stringify(['request_user_input_async', 'question-call', 1]), title: 'Choose an approach', options: ['Small', 'Large'] }])
  assert.equal(normalizeAsyncQuestions({ ...item, delivery: null }), undefined)
  assert.deepEqual(normalizeAsyncQuestions({ id: 'legacy', delivery: 'async', text: 'Anything else?' }), [{ id: 'legacy', title: 'Anything else?', options: [] }])
})

test('async answer envelopes round-trip native IDs and cannot mistake ordinary prose for a reply', () => {
  const question = { id: '["request_user_input_async","call",0]', title: 'Which "approach"?\nDetails?', options: [] }
  const text = encodeAsyncQuestionReply(question, '  First line\nSecond line  ')
  assert.deepEqual(readAsyncQuestionReplies(text), [{ questionItemId: question.id, question: question.title, answer: 'First line\nSecond line' }])
  assert.deepEqual(readAsyncQuestionReplies(`Here is an example:\n${text}`), [])
  assert.deepEqual(readAsyncQuestionReplies('<send_user_message_question_reply>invalid</send_user_message_question_reply>'), [])
})

test('retains question descriptions, free-text and secret input protocol fields', () => {
  const questions = readRequestQuestions({ questions: [
    { id: 'choice', header: 'Approach', question: 'Which approach?', isOther: true, options: [{ label: 'Small fix (Recommended)', description: 'Keeps the change focused.' }] },
    { id: 'free', question: 'Anything else?', options: null },
    { id: 'secret', question: 'Enter the secret', isSecret: true, options: null },
  ] })
  assert.equal(questions[0].options[0].description, 'Keeps the change focused.')
  assert.equal(questions[0].isOther, true)
  assert.deepEqual(questions[1].options, [])
  assert.equal(questions[2].isSecret, true)
})

test('does not silently select the first option, or send a stale Other answer alongside a choice', () => {
  const [question] = readRequestQuestions({ questions: [{ id: 'choice', isOther: true, options: [{ label: 'Small fix (Recommended)' }, { label: 'Broader change' }] }] })
  assert.deepEqual(requestQuestionAnswerValues(question), [])
  assert.deepEqual(requestQuestionAnswerValues(question, { choice: null, text: '' }), [])
  assert.deepEqual(requestQuestionAnswerValues(question, { choice: 0, text: 'An old custom answer' }), ['Small fix (Recommended)'])
  assert.deepEqual(requestQuestionAnswerValues(question, { choice: -1, text: '  My answer  ' }), ['My answer'])
  assert.deepEqual(requestQuestionAnswerValues(question, { choice: -1, text: '  ' }), [])
})

test('accepts free-text-only questions and ignores malformed rows', () => {
  const [question] = readRequestQuestions({ questions: [null, { id: '' }, { id: 'free', options: null }] })
  assert.deepEqual(requestQuestionAnswerValues(question, { choice: null, text: 'Keep this instruction.' }), ['Keep this instruction.'])
  assert.deepEqual(readRequestQuestions(null), [])
})

test('a multi-select question sends every picked option, in option order, plus an Other answer', () => {
  const [question] = readRequestQuestions({ questions: [{ id: 'q0', question: 'Which should I clear?', isOther: true, multiSelect: true, options: [
    { label: 'Old worktrees', description: '', preview: '  ├─ a\n  └─ b' },
    { label: 'Caches' },
    { label: 'Logs' },
  ] }] })
  assert.equal(question.multiSelect, true)
  assert.equal(question.options[0].preview, '  ├─ a\n  └─ b', 'previews keep their leading whitespace')
  assert.equal(question.options[1].preview, '')
  assert.deepEqual(requestQuestionAnswerValues(question, { choice: null, choices: [], text: '' }), [])
  assert.deepEqual(requestQuestionAnswerValues(question, { choice: null, choices: [2, 0], text: 'stale text' }), ['Old worktrees', 'Logs'])
  assert.deepEqual(requestQuestionAnswerValues(question, { choice: null, choices: [1, -1], text: '  Downloads  ' }), ['Caches', 'Downloads'])
  assert.deepEqual(requestQuestionAnswerValues(question, { choice: null, choices: [-1], text: ' ' }), [], 'an empty Other is not an answer')
  const [single] = readRequestQuestions({ questions: [{ id: 'q1', options: [{ label: 'Yes' }] }] })
  assert.equal(single.multiSelect, false)
})

test('reads when an agent carries on without an answer, and nothing when it waits', () => {
  const { readRequestDeadline } = moduleUnderTest
  assert.equal(readRequestDeadline({ expiresAtIso: '2026-10-12T12:52:00.000Z' })?.toISOString(), '2026-10-12T12:52:00.000Z')
  assert.equal(readRequestDeadline({ questions: [] }), null)
  assert.equal(readRequestDeadline({ expiresAtIso: 'soon' }), null)
})
