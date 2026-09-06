# Project Boards progress

Updated: 2026-09-06

Board-planning runtime baseline: released through 2cb29f5. Main was published, CI passed, the verified
frontend/CLI build was deployed, and one authorized independent-Terminal
restart completed. Post-restart bridge, boards, models, and pending-request
endpoints returned healthy responses; no runs or native requests were left
active. The public UI and API still redirect through the authenticated gateway.
A real run waiting at an invisible native test approval was stopped at the
user’s request; its saved rendering work has now been reviewed in the follow-up below.

## Current follow-up

- Completed Lead chats accept ordinary follow-up messages. A tracked
  Conversation uses the same chat/model while preserving Done, the original
  result, and the board execution slot for other work. Requested changes reopen
  through the Lead's board tool with dependency/access checks. Stop, failure,
  plan events and restart leave unpromoted completed results intact. Regression
  checks cover promotion racing Stop/exit and replacement lock ownership.
- All work now has loading feedback and a refresh action on screen-load failure.
  Aborting the production lazy chunk reproduced the reported blank screen;
  a fresh real-board navigation also succeeded. The main composer hides routine
  recording prose while retaining accessible state, Stop/Cancel, errors and Retry.
- All five maintained agent profiles now apply the researched product, UX,
  engineering, QA and orchestration principles proportionally. Use each project's
  established stack; coordinate overlapping files/shared state while permitting
  independent work. Existing board rosters reuse these maintained profiles on
  reload; custom profiles remain unchanged. No separate migration framework.
- Current release checks: all 262 unit tests, production frontend/CLI build,
  and Gitleaks pass. Full desktop/touch-mobile board, board/chat, and long-chat
  dictation journeys passed, with screenshots inspected. An independent review
  reproduced and then verified the repaired promotion race. Model/audio browser
  responses are synthetic; physical iPhone Safari remains unverified.
  Backend restart is explicitly authorized after publication and CI; deployment
  verification is pending. Current production boards have no active runs.

- Independent boards now apply globally: any folder can hold multiple boards
  running alongside one another. Each board still permits one active feature
  or dedicated planning run. Service reservations, atomic store guards, queue
  controls and live Lead links use board IDs, with no data migration. Tests
  cover same-folder/path-alias starts, concurrent queues, separate Stop ownership,
  and restart cleanup. Optional board planning is advertised on ordinary starts,
  steering and managed Lead turns; any chat can save a separate board draft.
  A Lead's chat keeps its current run controls and also shows review links for
  separate boards it planned, including in the header menu.
  Existing project identity, version checks, active-board guards and explicit
  planning opt-in remain. Related work stays on one board; separate boards share
  files and have no automatic cross-board dependency or worktree isolation.
  All 257 unit tests and the production build pass. Full desktop/touch-mobile
  board and chat journeys pass, including independent queue controls and exact
  Lead-created board navigation. Physical iPhone Safari remains unverified.
  This backend change is included in the authorized release described above.

- Board controls follow-up: mobile option actions use two columns and grow to
  fit wrapped labels. Feature details expose Model & reasoning directly, opening
  the existing model picker first while retaining source inheritance and active
  run/question edit guards. Board options now includes confirmed deletion of
  board metadata; project files, native chats and agent profiles remain.
  Lead Plan only/Continue work controls are visible and reversible for the next
  message, and dedicated planning chats explain their purpose and link back to
  the original chat. Frontend-only changes require a browser refresh, not another
  interruption of running Leads. All 253 unit tests, production build, secret scan,
  and the full desktop/touch-mobile board and chat journeys pass. Checks cover
  button text bounds at 320/390/640px, saved model overrides/reset, active-work
  guards, isolated board deletion, and reversible reply modes without sending or
  losing drafts. The live board's mobile options and deletion guard were also
  inspected without changing its work. Physical iPhone Safari remains unverified.

- Model and question follow-up implemented and validated: omitted model/reasoning fields independently inherit source-chat
  metadata, explicit card/profile settings survive, and blank specialists inherit
  their Lead. Both planning paths accept explicit overrides. Native questions
  are enabled for supported, configurable board sessions with the existing
  durable fallback retained. Runs read back native model/reasoning after launch;
  the Lead chat and feature details distinguish Requested from Confirmed by
  Codex, and current from last-run settings. All 251 unit tests, production build,
  secret scan, and the desktop/touch-mobile board and chat journeys pass.
  Published through 6951878; CI 34019855561 passed. One independent-Terminal
  restart completed and local API health/public authentication were verified.
  The requested Lead resumed in the same chat with Full access; native metadata
  and the live mobile header both confirm Astra/xhigh. Its two completed tasks
  remain done and its remaining verification is running. Other feature cards
  remain backlog and inherit the same source settings when explicitly started.
  Do not repeat the restart/resume or create replacement cards.

