import { constants } from 'node:fs'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const CONFIG_ENV = 'CODEXUI_CLAUDE_COMPUTER_USE_MCP_FILE'
const APPROVAL_ENV = 'CODEXUI_CLAUDE_COMPUTER_USE_APPROVAL'
const MAX_CONFIG_BYTES = 128 * 1024

const stdioServerSchema = z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string()).max(64).optional(),
  env: z.record(z.string(), z.string()).optional(),
}).passthrough()

const computerUseConfigSchema = z.object({
  mcpServers: z.object({ cua_repl: stdioServerSchema }).passthrough(),
}).passthrough()

async function newestBundledConfig(): Promise<string> {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  const root = join(codexHome, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use')
  const versions = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((first, second) => second.localeCompare(first, undefined, { numeric: true }))
  for (const version of versions) {
    const candidate = join(root, version, '.mcp.json')
    if ((await stat(candidate).catch(() => null))?.isFile()) return candidate
  }
  throw new Error('the installed Codex unified-computer-use plugin has no MCP configuration')
}

/** `never` gives Claude chats unattended control of this Mac; anything else asks first. */
export function claudeComputerUseNeedsApproval(): boolean {
  return process.env[APPROVAL_ENV]?.trim().toLowerCase() !== 'never'
}

/** Load only the Codex computer-use bridge, never arbitrary MCP entries. */
export async function loadClaudeComputerUseMcpConfig(): Promise<McpStdioServerConfig | null> {
  const configured = process.env[CONFIG_ENV]?.trim()
  if (!configured) return null
  const configPath = configured === 'auto' ? await newestBundledConfig() : configured
  if (!isAbsolute(configPath)) throw new Error(`${CONFIG_ENV} must be "auto" or an absolute path`)

  const info = await stat(configPath).catch(() => null)
  if (!info?.isFile()) throw new Error('the configured Claude computer-use MCP file does not exist')
  if (info.size > MAX_CONFIG_BYTES) throw new Error('the configured Claude computer-use MCP file is too large')

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'))
  } catch {
    throw new Error('the configured Claude computer-use MCP file is not valid JSON')
  }
  const result = computerUseConfigSchema.safeParse(parsed)
  if (!result.success) throw new Error('the configured Claude computer-use MCP file has an invalid cua_repl server')

  const server = result.data.mcpServers.cua_repl
  if (!isAbsolute(server.command)) throw new Error('the configured cua_repl command must be an absolute path')
  await access(server.command, constants.X_OK).catch(() => {
    throw new Error('the configured cua_repl command is not executable')
  })

  return {
    type: 'stdio',
    command: server.command,
    ...(server.args ? { args: server.args } : {}),
    env: {
      ...server.env,
      // Chrome uses Claude Code's native integration. Keep this MCP limited to
      // native Mac apps so one provider does not expose two browser drivers.
      CUA_REPL_ENABLED_SURFACES: 'computer',
      NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER: '',
      NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME: '',
    },
    timeout: 120_000,
    alwaysLoad: true,
  }
}
