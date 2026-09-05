# CodexUI next improvements

Recorded 2026-09-05. This is the proposed next scope, not a list of shipped
features. The user requested a small plan followed by real workflow testing.

## Decisions to preserve

- Any reusable agent may lead. The Lead chooses specialists and the verifier.
  Keep the existing independent-verification approach; a required QA selector
  or new reviewer dispatcher is not requested.
- Stopping dictation transcribes into an editable draft. Keep manual Add/Save
  for a selected-text comment and manual Send for the chat.
- Validate coherent features rather than every small edit. Validate earlier
  when another feature needs a proven result.
- Retain native Codex execution and the existing board, chat, and notification
  surfaces. New provider/account support is a later, separate feature.

## Small delivery sequence

### 1. Chat reliability and responsiveness

- **Message order:** reproduce the reported final-answer / “Worked for…” order
  problem. Streaming, completion, reconnect, refresh, and history paging should
  show the same chronology, with one duration separator immediately before the
  correct turn's final answer. Capture an event replay and add a focused
  regression for the demonstrated failure.
- **Long chats:** measure browser memory, rendered message count, typing, and
  scrolling with one representative large transcript on desktop and mobile.
  Keep initial/reloaded history bounded, render a limited window when needed,
  and release inactive chat caches while preserving drafts and scroll position.
- **Dictation polish:** show Recording → Transcribing → Ready and prevent
  annotation Add/Save from discarding speech still being transcribed. Keep text
  editable before submission; include the selection → dictate → stop → Add →
  Send flow in the same UI check.

Read-only triage: the browser already loads the newest 20 turns and pages older
history. The bridge still reads the full transcript before slicing; loaded
messages use an ordinary list and older pages/cached chats remain retained.
Twenty turns can also contain large tool results. These are investigation
points, not a reproduced diagnosis. Start with browser rendering/cache bounds;
migrate server pagination only if measurements justify it.

Ordering investigation: live arrival counters and persisted item indices can
differ; the duration separator currently targets the last assistant message,
with a fallback across turns. Check `useDesktopState.ts`, `api/normalizers/v2.ts`,
`ThreadConversation.vue`, and `codexAppServerBridge.ts` before choosing the fix.
Inspect the installed Codex equivalent before implementing UI behavior.

### 2. Per-feature model and reasoning controls

- Reuse the ordinary chat's model/effort picker and advertised supported values.
- Default to **Use Lead settings**; resolve an unset model through the app's
  configured default. Show the effective model and effort before starting.
- Save optional overrides on the feature without editing the reusable agent.
  Apply them on start and subsequent continuations, never halfway through a run.
- Label these as the feature Lead's settings. Specialists retain their own
  profile settings where native delegation supports them; do not imply a Lead
  override changes every child or supports another provider.
- Explain an unavailable model or unsupported effort and let the user choose a
  supported value. Do not silently substitute an explicitly selected model.

### 3. Make planning and related features understandable

- Keep **Plan & start** for a straightforward brief. Add **Plan first** for work
  the user wants to review before implementation. A planning run must not execute
  implementation tasks; **Start work** resumes the saved plan in the Lead chat.
  Plan review is an optional path, not a mandatory approval after every task.
- Accept an existing plan in the feature brief or a referenced project file.
  Have the Lead read it explicitly and show the resulting task list. Do not
  imply another chat or an unreferenced document is automatically imported.
- Add a simple **Depends on** picker using the existing dependency model.
  Give the Lead a compact view of relevant features and dependency outcomes,
  including what changed and what was checked. Current context omits sibling
  feature summaries, so the Lead cannot reliably coordinate the whole board yet.
- Before starting related work, check for duplicate scope or shared groundwork.
  Offer to combine tightly coupled work, or order separate features around one
  shared prerequisite. Keep one active board feature per project folder.
- Show why work is waiting and the explicit next action. Finishing one feature
  must not imply the next feature was automatically started.
- Preserve completed work when plans change. The current wholesale plan
  replacement is rejected after execution starts. Support a small follow-up
  feature or a bounded change to remaining tasks; do not erase past handoffs.

## Practical workflow contract

| Situation | Current behavior / smallest useful improvement |
|---|---|
| Clear small request | Brief + Done when → Plan & start → Lead does or delegates work → feature-level check. |
| Plan already exists | Put it in the brief or reference its project file; the Lead reads it and makes durable tasks. A normal chat plan alone does not populate the board. |
| Explore before building | Proposed Plan first → review/edit the plan → Start work. Today planning and execution share one action. |
| Features overlap | Today no semantic overlap detection exists. Board execution serializes features in one project; ordinary chats/external editors are outside that lock. Proposed dependency UI and shared context make sequencing explicit. |
| Shared foundation | Build it once as a prerequisite, then dependent features reuse its files and handoff. Strongly coupled edits may stay in one larger feature with one final check. |
| Specialist needs a decision | Specialist returns the question to the Lead → Needs You → user answers → continue when automatic continuation is enabled, otherwise Start explicitly. |
| Review fails or scope changes | Record findings and repair the relevant work before checking again. Preserve history; explain any manual retry needed by current state guards. |
| Run is interrupted | Saved tasks remain; unfinished active work becomes Blocked. Review partial work and explicitly retry rather than silently replaying side effects. |

Handoffs should stay short: task, relevant context, completion criteria, result,
files/output, checks, and unresolved issues. The Lead integrates the result and
records it on the board. Independent specialists may read/research in parallel;
shared project edits stay sequential. Recheck affected behavior after a later
feature changes code an earlier feature relied on; Done is evidence at that time,
not a guarantee against future regressions.

### 4. Notification and activity polish after the core workflow

Route board decisions through existing notification delivery, including a
closed-browser option, then add completion/failure notices and a compact
“who is working / what happened / what is next” trail. Reuse exact question links,
deduplication, and existing notification preferences. Do not build another inbox
or promise every intermediate agent event deserves an alert.

## Real workflow testing after implementation

Use a disposable project for one small build and one pair of related features:
shared groundwork → dependent change → final integration check. Exercise a
user-supplied plan, optional plan review, a clarification, a failed review/fix,
and an interrupted retry. Verify model/effort on actual native runs. Separately
replay the ordering failure and browse one large synthetic chat, including
selection/dictation and refresh/reconnect. Measure before/after memory and record
what actually passed. Do this at feature boundaries; add only regressions tied
to failures or new behavior.

## Patterns to borrow, without adding a framework

- [Hermes Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban):
  explicit dependency links, persistent tasks, and comments as handoff context.
- [LangGraph workflows](https://docs.langchain.com/oss/python/langgraph/workflows-agents):
  a coordinator divides work and combines results; a reviewer returns feedback
  for another revision when the result misses the acceptance criteria.
- [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts):
  save the work state, present the exact decision, and resume that same work.
- [Squad missions](https://squad.so/resources/docs/missions-board):
  clear ownership, a readable progress trail, and decisions attached to work.

These documented patterns inform the proposal; their documentation does not
prove this implementation is battle-tested. No framework migration, automatic
multi-account rotation, concurrent writer fleet, organization-chart editor,
mandatory reviewer selector, or large test matrix belongs in this next cycle.