- Work overview now collects requests, current Leads, results and board progress
  across projects. Activity separates Board work from Chats running and keeps
  questions first. Existing-board planning names its destination; the larger-plan
  handoff keeps the selected board and deliberate brief. Titles/names are optional.
  The desktop header keeps the card controls; project/board navigation, permissions,
  planning and agent management sit under Board options. A settled 1280×600 browser
  check reaches the last card through normal wheel scrolling. Phone cards stack,
  and recording fields show only a compact status with Stop/Cancel. Screenshots
  were inspected in both themes and touch Chromium; physical iPhone Safari is
  still unverified. Sidebar layout is unchanged. These changes are deployed.

- New question-format follow-up: a real newly created chat returned native
  agentMessage delivery=async with structured questions, but the frontend dropped
  those fields and displayed its fallback bullet text. The frontend now preserves
  those fields through live events and history reload, renders selectable answers
  with custom text/dictation, and sends the native structured chat reply. Accepted
  answers survive reload; failed sends preserve the draft. Desktop/touch-mobile
  question journeys and all 253 unit tests pass. The existing question setting
  alone cannot fix this renderer gap. This correction needs only a frontend
  build/refresh, with no further interruption of the running board Lead.

- Full access is now the saved board execution default for new and existing
  boards without an explicit setting. Board options can retain Project access;
  starts, selected batches, and idle Lead replies carry the displayed choice.
  Queues/continuations retain their accepted permissions; stopping or restarting
  still revokes continuation. Planning always sets read-only permissions.
  Native isolated tests proved a loaded chat needs a per-turn permission override:
  Full access wrote outside its project with zero approvals, and the next planning
  turn denied writes again. Full tests/build and desktop/mobile browser flows
  passed. This backend change is deployed, and the requested same-chat Lead
  resume with source model/reasoning inheritance is verified above.

- Mobile review flow: Board options collapses management controls; phone cards
  form one vertical list with a status filter. Finished feature details lead
  with the result and keep the Lead review action in the footer; editing, status,
  and deletion live under feature settings. Active requests/runs take priority
  over saved card labels and completion counts. Desktop and touch Chromium board
  journeys passed navigation, filters, review, voice/manual save, stop/delete,
  consent preservation, and responsive layout. These frontend changes are served
  on refresh and require no interruption of the user's resumed Lead.

- Approval visibility: pending native requests now stay mounted at the chat tail
  while history loads, with a waiting label instead of Thinking. Command, folder,
  reason, retry state, and phone-sized buttons remain reachable after hydration
  and scrolling. Only decisions advertised by the request are offered; legacy
  payloads retain their existing choices. No automatic approval is introduced.
  The existing long-chat browser journey covers empty/loading/full history,
  exact replies and retries. The real pending Lead approval was also observed
  after mobile Chromium reloads without answering it. Full tests/build passed;
  local WebKit crashes on app navigation, so iPhone Safari remains unverified.

- Active-run queue entry: the remaining cards no longer offer an invalid start
  while the board already has work running. The board and open dialog
  name the active feature and link to its Lead. Selection/consent stay intact;
  finishing the active run does not auto-start another queue. The existing full
  board browser journey passed same/other-board and late-arriving-run
  checks, explicit/implicit submission, completion, and mobile layout. This is
  a frontend correction; it does not alter or restart the user's running work.

- Startup and remaining blank-tail fix: use the native indexed chat catalog
  (same 100 summaries, no message bodies), open the routed chat without waiting
  for sidebar/account/skills, and load five recent turns with older pages on
  demand. Workspace skills stay scoped; early sends retain model/reasoning/speed
  choices. Streaming deltas update memory without repeated history downloads.
  Optional hub screens load their own code/styles when opened.
- Reproduced the desktop blank bottom with batched real visibility records: the
  old handler applied an obsolete off-screen record and left visible replies as
  empty shells. Applying the latest record fixes that case. This is distinct
  from the earlier history/scroll races below. All 242 unit tests, production
  build, desktop/Chromium touch chat workflow, and the existing 2,000-message
  rendering/voice journey passed. Physical iPhone Safari remains unverified.

