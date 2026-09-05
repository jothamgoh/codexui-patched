# Project Boards progress

Updated: 2026-09-06

Status: follow-up implementation and verification are in progress. The previous
release through 9523339 was deployed and its CI passed; the changes below are
not yet a completed release. A newly reported stale-history/final-message
regression still needs its fix and final checks.
Final grouped validation, push/CI, restart, and health verification remain.

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

## Follow-up changes in this checkout

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

## Evidence and its limits

- Focused queue/continuation, storage-isolation, starter-prompt, and question
  regressions passed. The Board/Needs You/Runs browser check and type-check
  passed; final integrated validation after outstanding fixes is still due.
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
  browser memory, not total device RAM. The user's latest stale-message report
  found a separate delayed-history overwrite race; its fix is under validation.
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

1. Finish the delayed-history/final-message regression fix and its targeted
   replay/viewport check. The new-chat question setting checks have passed.
2. Run one final coherent validation boundary, review screenshots/diff/status,
   and scan secrets. Update this file with actual results, not planned claims.
3. Commit discrete changes, push main, verify CI, then use the authorized
   machine-local independent-Terminal restart and verify health after reconnecting.
4. Dogfood a real user project and check physical iPhone Safari when available.
   Add only regressions that explain observed friction; do not expand the framework.
