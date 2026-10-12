/**
 * A chat that cannot continue until the user answers a question or an
 * approval. Claude's AskUserQuestion and Codex's request_user_input both
 * arrive as `item/tool/requestUserInput` server requests.
 */
export type InputRequestNotification = {
  /** Push tag and dedupe key. */
  id: string
  requestId: number
  threadId: string
  kind: 'question' | 'approval'
  /** The first question, or what an approval is for. Never a command line. */
  detail: string
  moreQuestions: number
  occurredAt: string
}

const APPROVAL_METHOD = /^item\/(commandExecution|fileChange|permissions)\/requestApproval$/u

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export type InputRequestDetail = Pick<InputRequestNotification, 'kind' | 'detail' | 'moreQuestions'>

/** What a question or approval request asks, or null for any other request. */
export function readInputRequestDetail(method: string, value: unknown): InputRequestDetail | null {
  const params = asRecord(value)
  const approval = APPROVAL_METHOD.test(method)
  if (!approval && method !== 'item/tool/requestUserInput') return null
  if (approval) return { kind: 'approval', detail: readString(params?.title) || readString(params?.reason), moreQuestions: 0 }
  const questions = (Array.isArray(params?.questions) ? params.questions : []).map(asRecord).filter((question) => question !== null)
  const first = questions[0]
  return {
    kind: 'question',
    detail: readString(first?.question) || readString(first?.header),
    moreQuestions: Math.max(0, questions.length - 1),
  }
}

export function readInputRequestNotification(value: unknown, occurredAt: string): InputRequestNotification | null {
  const request = asRecord(value)
  const threadId = readString(asRecord(request?.params)?.threadId)
  const asked = readInputRequestDetail(readString(request?.method), request?.params)
  if (!asked || !Number.isInteger(request?.id) || !threadId) return null
  return {
    id: `input-request:${threadId}:${String(request?.id)}`,
    requestId: Number(request?.id),
    threadId,
    ...asked,
    occurredAt,
  }
}

/** The question itself, with how many more follow it. */
export function inputRequestSummary(asked: InputRequestDetail): string {
  if (!asked.detail) return ''
  const more = asked.moreQuestions > 0
    ? ` (+${String(asked.moreQuestions)} more ${asked.moreQuestions === 1 ? 'question' : 'questions'})`
    : ''
  return `${asked.detail}${more}`
}

export function inputRequestNotificationCopy(event: InputRequestNotification, threadTitle: string): { title: string; body: string } {
  const label = event.kind === 'question' ? 'Answer needed' : 'Approval needed'
  return {
    title: threadTitle.trim() ? `${label} · ${threadTitle.trim()}` : label,
    body: inputRequestSummary(event)
      || (event.kind === 'question' ? 'Your answer is needed to continue.' : 'Your approval is needed to continue.'),
  }
}
