# Project Boards implementation

Scope revised: 2026-09-06. PROGRESS.md owns release status and actual evidence.

## Architecture

| Module | Responsibility |
|---|---|
| types/projectBoards.ts | Shared records and inputs. |
| server/projectBoardStore.ts | Serialized validation, transitions, persistence, handoffs. |
| server/projectBoardService.ts | Native Lead/planner runs, bounded tools, dependency queue, lifecycle. |
| server/projectBoardModels.ts | Advertised model capabilities and execution validation. |
| server/codexAppServerBridge.ts | HTTP, bounded source-chat context, app-server events. |
| server/turnNotificationRouter.ts | Board outcomes through existing durable notification sinks. |
| api/projectBoards.ts and composables/useProjectBoards.ts | Browser requests, snapshots, live updates. |
| components/content/ProjectBoardsHub.vue and BoardDailyViews.vue | Cards, decisions, run receipts, profiles, planning, queue controls. |
| components/content/BoardPlanDialog.vue and TrackFeatureDialog.vue | Multi-card planning or a single tracked feature, with voice and preserved retries. |
| App.vue, SidebarThreadTree.vue, and NotificationSettingsButton.vue | Linked chats/cards, selected-chat visibility, working/attention/result navigation. |
| components/content/BoardExecutionSettings.vue | Inherited or explicit supported model/reasoning settings. |
| components/content/DictationField.vue | Reusable speech insertion, retry, overflow review, and manual-save state. |
| components/content/RequestUserInputCard.vue | Native question choices, drafts, manual replies, and retry. |
| components/content/QuestionSettingControl.vue and composables/useQuestionPreference.ts | Capability/policy-gated browser preference for newly created ordinary chats. |
| api/subAgentActivity.ts and components/content/SubAgentActivityCard.vue | Shared native activity normalization and child-chat presentation. |

All paths are under src/. Reuse Vue/Reka, Express, native threads/turns, existing
notification history/delivery, and native approvals. There is no second runtime,
database migration, generic policy layer, or LLM polling dispatcher.

## Implemented delivery groups

1. Durable state and native execution: exact agent IDs, current prompts on every
   turn, atomic completion/dependency/QA guards, question provenance, canonical
   project locks, interruption recovery, and explicit workspace-write consent.
2. Chat reliability: stable turn/final ordering, heavy-content windowing, cache
   limits, transcription retry, and original-chat draft preservation.
3. Planning and delivery: project plan import, read-only feature planning,
   model/effort overrides, visible dependencies, compact handoffs, history-aware
   task repair, and an explicitly selected sequential queue.
4. Notification integration: meaningful committed outcomes use existing Activity,
   Web Push, Telegram, preferences, and deduplication; interrupted runs notify once.
5. Everyday usability: voice fields, native question cards, readable subagent
   activity, requested run settings, Board/Needs You/Runs views, and phone layouts.
6. Follow-up hardening: queue identity and consent checked across async waits,
   notification storage/fixtures isolated, and useful starter guidance with
   preserved custom copies. Current remaining fixes are tracked in PROGRESS.md.

7. Chat-centered board work: automatic editable titles, source links, selected
   Lead reveal, active/idle managed replies, exact native approvals, result links,
   and one selected-batch summary. No polling agent or new orchestration layer.

Context reads are compact by default. New native chats expose lazy read_agent
and read_card; legacy chats keep their existing tool schema and compatibility
context. A completed planner save is idempotent within its run. Queue approval
freezes selected card scope and is checked again atomically before execution.
Pending continuation also checks its original queue and current consent after
async waits; pause, replacement, failure, or disabling continuation must win.
An active turn is allowed to finish. Starter profiles are app-maintained text;
customized copies retain their own identity and saved instructions.

## Development and verification

Work on coherent groups and agree API contracts before parallel implementation.
Validate earlier only when downstream work needs a proven dependency or a
failure needs isolation. Preserve unrelated changes and commit discrete tasks.

At a release boundary:

1. Run npm run check:project-boards (tests, type-check/build, board browser).
2. Run the relevant chat/question/voice browser fixture when its behavior changed.
3. Inspect representative light/dark/mobile screenshots.
4. Review diff/status and run Gitleaks.
5. Commit, push main, and verify GitHub Actions.
6. Use machine-local deployment instructions for any required restart, through
   the authorized independent Terminal handoff. Verify health after reconnecting.

Do not rerun all checks after every small edit. A relevant failure or correction
justifies repeating the affected checks. Keep delivery stubs, synthetic browser
stress, disposable native write/review execution, physical-phone checks, and
production release evidence distinct. Bridge fixtures must isolate notification
state and environment loading, not just board data; see TEST_PLAN.md.

## Deliberate limits

One orchestrated feature per project; session-scoped queues/consent; blocked
restart recovery; mutable profiles; no automatic batch QA or provider rotation.
The bridge still reads a full native transcript before returning browser pages.
Use actual dogfood friction to choose the next implementation.
