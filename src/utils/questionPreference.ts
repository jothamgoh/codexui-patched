export const QUESTION_FEATURE = 'default_mode_request_user_input'
export const QUESTION_PREFERENCE_KEY = 'codex-web-local.new-chat-questions.v1'

export function readQuestionPreference(value: string | null): boolean {
  return value !== 'false'
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

export function canConfigureQuestionFeature(feature: unknown, requirementsResponse: unknown): boolean {
  const row = record(feature)
  if (row?.name !== QUESTION_FEATURE || row.stage === 'removed' || row.stage === 'deprecated') return false
  const response = record(requirementsResponse)
  if (!response || !Object.prototype.hasOwnProperty.call(response, 'requirements')) return false
  if (response.requirements !== null && !record(response.requirements)) return false
  const requirements = record(response.requirements)
  const featureRequirements = record(requirements?.featureRequirements)
  // A managed value is fixed, so offering either position of a switch would mislead.
  return !featureRequirements || !Object.prototype.hasOwnProperty.call(featureRequirements, QUESTION_FEATURE)
}
