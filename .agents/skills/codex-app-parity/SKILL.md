---
name: "codex-app-parity"
description: "Use when implementing or changing user-visible behavior/UI in this repository and parity with the installed Codex desktop app must be validated before coding."
---

# Codex App Parity Skill

## Findings: Planning controls and long conversations (2026-09-05)

- Phone board screenshots need a real touch/coarse-pointer context as well as
  a narrow desktop viewport. Keep toolbar labels within their buttons, close
  the initial sidebar, and allow vertical page scrolling so a short screen's
  controls cannot squeeze the card area to zero height. This is a web adaptation.
- Native `subAgentActivity` carries `agentThreadId`, `agentPath`, and a kind:
  started/interacted/interrupted/completed. Integrated `app-initial` maps these
  to active/updated/interrupted/completed; the final non-root path segment is
  the display name. `subagent-activity-chip-group-1b9dc9694a94.js` uses an agent
  glyph, concise lifecycle copy, and Open subagent navigation. An item/completed
  envelope closes the activity item; it does not itself mean the child finished.
- Board field microphones reuse the existing MediaRecorder/transcription path.
  Their per-field controls are an intentional web extension. Preserve typing,
  insert at the caret, keep retry/overflow text reviewable, and save manually.
  Cancelling a pending permission request must clear the busy state immediately;
  stale permission callbacks must not reset a newer recording attempt.
- At the user's request, Squad's public demo informed board owner badges,
  short column explanations, attention/completion counts, and search. Preserve
  local themes and accessible native inputs, rather than importing a UI system.
- Integrated `26.901.31953` uses `implementPlanRequest.prompt` and
  `composer.planModeIndicator` in `app-primary-37ff25fd4643.js` for explicit
  plan-to-implementation transitions. Its model controls filter advertised
  `supportedReasoningEfforts`. Board planning remains an intentional extension;
  use existing dialogs and distinguish planning from workspace-write execution.
- `local-conversation-turn-96bd5cd318dd.js` identifies final output with
  `phase === final_answer`. Keep work, final output, and the duration separator
  within the same turn when reconciling live and persisted item order.
- `local-conversation-thread-7fad29d31eb2.js` uses
  `data-virtualized-turn-content` and estimated-height shells.
  `app-initial-caa927532ffb.js` requests an initial five-turn page. For the web
  UI, unmount heavy offscreen content and bound inactive caches; lightweight
  shells and explicitly loaded active history remain. Do not describe browser
  heap measurements as total device memory.

## Findings: Composable board agents (2026-09-05)

- Integrated `26.901.31953` chunks `subagents-5f95f3a1e0e2.js` and
  `subagent-row-c294c1bf8d3d.js` represent native descendants by thread identity;
  the thumbnail uses `name || agentNickname || preview` and runtime status.
  Agent labels are presentation, so board assignment uses an exact profile ID.
- Durable board profiles and prompt editing have no exact native board
  counterpart. They remain an intentional extension using existing Reka
  dialogs, theme surfaces, focus restoration, and form components.
- Installed Codex CLI `0.153.1` supports `turn/start.additionalContext` with
  `kind: application` for per-turn developer context. An already loaded
  `thread/resume` may ignore configuration overrides; test current-profile
  behavior with the real runtime instead of relying only on fake RPC arguments.

Use this skill for any feature work or user-visible behavior/UI change in this repository.
Do not use it for purely internal refactors that do not affect behavior.

## Objective

Ensure behavior is implemented with Codex.app as the source of truth, then verified with headless Playwright and screenshots.

## Project Instructions

## Codex.app-First Development Policy

For every **new feature** and every **behavior/UI change**, treat the installed desktop app as the source of truth:

- App path: `/Applications/Codex.app`
- Primary bundle to inspect: `/Applications/Codex.app/Contents/Resources/app.asar`
- Integrated-app fallback: when the standalone app is absent, inspect `/Applications/ChatGPT.app/Contents/Resources/app.asar`; current ChatGPT builds include the Codex webview and local micro-service there.

Do not implement first and compare later. Compare first, then implement.

## How to Search for Features in Codex.app

### Extraction

Extract the app bundle once (reuse if already extracted):

```bash
mkdir -p /tmp/codex-app-extracted
npx asar extract "/Applications/Codex.app/Contents/Resources/app.asar" /tmp/codex-app-extracted
```

If `/Applications/Codex.app` is absent but ChatGPT.app is installed, extract the integrated bundle instead:

```bash
mkdir -p /tmp/chatgpt-app-extracted
npx asar extract "/Applications/ChatGPT.app/Contents/Resources/app.asar" /tmp/chatgpt-app-extracted
```

### Key Directories

| Directory | Contents |
|-----------|----------|
| `/tmp/codex-app-extracted/webview/assets/` | Frontend entry and chunk-split renderer assets + locale files |
| `/tmp/codex-app-extracted/.vite/build/` | Electron main process (`main.js`, `main-*.js`, `preload.js`, `worker.js`) |
| `/tmp/codex-app-extracted/package.json` | App metadata, version, entry point |

Use the same relative directories under `/tmp/chatgpt-app-extracted/` for the integrated ChatGPT build. Its `.vite/build/` directory also contains `codex-micro-service-*.js`.

### Searching the Minified Bundle

The main UI bundle is a single large minified JS file at `webview/assets/index-*.js`. Use Python to search since `grep -o` with large repeat counts fails on macOS:

```python
python3 -c "
with open('/tmp/codex-app-extracted/webview/assets/index-<hash>.js', 'r') as f:
    content = f.read()
idx = content.find('YOUR_SEARCH_TERM')
if idx >= 0:
    print(content[max(0, idx-200):idx+500])
"
```

### What to Search For

1. **i18n keys**: Search locale files (`webview/assets/zh-TW-*.js`, `webview/assets/en-*.js`, etc.) for human-readable labels. Keys follow the pattern `component.feature.property` (e.g., `composer.dictation.tooltip`).

2. **Component functions**: Minified React components follow patterns like `function X4n({prop1:t,prop2:e,...})`. Search for the feature's i18n key to find the component that renders it.

3. **API calls and endpoints**: Search main process files (`.vite/build/main-*.js`) for endpoint URLs, auth handling, and IPC channels. Key patterns:
   - `prodApiBaseUrl` → production API base (e.g., `https://chatgpt.com/backend-api`)
   - `devApiBaseUrl` → dev API base (e.g., `http://localhost:8000/api`)
   - `fetch-request` / `fetch-response` → IPC-proxied HTTP calls from renderer to main process

4. **Icon names**: Search for icon imports like `audiowave-dark.svg`, `book-open-dark.svg`. Icon mapping is in the main bundle around the `Hwn=Object.assign({` pattern.

5. **Keyboard shortcuts**: Search for `CmdOrCtrl+`, `Cmd+`, `keydown`, `keyCode`, or specific key names.

### Search Strategy

1. Start with **i18n locale files** — they have human-readable labels that identify features.
2. Use the i18n key to find the **component** in the main bundle.
3. Trace the component to find **hooks/composables**, **API calls**, and **event handlers**.
4. Check the **main process** bundle for any server-side proxying or Electron IPC handling.

### Architecture Notes

- **Renderer → Main Process**: The renderer uses a `Uu` HTTP client class that sends `fetch-request` IPC messages to the main process. The main process class `tle` handles these, adds auth tokens, and uses `electron.net.fetch` to make actual HTTP calls.
- **Auth**: Auth tokens come from the app-server's `getAuthStatus` RPC method (ChatGPT backend auth).
- **App-server**: A `codex app-server` child process communicating via JSON-RPC over stdin/stdout. Our bridge middleware proxies RPC calls to it.
- **Config constants**: `R7` = prodApiBaseUrl (`https://chatgpt.com/backend-api`), `I7` = devApiBaseUrl (`http://localhost:8000/api`), `C7` = originator (`Codex Desktop`).

## Required Workflow (Feature Work)

1. Identify target behavior:
- Restate what behavior is being added/changed.
- Define whether it is: data mapping, runtime event handling, UX text, visual treatment, interaction model, or all of these.

2. Inspect Codex.app before coding:
- Locate the implementation in `app.asar` (extract and search built assets as needed).
- Find relevant strings/keys/functions/components for the feature (status labels, event names, item types, summaries, collapse/expand behavior, etc.).
- Capture the closest equivalent pattern if exact parity is not present.

3. Build a parity checklist from Codex.app:
- Data model shape (fields used by UI).
- Realtime event sources and transitions.
- Rendering structure (what is shown collapsed vs expanded).
- Copy/text behavior (phrasing and status wording).
- Interaction behavior (auto-expand, auto-collapse, click/keyboard handling).
- Visibility rules (when elements appear/disappear).

4. Implement against that checklist:
- Prefer Codex.app behavior over novel design.
- Keep deviations minimal and intentional.
- If deviating, include a short reason in the final response.

5. Verify parity after implementation:
- Confirm each checklist item.
- Run local build/tests.
- Re-check UI behavior against Codex.app reference.

## Response Requirements (When delivering feature changes)

For feature tasks, include:

- `Codex.app analysis`: what was inspected (files/areas/patterns).
- `Parity result`: matched items and any explicit deviations.
- `Fallback note` only if Codex.app could not be inspected or had no equivalent.

## Fallback Rules

If Codex.app cannot be inspected (missing app, extraction/search failure) or has no equivalent pattern:

- State the blocker explicitly.
- Use best local implementation consistent with existing repository patterns.
- Keep behavior conservative and avoid speculative UX innovations.

## Scope and Safety

- This policy applies to **feature behavior and UX decisions**, not just styling.
- Bug fixes should still check Codex.app when they affect user-visible behavior.
- Prefer minimal patches that align with app behavior rather than large refactors.

## Completion Verification Requirement

- After completing a task that changes behavior or UI, always run a Playwright verification in **headless** mode.
- Always capture a screenshot of the changed result and display that screenshot in chat when reporting completion.

## Self-Improvement Protocol

After each feature implementation session that uses this skill:

1. **Record new findings**: Append a dated `## Findings:` section documenting any newly discovered Codex.app internals (state keys, API endpoints, component patterns, auth flows, etc.).
2. **Update search instructions**: If new search techniques were used (e.g., a better way to extract minified code, new file locations), update the "How to Search for Features" section.
3. **Update architecture notes**: If new IPC channels, API endpoints, or data flows were discovered, add them to the Architecture Notes.
4. **Keep findings actionable**: Each finding should include enough detail that a future session can reuse it without re-discovering.

## Findings: Workspace Root Ordering (2026-02-25)

- Codex.app persists workspace root ordering/labels in global state JSON keys:
  - `electron-saved-workspace-roots` (order source of truth)
  - `electron-workspace-root-labels`
  - `active-workspace-roots`
- In this environment, persisted file path is:
  - `~/.codex/.codex-global-state.json`
- In packaged desktop runs, equivalent userData path is typically:
  - `~/Library/Application Support/Codex/.codex-global-state.json`
- For folder/project reorder parity, prefer reading these keys over browser LocalStorage-only ordering.
- Validation requirement for reorder changes:
  - Run build/typecheck.
  - Run Playwright in headless mode and capture a screenshot showing sidebar order.

## Findings: Dictation / Microphone Feature (2026-02-26)

