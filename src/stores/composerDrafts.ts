import { defineStore } from 'pinia'
import {
  clearComposerDraft,
  ensureComposerDraft,
  updateComposerResponseAnnotation,
  type ComposerDraftMap,
  type ComposerDraftState,
} from '../utils/composerDrafts'

export const useComposerDraftStore = defineStore('composerDrafts', {
  state: (): { draftsByThreadId: ComposerDraftMap } => ({
    draftsByThreadId: {},
  }),

  actions: {
    draftFor(threadId: string): ComposerDraftState {
      return ensureComposerDraft(this.draftsByThreadId, threadId)
    },

    clearDraft(threadId: string): void {
      clearComposerDraft(this.draftsByThreadId, threadId)
    },

    setDraftText(threadId: string, text: string): void {
      ensureComposerDraft(this.draftsByThreadId, threadId).text = text
    },

    updateResponseAnnotation(threadId: string, annotationId: string, annotation: string): void {
      updateComposerResponseAnnotation(
        this.draftsByThreadId,
        threadId,
        annotationId,
        annotation,
      )
    },
  },
})
