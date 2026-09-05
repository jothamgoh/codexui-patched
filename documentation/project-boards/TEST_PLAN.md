# Project Boards verification

Revised 2026-09-06. Protect real behavior with focused scenarios, not an
exhaustive framework matrix. PROGRESS.md records what actually passed.

## Validation boundary

Develop a coherent feature/fix group, then validate. Check earlier for dependent
contracts, material risk, or a failure that needs isolation. Do not repeat
unchanged suites just because a small edit was made.

| Command | Purpose |
|---|---|
| npm run test:project-boards | Store/service/model/board-notification diagnosis. |
| npm run check:project-boards | Full tests, production build, board browser flow. |
| npm run test:e2e:project-boards | Browser-only rerun after a UI correction. |
| node tests/boardChatFlow.e2e.mjs | Frontend/store fixture for tracked chat creation, Activity, replies, drafts, and mobile navigation. |
| npm run test:thread-scroll | Actual-state delayed-history/rollback races and scroll/final-order rules. |
| node tests/chatReliability.e2e.mjs | Chat rendering, live/persisted activity, dictation, and stress. |
| node tests/requestUserInput.e2e.mjs | Native question choices, voice/free text, retry, replay, and resume. |
| npm run test:e2e:question-preference | New-chat setting defaults, persistence, capability/policy gates. |
| node tests/boardDictation.e2e.mjs | Field speech insertion, concurrent edits, retry/cancel, and overflow. |

npm test includes the focused board, question, preference, and notification
regressions. npm run test:native:question-preference is an optional isolated
app-server check, separate from npm test; CODEXUI_CODEX_COMMAND can select its
runtime. It uses a local fake model response with a real native request/reply.

## Keep fixtures isolated

The earlier bridge fixture used temporary CODEX_HOME but loaded real default
push subscribers, causing external stopped-run alerts. CODEX_HOME now scopes
notification storage too. Retain explicit defense in every bridge fixture:

- Use temporary project/state directories and an empty CODEXUI_ENV_FILE.
- Set CODEXUI_WEB_PUSH_STATE_FILE inside that temporary directory; clear inherited
  VAPID and all Telegram token/chat variables. Disable Telegram and use only a
  local fixture public URL.
- Assert zero push subscriptions and unavailable Telegram before browser actions.
  Unit delivery tests use stubs; do not send external test notifications.
- Intercept execution calls unless this is the explicitly bounded native probe.
  Do not mutate production boards, preferences, or notification history.
- Freeze source during smoke, or explicitly close the Vite watcher. A watch:null
  override can be merged with the repository config and leave HMR active.
- Stop the fixture and remove only its own temporary data and forwarding rules.

## Meaningful scenarios

- Serialized persistence, validation, capacity errors, and interruption recovery.
- Exact profile/thread/turn ownership, dependencies, question provenance, and
  final verification after the work it certifies. Updated built-ins must not
  overwrite user-customized prompt copies.
- Read-only Plan first; atomic/idempotent project-card creation; preserved prior
  work; supported model/default resolution; repair with retained handoffs.
- Selected dependency-ready queue work only. Exercise pause, replacement,
  failure, process exit, changed scope, and turning continuation off while a
  start awaits model metadata. A stale attempt cannot start or block new work.
- Committed outcomes enter existing history once, suppress generic Lead alerts,
  and recover interruptions without replaying old history or leaking fixtures.
- Brief-only titles, source/Lead separation, active exact-turn steering, idle
  same-chat tracked replies, atomic explicit reopening, and direct-RPC bypass
  rejection. Preserve inputs and drafts through failures and navigation.
- Stop covers delayed starts, native interruption failure, replay and replacement,
  owned descendants, and exact request cleanup even if a completion event is
  missing. Deleting stopped or waiting work must preserve code
  files and reject deletion while execution remains active.
- Native Lead requests produce one redacted device alert, resolve on answer/Stop,
  and agree across Activity, the board count, and Needs You. Exclude internal
  child chats and stale requests after restart.
- A selected batch alerts exactly once after its last turn; replay, pause,
  question, failure, and replacement cannot produce false completion.
- Delayed history must not overwrite newer streamed text or remove a fresh final
  answer. Keep turn-local final/separator order and relevant viewport coverage.
- Question retries and bridge replays retain drafts and prevent duplicate replies;
  secret answers remain masked. New-chat configuration must respect capability
  and managed-policy constraints without claiming to reconfigure loaded chats.

## Browser and device evidence

The board smoke combines a disposable real bridge/store with synthetic state and
intercepted execution. Cover the plan/chat entry, dependency/model controls,
write/queue consent, draft failures, Activity links, Board/Needs You/Runs views,
exact question/feature links, voice/manual save, themes, focus, and phone layout.

Separate frontend fixtures exercise a 2,000-message conversation, live/persisted
subagent activity, and native question request/reply. The field fixture checks
caret insertion, typing during transcription, retained audio retry, overflow,
cancellation, and delayed permission. Inspect representative screenshots under
ignored output/project-boards/, output/chat-reliability/,
output/request-user-input/, and output/board-dictation/.

Chromium touch emulation is the normal automated phone check. A supported host
can opt into CODEXUI_MOBILE_BROWSER=webkit; the current local engine crashes on
a blank page, so this does not establish Safari compatibility.

Real Android testing follows the user's device automation instructions: trusted
start/unlock, inspect before taps, no unnecessary Location changes, managed
captures, and cleanup/sleep. A disposable local fixture is sufficient for forms.
Current Pixel evidence includes actual mic permission/recording/upload, synthetic
transcript insertion, phone-keyboard edits, manual Backlog save, question voice
cancel, and Needs You/Runs navigation. Non-sensitive evidence is under ignored
output/android-project-boards/. No audio is retained. This is not physical iPhone
Safari or speech-recognition accuracy evidence.

## Bounded real native execution

Use a disposable project and isolated Codex state. Current evidence includes
both a read-only arithmetic flow and two real parser/CLI writing flows, including
one with copies of the current starter prompts. Each writing flow covered:

1. Project planning into two dependent features and read-only feature Plan first.
2. Same-chat implementation and a fresh native reviewer.
3. A deliberately introduced parser defect, recorded repair, and fresh recheck.
4. Automatic dependent CLI work using the saved parser contract; combined 8/8 tests.

Record run outcomes, thread reuse, actual files/checks, and preserved handoffs.
Stop native processes and remove temporary auth links. This proves a bounded
write/review/repair workflow, not arbitrary concurrent writers, production
release, or closed-browser notification delivery.

## Release

Review diff/status, scan secrets, run the coherent final checks, commit discrete
work, push main, verify CI, and follow the authorized machine-local restart/health
workflow. Keep simulated, native disposable, physical-device, and production
evidence distinct. A later material fix needs its affected checks again.