- **i18n keys**: `composer.dictation.*` — tooltip is "Hold to dictate", aria is "Dictate".
- **Component**: `M4n` React hook handles recording state, audio capture, and transcription.
- **Audio pipeline**: `navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })` → `MediaRecorder` → chunks → `Blob` → multipart POST.
- **Transcription endpoint**: The renderer sends audio to `/transcribe` via the IPC fetch proxy. The main process (`tle` class) prepends the `prodApiBaseUrl` (`https://chatgpt.com/backend-api`) and attaches ChatGPT auth bearer tokens. Full URL: `https://chatgpt.com/backend-api/transcribe`.
- **Request format**: Multipart form-data with boundary `----codex-transcribe-<uuid>`, fields: `file` (audio blob) and optional `language`. Body is base64-encoded and sent with `X-Codex-Base64: 1` header.
- **Response**: `{ text: "transcribed text" }`.
- **Interaction model**: Press-and-hold to record → release to stop and transcribe → text inserted into composer. Has "insert" and "send" modes.
- **Icon**: `audiowave-dark.svg` / `audiowave-light.svg` (custom SVG, not from icon library).
- **Web app implementation**: Our bridge proxies `/codex-api/transcribe` to the ChatGPT backend using auth tokens from the app-server `getAuthStatus` RPC. Frontend uses `useDictation` composable with `MediaRecorder` API.

## Findings: Dictation Bundle Split (2026-06-27)

- Current Codex.app builds may split dictation code outside the main `index-*.js` bundle.
- Useful renderer chunks found in `/tmp/codex-app-extracted/webview/assets/`:
  - `app-initial~app-main~onboarding-page~profile-*.js` contains `navigator.mediaDevices.getUserMedia`, `MediaRecorder`, and dictation/transcription hook code.
  - `global-dictation-orb-*.js` contains global dictation/orb-related code.
- Locale chunks still expose `dictation` and `transcribe` strings, but exact legacy keys such as `composer.dictation.tooltip` may not appear in every installed version.

## Findings: Chat Markdown Image Embeds (2026-03-04)

- Codex.app renderer bundle includes markdown-to-HTML image handling (`image({href,title,text})` emits `<img src="...">`), consistent with inline markdown image rendering in assistant/user text.
- In web parity mode, absolute local paths in markdown image URLs need explicit server mediation; browser runtime does not resolve `/Users/...` as local files.
- A dedicated local image endpoint (`/codex-local-image?path=...`) is required for parity-like rendering of absolute filesystem image paths in browser-delivered UI.
- Express `sendFile` must allow dot-directory segments (`dotfiles: 'allow'`) or paths under `~/.codex/...` return 404 despite existing files.

## Findings: Composer Enter Behavior (2026-03-05)

- Codex.app composer input is rich-text/multiline (`ProseMirror`-based), not single-line.
- Enter handling is configurable (`enterBehavior`):
  - `enter` submits by default.
  - `newline` inserts a newline on Enter.
  - `cmdIfMultiline` inserts newline when multiline, otherwise submits.
- Newline shortcuts are explicitly bound:
  - `Shift-Enter` inserts newline.
  - `Alt-Enter` inserts newline.
  - `Mod-Enter` submits.
- This confirms multiline composition parity requires newline-capable input plus explicit Enter-vs-newline key handling.

## Findings: Composer Multiline Layout (2026-07-04)

- Current Codex.app renderer builds render the main composer through an `xL.Input` wrapper and ProseMirror composer controller.
- The multiline composer path uses `layout: "multiline"` and passes `minHeight: "2.75rem"` to the rich-text input.
- Closest local web parity for this Vue textarea is auto-growing multiline input with Enter submit, Shift-Enter newline, and an internal scroll cap once content exceeds the composer maximum height.

## Findings: Mobile Web Visual Viewport Overscroll (2026-07-04)

- Codex.app itself does not expose the same iOS Safari rubber-band background issue because it runs in Electron rather than a mobile browser viewport.
- In CodexUI web, `visualViewport.height` can resize the fixed app shell for the keyboard, but `visualViewport.offsetTop` should not translate the shell because iOS Safari can also scroll the page around focused inputs.
- Keep the shell pinned at top, lock the document body, and contain overscroll on the app shell plus nested scroll panes.

## Findings: Composer `@` Mentions (2026-03-05)

## Findings: Conversation Message Spacing (2026-07-07)

- Current Codex.app compiled stylesheet (`webview/assets/app-jOJotR-N.css`) defines conversation rhythm tokens:
  - `--conversation-block-gap: 12px`
  - `--conversation-tool-assistant-gap: 16px`
- For local chat turn spacing, use 12-16px as the parity reference scale rather than tighter 6-8px gaps.

## Findings: Conversation Typography (2026-07-07)

- Current Codex.app compiled stylesheet (`webview/assets/app-jOJotR-N.css`) ships `OpenAI Sans` font faces and defines `--font-openai-sans: "OpenAI Sans", var(--font-sans-default)`.
- Codex.app routes app text through VS Code-style variables such as `--vscode-font-family` and uses a lighter default UI weight (`--vscode-font-weight: 430`).
- Local web parity should prefer a high-quality UI sans for chat text, a lighter variable weight around 430 when supported, and Tailwind Typography prose presets before adding manual Markdown spacing overrides.

## Findings: Conversation Markdown Measure (2026-07-06)

- Current Codex.app renderer builds include a dedicated conversation markdown stylesheet in a split asset similar to:
  - `/tmp/codex-app-extracted/webview/assets/app-initial~app-main~worktree-init-v2-page~remote-conversation-page~new-thread-panel-page~o~kg2pu5rs-*.css`
- The markdown content class sets:
  - `--markdown-font-size: var(--codex-chat-font-size)`
  - `--markdown-line-height: calc(var(--markdown-font-size) + 8px)`
  - `--thread-content-max-width: 40rem`
  - `overflow-wrap: anywhere`
- Local web parity should keep assistant markdown on a readable ~40rem measure while aligning the visible message column with the composer shell. Lists, headings, blockquotes, tables, images, and code blocks need explicit markdown styling because the desktop app does not rely only on raw browser defaults.

## Findings: Compact Mobile Composer Controls (2026-07-06)

- Codex.app composer footer CSS uses a `composer-footer` container query and hides footer labels below narrow widths such as `440px` / `475px`.
- This supports a mobile web composer strategy where narrow viewports keep only essential controls visible in one row: add files, model, reasoning effort, context usage, mic/stop, and send.
- The Safari iOS keyboard accessory bar for textarea navigation/dismissal is browser-owned UI and cannot be reliably removed from normal web content. Reducing the app composer height and keeping the textarea at `rows="1"` is the practical mitigation.

## Findings: ChatGPT-Integrated Codex UI Font Size (2026-08-10)

- When standalone `/Applications/Codex.app` is absent, the current ChatGPT bundle exposes the Codex Appearance settings in:
  - `/Applications/ChatGPT.app/Contents/Resources/app.asar`
  - extracted chunk `webview/assets/general-settings-*.js`
- The setting uses the label `UI font size` and description `Adjust the base size used for the {appName} UI`.
- The stored setting key is represented by `sansFontSize` in the compiled bundle.
- Current behavior uses a numeric pixel input with:
  - default: `14`
  - minimum: `11`
  - maximum: `16`
  - step: `1`
- For mobile web parity, preserve device-local persistence and pixel-labelled choices. A stricter minimum is appropriate when the user explicitly requires that the existing web size cannot be reduced.

## Findings: Rate-Limit Reset Redemption (2026-07-18)

- The integrated Codex renderer in ChatGPT.app fetches `/wham/rate-limit-reset-credits` with a one-minute refetch interval and a five-second stale window.
- Reset redemption is an explicit user interaction rendered through `codex.rateLimitResetModal.*`; no timer-driven automatic consumption was found.
- The consume request posts to `/wham/rate-limit-reset-credits/consume` with both `credit_id` and a `redeem_request_id`.
- The modal controller prevents concurrent redemption within one renderer and reuses the same redemption request ID after a transport failure. Successful redemption refreshes both rate-limit status and reset-credit queries.
- Web parity should keep redemption manual. Any future automation must be single-owner and must not use independent per-tab timers.

- Codex.app uses a dedicated mention trigger plugin for `@` with pattern `/(^|\s)(@[^\s@]*)$/`, so mentions activate at word boundaries and stop on whitespace or a second `@`.
- Mention entries are stored as an inline `mention-ui` node with attrs `{ label, path, fsPath }`, rendered with data attributes `at-mention-label`, `at-mention-path`, and `at-mention-fs-path`.
- Mention picker keyboard behavior includes:
  - `Escape` closes mention UI.
  - `Enter` and `Tab` commit the highlighted mention.
- Composer placeholder copy in local mode explicitly documents this affordance: `Ask Codex anything, @ to add files, / for commands`.

## Findings: Thread Row Archive Affordance (2026-03-07)

- Thread list row archive behavior lives in renderer bundle function `yS(...)` in `webview/assets/index-*.js`; practical anchors are i18n keys `codex.localTaskRow.archiveTask` and `codex.taskRowLayout.confirm`.
- Archive is a two-step inline interaction in row state: first activation enters confirm mode, second activation executes archive callback.

## Findings: Trace / Tool Call Transcript Density (2026-07-04)

- Current Codex.app local thread bundles expose MCP/tool call aggregation helpers, but no user-facing `Tool details` raw JSON payload panel was found.
- For CodexUI web parity, recognized successful tool calls should not persist as full transcript rows; keep running and failed tool calls visible, keep command cards because terminal output can be user-relevant, and reserve raw payload details for unknown/unhandled item types.

## Findings: Rate Limit Summary Windows (2026-07-04)

## Findings: Dark Theme Surface Tokens (2026-07-05)

- Current Codex.app CSS exposes separate dark-surface concepts through theme tokens rather than one shared app background:
  - `--color-token-side-bar-background` maps to `--vscode-sideBar-background`.
  - `--color-token-bg-primary` follows the sidebar background.
  - `--color-token-main-surface-primary` maps to `--color-background-surface`.
  - `--color-token-list-hover-background` and active-selection tokens drive sidebar row hover/selection states.
- For CodexUI dark-mode parity, keep sidebar and content surfaces as distinct CSS variables and tune row hover/active tones against the sidebar surface, not the main content surface.

## Findings: Worked Duration Dividers (2026-07-05)

- Codex.app local conversation chunks include the i18n key `localConversation.workedFor` with default copy `Worked for {time}`.
- The local conversation turn model carries turn-level timing fields such as `durationMs`, `turnStartedAtMs`, and `finalAssistantStartedAtMs`; the divider is associated with the completed turn and rendered between agent activity and the final assistant response.
- For CodexUI, anchor worked-duration dividers by `turnId` when available. Avoid using a thread-level singleton because that only preserves the latest completed turn.

- Codex.app rate-limit summary/menu code is split across current renderer chunks:
  - `app-initial~app-main~remote-conversation-page~hotkey-window-thread-page~thread-app-shell-ch~*.js` renders the compact `composer.mode.rateLimit.heading` / `Usage remaining` menu affordance.
  - `app-initial~app-main~remote-conversation-page~new-thread-panel-page~appgen-library-page~hot~fjhbmao5-*.js` maps account payloads into `RateLimitSnapshot` fields with `primary` and `secondary` windows.
  - `app-initial~app-main~onboarding-page-*.js` contains duration formatting for compact labels such as `{hours}h`, `{days}d`, and dynamic weekly/monthly labels.
- Relevant selector behavior:
  - Full menus render all available rate-limit windows.
  - Compact summary chooses a pressure window by higher `usedPercent`; ties choose the longer reset window.
  - Nearby settings copy includes a first-class `5 hour usage limit` label.

## Findings: Thread Goals / `/goal` (2026-07-02)

- Codex app-server exposes native goal RPCs and notifications:
  - requests: `thread/goal/get`, `thread/goal/set`, `thread/goal/clear`
  - notifications: `thread/goal/updated`, `thread/goal/cleared`