- Long-chat rendering: reviewed the saved Lead changes and fixed a confirmed
  overlapping cold-read race that discarded earlier text/summaries/pagination.
  Completed work rows remain until matching history arrives. Browser clamping
  and viewport changes no longer masquerade as upward user scrolling; deliberate
  history reading remains respected. The original saved scroll patch failed a
  real composer-resize check; the additional viewport guard fixes that case.
  All 237 unit tests, production build, and the existing browser journey passed,
  including three delayed 2,000-message reloads with complete final text and
  formatting, bounded mounted bodies, desktop/phone resizing, history reading,
  live activity, and voice drafts. The redundant mocked-observer test was omitted.
  Built frontend assets are available on refresh; no backend restart is needed.

- Optional same-chat board planning is implemented: ask to put a plan in a board;
  the current chat saves/revises draft cards through a bundled metadata-only
  skill. Ordinary planning stays in chat. Review board links show exact source
  boards, progress, and completed results; the composer stays ordinary. Existing
  feature/selected-queue controls start implementation after review.
  Atomic versioned saves preserve omitted/started work, stable IDs avoid retry
  duplicates, native thread lookup scopes the project, and reads are paged with
  full detail fetched only when needed. No global skill/config installation.
  Store/helper checks, isolated bridge create/revise/replay flow, independent
  helper forward-test, and desktop/Chromium touch result-review journeys passed.
  A real loaded native chat with a scripted local provider preserved the skill
  pointer, exact chat/connection, prior context, model, and reasoning; no model
  service call or tool execution was involved. Full 233 tests/build and Gitleaks
  passed. Main was published and CI run 34007893126 passed. The committed build
  and bundled skill were deployed through one authorized Terminal restart.
  Post-restart bridge, boards, models, and pending-request endpoints returned
  healthy responses; the deployed helper resolved the exact source chat/project.
  No board runs or native requests remained active. Public UI/API still redirect
  through the authenticated gateway. The rendering edits were preserved then
  and subsequently reviewed in the rendering follow-up above.

Next: dogfood one real user-selected plan through review, execution, and result
review. Improve demonstrated friction before adding more orchestration. Ordinary
planning remains in chat unless the user explicitly requests a board.

- Board-icon correction: Open project board browses existing work; Track on
  board opens the creation form. The brief uses only the unsent draft and
  selected text, including selection comments, or starts blank. Casual replies
  are no longer reused as feature descriptions/titles. The redundant title
  preview line was removed. Desktop/Chromium touch checks cover navigation
  without creation, blank-state submission protection, explicit draft/selection
  context, and the existing voice/retry workflow.

- Chat is the working view; the board is the overview. Track on board creates
  a feature with an optional generated title and a distinct, linked Lead chat.
  Large-plan entry still proposes multiple cards. Voice retains manual save.
- Individual starts open the Lead; selected batches stay on the board. Sidebar,
  header, card, and Activity links retain feature identity and title.
- Managed replies steer the exact active turn or start a guarded tracked run
  in the same chat. Discussion preserves Done; requested repair reopening
  preserves prior work. Failed or delayed
  sends retain drafts and cannot affect another chat's composer.
- Activity exposes working Leads and native approvals, even before ordinary chat
  listing catches up. Feature results open their Lead. Selected queue outcomes
  stay in history quietly and the final batch emits one summary.
- Stop shows the reason for waiting, revokes continuation consent, and confirms
  that the exact Lead and owned native subagents ended before releasing the
  board lock. Failure/uncertainty keeps Delete disabled with retry guidance;
  a stale Stop cannot cancel a replacement run. Confirmed Stop clears pending
  approvals even if a native completion event was missed. Deletion preserves
  code files and the Lead chat; it does not fabricate answers.
- Native Lead approvals/questions use configured device notification channels,
  resolve on answer/cancel, and agree across Activity, board counts, and Needs
  You. Explicit user stops are quiet; unexpected interruptions still alert.
- Final checks passed: 226 unit tests, production type-check/frontend/CLI build,
  isolated full-bridge browser flow, desktop/Chromium touch chat workflow, and
  Gitleaks. Browsers cover optional titles/voice, retry without duplicate cards,
  source/Lead navigation, approvals/results, rename, delayed draft retention, a
  second feature from the same chat, Stop failure/retry, and delete preserving
  files. Pending approval counts/Needs You agree and open the exact Lead.
