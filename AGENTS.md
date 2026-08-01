# AGENTS.md

## Project Overview

CodexUI is a maintained, standalone web UI for OpenAI Codex CLI. It runs on top of the Codex `app-server`, allowing browser access to a local Codex instance. The codebase originated from the MIT-licensed [friuns/codexui](https://github.com/friuns/codexui), with attribution preserved in `LICENSE`.

- **Tech stack**: Vue 3, TypeScript, Tailwind CSS 4, Vite 6, Express 5
- **Repo**: `https://github.com/jothamgoh/codexui-patched`

## Development Commands

```bash
npm install                # Install dependencies
npm run dev                # Start Vite dev server (port 5173, spawns codex app-server)
npm run build              # Type-check + build frontend + build CLI
npm run build:frontend     # vue-tsc --noEmit && vite build
npm run build:cli          # tsup (builds CLI to dist-cli/)
npm run preview            # Preview production build
```

Requires Node.js >= 18 and `codex` CLI installed and in PATH.

## Local deployment

Keep machine-specific paths, service labels, ports, domains, and restart commands outside
the repository. If `~/.config/codexui/AGENTS.local.md` exists, read it before local deployment
work. Use `deployment/macos/com.codexui.user.plist.example` as the public-safe service template.

The compiled service runs from `dist/` and `dist-cli/`, so always run `npm run build` before
deploying a source change. Do not use Playwright or E2E testing unless the user specifically
asks for it.

## Release and production workflow

This repository is public. Unless the user explicitly asks for a local-only experiment, take a
completed source change all the way through this workflow:

1. Review `git diff` and `git status` for accidental machine paths, runtime data, or credentials.
2. Run `gitleaks dir --redact .` when Gitleaks is available locally. A clean CI scan is a second
   guardrail, not permission to push a known secret.
3. Run `npm test` and `npm run build`.
4. Commit the discrete task with a descriptive message.
5. Push `main` to `https://github.com/jothamgoh/codexui-patched` and verify the GitHub Actions run.
6. Verify the local production health check described in `~/.config/codexui/AGENTS.local.md`.

Pushing `main` publishes the source repository; it does not restart a Mac service. A successful
build writes the frontend assets to `dist/`, so frontend-only changes are served on browser
refresh without restarting Node. Changes to `src/server/`, `src/cli/`, dependencies, environment
loading, or process configuration require a service restart after the build.

Never commit a populated `.env`, Codex `auth.json`, OAuth token, browser profile, API key,
notification credential, runtime database, user log, or machine-specific service definition.
GitHub secret-scanning push protection and the Gitleaks CI job must remain enabled.

## Remote-access security boundary

CodexUI controls a Codex process with access to the host filesystem. Treat every HTTP, SSE,
and WebSocket client as having the same authority as the local Codex user.

- Keep direct listeners limited to trusted localhost, LAN, and private-overlay clients.
- Put every remotely reachable hostname behind Cloudflare Access or an equivalent authenticated
  gateway. Do not expose port 5999 directly to the internet.
- Do not rely on the built-in CodexUI password as the only protection behind a local reverse
  proxy. Proxy connections arrive from loopback, which the current authentication middleware
  treats as local and permits without a password challenge.
- Preserve this external authentication requirement in deployment documentation and templates.
- Do not weaken the external access policy or assume a printed CodexUI password makes a public
  tunnel safe.

## Architecture

Single-page Vue 3 app that communicates with Codex app-server via a Node.js bridge (Express middleware in dev, standalone Express server in production).

```
Browser (Vue 3 SPA)
  -> HTTP/SSE/WebSocket to /codex-api/*
    -> Node.js Bridge (Express)
      -> stdin/stdout JSON-RPC to codex app-server (child process)
```

### Key Files
- `src/App.vue` - Root component
- `src/composables/useDesktopState.ts` - Central state composable (~2000 LOC, all reactive state)
- `src/api/` - Backend communication layer (gateway, RPC client, DTOs)
- `src/components/` - UI components (content, sidebar, layout, icons)
- `src/server/` - Node.js server (bridge, auth, Express)
- `src/cli/` - CLI entry point (Commander)
- `documentation/` - Codex app-server protocol docs and schemas
- `PROJECT_SPEC.md` - Detailed project specification (architecture, protocol, state management)

## Merge To Local Main Flow For Worktree

- Do not reinterpret "push" as a local `main` merge.
- If the user explicitly asks to merge the current work into local `main`, follow the flow below.

1. In the worktree, commit changes and create a branch.
   - `git add -A && git commit -m "<message>"`
   - `git switch -c <your-branch>`
2. If the user asks for a **single merge commit**, do this exact sequence in the main worktree:
   - find pre-merge `main` from reflog (example: `git reflog main`)
   - `git checkout main`
   - `git reset --hard <pre-merge-main-commit>`
   - `git merge --no-ff <your-branch> -m "Merge branch '<your-branch>' into main"`
3. Otherwise, merge into local `main` from the main worktree:
   - `git checkout main`
   - `git merge --ff-only <your-branch>`
4. If `--ff-only` fails (non-linear history), use:
   - `git merge --no-ff <your-branch>`

## Commit After Each Task

- Always create a commit after completing each discrete task or sub-task.
- Do not batch multiple tasks into a single commit.
- Each commit message should describe the specific change made.
