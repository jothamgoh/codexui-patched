# Project Boards progress

Updated: 2026-09-05

Status: released. Source through 9523339 was pushed to main and
[GitHub CI passed](https://github.com/jothamgoh/codexui-patched/actions/runs/33974933982).
The authorized independent-Terminal restart completed. After reconnecting,
the bridge and board/model APIs returned valid HTTP 200 responses, and public
access still redirected to the authenticated gateway. The checkout is ready
for real-work dogfooding.

## Goal and decisions

Make larger builds easy to steer from a chat or a board: plan the project,
review feature cards, run useful work, see results, and answer focused questions.
Keep native Codex execution and the existing UI framework. Validate coherent
features, earlier only when dependencies or risk justify it.

Any reusable agent can lead or delegate. The Lead chooses a fresh verifier when
independent verification is requested; no mandatory QA selector or separate
reviewer-launch service is needed. Dictation keeps manual Add and Send.
Multi-account/provider execution remains separate future work.

## Implemented in this cycle

- Chat final output uses native final-answer phase and stable turn grouping.
  Work, the duration separator, final answer, and diff remain in their own turn.
- Long chats unmount heavy offscreen content, bound markdown and inactive
  history caches, and retain drafts/scroll state. Lightweight shells remain.
- Dictation shows Recording, Transcribing, and Ready; retries preserve audio.
  Pending transcription belongs to the original chat draft after switching.
  Late microphone permission cannot start an invisible recording.
- Features save optional model/reasoning overrides, defaulting to Lead settings.
  Agent profiles also expose settings. The server validates advertised model
  capabilities before a run; specialists retain their own profile settings.
- Chat header → Turn this chat into a board opens a prefilled, editable plan.
  Choose an existing project or open/create its folder. A retry reuses the
  newly created board. The source chat remains linked.
- Plan features starts a read-only coordinator chat that saves distinct cards
  and dependencies. Saved project plans remain visible on the board.
- Plan first saves a feature task plan without implementation; Start work
  resumes that same Lead chat. Simple briefs can still use Plan & start.
- Feature dependencies and compact prerequisite outcomes explain sequencing.
  Completed task handoffs remain recorded when a Lead reopens work for repair.
- Run selected features grants a specific, session-scoped queue authorization.
  The service starts dependency-ready selected features sequentially and pauses
  for questions, failures, review, or changed approved scope. Added cards do not
  silently join the queue; restart requires selecting remaining work again.
- Outcome/question notifications use existing Activity, Web Push, and Telegram
  settings. Generic Lead-turn completion alerts are suppressed. Restart
  interruptions appear once without replaying old history.
- Prompt context uses bounded summaries and lazy profile/card reads. Queue
  advancement is deterministic and event-driven, without polling an LLM.
- Board forms now reuse Codex voice transcription for text fields, preserving
  caret position and typed edits. Retry/overflow text stays reviewable; Save
  waits until pending speech is resolved. Microphone stop never submits a form.
- Squad's public demo informed clearer ownership, concise column explanations,
  attention/completion counts, and feature search. Themes and dialogs remain
  consistent with CodexUI.
- Orca's guide and completion/question/receipt source reinforced the existing
  orchestration design. Runs now retain requested model/reasoning settings.
- Native subAgentActivity renders agent names, lifecycle status, and child-chat
  links instead of Unsupported item. Newly created children can open before
  they appear in the sidebar list.
- Phone controls have comfortable touch targets, readable selectors, scrollable
  forms, and a board layout that leaves cards reachable on short screens. The
  sidebar starts closed on mobile instead of covering a fresh board visit.

The underlying durable store, active-thread/turn guards, atomic completion and
QA checks, canonical project lock, native approvals, and development SSE remain.
No database, generic dispatcher framework, or provider layer was added.

## Validation evidence

- Final grouped check: 196 tests passed, production type-check/frontend/CLI
  build passed, and board browser flow passed.
- Headless board browser flow passed: model/effort settings, dependency saving,
  Plan first versus write consent, queue selection, chat plan prefill/source,
  retry without duplicate boards, Activity outcome deep links, preserved
  drafts, ordinary chats, light/dark surfaces, unlisted child-chat navigation,
  integrated field dictation/manual save, and Chromium phone/touch emulation.
- Separate headless chat browser passed: long history scrolling, transcription
  retry, manual Add/Send, original-chat draft preservation, and late microphone
  permission cancellation, plus native subagent events through the live SSE
  consumer and persisted rendering. Screenshots are in ignored output directories.
- Synthetic 2,000-message comparison: about 47,385 → 2,193 DOM nodes,
  2,000 → 6 mounted rich message bodies, and about 97MB → 40MB Chromium heap.
  These are illustrative browser measurements, not total device RAM results.
- Real native app-server 0.153.1 probe passed all four runs: project planning →
  feature Plan first → same-chat execution → automatic dependent execution.
  Both related features finished; the second used the first's exact saved
  handoff. Three thread starts and one resume; gpt-6-astra with low effort.
  It used disposable read-only arithmetic work, not a production writing task.
- Earlier composability probe used a real fresh native reviewer and confirmed
  edited profile instructions on the same resumed Lead chat. It does not prove
  arbitrary nested writer trees.
- Notification delivery/recovery tests use stubs. No real external test message,
  production board mutation, or global configuration change was made.
- Final diff whitespace check and Gitleaks scan passed.
- Isolated field-dictation browser passed caret insertion, concurrent edits,
  retry/cancel, overflow review, delayed permission cancellation, and touch/dark
  layout. Existing chat browser passed again after the shared cancellation fix.
- The installed WebKit test engine crashes even on a blank page. Safari and a
  physical phone are unverified; Chromium phone/touch checks are not a Safari pass.
- After the final mobile CSS correction, the production build and integrated
  browser check passed again. Screenshot review confirmed toolbar labels fit
  and cards remain reachable. The browser opens a card with a touch action.

## Native comparison and references

Inspected integrated Codex 26.901.31953 for final-answer phase, virtualized
content shells, planning/implementation controls, advertised reasoning levels,
theme tokens, and focus restoration. These patterns are recorded in the local
parity skill. Durable boards remain an intentional CodexUI extension.

Official Hermes, OpenClaw, Squad, LangGraph, and Orca references and adopted choices
are in PRD.md and ../UX_BACKLOG.md. They informed the workflow; their maturity is
not evidence that this implementation has identical capabilities.

## Limits that matter

- One orchestrated feature per canonical project directory. Ordinary chats and
  external editors are outside that lock; related writers must be coordinated.
- Active chats retain fetched raw history until switching; the bridge still
  reads the full app-server transcript before paging it to the browser.
- Queues and continuation consent do not survive service restart. Interrupted
  work is blocked for deliberate retry; there is no automatic side-effect replay.
- Existing native chats retain their original dynamic-tool schema. Legacy
  repair uses the documented manual/replan path; new chats support task reopen.
- Independent verification is Lead-driven. The server checks recorded task
  ordering/completion, not that a separate reviewer chat actually ran.
- Project-planning clarification currently stops with an explanation; edit the
  plan and retry. Feature questions use Needs You.
- Closed-browser delivery requires configured Web Push or Telegram and a running
  server. Reminder policies, parallel worktrees, rich specialist telemetry,
  automatic batch QA, immutable profiles, and provider/account rotation are deferred.

## Exact next step

1. Refresh the UI on the user's phone. Start with a chat plan or Plan features,
   dictate the brief, review the cards, and select a small real build with shared
   groundwork and one dependent feature, including a review/fix.
2. Record actual friction before expanding the framework. Preserve the read-only
   scope of automated native evidence; production writing was not tested.
3. Check Safari on a working WebKit host or physical phone. Its current test-engine
   crash is an environment limitation, not a passed compatibility check.