- Physical Pixel 8a Chrome passed real microphone recording/upload, synthetic
  transcript insertion, blank-title manual creation, Lead/approval navigation,
  failed Stop retaining Delete protection, successful retry, and deletion
  retaining the code file. No horizontal overflow at 411px. The discovered board
  approval-count inconsistency was fixed and rechecked in Chromium touch; that
  final count change was not rechecked on the physical device. All temporary
  device tabs, forwarding, captures, and fixture processes were cleaned up.
- New evidence lives in ignored output/board-chat-flow/ and
  output/android-chat-flow/. These workflows used isolated fixture responses
  and no external notification delivery. Physical iPhone Safari remains
  unverified; Android and Chromium touch are not a Safari pass.

## Goal and decisions

Make larger builds easy to steer from a chat or board: plan, review feature
cards, run useful work, see results, and answer focused questions. Reuse native
Codex execution and the existing Vue/Reka framework. Validate coherent features,
earlier only when a dependency or material risk requires it.

Any reusable agent can lead or delegate; delegation is optional. The Lead chooses
a fresh verifier for independent QA. There is no mandatory reviewer selector or
separate reviewer-launch service. Voice input always keeps manual Save/Add/Send.
Multi-account/provider execution remains separate future work.

## Working capabilities

- Chat → editable project plan → read-only coordinator → distinct feature cards
  and dependencies. Retry preserves the draft and reuses the newly created board.
- Feature Plan first saves tasks without implementation. Start work resumes the
  same Lead chat; Plan & start remains available for a clear brief.
- Optional per-feature model/reasoning overrides inherit source-chat settings
  after any explicit Lead profile setting. Agent
  profiles expose their own settings; supported choices come from the runtime.
- A selected, sequential delivery queue starts dependency-ready features and
  pauses for questions, failure, review, or changed approved scope. Shared
  groundwork has one prerequisite card and a compact saved handoff.
- Task repair preserves previous handoffs, reopens affected work, and requires
  fresh verification after changes. New chats support the repair tool schema.
- Activity and existing Web Push/Telegram settings carry meaningful outcomes.
  Generic Lead-turn completion is suppressed; interrupted runs remain visible.
- Board text fields use Codex transcription, with caret insertion, preserved
  typing, retry/cancel, reviewable overflow, and pending-speech save guards.
- Heavy offscreen chat bodies unmount; markdown and inactive-history caches are
  bounded. Native subagent activity has names, status, and child-chat links.
- Board/Needs You/Runs views expose work, decisions, blockers/review, and run
  receipts with exact feature/question/chat navigation. Phone forms and controls
  remain usable with touch, keyboard, voice, and both themes.

## Previously delivered reliability work

- Delayed history cannot replace newer streamed text with an empty/partial
  snapshot. Hydration preserves subsequent deltas and one message per ID, keeps
  final-answer order, and respects authoritative completion and rollback.
- Phone-width and composer-height changes keep the latest reply visible while
  following the bottom. Deliberately reading older history keeps that position.
  The existing heavy-content windowing remains; no renderer rewrite was needed.
- Pending automatic continuation retains its originating queue identity. Pause,
  replacement, failure, or app-server exit cannot authorize a late start or let
  an old rejection block a replacement queue.
- Turning off Continue within features revokes pending continuation consent,
  including starts waiting on model metadata. An already active turn finishes;
  an idle queue waiting to continue pauses. Restart still clears consent.
- Starter Lead/Product/Design/Engineer/QA prompts now give practical role,
  delegation, proportional verification, and repair guidance. Built-in text is
  maintained by the app; user-customized copies retain their saved instructions.
- Native chat questions now show option descriptions, recommendations, progress,
  Other/free text, voice, explicit Submit, retry, and preserved drafts. Secret
  answers stay masked and do not offer voice. Replies use the native request;
  questions do not bypass approvals or turn ordinary prose into a form.
- Tools → Settings → Questions in new chats is capability/managed-policy gated,
  browser-local, and default on. It applies only when creating ordinary chats;
  loaded chats retain native configuration. Unit/browser checks and a real
  app-server request/reply probe passed.
- Notification storage now respects CODEX_HOME. Browser fixtures also use an
  empty explicit environment file, isolated push state, and no delivery
  credentials, and assert zero subscribers before interactions.

