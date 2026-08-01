import type {
  FileAttachmentParam,
  PluginMentionParam,
  ThreadMentionParam,
} from '../api/codexGateway'
import type { ResponseTextAnnotation } from '../types/codex'

export type ComposerSelectedImage = {
  id: string
  name: string
  url: string
}

export type ComposerSelectedSkill = {
  name: string
  description: string
  path: string
}

export type ComposerDraftState = {
  text: string
  selectedImages: ComposerSelectedImage[]
  selectedSkills: ComposerSelectedSkill[]
  selectedPlugins: PluginMentionParam[]
  selectedThreads: ThreadMentionParam[]
  fileAttachments: FileAttachmentParam[]
  mentionedFilePaths: string[]
  responseTextAnnotations: ResponseTextAnnotation[]
}

export type ComposerDraftMap = Record<string, ComposerDraftState>

export function normalizeComposerDraftKey(threadId: string): string {
  return threadId.trim() || '__inactive-thread__'
}

export function createEmptyComposerDraft(): ComposerDraftState {
  return {
    text: '',
    selectedImages: [],
    selectedSkills: [],
    selectedPlugins: [],
    selectedThreads: [],
    fileAttachments: [],
    mentionedFilePaths: [],
    responseTextAnnotations: [],
  }
}

export function ensureComposerDraft(
  draftsByThreadId: ComposerDraftMap,
  threadId: string,
): ComposerDraftState {
  const key = normalizeComposerDraftKey(threadId)
  const existing = draftsByThreadId[key]
  if (existing) return existing

  const created = createEmptyComposerDraft()
  draftsByThreadId[key] = created
  return created
}

export function clearComposerDraft(
  draftsByThreadId: ComposerDraftMap,
  threadId: string,
): ComposerDraftState {
  const cleared = createEmptyComposerDraft()
  draftsByThreadId[normalizeComposerDraftKey(threadId)] = cleared
  return cleared
}

export function updateComposerResponseAnnotation(
  draftsByThreadId: ComposerDraftMap,
  threadId: string,
  annotationId: string,
  annotation: string,
): void {
  const normalizedAnnotation = annotation.trim()
  const draft = ensureComposerDraft(draftsByThreadId, threadId)
  draft.responseTextAnnotations = draft.responseTextAnnotations.map((item) =>
    item.id === annotationId
      ? {
          ...item,
          ...(normalizedAnnotation ? { annotation: normalizedAnnotation } : { annotation: undefined }),
        }
      : item,
  )
}
