import { defineConfig } from 'tsup'
import { cp } from 'node:fs/promises'

export default defineConfig({
  // The cua relay is started as its own process by Claude Code, so it ships as a separate file.
  entry: { index: 'src/cli/index.ts', cuaRelay: 'src/server/cuaRelay.ts' },
  splitting: false,
  outDir: 'dist-cli',
  format: 'esm',
  target: 'node18',
  sourcemap: true,
  clean: true,
  onSuccess: async () => { await cp('skills/codexui-board-planning', 'dist-cli/skills/codexui-board-planning', { recursive: true }) },
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: ['express', 'commander', '@anthropic-ai/claude-agent-sdk', 'zod'],
})