- Generated protocol types confirm:
  - `ThreadGoal = { threadId, objective, status, tokenBudget, tokensUsed, timeUsedSeconds, createdAt, updatedAt }`
  - `ThreadGoalStatus = active | paused | blocked | usageLimited | budgetLimited | complete`

## Findings: Authenticated PWA Manifests (2026-08-10)

- Codex.app has no equivalent browser installation path because its UI is packaged in Electron.
- CodexUI deployments that protect all same-origin resources with an authenticated gateway such as Cloudflare Access must load the web-app manifest with `crossorigin="use-credentials"`.
- Without that attribute, Chromium omits credentials from the manifest request, receives the authentication redirect, reports `manifest-parsing-or-network-error` and `no-manifest`, and offers only a browser shortcut instead of a standalone PWA installation.

## Findings: Sidebar Thread Reordering / New Thread Folder Defaults (2026-07-04)

- Current Codex.app bundles expose persisted project/workspace-root ordering through `electron-saved-workspace-roots`, `electron-workspace-root-labels`, and `active-workspace-roots`.
- Search terms `reorder`, `drag`, `pinnedThreadsGroup`, `recentThreadsGroup`, `newThreadInGroup`, and workspace-root keys did not reveal an exact manual sidebar thread-row reorder feature in the installed app.
- For CodexUI web parity, project ordering should continue to mirror workspace root state; manual thread ordering is a web-local display preference layered over app-server `thread/list` data.
- New-thread folder defaults map most closely to Codex.app workspace root selection behavior; retaining the last chosen local folder is a conservative web-only preference when no first-class app-server setting is available.

- Codex.app renderer strings indicate goal UI is composer-inline, not a separate persistent bottom tab:
  - `composer.goalSlashCommand.title`
  - `composer.goalSlashCommand.setDescription`
  - `composer.threadGoal.*`
  - `composer.goalModeIndicator`
- Desktop app action wiring from the extracted bundle:
  - `set-thread-goal` calls `thread/goal/set { objective, status: 'active' }`
  - `set-thread-goal-status` calls `thread/goal/set { status }`
  - `clear-thread-goal` calls `thread/goal/clear`
  - after setting an active goal, app code calls `maybeContinueActiveThreadGoal(...)`
- `maybeContinueActiveThreadGoal(...)` is re-triggered when the thread becomes idle and after turn completion, effectively re-pinging `thread/goal/set { status: 'active' }` while the goal remains active.
- Live bridge behavior observed in this repo's runtime:
  - `thread/goal/set` returns a valid `goal` payload and emits `thread/goal/updated`
  - `thread/goal/get` may still return `{ goal: null }` immediately afterward for the same thread, so reload-time hydration cannot rely on `get` alone
  - goal-only threads may not appear in the next `thread/list` refresh unless the UI preserves the optimistic local thread row until notifications / turns catch up

## Findings: Goal Slash Command Copy (2026-07-04)

- Current Codex.app locale chunks expose goal slash command strings:
  - `composer.goalSlashCommand.title` = `Goal`
  - `composer.goalSlashCommand.setDescription` = `Set a goal Codex will keep working toward`
- The app also exposes `composer.goalModeIndicator` as `Goal` and clear-goal tooltip/copy through `composer.goalModeIndicator.clear` / `.tooltip`.

## Findings: Completed Turn Work Duration (2026-07-04)

- Codex.app renders the completed-turn divider from i18n key `localConversation.workedFor` with default copy `Worked for {time}`.
- The renderer component around `SN` / `ENe` in `webview/assets/app-initial~app-main~onboarding-page-*.js` formats `startedAtMs` and `completedAtMs` into the divider label.
- The local conversation page passes `workedDurationMs` from the latest turn state (`u.durationMs`) and treats `worked-for` as a turn metadata item, not as a normal assistant/user transcript message.
- App-side notification handling updates turn state from `turn/completed` by assigning `e.durationMs = t.durationMs`; web parity can persist the synthesized latest-turn summary locally when the app-server protocol does not expose historical duration on `thread/read`.

## Findings: Desktop Turn Notifications (2026-06-27)

- Codex.app renderer bundle `webview/assets/app-initial~app-main~automations-page-*.js` contains a desktop notification service function `E8(...)`.
- The service requests notification permission lazily through `Notification.requestPermission()` and logs existing permission state instead of prompting on startup unconditionally.
- Turn completion notifications are wired through `addTurnCompletedListener(...)`, suppress some heartbeat-only completions, and fall back to `Codex finished responding` when no assistant text is available.
- Notification payloads carry thread/conversation routing data and click handlers navigate back into the originating conversation.
- Archive affordance visibility is hover/focus driven (`group-hover` / `group-focus-within`) with default hidden state (`opacity-0` + disabled pointer events), and there is no explicit touch/mobile-only branch in this component.

## Findings: Thread In-Progress vs Unread Indicators (2026-03-07)

- Codex.app task rows build indicator state from explicit runtime status, not unread alone:
  - Cloud task rows use `task_status_display.latest_turn_status_display.turn_status`; `in_progress`/`pending` map to a loading indicator type.
  - Local task rows derive `ve` (in-progress) from runtime/turn state and feed `statusState.type = 'loading'` when active.
- Local rows still pass unread (`hasUnreadTurn`) separately, but loading/error/idle type is decided first; this prevents unread-only dots from representing active work.
- In this repo's app-server v2 schema, `Thread` does not expose a stable unread/read field. The web UI therefore uses local read timestamps plus live turn-completion events. Missing local read state should be treated as unknown/read, not unread, otherwise historical threads all show unread after storage loss or first load.

## Findings: Thread Scroll Locking (2026-06-27)

- Current Codex.app builds split thread scrolling into chunks such as `thread-scroll-layout-*.js` and `local-conversation-thread-*.js`.

## Findings: Thread Goal Event Flow (2026-07-02)

- Codex.app uses explicit realtime goal notifications:
  - `thread/goal/updated`
  - `thread/goal/cleared`
  - `thread/status/changed`
- `set-thread-goal-status` and `set-thread-goal` both call `thread/goal/set`, then update local conversation state and may trigger `maybeContinueActiveThreadGoal(...)` when status is `active`.
- Goal continuation is event-driven around idle transitions:
  - `thread/status/changed` with `status.type === 'idle'`
  - `turn/completed`
- Backend event payloads observed in this repo's live app-server use camelCase goal fields:
  - `threadId`, `objective`, `status`, `tokenBudget`, `tokensUsed`, `timeUsedSeconds`, `createdAt`, `updatedAt`
- A broken sidebar/render path can mask goal-event parity. In this repo, a `RateLimitsSummary` render exception prevented reliable verification until fixed; once removed, the open thread route reflected external `thread/goal/clear` and `thread/goal/set` events without reload.
- `thread-scroll-layout-*` tracks distance from bottom and exposes methods like `scrollToBottom`, `scrollToDistanceFromBottomPx`, `getLastScrollDistanceFromBottomPx`, and user scroll listeners.
- Local conversation code reacts to user scroll separately from programmatic bottom locking; upward user scroll should break bottom-follow behavior until the user returns to the bottom or manually scrolls there.

## Findings: Model Picker Defaults (2026-06-27)

- Current Codex.app builds include host-aware model selection/default handling in split chunks such as `app-initial~app-main~home-ambient-suggestions-content-*.js`.
- The local web fork has simpler state: a new-thread model default plus a per-thread `threadModelConfigById` cache populated from `thread/resume` and local picker changes.
- For this fork, new-thread defaults should be chosen from the preferred local default (`gpt-5.4` when available), while existing thread selection should continue to apply the cached/resumed per-thread model.

## Findings: Composer Model Selection (2026-04-27)

- Codex.app updates per-conversation model state immediately when the picker changes via internal handler `e9(...)`, not only when the next turn is sent.
- That handler updates conversation-local fields `latestModel`, `latestReasoningEffort`, and `latestCollaborationMode.settings.{model,reasoning_effort}` so later reloads/resumes keep the selected model instead of snapping back to the host default.
- The renderer also consumes `sessionConfigured` / `session_configured` payloads as a source of truth for the active session model and reasoning effort after a turn starts.

## Findings: Appearance / Theme Assets (2026-04-17)

- Codex.app ships explicit appearance-aware frontend assets in `webview/assets/`, including `codex-light-*.js` plus multiple dark/light syntax theme bundles such as `dark-plus-*.js`, `light-plus-*.js`, `github-dark-*.js`, and `github-light-*.js`.
- The desktop settings bundle `general-settings-*.js` imports a toggle control and distinct moon/sun icon components, which is a strong signal that appearance settings exist in the desktop renderer even when the exact persistence key is not trivially searchable in the minified bundle.
- Practical parity takeaway for CodexUI feature work: default theme choices should stay conservative and neutral, and any added manual theme control should preserve the desktop app’s light/dark framing rather than introducing a custom color system.

## Findings: Account Rate Limits UI (2026-03-12)

- Codex.app listens for `account/rateLimits/updated` notifications and exposes a compact summary labeled `Rate limits remaining`.
- In the compact summary, the app selects the most constrained window by comparing `primary` and `secondary` buckets on `usedPercent`, breaking ties toward the longer window.
- Renderer string anchors for parity checks:
  - `composer.mode.rateLimit.heading` → `Rate limits remaining`
  - `settings.usage.limits.window.resetAt` → `Resets {time}`
  - `settings.usage.limits.fiveHour.label` and `settings.usage.limits.weekly.label` for detailed rows
- The detailed settings view renders one row per usage window with:
  - a human-readable window label
  - a `Resets {time}` description
  - a remaining-percent progress bar (`{remaining}% left`)
- `account/rateLimits/read` returns the full multi-bucket view (`rateLimitsByLimitId`), while the realtime notification payload carries a single `rateLimits` snapshot, so web clients need to merge notification snapshots into previously fetched state.

## Findings: Web Chat Message Ordering / Tunnel Transport (2026-03-12)

- In this web fork, the backend already exposes a WebSocket notification stream at `/codex-api/ws`; this is a better default than SSE when the UI is accessed through a Cloudflare tunnel because reconnects are less lossy in practice.
- Persisted thread items already carry a sortable `orderKey` derived from `turnIndex:itemIndex:messageIndex`; the remaining ordering bug came from local reconciliation:
  - silent refreshes were appending temporarily missing local items to the end of the list instead of reinserting them near their prior anchor;
  - messages without an `orderKey` could fall back to ID-based sorting, which can reorder live items incorrectly.
- For parity-like chat ordering in the web UI, preserve server order first, then reinsert only genuinely missing local items relative to adjacent known messages, and keep fallback sorts stable by original array position.

## Findings: Current Packaged Webview Entry (2026-03-12)

- In the currently installed `/Applications/Codex.app`, `npx asar list "/Applications/Codex.app/Contents/Resources/app.asar"` shows the renderer entry at:
  - `/webview/index.html`
  - `/webview/assets/index-CMu6BCpo.js`
- The renderer is chunk-split rather than a single monolithic `index-*.js`; searches should include `webview/index.html` first to locate the current hashed entry chunk before probing the rest of `webview/assets/`.
- Codex.app includes stream continuity hooks (`thread-stream-snapshot-request`, `thread-stream-resume-request`), indicating stream UI restoration relies on persisted/runtime conversation metadata rather than transient send-button state.

## Findings: Tool Activity / Running Indicators (2026-03-12)

- In the currently installed renderer bundle (`webview/assets/index-CMu6BCpo.js`), loading/running copy and command summaries are keyed through:
  - `thinkingShimmer.default` (`Thinking`)
  - `localConversation.workedFor` (`Worked for {time}`)
  - `toolSummaryForCmd.runningGenericCommand` / `toolSummaryForCmd.ranGenericCommand`
  - `toolSummaryForCmd.searchingFor*` / `toolSummaryForCmd.searchedFor*`
