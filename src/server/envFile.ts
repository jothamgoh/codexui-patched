import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type LoadCodexUiEnvOptions = {
  appRootDir?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  explicitPath?: string
}

export type LoadedCodexUiEnv = {
  path: string
  loadedKeys: string[]
}

const SENSITIVE_ENV_KEYS = [
  'CODEXUI_PASSWORD',
  'CODEXUI_TELEGRAM_BOT_TOKEN',
  'CODEXUI_TELEGRAM_CHAT_ID',
  'CODEXUI_WEB_PUSH_PRIVATE_KEY',
  'JINA_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'MY_TELEGRAM_CHAT_ID',
]

function normalizeValue(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function parseEnvFile(raw: string): Record<string, string> {
  const parsed: Record<string, string> = {}

  for (const rawLine of raw.split(/\r?\n/u)) {
    let line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice('export '.length).trim()

    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) continue

    const key = line.slice(0, separatorIndex).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue

    let value = line.slice(separatorIndex + 1).trim()
    const singleQuoted = value.startsWith("'") && value.endsWith("'") && value.length >= 2
    const doubleQuoted = value.startsWith('"') && value.endsWith('"') && value.length >= 2
    if (singleQuoted || doubleQuoted) {
      value = value.slice(1, -1)
    } else {
      const commentIndex = value.indexOf(' #')
      if (commentIndex >= 0) value = value.slice(0, commentIndex).trim()
    }

    parsed[key] = value
  }

  return parsed
}

function resolveCandidates(options: LoadCodexUiEnvOptions): { paths: string[]; required: boolean } {
  const env = options.env ?? process.env
  const configuredPath = normalizeValue(options.explicitPath) || normalizeValue(env.CODEXUI_ENV_FILE)
  if (configuredPath) {
    return { paths: [resolve(configuredPath)], required: true }
  }

  const appRootDir = resolve(options.appRootDir ?? process.cwd())
  const cwd = resolve(options.cwd ?? process.cwd())
  const paths = [resolve(appRootDir, '.env')]
  const cwdPath = resolve(cwd, '.env')
  if (!paths.includes(cwdPath)) paths.push(cwdPath)
  return { paths, required: false }
}

export function loadCodexUiEnv(options: LoadCodexUiEnvOptions = {}): LoadedCodexUiEnv | null {
  const env = options.env ?? process.env
  const candidates = resolveCandidates(options)
  const envPath = candidates.paths.find((candidate) => existsSync(candidate))

  if (!envPath) {
    if (candidates.required) {
      throw new Error(`CodexUI environment file was not found: ${candidates.paths[0]}`)
    }
    return null
  }

  const parsed = parseEnvFile(readFileSync(envPath, 'utf8'))
  const loadedKeys: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (Object.prototype.hasOwnProperty.call(env, key)) continue
    env[key] = value
    loadedKeys.push(key)
  }

  env.CODEXUI_ENV_FILE = envPath
  return { path: envPath, loadedKeys }
}

export function getCodexUiChildEnv(
  overrides: NodeJS.ProcessEnv = {},
  allowedSensitiveKeys: string[] = [],
): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides }
  const allowed = new Set(allowedSensitiveKeys)
  for (const key of SENSITIVE_ENV_KEYS) {
    if (!allowed.has(key)) delete env[key]
  }
  return env
}
