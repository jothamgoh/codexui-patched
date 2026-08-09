import { ref, watch } from 'vue'
import {
  DEFAULT_UI_FONT_SIZE,
  normalizeUiFontSize,
  uiFontScale,
  type UiFontSize,
} from '../utils/uiFontSize'

const UI_FONT_SIZE_STORAGE_KEY = 'codex-web-local.ui-font-size.v1'

function loadUiFontSize(): UiFontSize {
  if (typeof window === 'undefined') return DEFAULT_UI_FONT_SIZE
  return normalizeUiFontSize(window.localStorage.getItem(UI_FONT_SIZE_STORAGE_KEY))
}

function applyUiFontSize(fontSize: UiFontSize): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.uiFontSize = String(fontSize)
  document.documentElement.style.setProperty('--ui-font-scale', String(uiFontScale(fontSize)))
}

export function initializeUiFontSize(): void {
  applyUiFontSize(loadUiFontSize())
}

export function useUiFontSize() {
  const uiFontSize = ref<UiFontSize>(loadUiFontSize())

  watch(
    uiFontSize,
    (value) => {
      const normalized = normalizeUiFontSize(value)
      if (normalized !== value) {
        uiFontSize.value = normalized
        return
      }
      applyUiFontSize(normalized)
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(UI_FONT_SIZE_STORAGE_KEY, String(normalized))
      }
    },
    { immediate: true },
  )

  function setUiFontSize(value: UiFontSize): void {
    uiFontSize.value = normalizeUiFontSize(value)
  }

  return {
    uiFontSize,
    setUiFontSize,
  }
}