- This confirms Codex.app treats "turn running" and "tool summary rows" as distinct UI surfaces:
  - a persistent running indicator (`Thinking`/status shimmer),
  - plus per-tool/per-command summary rows with collapsed details.
- Practical parity implication for this web fork:
  - do not hide command/tool rows behind only the post-turn `Worked for ...` separator;
  - keep a visible running affordance near composer controls while a turn is in progress.

## Findings: In-Progress and Tool Summary UI (2026-03-12)

- In Codex.app, the default in-progress label uses `thinkingShimmer.default` (`Thinking`) and is rendered via a shimmer text component even when there is no richer activity detail yet.
- MCP tool calls are rendered as compact collapsed summaries with explicit verbs:
  - in progress: `Calling`
  - completed: `Called`
  - details text: `{tool} tool from {server}` (`codex.mcpTool.collapsedLabel.*` keys).
- Web search items are rendered as compact summaries (`codex.webSearch.summary*`), using an in-progress verb (`Searching web`) and completed verb (`Searched web`) plus optional query details.
- Completed turns show a divider label with duration (`localConversation.workedFor`: `Worked for {time}`), reinforcing that per-item tool rows should remain compact while details stay secondary.

## Findings: Mobile Keyboard Gap / iOS Composer Zoom (2026-03-15)

- In this web fork, iPhone focus on the chat composer can trigger Safari input zoom when composer text size is below 16px; setting mobile composer text to 16px removes forced zoom.
- Keyboard gap artifacts become visually obvious when page fallback/background color differs from the chat surface; avoid dark body fallback behind a light chat UI.
- A `visualViewport.height`-driven CSS variable applied to the top-level chat layout gives more stable keyboard behavior than static `100vh`/`100dvh` alone on mobile browsers.
- Adding `interactive-widget=resizes-content` in the viewport meta aligns behavior with modern mobile browser keyboard resizing where supported.
- Listening to `visualViewport.scroll` can over-react to Safari focus panning; `resize` is the safer event for keyboard height updates in this layout.
- Locking `html/body/#app` overflow and using a fixed full-screen root layout prevents iOS focus from shifting the entire page when the composer is already visible.
- If iOS Safari still shifts focused input upward, include `visualViewport.offsetTop` compensation on the root layout (translate by offset) so viewport panning does not visually detach composer from keyboard.
- To avoid "jump up then down" during keyboard animation on iOS Safari, debounce viewport metric commits briefly (about 80-100ms) while an editable element is focused, and apply height/offset as one stabilized update.

## Findings: Conversation Scroll-To-Bottom Control (2026-03-22)

- In the currently installed app bundle (`/Applications/Codex.app/Contents/Resources/app.asar`), the chat composer area renders a dedicated scroll-to-bottom control keyed by i18n id `localConversation.scrollToBottomButton` with default text `Scroll to bottom`.
- The button component (`f4` in `webview/assets/full-app-BlLz-ebA.js`) is a floating circular button with fade in/out animation (`opacity` transition ~150ms), `z-30`, and centered-above-composer placement (`end-1/2 translate-x-1/2` + `bottom-[calc(100%+6*var(--spacing))]`).
- Visibility is driven by thread scroll controller state: show only when `isScrolledFromBottom` is true and a conversation exists (`U = y && a`).
- Click behavior calls the scroll controller’s `scrollToBottom` action directly (from `x4()` hook), which re-locks the view to the latest message.

## Findings: Model Picker Persistence (2026-04-12)

- In this web fork, the model picker initializes from app-server `config/read` (`config.model` and `config.model_reasoning_effort`), not from browser `localStorage`.
- Persisting the picker across reloads/new chats requires app-server RPC `setDefaultModel` with both `model` and `reasoningEffort`; updating only frontend reactive state keeps the change in-memory for the current session only.
- On the Mac mini production deployment, validating that a model-picker change is live can be done by rebuilding, then confirming `localhost:5999` serves the new `dist/assets/index-*.js` hash before checking behavior.

## Findings: Model List Defaults (2026-04-26)

- In the currently installed Codex.app bundle (`/Applications/Codex.app/Contents/Resources/app.asar`), renderer code references both `gpt-5.4` and `gpt-5.5` in model-upgrade UI flows, confirming first-party awareness of both models.
- On this machine, probing `codex app-server` directly with `model/list` returned a visible list containing `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, and `gpt-5.2`; `gpt-5.5` was marked `isDefault: true`.
- Practical implication for this fork: keeping `gpt-5.4` as the default picker selection is a deliberate web-fork override and should be implemented in frontend fallback selection logic, not by rewriting the app-server model catalog.

## Findings: Default Model Persistence RPC (2026-04-27)

- On this machine's current `codex app-server`, the legacy RPC method `setDefaultModel` is no longer accepted; the server returns `Invalid request: unknown variant 'setDefaultModel'`.
- Persisting model picker changes now works via `config/value/write` on `keyPath: 'model'` and `keyPath: 'model_reasoning_effort'`, which writes to `~/.codex/config.toml`.
- If the picker visually changes and then snaps back, the frontend is likely doing an optimistic update and then reverting when that obsolete RPC fails.

## Findings: Current Composer Send Shortcut Settings (2026-08-29)

- The ChatGPT-integrated Codex renderer stores its send-key preference as `composerEnterBehavior`.
- The current renderer exposes three behaviors: `enter`, `cmdIfMultiline`, and `cmdAlways`.
- Settings copy identifies the modifier shortcut as `{modifierSymbol} + Enter`; on macOS the modifier is Command.
- For a multiline web composer that preserves plain Enter for newlines, an exact, IME-safe `Command+Enter` binding is the conservative parity choice.

## Findings: Thread Model Metadata (2026-04-27)

- The v2 `Thread` object returned by `thread/list` and `thread/read` does not include per-thread `model` or `reasoningEffort` fields.
- `thread/start` and `thread/resume` responses include top-level `model` and `reasoningEffort`; use those response fields to hydrate the model picker for the active conversation.
- On this machine, probing a real thread showed `thread/resume` returning `model: gpt-5.5` and `reasoningEffort: medium` while the global config was reset to `gpt-5.4` / `high`.

## Findings: Compact Reasoning Display (2026-07-05)

- Current Codex.app bundles stream reasoning summaries through `item/reasoning/summaryTextDelta` and `item/reasoning/summaryPartAdded`; the visible running state remains a separate compact `Thinking` shimmer/status surface.
- `conversation-markdown-*.js` omits `reasoning` items when converting conversation content to markdown, matching CodexUI's existing `thread/read` behavior of not rendering persisted reasoning as normal assistant prose.
- For CodexUI web parity, live reasoning can be shown as a compact preview with an expandable disclosure while preserving the full streamed text for users who want details.

## Findings: Sidebar Density and Usage Rows (2026-07-05)

- Current Codex.app sidebar strings live across app-main chunks and expose compact top controls for `sidebarElectron.newThread` (`New chat`) and `sidebarElectron.search` (`Search`).
- The desktop usage/progress UI uses compact progress bars (`h-1.5`, fixed-width percentage text, `Usage remaining`) and muted token foreground colors rather than a high-contrast card treatment.
- For CodexUI web parity, keep fork-only entries such as Skills Hub and MCPs in the sidebar, but tune row density, 13px list text, 11px metadata, softer hover/active backgrounds, and a lower-contrast rate-limit status block.

## Findings: Roomier Sidebar and Mobile Focus Stability (2026-07-05)

- The desktop app screenshot favors 14-15px sidebar labels, muted foreground color, and more vertical spacing rather than denser 13px rows.
- Codex.app exposes pin behavior internally via `set-thread-pinned`, but the public app-server schema in this repo has no thread pin RPC; CodexUI web can persist pins across browsers by storing `codexui-pinned-thread-ids` in `~/.codex/.codex-global-state.json`.
- On iOS Safari, listening to `visualViewport.scroll` while a textarea is focused can make the fixed app shell chase browser focus panning. Prefer `visualViewport.resize` plus narrow composer-focus scroll stabilization.

## Findings: Thread Names and Quiet Transcript (2026-07-05)

- The live `thread/list` payload in this environment includes a `name` field, but sampled local rows returned `name: null`; generated desktop/sidebar titles are therefore not guaranteed to be persisted in list metadata.
- The v2 protocol still exposes `thread/name/set` and `thread/name/updated`, so web sidebar title normalization should prefer `name`, `title`, `threadName`, and `thread_name` when present, then fall back to `preview`.
- For a quieter Codex.app-like transcript in this web fork, routine successful `commandExecution`, tool summary, `fileChange`, and `contextCompaction` rows can be filtered from the main conversation while preserving failed command/tool rows and approval prompts.

## Findings: Rate Limit Reset Credits (2026-07-05)

- Current Codex.app bundles expose usage-reset UI through strings such as `codex.rateLimitResetModal.*`, `codex.rateLimitResetPromptModal.resetUsage`, and `composer.mode.rateLimit.resetsAvailable`.
- The local app-server method catalog exposes `account/rateLimitResetCredit/consume`, `account/rateLimits/read`, and `account/usage/read`.
- In this environment, `account/rateLimits/read` includes a runtime-only `rateLimitResetCredits.availableCount` field even though the checked-in generated `GetAccountRateLimitsResponse` type does not yet include it.
- A harmless validation probe confirmed `account/rateLimitResetCredit/consume` requires an `idempotencyKey`; the UI should use a fresh key per explicit consume attempt and require confirmation because the call spends a real reset credit.

## Findings: Integrated ChatGPT Codex, Dictation, and Chat Identity (2026-07-18)

- This machine no longer has a standalone `/Applications/Codex.app`. The closest first-party implementation is integrated into `/Applications/ChatGPT.app/Contents/Resources/app.asar`, including Codex renderer chunks under `webview/assets/` and `codex-micro-service-*.js` under `.vite/build/`.
- The integrated composer command registry maps `composer.startDictation` to `Ctrl+Shift+D` and `composer.startVoiceMode` to `Ctrl+Shift+V`. Dictation supports both click/hold behavior and global keydown/keyup start-stop handling; a fork-specific `Cmd+U` mapping is therefore an intentional shortcut override, not exact key parity.
- Local chat labels resolve as `conversation.name?.trim() || conversation.preview`, so a missing server-side name legitimately exposes prompt text. The stable `thread/name/set` request and `thread/name/updated` notification remain the correct path for user-editable names.
- Running/loading state and unread state are modeled separately in the integrated renderer. Its command UI also exposes pinned, recent, and unread groupings, supporting separate Running and Unread filters rather than one ambiguous activity dot.
- A direct `model/list` probe against the current local app-server returned `gpt-5.6-sol` as an available/default model with `xhigh` reasoning support. Prefer runtime model metadata over stale model IDs recorded in older findings.

## Findings: Max and Ultra Reasoning Modes (2026-07-18)

- The integrated ChatGPT/Codex renderer accepts both `max` and `ultra` as distinct reasoning-effort values.
- Its model filtering consumes app-server `supportedReasoningEfforts`, can gate Ultra separately, and tracks model support for Max and Ultra independently.
- The current app-server advertises `max` as maximum reasoning depth and `ultra` as maximum reasoning with automatic task delegation for GPT-5.6 Sol and Terra.
- The renderer forwards the selected reasoning effort unchanged to `turn/start`; web forks must not label `max` as Ultra or normalize `ultra` down to `max`.

## Findings: Composer Clipboard Files (2026-07-19)

- The integrated ChatGPT/Codex composer handles paste on the composer container and reads file-kind entries from `ClipboardEvent.clipboardData`.
- Clipboard files are split into image and non-image collections; when either collection is non-empty, the handler prevents the editor's default paste and adds the files as composer attachments.
- Normal text paste remains editor-native because the handler does not prevent the event when no clipboard files are present.

## Findings: Authoritative Thread Runtime Status (2026-07-19)

- Current `thread/list` payloads expose `thread.status` with runtime variants `active`, `idle`, `notLoaded`, and `systemError`; `active` also carries `activeFlags` such as `waitingOnApproval` and `waitingOnUserInput`.
- The integrated renderer stores this as `threadRuntimeStatus` and updates it directly from `thread/status/changed` notifications.
- For conversations that still need resume, the desktop running predicate is `threadRuntimeStatus.type === 'active'`; after resume it falls back to whether the latest turn is `inProgress`.
- Web sidebar state should refresh all rows from `thread/list` runtime status and treat non-active status events as authoritative cleanup for persisted active-turn IDs.

## Findings: Selected Response Text Add to Chat (2026-07-23)

- The current integrated ChatGPT/Codex renderer (`ChatGPT.app` version `26.715.31925`) exposes `selectedTextOverlay.addToChat`, `selectedTextOverlay.comment`, and the editor placeholder `Add an optional comment…`.
- The interaction is selection-driven: selecting text in an earlier assistant response anchors a small floating toolbar to the browser selection range; clicking `Add to chat` opens the optional-comment editor. It is not primarily a right-click context-menu action.
- Each attachment is stored as selected response `text` plus an optional `annotation`; the comment may be empty. The composer represents one or more attached selections as removable context before submission.
- On submission, the desktop renderer serializes these attachments into the normal turn text under a hidden `<response-annotations>` JSON block, followed by `## My request for Codex:`. No dedicated annotation RPC is required.

