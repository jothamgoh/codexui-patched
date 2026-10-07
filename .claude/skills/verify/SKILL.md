---
name: verify
description: Drive the real CodexUI web app (Vue SPA + Express bridge + codex app-server) in an isolated dev instance with Playwright, and capture screenshot and side-effect proof. Use to prove a UI or bridge change works the way a user would see it, to reproduce a UI bug, or whenever someone asks to run, screenshot, or verify CodexUI.
---

# Verify CodexUI

This skill drives a separate dev copy of CodexUI on port 5181. Each instance gets its own scratch
Codex and Claude config folders. It never touches the production service on port 5999, the
user's real chats, or `~/.codex` state, and it never restarts anything.

The feature map lives in [`features/README.md`](features/README.md). Read the file for the
feature you changed before you drive it. A proof that covers one entry point is incomplete if
the map lists others.

## Launch

From the repo root:

```bash
.claude/skills/verify/scripts/instance.sh start               # UI-only: nobody signed in
.claude/skills/verify/scripts/instance.sh start --live-auth   # copies the Codex login so chats really run
```

- Ready means the script prints `ready: http://127.0.0.1:5181 ...`. It polls
  `/codex-api/meta/methods` for up to 60 seconds and prints the log tail if startup fails.
- The instance runs `vite` from source with the bridge middleware. Frontend edits hot-reload.
  Edits under `src/server/` need `stop` and `start` again.
- Choose the mode:
  - **UI-only (default):** use it for layout, dialogs, settings, boards, scheduled tasks, and
    anything else that does not need a model reply. Sending a chat message fails.
  - **`--live-auth`:** copies `~/.codex/auth.json` and `config.toml` into the scratch home and
    creates `$VERIFY_DIR/workspace` as a safe folder for chats. Each message spends the user's
    Codex quota, so use the `Low` effort and one-word prompts. The script refuses to start
    when the token is close to expiry or stale, because a refresh inside the scratch copy could
    sign out the real login.
- Claude chats are always signed out. The real Claude login lives in the login keychain and
  its chats live in `~/.claude`, so this skill does not drive Claude chats. Verify Claude
  backend changes with `npm run test:claude-backend`.
- Override the port with `VERIFY_PORT=5182` and the scratch folder with `VERIFY_DIR`. Port 5173
  (`npm run dev`) is often taken by another repo's Vite server on this machine, so do not use it.

## Doctor

```bash
.claude/skills/verify/scripts/instance.sh doctor
```

The script runs read-only checks: our process is alive, port 5181 belongs to our process group
and not someone else's, the bridge answers, which auth mode is active, and the
`/codex-api/providers` sign-in state. It ends with `doctor: OK` or `doctor: NOT OK`. Run it
first whenever something looks wrong. If the port belongs to a foreign process, choose another
`VERIFY_PORT`. Never kill that process.

## Drive

Write each scenario as `output/verify/<run>/scenario.mjs`, so the scenario is stored with its
evidence and `playwright` resolves from the repo. Name the run `<YYYYMMDD-HHMMSS>-<feature>`.
The helper [`scripts/session.mjs`](scripts/session.mjs) opens a headless browser and collects
page errors:

```js
import assert from 'node:assert/strict'
import { openSession } from '../../../.claude/skills/verify/scripts/session.mjs'
const s = await openSession({ run: '20261008-000835-scheduled-task' /*, mobile: true, engine: 'webkit' */ })
const { page } = s
try {
  await s.go('/scheduled')                       // hash routes: /, /thread/:id, /boards, /board/:id, /scheduled, /skills, /mcps, /plugins
  await page.getByRole('button', { name: 'New task' }).click()
  await s.shot('01-dialog')                      // writes output/verify/<run>/01-dialog.png
  s.note('PASS ...')                             // appended to log.txt
} catch (e) { await s.shot('failure'); await s.snapshot('failure'); throw e }
finally { await s.close() }                      // writes log.txt with browser errors
```

Run it from the repo root:

```bash
VERIFY_CODEX_HOME="${TMPDIR%/}/codexui-verify/codex-home" VERIFY_WORKSPACE="${TMPDIR%/}/codexui-verify/workspace" \
  node output/verify/<run>/scenario.mjs
```

- Use role and accessible-name locators (`getByRole('button', { name: 'Send message' })`).
  The app labels its controls well, and the feature files list the real names.
- When a name is unknown, call `await s.snapshot('x')` and read `output/verify/<run>/x.aria.yml`.
- The user mostly works on a phone. For layout or touch changes, run the scenario a second time
  with `{ mobile: true }` (iPhone 13), and also with `engine: 'webkit'` when Safari behavior
  matters.
- The existing `tests/*.e2e.mjs` scripts mount single components with mocked API responses.
  They are useful regression checks, but they do not prove the full app path. This skill does.

## Evidence

- Proof lives in `output/verify/<run>/`: the scenario, numbered screenshots, `log.txt` (notes
  and browser errors), and any `.aria.yml` snapshots. `output/` is gitignored, and cleanup does
  not touch it. View screenshots with the Read tool and report the paths.
- Follow the real user path through visible controls. Do not call internal setters or post to
  `/codex-api/*` directly to skip the UI.
- Capture the action and the resulting state: a screenshot before the action and one after.
  Then reload the page to prove the change persisted.
- Check side effects in the scratch home as well as on screen. For example,
  `codexui-automations.json`, `codexui-project-boards.json`, `codexui-pinned-threads.json`, and
  `sessions/**/rollout-*.jsonl` all live under `$VERIFY_DIR/codex-home`.
- Report every browser `pageerror` in `log.txt`. A 502 console error comes from Skills Hub's
  external fetch and is expected.

## Cleanup

```bash
.claude/skills/verify/scripts/instance.sh stop
```

`stop` terminates only the process group recorded at `start` (Vite and its codex app-server
child), then deletes `$VERIFY_DIR`, including the scratch login copy. If the scratch login
changed during the run, it prints a warning. Pass that warning on to the user. Evidence in
`output/verify/` survives. Run `stop` after every failed attempt too. Never kill processes by
name: production CodexUI, the Claude host, and the ChatGPT app all run `codex app-server`
processes on this machine.

## Never

- Never point a scenario at port 5999 or a public hostname. That is production, with the
  user's real chats.
- In `--live-auth` mode, never click **Sign out** (it logs out the copied ChatGPT login) or
  **Use reset** (it spends the user's real rate-limit reset credits).
- Never restart the production service or the Claude host from this skill.
