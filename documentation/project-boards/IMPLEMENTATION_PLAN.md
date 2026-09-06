# Project Boards implementation

Scope revised: 2026-09-06. PROGRESS.md owns release status and actual evidence.

## Architecture

| Module | Responsibility |
|---|---|
| types/projectBoards.ts | Shared records and inputs. |
| server/projectBoardStore.ts | Serialized validation, transitions, persistence, handoffs. |
| server/projectBoardService.ts | Native Lead/planner runs, bounded tools, dependency queue, lifecycle. |
| server/projectBoardModels.ts | Advertised model capabilities and execution validation. |
| server/projectBoardQuestions.ts | Capability/policy-gated native clarification configuration for Board chats. |
| server/projectBoardPlanning.ts | Optional ordinary-turn skill pointer and compact project-scoped planning reads. |
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
| composables/useThreadHelperActivity.ts and utils/threadHelpers.ts | Lazy descendant summaries, native ancestry, and grouped Activity without transcript loading. |

All paths are under src/. Reuse Vue/Reka, Express, native threads/turns, existing
notification history/delivery, and native approvals. There is no second runtime,
database migration, generic policy layer, or LLM polling dispatcher.

The bundled skills/codexui-board-planning directory is copied into dist-cli by
the CLI build. Ordinary turn/start preserves caller settings and adds a small
native application-context pointer with the exact chat ID and local bridge
connection. The model reads the skill only for an explicit board request; there
is no keyword interception, global skill installation, or automatic card creation.
Existing chats use their normal tools; no dynamic-tool retrofit is needed.

The helper only reads context or saves a draft through project-board-planning.
The bridge derives the project from native thread/read. Saves validate a current
snapshot version and stable UUIDs atomically, preserve omitted cards, reject
started work/active queues, and publish existing snapshot events. sourceThreadId
is a link, not managed execution ownership. Context pages 30 feature summaries;
full cards and long project plans are fetched explicitly. Planning does not
alter an ordinary chat's sandbox or authorize implementation.

Source model inheritance reads thread metadata with includeTurns:false, not a
transcript or resume. Resolve each field as card, explicit profile, source, app
default and retain the resolved launch settings on the run. Native planner saves
and the ordinary-chat helper both accept optional model/reasoning overrides.
Board thread preparation asynchronously adds supported question configuration
to start/resume; recheck cancellation afterward before starting native work.

## Implemented delivery groups

1. Durable state and native execution: exact agent IDs, current prompts on every
   turn, atomic completion/dependency/QA guards, question provenance, board-scoped
   execution locks, interruption recovery, and saved board work permissions.
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
Board execution defaults to Full access; Project access retains the original
workspace-write consent. Each start, queue, and continuation carries its accepted
access level. Set the native sandbox and approval policy on every turn: loaded
threads can ignore thread/resume changes. Plan turns explicitly restore read-only.
An active turn is allowed to finish. Starter profiles are app-maintained text;
customized copies retain their own identity and saved instructions.

Completed-feature replies use a tracked follow_up run in the same native chat.
The run keeps its own activity and request controls while the card retains Done,
its result, and its original lastRunId. It neither owns the board execution slot
nor advances a queue. A requested repair promotes it atomically to execute:
new schema-3 Leads use reopen_feature; existing schema-2 Leads use reopen_task
with a reason. Native resume does not retrofit dynamic tools. Promotion checks
dependencies and write access, owns its reservation explicitly, and rechecks
cancellation before persistence and after awaiting it. Stop and process exit
clean up the persisted kind without releasing another run's reservation.

Maintained starter prompts emphasize observed user problems, small complete
outcomes, useful evidence, and coordination of overlapping work. Existing state
normalization refreshes all five built-in profiles while retaining custom
profiles, board rosters, cards, and explicit execution settings. No migration
or additional prompt-management layer is needed.

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

One orchestrated feature per board, with independent boards in any folder;
session-scoped queues/consent; blocked
restart recovery; mutable profiles; no automatic batch QA or provider rotation.
The bridge still reads a full native transcript before returning browser pages.
Use actual dogfood friction to choose the next implementation.