## Correction: notification test isolation

Earlier progress incorrectly stated that no real external test messages were
sent. Disposable board fixtures isolated CODEX_HOME but loaded the real default
Web Push subscribers; restart recovery produced real “Board run stopped” alerts
with fixture-only links. The user reported these alerts. Production board data
was not mutated. The fixture environment and notification storage defaults were
corrected; subsequent phone/browser checks used verified zero-subscriber state.
Do not erase real notification history as part of test cleanup.

## Earlier evidence and its limits

- Final grouped check after the viewport fix: 209 tests, production type-check/
  frontend/CLI build, and isolated Board/Needs You/Runs browser flow passed.
  Diff whitespace review and Gitleaks scan passed.
- Five actual-state delayed-response regressions and independent review passed:
  stale/empty/reordered history, continued deltas, item identity, completion,
  lifecycle freshness, and rollback. Chat browser checks passed actual tail
  visibility through phone/composer resizing, history remounts, chat switches,
  and incoming messages, while preserving deliberate reading in older history.
  Screenshot review exposed the resize defect and confirmed the corrected tail.
- Final question browsers passed descriptions, free text/voice, explicit reply,
  retry/replay, resumed messages, masked secrets, mobile layout, and the new-chat
  setting's default, persistence, capability/policy gates, and unchanged pending
  requests.
- Two disposable real-write native probes passed with gpt-6-astra/low, including
  the new built-in prompt copies. Each planned two dependent features, used
  read-only Plan first, wrote a parser and CLI, and finished four native runs.
  Fresh QA found an injected uppercase-X/trimming defect; the Lead preserved two
  repair records, fixed it, and obtained a new review. Each probe passed the
  combined parser/CLI tests 8/8. The second recorded three starts, one resume,
  and 26 native agent events. Processes stopped and temporary auth links were removed. This is real
  disposable writing/review evidence, not a production deployment.
- Earlier native arithmetic evidence also passed project planning → feature
  planning → same-chat execution → dependent execution using the saved handoff.
- Real Pixel 8a Chrome passed microphone permission/recording/upload, insertion
  into a feature title, phone-keyboard editing, manual save to Backlog, exact
  Needs You question navigation, question voice cancellation, and Runs→feature
  navigation. Audio was real and discarded in memory; transcription text was a
  synthetic fixture response. Test tab, forwarding, temporary boards, and managed
  captures were cleaned up; the display was put to sleep.
- Representative non-sensitive Android evidence is under ignored
  output/android-project-boards/. Other browser evidence is under
  output/project-boards/, output/request-user-input/, output/board-dictation/,
  and output/chat-reliability/. Inspect assertions and screenshots together.
- Synthetic 2,000-message checks reduced roughly 47,385→2,193 DOM nodes,
  2,000→6 mounted rich bodies, and 97→40MB Chromium heap. This is illustrative
  browser memory, not total device RAM. The user's latest report exposed two
  separate defects—delayed-history replacement and bottom-follow loss on resize—
  now covered by state and browser regressions.
- The local WebKit engine crashes even on a blank page. Physical iPhone Safari
  remains unverified; Android and Chromium emulation are not a Safari pass.

## Boundaries to retain

One orchestrated feature runs per canonical project directory; ordinary chats
and external editors are outside that lock. Queues/consent do not survive
restart. Legacy chats retain their original dynamic-tool schema. Independent QA
is Lead-driven: the server checks recorded ordering/completion, not independent
proof that a reviewer chat ran. Active chats retain fetched raw history, and the
bridge still reads the full native transcript before browser paging.

Native clarification pauses the Lead/planner for an answer when supported;
older project-planning sessions fall back to an explanation and retry. Durable
feature questions use Needs You. Closed-browser delivery requires configured
Web Push/Telegram and a running server. No database, second runtime, generic
workflow engine, LLM polling, automatic batch QA, or provider rotation was added.
References and adopted choices remain in PRD.md and ../UX_BACKLOG.md.

## Exact next steps

1. Refresh a long desktop conversation and check the previously missing text;
   capture any remaining distinct failure before changing the renderer further.
2. Dogfood an explicitly requested board plan → review/revise cards → selected
   feature execution → result/check review. Existing stopped features can be
   deleted after their run is confirmed stopped.
3. Verify physical iPhone Safari. Keep provider rotation, scheduling, and
   automatic batch QA separate unless a real workflow needs them.