## Findings: Selected Response Annotation Input (2026-07-23)

- The integrated ChatGPT/Codex annotation editor reuses its shared compact composer with `useAddSubmitAction: true`, `allowEmptySubmit: true`, and the placeholder `Add an optional comment…`.
- Plain Enter invokes the annotation editor's direct submit action; Shift+Enter and Alt+Enter remain multiline input. The shortcut belongs to the focused annotation editor and does not install a thread-level Enter handler.
- Because this surface reuses the shared composer, its voice/dictation control is available inside the annotation editor as well as in the main thread composer.

## Findings: Markdown Table Theme Contrast (2026-07-23)

- The integrated ChatGPT/Codex Markdown table styles use theme tokens rather than fixed light-theme slate colors: header text uses `var(--text-primary)`, header rules use `var(--border-medium)`, and body-cell rules use `var(--border-light)`.
- CodexUI's `prose-slate` utilities can otherwise leave table descendants with light-theme foreground values in dark mode. Explicit table header and body-cell token colors preserve contrast without adding a desktop-inconsistent header fill.

## Findings: Response Annotation Markers (2026-07-23)

- The integrated ChatGPT/Codex renderer positions each pending response-annotation marker at the selected range's upper-right edge: the horizontal point is the maximum visible range-rect right edge and the vertical point is the minimum visible top edge minus half the 25px marker height.
- Marker component `bA` renders a 25×25 blue (`#0285ff`) speech-pin SVG with a 1.65px white outline and a centered 10px bold white number. Labels follow pending annotation order starting at 1, and the active/hovered marker scales to 1.08.
- Markers remain coupled to pending composer annotations. Clicking a marker reopens that annotation for editing, while hover/focus shows a one-line comment preview; removing or submitting the composer attachment removes its marker.

## Findings: Continue in a New Chat (2026-07-23)

- The integrated ChatGPT/Codex renderer (`ChatGPT.app` version `26.715.31925`) exposes an assistant-message action with tooltip `Continue in new chat` and accessible label `Continue in new chat from here`.
- Its dialog title is `Continue in a new chat`. The first choice is `Use this workspace` with the description `Continue from this message in a new local chat`; inside an existing worktree the label becomes `Use this worktree`. The second choice is `Use a new worktree` with the description `Continue from this message in a new worktree`, and is disabled outside a Git repository.
- Same-workspace continuation forks the latest thread with `thread/fork`, locates the selected turn, and calls `thread/rollback` on the fork for the number of later turns. This preserves the selected assistant response while removing conversation history after it.
- New-worktree continuation first prepares a managed Git checkout, then applies the same fork-from-turn flow with that checkout as the new thread's working directory. A shared workspace reuses the same files, while a worktree isolates the checkout for parallel changes.

## Findings: Mobile Workspace Picker (2026-07-23)

- The Electron desktop implementation has no direct equivalent of iOS Safari's focus zoom or viewport clipping. For mobile web parity, the workspace picker should use a portaled, collision-aware surface constrained to the visual viewport.
- Avoiding automatic input focus on coarse pointers prevents the keyboard from immediately displacing the picker, and a 16px search-input font prevents Safari's automatic form zoom. Light and dark styling should come from the app's semantic surface, foreground, muted, and border tokens.

## Findings: Composer Plugin Mentions (2026-07-28)

- The integrated ChatGPT/Codex renderer maps an installed plugin to a composer mention with its package `name`, user-facing `displayName`, and a `plugin://<plugin-id>` path. Browser and Computer Use have special display-label overrides, but the path format is unchanged.
- The desktop composer's `@` autocomplete places a `Plugins` section before its later mention sources and inserts the chosen plugin as a rich mention. Its utility bar also exposes a separate searchable, multi-select `Plugins` control.
- The current plugin-enabled app-server exposes `plugin/installed` without requiring experimental API opt-in. Its response groups `PluginSummary` rows by marketplace and includes `installed`, `enabled`, `availability`, and `interface.displayName` / `shortDescription`.
- On this Mac Mini, the CodexUI bridge already launches `~/.codex/plugins/.plugin-appserver/codex` ahead of the ChatGPT-bundled and PATH binaries, so the web UI can discover the same enabled local and remote plugins as the integrated desktop app.
- Plugin-backed prompts use a markdown mention such as `[@Gmail](plugin://gmail@openai-curated-remote)` plus a structured `turn/start` input item of type `mention`; preserving both matches current rich-composer serialization and app-server invocation semantics.
- The integrated desktop Plugins page provides browse/search, Installed and featured/category sections, refresh, install/uninstall, and enabled/disabled status. Admin-managed/default installations show a protected action rather than an uninstall affordance.
- The current plugin-enabled app-server accepts `plugin/list`, `plugin/install`, and `plugin/uninstall` without experimental initialization. Remote installs use `remoteMarketplaceName` plus `pluginName`; local installs use `marketplacePath` plus `pluginName`; uninstall uses the stable plugin `id`.
- Local-chat mentions in the integrated desktop composer use `thread://<thread-id>` paths; ChatGPT-hosted conversations use the separate `chatgpt-conversation://` scheme. CodexUI should use `thread://` because its sidebar conversations are local app-server threads.
- This fork deliberately omits the desktop composer's persistent Plugins utility-bar control and the duplicate Plugins entry under `+`. Plugins remain available through the Plugins-first `@` autocomplete, while management and details live in the sidebar Plugins page; this preserves capability without duplicating composer controls.
- The integrated desktop derives user-facing MCP activity identity from matched app metadata and groups calls into app/tool activities rather than presenting raw `server` and `tool` identifiers. When app-server items include `appContext.appName` and `appContext.actionName`, CodexUI should prefer those fields over names such as `codex_apps` and `booking_com.accommodations_search_v2`.
- Connector no-match outcomes can arrive with item status `failed` while the structured result contains an expected domain outcome such as `hotel_names_not_resolved` or `hotel_names_no_availability`. These should remain non-successful calls internally but display as `No results` or `Unavailable`, with the connector's explanation, instead of implying a broken search integration.
- MCP App result rendering is gated behind the desktop app's `enable_mcp_apps` path. A completed call associates `appContext.resourceUri` (with legacy `mcpAppResourceUri` fallback) with the arguments, structured result, and result `_meta`, then renders the referenced UI resource in a sandboxed app frame.
- Within one turn, earlier calls using the same MCP App resource are treated as superseded so the transcript emphasizes the latest useful result rather than stacking retry widgets.
- The installed Booking.com and Trip.com resources use the legacy `text/html+skybridge` compatibility surface and read `window.openai.toolInput`, `window.openai.toolOutput`, and `window.openai.toolResponseMetadata`. Booking.com currently loads an external module, while Trip.com currently ships an inline app bundle, so a compatible host must support both forms.
- Expected domain outcomes such as no hotel match, no availability, or a train date outside the presale window should not visually compete with a later successful rich result. Genuine integration or transport failures still need a compact failure state.

- CodexUI applies a second transcript-density filter in `App.vue` before `ThreadConversation.vue`. When adding a rich rendering for a completed tool call, that outer filter must explicitly retain messages carrying the rich result; otherwise the normalizer can be correct while the renderer never receives the message.
- The desktop MCP App host derives theme from the current document `color-scheme`, sends theme plus live container dimensions to the sandbox, and updates dimensions through a `ResizeObserver`. Trip.com's current compatibility widget also reads `document.documentElement[data-theme]`, so a legacy `window.openai` host should mirror its current theme onto the sandbox document in addition to emitting `openai:set_globals`.

## Findings: Mobile Response Annotation Editor Tracking (2026-08-08)

- The integrated ChatGPT/Codex selected-text annotation editor accepts an `onDelete` callback in edit mode, in addition to removal from the composer attachment surface. Web parity should make deletion available directly while editing an existing annotation.
- A mobile web annotation editor anchored through a virtual selection reference must continuously track layout changes while the iOS keyboard resizes the visual viewport. With Reka/Floating UI, `updatePositionStrategy: 'always'` enables animation-frame anchor tracking; the default optimized strategy can leave the editor at its pre-keyboard coordinates until a window resize.
- Snapshot the selected range on the Add action's `pointerdown`, while retaining `click` for keyboard activation. Mobile Safari can collapse the native selection before `click`, otherwise removing the action surface before the editor state is created.

## Findings: Cross-Device Turn Notifications (2026-07-28)

- The integrated ChatGPT/Codex renderer's `general-settings-*.js` notification settings expose three turn-completion modes: `Never`, `Only when unfocused`, and `Always`. The current default resolves to `unfocused`.
- Desktop notification permission is requested lazily after a user action. Completion notifications carry conversation routing data, and clicking one navigates to the originating conversation.
- An Electron notification handler cannot cover a closed browser-delivered web app. CodexUI web parity therefore keeps the same modes and click-routing behavior while using a standards-based manifest, service worker, VAPID subscription, and server-side Web Push delivery.
- On iOS/iPadOS, Web Push setup must be initiated from the installed Home Screen web app and from an explicit user gesture. On macOS, supported Safari/Chromium browsers can subscribe without Home Screen installation.
- Apple's `web.push.apple.com` endpoint rejects a VAPID JWT whose contact subject uses a `.local` email domain with `403 BadJwtToken`; use a public HTTPS contact URL or a valid public-domain `mailto:` subject. A successful Apple delivery returns HTTP 201 from the push service.

## Findings: Notification Activity Center (2026-07-28)

