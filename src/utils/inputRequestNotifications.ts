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

export function readInputRequestNotification(value: unknown, occurredAt: string): InputRequestNotification | null {
  const request = asRecord(value)
  const params = asRecord(request?.params)
  const method = readString(request?.method)
  const approval = APPROVAL_METHOD.test(method)
  if (!approval && method !== 'item/tool/requestUserInput') return null
  const threadId = readString(params?.threadId)
  if (!Number.isInteger(request?.id) || !threadId) return null
  const questions = (Array.isArray(params?.questions) ? params.questions : []).map(asRecord).filter((question) => question !== null)
  const first = questions[0]
  return {
    id: `input-request:${threadId}:${String(request?.id)}`,
    requestId: Number(request?.id),
    threadId,
    kind: approval ? 'approval' : 'question',
    detail: approval
      ? readString(params?.title) || readString(params?.reason)
      : readString(first?.question) || readString(first?.header),
    moreQuestions: approval ? 0 : Math.max(0, questions.length - 1),
    occurredAt,
  }
}

export function inputRequestNotificationCopy(event: InputRequestNotification, threadTitle: string): { title: string; body: string } {
  const label = event.kind === 'question' ? 'Answer needed' : 'Approval needed'
  const more = event.moreQuestions > 0
    ? ` (+${String(event.moreQuestions)} more ${event.moreQuestions === 1 ? 'question' : 'questions'})`
    : ''
  return {
    title: threadTitle.trim() ? `${label} · ${threadTitle.trim()}` : label,
    body: event.detail
      ? `${event.detail}${more}`
      : event.kind === 'question' ? 'Your answer is needed to continue.' : 'Your approval is needed to continue.',
  }
}
