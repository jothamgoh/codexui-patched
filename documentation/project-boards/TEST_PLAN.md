# Project Boards verification

Revised 2026-09-05. Protect behavior with focused scenarios, not an exhaustive
framework matrix. PROGRESS.md records which checks actually passed.

## When to validate

Develop a coherent feature/fix group, then validate. Check earlier for dependent
contracts, material risk, or a failure that needs isolation.

| Command | Purpose |
|---|---|
| npm run test:project-boards | Focused store/service/model/notification diagnosis. |
| npm run check:project-boards | Full tests, production build, board browser flow. |
| npm run test:e2e:project-boards | Browser-only rerun after a UI correction. |
| node tests/chatReliability.e2e.mjs | Chat rendering/dictation stress and interaction checks. |
| node tests/boardDictation.e2e.mjs | Isolated text-field speech insertion/retry/cancel/overflow checks. |

npm test already includes focused board tests and notification routing/delivery
regressions. Do not repeat equivalent suites at an unchanged boundary.

## Behavioral coverage

- Durable serialized mutations, input guards, capacity errors, and recovery.
- Exact profile assignments, current prompts on resumed chats, active-thread/
  turn ownership, dependencies, questions, and final verification ordering.
- Plan first prevents implementation; project planning saves related cards
  atomically/idempotently and preserves existing completed work.
- Queues start only approved dependency-ready cards, pause for attention, reject
  changed scope, and resist pause/start races. Restart clears continuation consent.
- Available model/default resolution and rejection of unsupported explicit choices.
- New task repair preserves handoff history and requires affected dependents to
  be reopened before their prerequisites.
- Meaningful board outcomes enter existing history/delivery once, suppress
  generic Lead completion, and handle recovery ordering without replaying history.
- Final-answer grouping, pagination, draft preservation, and dictation cancellation.

Use temporary state/project directories and fake execution/delivery for these
tests. Never send real external notifications or touch production board state.

## Browser verification

The board smoke uses a disposable real bridge/store with synthetic state and
intercepted native Start/Plan/Queue calls. It covers forms and errors, question
links, profile prompts, dependencies/model settings, planning/write consent,
chat-to-board source/prefill/retry, Activity navigation, routes, focus,
light/dark dialogs, and contained mobile scrolling. A separate phone/touch
context checks a fresh visit, readable toolbar controls, reachable cards,
44px microphones, manual voice-field saving, and fixed dialog headers while
forms scroll. Chromium is the default; CODEXUI_MOBILE_BROWSER=webkit opts into
the Safari engine on a supported host. Neither is a physical-device test.

The separate isolated chat fixture renders 2,000 synthetic messages and verifies
scrolling, limited rich-content mounting, selected-text dictation/retry, manual
Add/Send, original-chat draft retention, and late microphone permission handling.
It also exercises native subagent activity through the actual live SSE consumer,
persisted rendering, lifecycle labels, and child navigation without JSON dumps.
Browser heap numbers are illustrative, not total hardware memory measurements.

The field-dictation fixture tests caret insertion, simultaneous typed edits,
retained audio retry, overflow review, cancellation, late permission responses,
manual saving, and touch/dark layout. The integrated board flow additionally
checks that microphone stop cannot create a plan or discard pending speech.

Inspect screenshots under ignored output/project-boards,
output/board-dictation, and output/chat-reliability. Behavioral assertions and visual review complement
each other.

## Real native execution

Keep a separate bounded disposable probe. Current evidence covers project plan →
two related cards → read-only Plan first → same Lead chat implementation →
automatic dependent execution using the first saved handoff, with native
model/effort checked. Earlier evidence covers a real fresh verifier and profile
edits on a resumed chat.

This read-only arithmetic probe does not prove production writing, arbitrary
parallel writers, deeply nested trees, or real closed-browser notification
delivery. The next practical dogfood is a small repository change and dependent
feature with one review/fix. Record real friction and add only useful regressions.

## Release

Review diff/status, scan secrets, commit discrete work, push main, verify CI,
and use the authorized local restart/health workflow. Passing simulated checks
must never be described as evidence of a production action.
