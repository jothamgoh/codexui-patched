import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/api/requestUserInput.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
const { readRequestQuestions, requestQuestionAnswerValues } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

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
