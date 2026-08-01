import { ref } from 'vue'
import type { ResponseTextAnnotation } from '../types/codex'

const responseTextAnnotations = ref<ResponseTextAnnotation[]>([])

export function useResponseAnnotations() {
  function updateResponseAnnotation(annotationId: string, annotation: string): void {
    const normalizedAnnotation = annotation.trim()
    responseTextAnnotations.value = responseTextAnnotations.value.map((item) =>
      item.id === annotationId
        ? {
            ...item,
            ...(normalizedAnnotation ? { annotation: normalizedAnnotation } : { annotation: undefined }),
          }
        : item,
    )
  }

  return {
    responseTextAnnotations,
    updateResponseAnnotation,
  }
}
