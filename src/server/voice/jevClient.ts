/**
 * Bounded Jev (TypeSafe System One) requests with strict answer validation.
 * Same transport and validation contract as the TypeSafe router used in our other apps (utils/typesafe_router.py):
 * a 1.5 s wall-clock deadline, no retries, and any unusable answer is a failure
 * the caller turns into its fallback. Logs never include the state, the key or
 * the provider's response body.
 */

export const JEV_MODEL = 'jev-1.13.0'
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
export const JEV_TIMEOUT_MS = 1_500
export const MAX_JEV_REQUEST_BYTES = 120_000

export type JevChoiceQuestion = {
  type: 'choice'
  instructions: unknown
  criteria: Record<string, unknown>
}

export type JevNoulQuestion = {
  type: 'noul'
  instructions: unknown
  criteria?: { true: unknown; false: unknown }
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion
export type JevQuestions = Record<string, JevQuestion>

export type JevChoiceAnswer = {
  type: 'choice'
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

export type JevNoulAnswer = {
  type: 'noul'
  noul: number
}

export type JevAnswers<Q extends JevQuestions> = {
  [K in keyof Q]: Q[K] extends JevChoiceQuestion ? JevChoiceAnswer : JevNoulAnswer
}

export type JevFailureReason = 'disabled' | 'too_large' | 'timeout' | 'http_error' | 'network' | 'invalid_response'

export type JevOutcome<Q extends JevQuestions> =
  | { ok: true; answers: JevAnswers<Q>; elapsedMs: number }
  | { ok: false; reason: JevFailureReason; elapsedMs: number; status?: number }

export type JevRequestOptions = {
  apiKey: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  endpoint?: string
}

export class JevValidationError extends Error {}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function sameKeys(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = new Set(Object.keys(right))
  return leftKeys.length === rightKeys.size && leftKeys.every((key) => rightKeys.has(key))
}

function validateChoice(answer: Record<string, unknown>, question: JevChoiceQuestion): JevChoiceAnswer {
  if (answer.type !== 'choice') throw new JevValidationError('Invalid Jev choice')
  const probabilities = asRecord(answer.probabilities)
  const { choice, confidence } = answer
  if (!probabilities || !sameKeys(probabilities, question.criteria) || typeof choice !== 'string' || !(choice in probabilities)) {
    throw new JevValidationError('Unknown or missing Jev choices')
  }
  const values = Object.values(probabilities)
  if (!values.every(isProbability) || !isProbability(confidence)) {
    throw new JevValidationError('Invalid Jev confidence or probabilities')
  }
  // Jev may round to whole percentages; allow the rounding error that implies.
  let tolerance = 0.001
  if (values.every((value) => Math.abs(value * 100 - Math.round(value * 100)) <= 1e-8)) {
    tolerance = Math.max(tolerance, 0.005 * values.length + 1e-8)
  }
  const sum = values.reduce((total, value) => total + value, 0)
  const max = Math.max(...values)
  if (Math.abs(sum - 1) > tolerance || (probabilities[choice] as number) < max - 1e-8) {
    throw new JevValidationError('Invalid Jev probability distribution')
  }
  return { type: 'choice', choice, confidence, probabilities: probabilities as Record<string, number> }
}

function validateNoul(answer: Record<string, unknown>): JevNoulAnswer {
  if (answer.type !== 'noul' || !isProbability(answer.noul)) throw new JevValidationError('Invalid Jev noul')
  return { type: 'noul', noul: answer.noul }
}

/** Throws JevValidationError unless every answer is complete and well formed. */
export function validateJevAnswers<Q extends JevQuestions>(payload: unknown, questions: Q): JevAnswers<Q> {
  const record = asRecord(payload)
  if (!record || record.model !== JEV_MODEL) throw new JevValidationError('Unexpected Jev response model')
  const answers = asRecord(record.answers)
  if (!answers || !sameKeys(answers, questions)) throw new JevValidationError('Incomplete Jev answers')
  const result: Record<string, JevChoiceAnswer | JevNoulAnswer> = {}
  for (const [name, question] of Object.entries(questions)) {
    const answer = asRecord(answers[name])
    if (!answer) throw new JevValidationError('Invalid Jev answer')
    result[name] = question.type === 'choice' ? validateChoice(answer, question) : validateNoul(answer)
  }
  return result as JevAnswers<Q>
}

/** Top probability and its ratio to the runner-up, for gating a Choice. */
export function choiceMargin(answer: JevChoiceAnswer): { top: string; topProbability: number; ratio: number; ranked: Array<[string, number]> } {
  const ranked = Object.entries(answer.probabilities).sort((left, right) => right[1] - left[1])
  const [top, topProbability] = ranked[0] ?? ['', 0]
  const second = ranked[1]?.[1] ?? 0
  return { top, topProbability, ratio: second > 0 ? topProbability / second : Number.POSITIVE_INFINITY, ranked }
}

export async function askJev<Q extends JevQuestions>(
  questions: Q,
  state: unknown,
  options: JevRequestOptions,
): Promise<JevOutcome<Q>> {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  if (!options.apiKey) return { ok: false, reason: 'disabled', elapsedMs: 0 }
  const body = JSON.stringify({ model: JEV_MODEL, state, questions })
  if (Buffer.byteLength(body) > MAX_JEV_REQUEST_BYTES) return { ok: false, reason: 'too_large', elapsedMs: elapsed() }

  const controller = new AbortController()
  // One deadline covers connecting and reading the whole body. No retries.
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? JEV_TIMEOUT_MS)
  try {
    const response = await (options.fetchImpl ?? fetch)(options.endpoint ?? JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body,
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      return { ok: false, reason: 'http_error', status: response.status, elapsedMs: elapsed() }
    }
    const payload = await response.json() as unknown
    return { ok: true, answers: validateJevAnswers(payload, questions), elapsedMs: elapsed() }
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, reason: 'timeout', elapsedMs: elapsed() }
    if (error instanceof JevValidationError || error instanceof SyntaxError) return { ok: false, reason: 'invalid_response', elapsedMs: elapsed() }
    return { ok: false, reason: 'network', elapsedMs: elapsed() }
  } finally {
    clearTimeout(timer)
  }
}
