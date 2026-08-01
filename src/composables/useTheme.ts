import { computed, ref, watch } from 'vue'

export type ThemePreference = 'light' | 'dark'

const THEME_STORAGE_KEY = 'codex-web-local.theme.v1'
const THEME_COLORS: Record<ThemePreference, string> = {
  light: '#ffffff',
  dark: '#181820',
}

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark'
}

function getSystemTheme(): ThemePreference {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function loadThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'light'
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return isThemePreference(stored) ? stored : getSystemTheme()
}

function applyTheme(theme: ThemePreference): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme])
}

export function initializeTheme(): void {
  applyTheme(loadThemePreference())
}

export function useTheme() {
  const theme = ref<ThemePreference>(loadThemePreference())

  watch(
    theme,
    (value) => {
      applyTheme(value)
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(THEME_STORAGE_KEY, value)
      }
    },
    { immediate: true },
  )

  const isDarkTheme = computed(() => theme.value === 'dark')

  function toggleTheme(): void {
    theme.value = isDarkTheme.value ? 'light' : 'dark'
  }

  return {
    theme,
    isDarkTheme,
    toggleTheme,
  }
}
