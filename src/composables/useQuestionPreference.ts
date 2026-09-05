import { readonly, ref } from 'vue'
import { rpcCall } from '../api/codexRpcClient'
import { canConfigureQuestionFeature, QUESTION_FEATURE, QUESTION_PREFERENCE_KEY, readQuestionPreference } from '../utils/questionPreference'

function loadPreference(): boolean {
  try { return readQuestionPreference(localStorage.getItem(QUESTION_PREFERENCE_KEY)) } catch { return true }
}

const available = ref(false)
const enabled = ref(loadPreference())
const error = ref('')
let capabilityRequest: Promise<boolean> | null = null

async function refreshAvailability(): Promise<boolean> {
  enabled.value = loadPreference()
  if (capabilityRequest) return capabilityRequest
  capabilityRequest = (async () => {
    try {
      const requirements = await rpcCall('configRequirements/read', {})
      const seenCursors = new Set<string>()
      let cursor: string | null = null
      do {
        const page: { data?: Array<{ name?: string }>; nextCursor?: string | null } = await rpcCall('experimentalFeature/list', { limit: 200, ...(cursor ? { cursor } : {}) })
        const feature = page.data?.find((row) => row.name === QUESTION_FEATURE)
        if (feature) return available.value = canConfigureQuestionFeature(feature, requirements)
        cursor = page.nextCursor ?? null
        if (cursor && seenCursors.has(cursor)) break
        if (cursor) seenCursors.add(cursor)
      } while (cursor)
    } catch {
      // Older runtimes keep their own defaults and do not receive an unknown override.
    }
    return available.value = false
  })()
  try { return await capabilityRequest } finally { capabilityRequest = null }
}

function setEnabled(value: boolean): void {
  if (!available.value) return
  try {
    localStorage.setItem(QUESTION_PREFERENCE_KEY, String(value))
    enabled.value = value
    error.value = ''
  } catch {
    error.value = 'Could not save the question setting for this browser.'
  }
}

export function useQuestionPreference() {
  return { available: readonly(available), enabled: readonly(enabled), error: readonly(error), refreshAvailability, setEnabled }
}

export async function getNewChatQuestionConfig(): Promise<Record<string, boolean> | undefined> {
  if (!await refreshAvailability()) return undefined
  enabled.value = loadPreference()
  return { [`features.${QUESTION_FEATURE}`]: enabled.value }
}