- The integrated ChatGPT/Codex renderer models running and unread conversations independently, so a web notification affordance should prioritize separate `Running` and `Unread` sections instead of using its badge only to advertise push-permission state.
- CodexUI's shared `UiThread.inProgress` and `UiThread.unread` flags are the authoritative live inputs for those sections. A bounded server-side completion history can supply a short `Recent` section without becoming a second conversation archive.
- For this web fork, the header bell is intentionally an activity center first and notification delivery settings second. Its badge counts conversations needing attention, while Web Push and Telegram delivery controls live behind a secondary Settings tab.
- A persisted Telegram on/off override can safely disable fallback messages without deleting bot credentials. Keeping that preference in `~/.codex/codexui-telegram-notifications.json` makes future re-enabling a one-click UI action and survives server restarts.
- Recent completed rows should remain a bounded convenience surface rather than another full sidebar: show six initially, allow progressive expansion, and keep already-read rows out of the attention badge.
- Dismissal should target one completion timestamp, not permanently hide the conversation. Clearing that thread's dismissal when a later turn completes lets the new activity reappear naturally.
- On mobile, an almost full-width popover with compact 48px rows preserves tap targets while reducing vertical density; left-swipe dismissal should be paired with a visible dismiss button for discoverability and accessibility.
- The integrated renderer exposes explicit `Mark as unread` and `Mark as read` conversation actions and separate unread/recent groupings. In CodexUI, opening an unread completion should transition it into Recently completed instead of filtering out the active conversation.
- A visible row-actions button and mobile long press should open the same read-state and dismissal actions; long press is an additional shortcut, not the only way to discover the controls.
- The activity bell is the primary compact mobile surface, while the desktop sidebar remains the fuller navigation surface. Low-frequency appearance controls belong in the sidebar Tools settings group rather than competing with notification activity in the content header.
- iOS may suspend a Home Screen PWA instead of recreating its JavaScript state. Refresh shared read markers on `pageshow` or return to visible state so a suspended device cannot keep showing a chat that another device already marked read.

## Findings: Notification Text and Conversation Recency (2026-07-28)

- The installed ChatGPT/Codex desktop main process parses notification Markdown into an AST before setting the native notification body. It removes writing-block markers, comments, script/style content, and HTML markup, then extracts compact plain text and collapses whitespace.
- Native notification bodies and compact activity previews should therefore preserve readable labels, code, and image alt text without exposing Markdown punctuation or attempting to render full rich Markdown in a system notification.
- The integrated renderer tracks both `updatedAt` and `recencyAt` for conversations and prefers `recencyAt ?? updatedAt` when computing recent-conversation signatures and ordering.
- CodexUI sidebar timestamps should use a thread's latest activity (`updatedAtIso`), not its creation time, and compact activity surfaces should share one reactive clock so their relative labels change together.
- Sending a message or receiving turn activity should immediately promote that conversation to the top of its project. Pinned conversations remain in the pinned surface; recency promotion applies to the normal project list.

## Findings: Global Chat Search (2026-07-28)

- The integrated ChatGPT/Codex desktop command registry maps `openCommandMenu` to `CmdOrCtrl+K` and `CmdOrCtrl+Shift+P`. Its sidebar Search row opens the chat-search intent in that same command-menu surface rather than filtering the visible sidebar in place.
- The chat-search intent uses `Search chats`, shows `Pinned chats` and `Recent chats` before a query, and searches titles plus conversation content after typing.
- Full conversation search calls experimental app-server method `thread/search` with `searchTerm`, `sortKey: updated_at`, and an unarchived filter. Results contain a thread summary plus a matched-content `snippet`; the client must opt into `capabilities.experimentalApi` during `initialize`.
- CodexUI should expose one responsive search dialog from both desktop `CmdOrCtrl+K` and mobile Tools. Search results outside the initial `thread/list` page must be inserted into local thread state and retained while selected so older matches remain open during background refreshes.

## Findings: Authoritative Pinned Thread State (2026-07-28)

- The integrated ChatGPT/Codex main process exposes `list-pinned-threads`, granular `set-thread-pinned { threadId, pinned, beforeThreadId? }`, and `set-pinned-threads-order { threadIds }`.
- Each successful mutation sends `pinned-threads-updated` to every registered window and flushes global state before returning. Renderer queries invalidate `list-pinned-threads` when that event arrives.
- Pin state and mutation ordering therefore live above the sidebar component lifecycle. A mobile drawer may unmount without discarding the authoritative list or its pending mutations.
- For CodexUI, keep browser storage as a startup cache only; never recover pin membership by replaying a complete cached list. Pin/unpin must remain granular, while a full list may be accepted only as an ordering change when its membership exactly matches current server state.
- A suspended PWA can resume old JavaScript after another device changes pins. Server-side membership validation is therefore required even after the active frontend has moved to granular mutations; client-side queues alone cannot protect shared state from an older writer.

## Findings: Desktop Web Push Reliability and Activity Shortcuts (2026-07-28)

- Web Push subscriptions and browser notification permission are device-specific even when completion history and chat read state are shared. A mode such as `Always` on an iPhone does not enroll desktop Chrome; the settings UI must identify the current device's subscription state separately from its selected mode.
- Push-provider acceptance cannot prove that macOS displayed a banner. While a subscribed CodexUI tab is open, showing the same completion through its service-worker registration with the same notification tag gives desktop Chrome an immediate local path while the server Web Push path continues to cover closed/background clients.
- A Web Push test endpoint must distinguish an accepted send from an expired subscription and a transient provider failure. Returning success after logging a provider error makes the test control misleading.
- Chrome can leave `Notification.requestPermission()` pending behind an address-bar permission prompt. A bounded wait with actionable permission guidance prevents an indefinite `Enabling…` state.
- The integrated desktop command registry maps `CmdOrCtrl+J` to `toggleBottomPanel`. CodexUI has no equivalent bottom panel, so assigning `Cmd+J` to its notification activity center is an intentional fork-specific shortcut rather than exact parity.
- Notification number shortcuts should follow the visible activity order: Running, then Unread, then Recently completed. They take precedence over sidebar `Cmd+1`–`Cmd+9` only while the activity center is open.

## Findings: Recovered Tool Failure Presentation (2026-07-28)

- App-server tool items preserve each invocation's actual failed/completed state. A transient `fetch failed` item can therefore remain in persisted history even when a later invocation of the same tool succeeds and the overall workflow completes.
- CodexUI already suppresses routine completed tool summaries for transcript density. When a same-turn connection failure is followed by a completed call with the same tool identity, suppressing the recovered failure follows that quiet-transcript model without falsifying the underlying item state.
- An unrecovered transport failure should remain visible, but `Connection issue` with warning styling is more accurate than a task-level red `Failed` card for timeouts, failed fetches, connection resets/refusals, and temporary 502/503/504 responses.

## Findings: Scheduled Tasks and Chat Automations (2026-07-28)

- The integrated desktop renderer's Scheduled page calls host actions named `list-automations`, `automation-create`, `automation-update`, `automation-delete`, and `automation-run-now`. The scheduler and persistent run inbox live in the Electron desktop host, not in the Codex app-server protocol itself.
- Chat creation and editing use an injected app-server dynamic tool named `automation_update`. Its modes include immediate `create`/`update`/`delete` plus `suggested_create` and `suggested_update`; suggested modes render an inline proposal card that the user can open and confirm instead of mutating immediately.
- Chat-attached follow-ups are `heartbeat` automations with a `targetThreadId` and reuse the existing conversation context. Standalone `cron` automations run as independent local jobs against a project, optionally in a background worktree, and create a new result conversation per run.
- The current management surface provides search, All/Active/Paused filters, next-run and running state, manual create, Create with ChatGPT/Codex, plugin-provided templates, pause/resume, Run now, edit, delete confirmation, and a Previous runs rail with read/unread and archive actions.
- The manual form includes name, prompt, destination (Existing chat/New chat), pinned target chat, project, local/worktree execution, model, reasoning effort, notification policy, and presets for hourly/daily/weekdays/weekly/interval/custom RFC 5545 RRULE schedules.
- CodexUI cannot achieve parity with a browser timer or page-local state. It needs an always-on server scheduler, a dedicated persistent task/run store, dynamic-tool injection and execution, current-chat and standalone run orchestration, notifications, and a responsive Scheduled management route built from the existing shadcn-vue/Reka primitives.

## Findings: Portaled Activity Center and Durable Pin Ownership (2026-07-28)

- The shared shadcn-vue `PopoverContent` uses a Reka portal. A scoped `:deep(.notification-popover)` rule compiles to a scoped ancestor selector and does not match the portaled root; root sizing must use `:global(.notification-popover)` or a class owned by the shared popover primitive.
- A 30rem desktop activity popover and an almost full-viewport mobile popover preserve substantially more title and preview text. Shortcut keycaps fit best in the secondary status/time row rather than competing with the title.
- Closing the activity center by keyboard should explicitly restore focus to the composer after the portal closes. The same public composer focus method can focus a newly mounted New chat composer after desktop pencil navigation.
- CodexUI-specific pins must not be stored as an unowned custom key inside ChatGPT desktop's `.codex-global-state.json`. The desktop host keeps an in-memory global-state snapshot and can later flush the whole file, overwriting CodexUI's newer key value even when stale browser writes are rejected.
- Store CodexUI pins in an atomic, CodexUI-owned file, migrate the legacy list once, serialize granular pin intents, and retain server-side membership validation for reorder snapshots. This separates desktop-host and web-UI ownership while keeping cross-device pin state authoritative.

## Findings: External Scheduler Ownership and Scheduled Cards (2026-07-29)

- The ChatGPT/Codex scheduler is private to the trusted Electron host. Its renderer calls Electron IPC actions; the installed app exposes no supported HTTP/socket bridge or cross-process ownership lock that an external browser UI can safely reuse.
- CodexUI should therefore have one server-side scheduler owner and its own atomic task store. Co-watching the desktop app's private automation files could execute the same task twice and is not safe parity.
- Injecting `automation_update` when a new app-server thread starts provides the same chat-first proposal model. Existing threads created before the injection cannot retroactively gain that dynamic tool through `thread/resume`, but they can still be attached from the Scheduled management form.
- An accepted proposal should remain as an inline scheduled-task card rather than disappearing. Persist the resolved task ID on the proposal so the card reflects subsequent Active, Paused, or Removed state, the current schedule, and the next run.
- Scheduled surfaces should use the app's semantic surface, text, border, input, and accent tokens. In this Vue scoped-CSS pipeline, `:global(html[data-theme='dark']) .child` can compile as repeated selectors against `html` itself; semantic tokens avoid that failure and keep desktop dialogs and mobile bottom sheets consistent.
- CodexUI's scheduler continues while the browser/PWA is closed only while its Mac Mini server process remains running. Per-task notification policy belongs in the execution metadata so Web Push, Telegram, and in-tab notifications make the same delivery decision.

## Findings: Confirmed Automation Citations and Wall-Clock Time (2026-07-29)

- The integrated ChatGPT/Codex renderer maps completed `automation_update` modes to compact citation labels: `create` → `Created`, `update` → `Updated`, `delete` → `Deleted`, `suggested-create` → `Proposed`, and `suggested-update` → `Proposed update`.
- A suggested automation opens an editable proposal side panel with `Cancel` plus `Create scheduled task` or `Apply changes`. After saving, the host records the returned automation ID against the suggestion's directive key; the same citation then opens the persisted task and exposes `Open settings`.
- An immediate `create` after explicit user authority does not show another confirmation button. It renders directly as `Created` with the task name, schedule summary, and an Open action.
- CodexUI must atomically reconcile an AI's direct create with an exact pending proposal. Creating the task through a separate path leaves a stale confirmation card and can produce duplicates if the user confirms it again.
- The desktop tool schema describes RRULE hours as wall-clock time in the user's locale. An RRULE library's zero-offset/floating `Date` is not necessarily a true UTC instant; convert between timezone-local components and an actual instant before persisting `nextRunAtIso`.
- This CodexUI deployment intentionally fixes scheduled wall-clock time to `Asia/Singapore` (SGT/GMT+8), shows that zone on cards and in the editor, and migrates legacy UTC-interpreted next-run timestamps once through a scheduler schema version.

