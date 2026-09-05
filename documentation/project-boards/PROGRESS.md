# Project Boards progress

Updated: 2026-09-06

Status: chat/board follow-up is verified through 402bb83. Publication and the
authorized independent-Terminal restart remain to do; the previous release is
still deployed. Preserve the stopped Lead’s uncommitted
message-display edits in the main checkout; they are separate from this release.
A real run waiting at an invisible native test approval was stopped at the
user’s request; its code edits remain saved.

## Current follow-up

- Chat is the working view; the board is the overview. Track on board creates
  a feature with an optional generated title and a distinct, linked Lead chat.
  Large-plan entry still proposes multiple cards. Voice retains manual save.
- Individual starts open the Lead; selected batches stay on the board. Sidebar,
  header, card, and Activity links retain feature identity and title.
- Managed replies steer the exact active turn or start a guarded tracked run
  in the same chat. Explicit reopening preserves prior work. Failed or delayed
  sends retain drafts and cannot affect another chat's composer.
- Activity exposes working Leads and native approvals, even before ordinary chat
  listing catches up. Feature results open their Lead. Selected queue outcomes
  stay in history quietly and the final batch emits one summary.
- Stop shows the reason for waiting, revokes continuation consent, and confirms
  that the exact Lead and owned native subagents ended before releasing the
  project lock. Failure/uncertainty keeps Delete disabled with retry guidance;
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
- Optional per-feature model/reasoning overrides inherit Lead settings. Agent
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

Project-planning clarification stops with an explanation and retry; durable
feature questions use Needs You. Closed-browser delivery requires configured
Web Push/Telegram and a running server. No database, second runtime, generic
workflow engine, LLM polling, automatic batch QA, or provider rotation was added.
References and adopted choices remain in PRD.md and ../UX_BACKLOG.md.

## Exact next steps

1. Integrate the isolated branch without committing or losing the stopped
   Lead’s saved edits. Publish main and verify CI. Deploy the already-built
   committed source separately from those unrelated uncommitted edits.
2. Perform one authorized independent-Terminal restart after release checks,
   then verify local health and authenticated public access after reconnecting.
3. Dogfood one small feature through the new chat flow. The stopped Lead’s
   saved bug-fix edits still need their own review/verification before release.
   Physical iPhone Safari remains unverified. Keep provider rotation, scheduling,
   and automatic batch QA separate unless a real workflow needs them.
