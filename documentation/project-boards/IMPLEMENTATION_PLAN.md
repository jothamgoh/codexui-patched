# Project Boards implementation

Scope revised: 2026-09-05. PROGRESS.md owns release status and actual evidence.

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
| components/content/ProjectBoardsHub.vue | Cards, dependencies, profiles, feature planning, queue controls. |
| components/content/BoardPlanDialog.vue | Chat/board plan entry with preserved retries. |
| components/content/BoardExecutionSettings.vue | Inherited or explicit supported model/reasoning settings. |
| components/content/DictationField.vue | Reusable speech insertion, retry, overflow review, and manual-save state. |
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
5. Everyday usability: voice in board fields, readable subagent activity,
   requested run settings, board overview/search, and phone/touch layouts.

Context reads are compact by default. New native chats expose lazy read_agent
and read_card; legacy chats keep their existing tool schema and compatibility
context. A completed planner save is idempotent within its run. Queue approval
freezes selected card scope and is checked again atomically before execution.

## Development and verification

Work on coherent groups and agree API contracts before parallel implementation.
Validate earlier only when downstream work needs a proven dependency or a
failure needs isolation. Preserve unrelated changes and commit discrete tasks.

At a release boundary:

1. Run npm run check:project-boards (tests, type-check/build, board browser).
2. Run node tests/chatReliability.e2e.mjs when chat behavior changed.
3. Inspect representative light/dark/mobile screenshots.
4. Review diff/status and run Gitleaks.
5. Commit, push main, and verify GitHub Actions.
6. Use machine-local deployment instructions for any required restart, through
   the authorized independent Terminal handoff. Verify health after reconnecting.

Do not rerun all checks after every small edit. A relevant failure or correction
justifies repeating the affected checks. Keep delivery stubs, synthetic browser
stress, real read-only agent execution, and production writing evidence distinct.

## Deliberate limits

One orchestrated feature per project; session-scoped queues/consent; blocked
restart recovery; mutable profiles; no automatic batch QA or provider rotation.
The bridge still reads a full native transcript before returning browser pages.
Use actual dogfood friction to choose the next implementation.
