export type RequestQuestion = {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: Array<{ label: string; description: string }>
}

export type RequestQuestionAnswer = { choice: number | null; text: string }
export type RequestQuestionDraft = { index: number; answers: Map<string, RequestQuestionAnswer> }

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
      options: Array.isArray(question.options) ? question.options.flatMap((value) => {
        const option = record(value)
        return typeof option?.label === 'string' && option.label
          ? [{ label: option.label, description: typeof option.description === 'string' ? option.description : '' }]
          : []
      }) : [],
    }]
  })
}

export function requestQuestionAnswerValues(question: RequestQuestion, answer?: RequestQuestionAnswer): string[] {
  if (!answer) return []
  if (question.options.length === 0 || (question.isOther && answer.choice === -1)) {
    const text = answer.text.trim()
    return text ? [text] : []
  }
  const option = answer.choice === null ? undefined : question.options[answer.choice]
  return option ? [option.label] : []
}
