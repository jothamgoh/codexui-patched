import { canConfigureQuestionFeature, QUESTION_FEATURE } from '../utils/questionPreference'

type Rpc = (method: string, params: unknown) => Promise<unknown>
type FeaturePage = { data?: Array<{ name?: string } | null>; nextCursor?: unknown }

/** Board Leads can ask native questions when the runtime permits this feature. */
export async function readProjectBoardQuestionConfig(rpc: Rpc): Promise<Record<string, boolean> | undefined> {
  try {
    const requirements = await rpc('configRequirements/read', {})
    const seenCursors = new Set<string>()
    let cursor = ''
    do {
      const page = await rpc('experimentalFeature/list', { limit: 200, ...(cursor ? { cursor } : {}) }) as FeaturePage | null
      const feature = Array.isArray(page?.data) ? page.data.find((row) => row?.name === QUESTION_FEATURE) : undefined
      if (feature) {
        return canConfigureQuestionFeature(feature, requirements)
          ? { [`features.${QUESTION_FEATURE}`]: true }
          : undefined
      }
      cursor = typeof page?.nextCursor === 'string' ? page.nextCursor : ''
      if (cursor && seenCursors.has(cursor)) break
      if (cursor) seenCursors.add(cursor)
    } while (cursor)
  } catch {
    // Older or managed runtimes retain their defaults; the durable board question remains available.
  }
  return undefined
}
