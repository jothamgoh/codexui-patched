import type { AskedQuestionsData, UiMessage } from '../types/codex'

export type RequestQuestion = {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  /** Claude's AskUserQuestion can let the user pick several options. */
  multiSelect: boolean
  /** `preview` is a mockup or code sample Claude attached to an option. */
  options: Array<{ label: string; description: string; preview: string }>
}

/**
 * `choice` is the picked option of a single-choice question and `choices` every
 * pick of a multi-select one; -1 stands for Other, answered in `text`.
 */
export type RequestQuestionAnswer = { choice: number | null; choices?: number[]; text: string }
export type RequestQuestionDraft = { index: number; answers: Map<string, RequestQuestionAnswer> }

export type AsyncQuestion = { id: string; title: string; options: string[] }
export type AsyncQuestionReply = { questionItemId: string; question: string; answer: string }
export type AsyncQuestionDraft = { choice: number; text: string; sending: boolean; dictating: boolean; error: string; sent?: string }

/** Native async questions arrive as assistant items, not blocking server requests. */
export function normalizeAsyncQuestions(item: Record<string, unknown>): AsyncQuestion[] | undefined {
  if (item.delivery !== 'async' || typeof item.id !== 'string') return undefined
  if (Array.isArray(item.questions) && item.questions.length) {
    return item.questions.flatMap((value, index) => {
      const question = record(value)
      if (typeof question?.title !== 'string' || !question.title.trim()) return []
      return [{ id: JSON.stringify(['request_user_input_async', item.id, index]), title: question.title,
        options: Array.isArray(question.options) ? question.options.filter((option): option is string => typeof option === 'string' && Boolean(option.trim())) : [] }]
    })
  }
  return typeof item.text === 'string' && item.text.trim() ? [{ id: item.id, title: item.text, options: [] }] : []
}

const ASYNC_REPLY_START = '<send_user_message_question_reply>'
const ASYNC_REPLY_END = '</send_user_message_question_reply>'

export function encodeAsyncQuestionReply(question: AsyncQuestion, answer: string): string {
  return `${ASYNC_REPLY_START}\n${JSON.stringify([{ questionItemId: question.id, question: question.title, answer: answer.trim() }])}\n${ASYNC_REPLY_END}`
}

export function readAsyncQuestionReplies(text: string): AsyncQuestionReply[] {
  const value = text.trim()
  if (!value.startsWith(ASYNC_REPLY_START) || !value.endsWith(ASYNC_REPLY_END)) return []
  try {
    const parsed: unknown = JSON.parse(value.slice(ASYNC_REPLY_START.length, -ASYNC_REPLY_END.length))
    return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((value) => {
      const row = record(value)
      return typeof row?.questionItemId === 'string' && typeof row.question === 'string' && typeof row.answer === 'string'
        ? [{ questionItemId: row.questionItemId, question: row.question, answer: row.answer }] : []
    })
  } catch { return [] }
}

/**
 * Claude's questions with the answers it got, from an `askedQuestions` item.
 * Shared by persisted items and item/started + item/completed notifications.
 */
export function normalizeAskedQuestions(item: Record<string, unknown>): UiMessage | null {
  if (item.type !== 'askedQuestions' || typeof item.id !== 'string' || !item.id) return null
  const questions = (Array.isArray(item.questions) ? item.questions : []).flatMap((value) => {
    const row = record(value)
    if (typeof row?.question !== 'string' || !row.question.trim()) return []
    return [{
      header: typeof row.header === 'string' ? row.header : '',
      question: row.question,
      answer: typeof row.answer === 'string' ? row.answer : '',
    }]
  })
  const status: AskedQuestionsData['status'] = item.status === 'completed' ? 'answered' : item.status === 'failed' ? 'unanswered' : 'waiting'
  return {
    id: item.id,
    role: 'system',
    text: questions.map(({ question, answer }) => (answer ? `${question}\n${answer}` : question)).join('\n\n'),
    messageType: 'askedQuestions',
    askedQuestions: { status, questions },
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

export function readRequestQuestions(params: unknown): RequestQuestion[] {
  const questions = record(params)?.questions
  if (!Array.isArray(questions)) return []
  return questions.flatMap((value) => {
    const question = record(value)
    if (typeof question?.id !== 'string' || !question.id) return []
    return [{
      id: question.id,
      header: typeof question.header === 'string' ? question.header : '',
      question: typeof question.question === 'string' ? question.question : '',
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      multiSelect: question.multiSelect === true,
      options: Array.isArray(question.options) ? question.options.flatMap((value) => {
        const option = record(value)
        return typeof option?.label === 'string' && option.label
          ? [{
            label: option.label,
            description: typeof option.description === 'string' ? option.description : '',
            preview: typeof option.preview === 'string' ? option.preview : '',
          }]
          : []
      }) : [],
    }]
  })
}

/** When the agent carries on without an answer, or null when it waits indefinitely. */
export function readRequestDeadline(params: unknown): Date | null {
  const value = record(params)?.expiresAtIso
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(time) ? new Date(time) : null
}

export function requestQuestionAnswerValues(question: RequestQuestion, answer?: RequestQuestionAnswer): string[] {
  if (!answer) return []
  const text = answer.text.trim()
  if (question.multiSelect && question.options.length > 0) {
    const picks = answer.choices ?? []
    const labels = question.options.flatMap((option, index) => picks.includes(index) ? [option.label] : [])
    return question.isOther && picks.includes(-1) && text ? [...labels, text] : labels
  }
  if (question.options.length === 0 || (question.isOther && answer.choice === -1)) {
    return text ? [text] : []
  }
  const option = answer.choice === null ? undefined : question.options[answer.choice]
  return option ? [option.label] : []
}
