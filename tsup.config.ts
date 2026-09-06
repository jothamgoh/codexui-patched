import { defineConfig } from 'tsup'
import { cp } from 'node:fs/promises'

export default defineConfig({
  entry: ['src/cli/index.ts'],
  outDir: 'dist-cli',
  format: 'esm',
  target: 'node18',
  sourcemap: true,
  clean: true,
  onSuccess: async () => { await cp('skills/codexui-board-planning', 'dist-cli/skills/codexui-board-planning', { recursive: true }) },
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: ['express', 'commander'],
})