## Findings: Proposal Placement and New-Chat Picker Drafts (2026-07-29)

- CodexUI's persisted `thread/read` response omits handled `automation_update` dynamic-tool items, while the separate automation store retains the proposal. Without a stable transcript item anchor, rendering proposal cards before the message list can hide a newly created approval behind the user's current bottom scroll position.
- The conservative fallback is to render retained proposal cards in chronological order at the active end of the conversation and include proposal changes in bottom-follow calculations. This keeps `Proposed` actions visible without inventing an unreliable transcript anchor.
- New-chat model and effort choices are draft state, separate from both global defaults and per-thread session configuration. Persist that draft independently and never overwrite it when selecting an empty/New chat route.
- During startup, an intentionally empty selected-thread ID must not be replaced with the first historical thread while `thread/list` loads. That transient selection can misroute a user's New chat picker change into an old thread and later appear to “snap back” when route synchronization clears the thread again.

## Findings: Long Conversation Paging (2026-07-30)

- App-server `thread/read` currently exposes only `includeTurns`; it has no turn cursor or turn limit. Current `thread/resume` supports `excludeTurns`, while older versions may ignore it and return the complete thread even when a client only needs the resumed model configuration.
- The integrated desktop renderer still requests all turns, then uses a measured turn virtualizer with an estimated 280px row height, viewport distance-from-bottom tracking, and overscan to keep most historical turns out of the DOM.
- For a remote browser/PWA, DOM virtualization alone does not prevent the complete transcript from crossing the network or entering browser memory. CodexUI intentionally adds a bridge-owned page boundary that slices `thread/read` before JSON serialization and requests `excludeTurns` for its model-only resume response, retaining response stripping as an older-server fallback.
- Message order keys for paged results must retain the absolute server turn index. Relative page indices cause earlier pages to collide with or sort after newer turns.
- Upward infinite scrolling should capture scroll height and scroll top before requesting an earlier page, then add the new height delta to scroll top after prepend. This preserves the reader's exact visual anchor while keeping normal bottom-follow behavior for live turns.

## Findings: Automatic Thread Titles (2026-08-01)

- The integrated ChatGPT/Codex implementation generates a title after the first prompt with `gpt-5.6-luna`, low reasoning, a 30-second timeout, and a structured schema requiring a title of at most 36 characters plus a compact description of at most 100 characters.
- Generation runs in an ephemeral `system` thread with approval policy `never`, read-only sandboxing, Web Search disabled, and fanout, hooks, multi-agent, plugins, and tool suggestions disabled. The source prompt is truncated to 2,000 characters.
- The generator listens for the temporary thread's agent-message and turn-completion notifications, parses the structured JSON result, then unsubscribes the temporary thread. A separate bridge process prevents these internal events from entering the normal transcript or completion-notification paths.
- Generated titles should be persisted through `thread/name/set`; browser metadata is only a compatibility cache. If a user manually renames the chat while generation is pending, the manual title must win.

## Findings: Scheduled Card Turn Anchors and One-Time Schedules (2026-08-01)

- App-server dynamic tool requests for `item/tool/call` always carry both `threadId` and `turnId` in `DynamicToolCallParams`. Persisting that `turnId` with a CodexUI automation proposal gives retained inline cards a stable conversation anchor even though handled dynamic-tool items are omitted from `thread/read`.
- Legacy resolved proposal cards without a persisted turn anchor must not be appended after every later transcript message. Recover their exact `turnId` from the matching timestamped `automation_update` call in Codex session history and persist it. If session history is unavailable, retain resolved cards in a fixed pre-transcript fallback instead of hiding them or trailing them after newer messages. Keep unanchored pending proposals at the active end so they remain actionable.
- The integrated ChatGPT/Codex automation editor exposes recurring Frequency controls (`Repeat`, `On`, and `At`) and next-run state, but the 2026-08-01 build has no visible one-time scheduling control or one-time copy.
- CodexUI intentionally extends the desktop model with explicit `scheduleType: recurring | once` and `runAtIso`. Existing RRULEs containing `COUNT=1` should be presented and consumed as one-time schedules for backward compatibility, then mark themselves completed after the scheduled run.

## Findings: Mobile Response Selection Actions (2026-08-08)

- The integrated ChatGPT/Codex renderer version `26.727.51351` implements response selection in `webview/assets/app-initial-iBPGfcXU.js` through the `Yja` selection lifecycle, `Rto` action toolbar, and `Bac` response-annotation editor.
- The desktop lifecycle listens to `selectionchange`, pointer down/up/cancel, keyup, resize, and capture-phase scroll. Add to chat explicitly calls `window.getSelection()?.removeAllRanges()` before creating the response annotation; the optional-comment editor supports Cancel, Escape, and light dismiss.
- The desktop action toolbar is placed above the selected range and has no coarse-pointer/mobile branch or visible dismiss control. That placement directly competes with iOS Safari's native Copy/Look Up callout, which Electron never needs to handle.
- For CodexUI mobile web, preserve the native selection menu and dock a separate Add to chat/Cancel bar near the composer. Use at least 44px touch targets and a 16px annotation input to avoid Safari focus zoom.
- Synchronize web selection state through `selectionchange`, clear the native range on Add and explicit dismiss, and only re-capture after pointerup when the browser reported a changed range. This prevents a plain tap on already-selected text from immediately reopening a dismissed action bar.

## Findings: Mobile Native Response Selection Handles (2026-08-08)

- The integrated ChatGPT/Codex `Yja`/`Xto` selection lifecycle treats pointerdown inside the selected response as the start of a drag: it hides the custom action overlay, marks the selection as dragging, preserves the native range, and recalculates actions after pointerup.
- On iOS Safari, a native selection-handle touch targets the underlying response element. A capture-phase handler must not call `Selection.removeAllRanges()` for that pointerdown or the browser loses both handles before it can expand the phrase.
- Keep native-range clearing for explicit Add, Cancel/X, Escape, and true outside dismissal. During a response-surface gesture, hide only the app-owned action UI and let `selectionchange` plus pointerup capture the expanded range.

## Findings: Subagent Notification Filtering (2026-08-08)

- The integrated ChatGPT/Codex activity tray and completion-notification path suppress child-agent conversations; only interactive top-level chats appear as user-facing activity.
- Current app-server v2 child threads carry `source: { subAgent: ... }`; spawned children include `thread_spawn.parent_thread_id` and `depth`. Legacy sessions may use lowercase `subagent`, while `thread/list` exposes `subAgent*` source-kind variants.
- CodexUI must classify child threads from structured source metadata, never from titles, previews, or absence from the currently loaded interactive thread page. Auto-attached child sessions can emit `turn/completed` without a preceding `thread/started`, so unknown completion IDs require an authoritative `thread/read` source lookup and caching of both child and interactive results.
- Backfill current and archived child IDs with paginated `thread/list` requests, remove their legacy Web Push history, and suppress new completions before Web Push history/delivery or Telegram delivery. Bound lookup/backfill requests and fail open after a timeout so app-server trouble does not indefinitely swallow top-level notifications.
- Use the same notification router in production and Vite development. Browser-local unread/banner handling also needs authoritative source lookup; filtering history by only the visible 100-thread page incorrectly hides valid off-page or archived top-level activity.

## Findings: Review Changes Panel (2026-08-08)

- The integrated ChatGPT/Codex renderer synthesizes one completed `turn-diff` transcript item after a turn. It prefers the realtime `turn/diff/updated` aggregate while available and otherwise reconstructs the review from successful patch batches, preserving batch order and the working directory used by each batch.
- Persisted app-server v2 `fileChange` items expose updates as hunk-only unified text, while additions and deletions carry raw whole-file content. A compatible client must add Git/file headers for updates and synthesize complete new/deleted-file patches for raw content before calculating line numbers or applying Undo.
- The completed-turn card uses `Edited {filename}` or `Edited # files`, aggregate additions/deletions, three file rows by default, expand/collapse, an explicit Review action, and Undo/Reapply. Opening it leads to the Review side panel; the full desktop surface defaults to unified, unwrapped diffs with all ordinary files expanded.
- The installed desktop bundle has no purpose-built touch Review layout. CodexUI adapts it as a closable right sheet on desktop and a full-screen, safe-area-aware surface on mobile, with sticky controls, horizontally contained code, 44px mobile targets, visible `+`/`−` markers, and an optional wrap toggle.
- Revert must re-read the authoritative `threadId`/`turnId` instead of accepting browser-supplied patch text. Undo applies patch batches in reverse order and Reapply in forward order; dependent edits to the same file require sequential simulation, because concatenating reversed patches into one `git apply -R` can reject valid history.
- A temporary Git index/object directory can preflight the complete ordered sequence against the current worktree without touching real files. Real application remains batch-ordered and rolls back already-applied batches if an unexpected apply failure occurs. Confirmation stays enabled for every Undo and does not include the desktop app's persistent “Don't ask again” bypass.
- Authoritative reconstruction must fail the whole action if any completed change, batch ID, working directory, or repository-relative path cannot be represented safely. Serialize Review mutations per repository so two Undo/Reapply requests cannot interleave between preflight and application.
- Bind the browser's reviewed scope to each batch ID, raw-change fingerprint, and canonical lexical working directory, then re-read and compare it before mutation. Reject symlink-resolved workspaces and command directories instead of allowing an unchanged relative path to retarget a different file.
- Coordinate Review with the app-server's shared turn-start path, including scheduled automations, and track `turn/started` through `turn/completed`; checking only the selected thread leaves sibling writers able to race the worktree. Bound every Git subprocess so a stalled filter cannot retain the mutation reservation indefinitely.
- Whole-file add/delete patches must preserve CRLF bytes and `\ No newline at end of file`; pure renames need `similarity index 100%` plus `rename from`/`rename to` metadata. Parse file headers only before the first hunk so removed content beginning with `--` cannot masquerade as a `---` header.
- Persisted file-change items do not record reliable worktree modes for added or deleted files. A later Reapply can otherwise recreate an executable as `0644`, while a saved revision and index cannot detect a pre-deletion unstaged `chmod`; CodexUI therefore keeps those turns reviewable but disables Undo.
- Git patches also do not record directory permissions. Keep cross-directory renames visible in Review, but disable Undo/Reapply because recreating a removed source or destination directory could silently replace an original private or special mode with the process default; same-directory renames remain reversible.
- `git apply` normalizes worktree file modes to coarse `0644`/`0755` values even when no mode change is present. Capture exact `0o7777` modes transactionally, restore them after ordinary successful updates, transfer them across safe same-directory renames, and reject symlinked files rather than risk retargeting their contents.
- Successful apply and copy-based rollback can also drop group ownership, macOS extended attributes, ACLs, or hard-link topology. Preserve UID/GID and bounded macOS xattrs with the file snapshot, reject files owned by an un-restorable user/group, and reject ACL-bearing or hard-linked files before preflight rather than report a lossy success.
- Both temporary-index preflights read the worktree before the transactional snapshot, so capture affected access times first and restore them immediately after preflight. Restore snapshot timestamps on rollback and transfer them for metadata-only renames, but let content-changing updates receive a fresh modification time. Reject non-default macOS BSD file flags because a Git apply can silently discard them.
- Reject explicit `old mode`/`new mode` patches as well as add/delete mode headers. Restoring exact pre-action metadata after a content apply would otherwise silently override the patch's requested mode transition.
- Run Review's Git mutation commands with repository content filters and fsmonitor disabled. A smudge/process filter can otherwise outlive a timed-out `git apply`, leave a partially written batch behind, and retain the Review/turn-start gate.
- Browser-local Undo/Reapply labels can be stale across devices. When the requested direction no longer applies, safely preflight the opposite direction and return the reconciled applied/undone state so another browser can recover without accepting browser-supplied patch data.
- `git apply` can exit nonzero after writing an earlier file from the same patch. Capture bounded, mode-aware per-batch worktree snapshots and restore them in reverse on any failure; inverse patches alone cannot reliably undo a partially applied current batch.
- Git may relocate a stale hunk onto a repeated block. Preflight both directions, reject offset/fuzz application, and treat a state where both directions apply as ambiguous instead of mutating another matching location.
- Structured question cards already exist in CodexUI for `item/tool/requestUserInput`. They only appear when Codex emits that server request, so ordinary prose clarification does not surface them.

## Findings: Git-backed Review and Branch Switching (2026-08-08)

- The integrated ChatGPT/Codex renderer version `26.727.51351` has repository-wide Review beyond the completed-turn card. Its source selector groups `Last Turn`; `Uncommitted`, `Unstaged`, and `Staged`; then `Committed` and `Branch`.
- Review's `Branch` source is compare-only. The header renders the current branch, an arrow, and a searchable base-branch picker; changing that picker updates the diff source and does not check out a branch.
- Actual checkout is a separate Environment branch switcher backed by native `git-checkout-branch` and `git-create-branch` host actions. It shows the active branch, an `Uncommitted: # files` sublabel, recent/searchable branches, and a guarded conflict flow when checkout would overwrite local edits.
- Native has no title-adjacent changes badge or notification strip. Its compact pattern is a small header Summary control that opens an overlay; the Environment section inside contains the branch row and a `Changes` row with diff stats. The branch control also appears in the composer utility bar.
- The desktop Review surface is a right task side panel. Narrow layouts retain the source selector, move branch comparison onto a second header row, collapse secondary controls into Review options, and allow the file tree to be hidden. The Electron renderer has no purpose-built coarse-pointer Review or branch picker.
- For CodexUI, keep repository checkout separate from Review comparison, use the compact Summary/Environment overlay instead of inventing a top-bar count badge, and adapt Review plus branch selection to full-screen, safe-area-aware mobile surfaces with 44px controls.
- Live Git endpoints must be purpose-built and scoped through the authoritative selected thread workspace. Do not expose arbitrary Git command execution or trust a browser-supplied repository path. Diff commands must disable external diff/textconv and inherited Git configuration injection; checkout must never force, reset, clean, or discard local changes.

## Findings: Frontend/Server Bridge Version Skew (2026-08-08)

- Production serves newly built `dist/` frontend assets without restarting Node, while new `/codex-api/*` server routes do not exist until the service restarts. During that version-skew window, an unmatched API request can fall through Express static handling to `index.html` with HTTP 200.
- Bridge clients should recognize a successful `text/html` response as frontend/server version skew and show an explicit restart-required message instead of reporting a malformed JSON envelope.
- Once the updated server is running, unmatched `/codex-api/*` paths should return a JSON 404 before the SPA fallback so future client/server mistakes remain diagnosable API errors.

## Findings: Mobile Submit Focus and Recording Wake Lock (2026-08-09)

- The integrated ChatGPT/Codex composer is an Electron desktop surface: it keeps composer focus after submission and its dictation implementation has no Screen Wake Lock API integration.
- Mobile Safari and Android browsers need an intentional web adaptation. After a successful local submit, blur the composer on phone/touch-iPad user agents so the software keyboard closes; preserve desktop refocus for rapid keyboard-driven follow-ups.
- While `MediaRecorder` is actively recording, request a best-effort `navigator.wakeLock.request('screen')` lock. Release it before transcription, on cancellation, on errors, and on unmount; reacquire after a visibility return only if recording is still active.
- Wake-lock support or acquisition failure must never block recording. A request that resolves after recording stopped must immediately release its late sentinel.
- Pause nonessential presentation clocks (for example relative timestamps and per-second goal duration labels) while the document is hidden, then refresh once on visibility return. Keep realtime transports active so battery savings do not trade away completion delivery.

## Findings: Referencing Other Chats (2026-08-10)

- The integrated ChatGPT/Codex renderer version `26.727.51351` includes chats in its `@` picker. Local Codex chats use `thread://` paths through its agent-mention node, while ChatGPT conversation references use the distinct `chatgpt-conversation://` node and scheme; files and plugins are additional mention sources in the same composer.
- App-server `UserInput` mention blocks contain only `name` and `path`. They do not carry transcript content, and a `thread://` mention must not be assumed to expand a local Codex thread into model context.
- For CodexUI's explicit local-chat reference feature, resolve each selected thread through authoritative `thread/read`, include only bounded recent user/assistant transcript text, and label it as incomplete quoted context rather than instructions. Exclude tool/system payloads, cap both reference count and total text, and escape the enclosing delimiter inside serialized content.
- Preserve the structured `thread://` mention alongside the bounded text so sent messages can reconstruct a visible chat chip and navigate back to the referenced thread. Removing the typed token in the composer and then ignoring persisted mention blocks makes a working reference appear to have vanished.

## Findings: Android Selected-Text Action Handoff (2026-08-10)

- The integrated ChatGPT/Codex selected-text toolbar prevents the default press behavior on `mousedown`, but invokes Add to chat from the completed `click`; its selection controller keeps a cloned DOM range and dismisses the native range only as the action is committed.
- Do not replace the selection toolbar with the annotation editor during `pointerdown`. On Android Chrome, removing the pressed button before click dispatch can leave the selection bar gone without opening the editor. Snapshot the range during pointerdown, keep the button mounted, then open from click; this also retains keyboard activation.
- Android can emit a transient collapsed `selectionchange` while closing its native selection menu or handing the tap to the app-owned touch dock. A cloned touch selection should survive that event until Add, Cancel, an outside tap, or a new response-surface gesture explicitly resolves it. Desktop collapsed-selection dismissal remains immediate.

## Findings: Tail-Hydrated Thread Resume (2026-08-11)

- The integrated ChatGPT/Codex renderer version `26.727.51351` sends `excludeTurns: true` on `thread/resume` when tail hydration is enabled. Its native paginated path may also request `initialTurnsPage`, while legacy paths can fall back to `thread/read { includeTurns: true }`.
- A client that loads history separately should set `excludeTurns: true` on its metadata-only resume call. Keep response-side turn stripping as a compatibility fallback for older app-server versions that ignore the parameter.
- CodexUI's `/thread-page` route still calls `thread/read { includeTurns: true }` and slices the result in the bridge. That limits browser transfer and memory, but true app-server turn pagination is a separate protocol migration.

## Findings: Notification Read Actions (2026-08-17)

- The installed integrated ChatGPT/Codex renderer (`26.803.41515`) uses the exact `Mark all as read` wording for bulk unread actions in sidebar context menus, disables the action when no unread items exist, and exposes per-item `Mark as read`/`Mark as unread` actions in the same contextual pattern.
- Its unread badges prefer a numeric count with a `99+` cap, falling back to a simple unread indicator when no count is available.
- No dedicated notification-center unread filter was present in the inspected bundle. CodexUI's Activity `All`/`Unread` filter is an intentional local enhancement because its notification badge combines shared thread unread state with separate Web Push history read markers.

## Findings: Fast Mode Speed Setting (2026-08-22)

- The installed integrated ChatGPT/Codex renderer (`26.803.41515`) places a `Speed` selector in General Settings with `Standard` (`Default speed`) and `Fast` (`1.5x speed, increased usage`) options. A settings-row control is therefore the native-parity surface; CodexUI maps it to Tools → Settings rather than adding another composer-bar control.
- Current app-server model metadata advertises Fast through `serviceTiers` with protocol ID `priority`; older builds may expose `additionalSpeedTiers`, and persisted configuration uses the alias `fast`. Treat both `fast` and `priority` as Fast while sending each model's advertised protocol ID.
- `thread/start` and `turn/start` accept `serviceTier`; the latter applies the override to the current and subsequent turns. Send an explicit tier or `null` on every turn so changing the setting affects existing chats on their next turn and switching back to Standard clears a previously fast thread.
- The shared Codex configuration is the cross-device authority. Persist Fast as `service_tier = "fast"` with `features.fast_mode = true`; persist Standard as a null `service_tier`. Read the value again when Tools opens or the page resumes so another device's choice is reflected locally.
- Fast availability is model-specific. Hide the setting when no available model advertises a fast tier, and fall back to Standard for an unsupported selected model even when the shared preference remains Fast.

## Findings: Send-Button-Only Composer Submission (2026-08-27)

- The installed Codex renderer exposes three configurable send-shortcut modes in `general-settings-*.js`: `enter`, `cmdIfMultiline`, and `cmdAlways`. Its settings copy explicitly distinguishes sending from inserting a newline.
- CodexUI's mobile web composer uses a native multiline `textarea`, so leaving Enter unhandled inserts a newline across mobile keyboards without custom key synthesis.
- For a strict send-button-only interaction requested by the user, prevent native form submission without calling the submit handler, keep submission on the visible Send button's click handler, and retain Enter/Tab only for committing an open mention-picker selection. This intentionally goes beyond Codex.app's `cmdAlways` mode by disabling modifier-key submission too.

## Findings: Project Boards and Agent Orchestration (2026-09-05)

- The installed ChatGPT/Codex renderer (`26.803.41515`) has project navigation, task side panels, agent activity, and attention states, but no project-level Kanban or durable cross-chat feature board. CodexUI Project Boards are therefore an intentional product extension, not an exact missing-app parity port.
- The closest native runtime language maps active work to Working; user input or approval to Needs input/Waiting; errors to Blocked/Failed; unread completion to Ready/Review; and terminal work to Done. A five-lane board can group the durable `needs_input` and `blocked` states under Needs You while retaining distinct card labels and data.
- Native subagent activity groups Active and Done agents and labels individual agents Working or Waiting. CodexUI should keep its board task graph durable and deterministic, then use those native activity concepts only for live run presentation; a completed turn or idle child thread is not proof that a task is done.
- The native task/review surface docks on the right at wide desktop widths and becomes a modal/full-screen surface when space is constrained. CodexUI follows that responsive pattern for feature detail while leaving the ordinary chat composer and thread routes unchanged.
- The native app has no comparable touch Kanban interaction. CodexUI must provide explicit status selects as the accessible/mobile equivalent to drag-and-drop, keep horizontal scrolling contained within the lane area, and preserve the global header and notification center across board and chat routes.

## Findings: Project Board Theme and Focus Corrections (2026-09-05)

- Rechecked the extracted integrated app version `26.901.31953`. The `app-initial-*.css` renderer stylesheet uses theme surface tokens; `projects-index-page-*` and `toggle-thread-summary-panel-*` include focus restoration patterns.
- `app-primary-*` and `avatar-overlay-*` distinguish Working, Needs input, Ready, and Blocked. A durable board remains a CodexUI extension; use those nearby patterns without deriving completion from transient native activity.
- Match the existing local `WorkspaceReviewPanel.vue` Reka pattern: a non-modal docked detail on wide pointer-driven screens, a modal detail at narrow widths, and focus restoration on close. Use surface/text tokens for portaled content as well as in-page cards.
- Keep browser smoke evidence in ignored `output/project-boards/`. Pre-seeded browser state and fake service orchestration are complementary checks, not proof of a real Codex Lead/subagent session.

- CodexUI's Vite bridge mounts HTTP/SSE but has no production WebSocket upgrade handler. Use the existing SSE transport in development, start notification listening before chat hydration, and freeze source edits during browser smoke: Vite full reloads intentionally discard component form drafts.
