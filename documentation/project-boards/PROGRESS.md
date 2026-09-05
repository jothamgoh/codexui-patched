# Project Boards progress

Updated: 2026-09-05

Status: implementation complete, source pushed, local checks and source CI
passed. Production restart is pending explicit authorization to disconnect the
hosting session. No restart or real Lead/subagent dogfood was performed.

## Goal and scope

Make larger builds easy to steer: see progress across features/chats, let a Lead
use specialists where they help, and bring decisions back to the user. Validate
at the larger feature boundary unless dependencies or risk require earlier
checks. Existing work is replaceable; the old full-MVP framework is not a release
requirement.

This continuation reviewed the original five board documents, repository
architecture and deployment instructions, existing store/transport/UI patterns,
local app-server schemas, and the installed integrated Codex UI patterns.

## Completed work

- Kept the useful core: durable boards/cards/tasks, one persistent Lead chat per
  feature, optional specialists, questions, handoffs, and final verification.
- Removed unused alternate execution paths and replaced the exhaustive roadmap
  and test matrix with current-scope documents. Added
  `npm run check:project-boards` for one integrated feature-boundary pass.
- Removed the QA-batch creation selector. Existing records stay readable;
  `batch` appears as Review later and does not claim automated combined QA.
- Public mutations cannot rewrite execution ownership/progress or fabricate
  task completion. Feature completion is atomic and checks questions,
  dependencies, and QA. Completed task attribution cannot be rewritten into QA.
- Independent QA must depend on implementation and follow its latest completion.
  Referenced dependencies cannot be deleted, missing dependencies block work,
  and capacity or unsupported store formats reject writes without replacing data.
- Dynamic writes require the exact active Lead thread/turn and retain run
  provenance. Repeated questions notify using the correct saved question ID.
- App-server exits and restarts interrupt runs, block unfinished active tasks,
  and release project locks. Canonical directory locks cover path aliases and
  symlinks; unavailable project directories fail before creating a run.
- Write-capable Start requires explicit consent. Native Lead/children share the
  sandbox, and execution uses native on-request approvals. Continuation consent
  belongs to the current service session and cannot be granted by an answer.
- Project/board/feature routes and exact question selection stay consistent.
  Failed saves and live updates preserve form drafts. Existing Reka dialogs,
  theme surfaces, modal ARIA, and mobile controls replace the fragile UI paths.
- Fixed development notifications: Vite uses the existing SSE endpoint, and
  notification listening begins before chat hydration. Production keeps its
  WebSocket transport. No extra transport or dispatcher framework was added.

## Verification evidence

Final local command: `npm run check:project-boards` — PASS.

- `npm test`: 179/179 passed, no skips. This includes 15 focused board tests
  (8 store, 5 service, 2 notification); no separate duplicate focused pass is
  required at an unchanged release boundary.
- `npm run build`: frontend type-check/Vite and CLI build passed.
- Browser smoke: passed against disposable state/projects with seeded questions
  and intercepted Lead Start. It covers live updates/draft retention, failures,
  guarded moves, exact questions, consent transport, scoped routes, ordinary
  chats, dark dialogs, modal behavior, and contained mobile scrolling.
- Desktop, overview, dark detail/dialog, and mobile detail/overview screenshots
  inspected in ignored `output/project-boards/`. Interrupted tasks no longer
  display an active Engineer after their run stops.
- `git diff --check`: clean. `gitleaks dir --redact .`: no leaks found.
- `npm audit --audit-level=high`: passed; one existing moderate `qs` advisory
  remains. Vite's existing dependency annotations and large-bundle warnings are
  non-fatal.
- GitHub [source CI](https://github.com/jothamgoh/codexui-patched/actions/runs/33962659852)
  passed for `92f10ba`: secret scan, clean dependency install, audit, tests, build.
- The documentation commit's CI exposed an existing Git fixture helper race:
  writing stdin after Git exited raised an unhandled EPIPE. The follow-up test
  helper uses ignored stdin for commands without input and reports Git's exit
  status for early pipe closure. This does not change application behavior or
  add tests. `npm test` (179 passed) and `npm run build` passed again after the
  helper fix; inspect the latest commit's CI for the final release result.

The smoke tests real browser/server persistence and development events. Service
orchestration uses a fake adapter. This does **not** prove that a real Codex
Lead/subagent session has completed; do not describe it as real-agent E2E.

## Commits

- `65be68c`: frontend API/composable foundation from the previous session.
- `dec3972`: durable store, workflow guards, and focused store tests.
- `8c5721a`: bounded Lead execution, lifecycle handling, and service tests.
- `92f10ba`: integrated board UI, notifications, development transport, and smoke.
- `5a1e44e`: simplified requirements, delivery/test plans, and handoff evidence.
- The following test-helper commit fixes the CI stdin race described above;
  it does not change application behavior.

## Native app comparison

Rechecked extracted integrated Codex `26.901.31953` for theme surface tokens,
focus restoration, task-panel interactions, and Working/Needs input/Ready/Blocked
labels. The board follows nearby native theme/focus/detail patterns. There is no
equivalent durable project board, so this is an intentional CodexUI extension.
The parity skill records the inspected areas and reusable findings.

## Exact next step

The configured production metadata health check returned HTTP 200 before
release. This confirms the old service is reachable, not that the new backend
has been activated. The production build is ready in `dist/` and `dist-cli/`.

1. Obtain explicit authorization for the hosting-session disconnect, then launch
   exactly one independent Terminal restart using the machine-local instructions.
   Do not restart the hosting service from its own Codex process or add a retry
   wrapper/scheduled helper.
2. After reconnecting, verify the configured local/public health checks.
3. Dogfood one small real feature in a safe project with an implementation task
   and a combined verification task. Record useful feedback as board cards.

## Deliberately deferred

- Closed-browser Web Push/Telegram Needs You and reminders. The open in-app
  notification center remains the reliable surface.
- Automated QA-batch membership, combined result fan-out, partial reopen, and
  waivers. Prefer a larger feature with one final verification task.
- Rich specialist telemetry, separate durable specialist runs, immutable agent
  snapshots, existing-chat conversion, saved views, and workflow templates.
- Multiple concurrent features/worktrees, leases, and live restart reconciliation.
  Interrupted work becomes Blocked and requires a deliberate retry.
- Optimistic multi-tab conflict UI and stable project identity across directory
  moves. Mutations serialize; execution locks resolve canonical directories,
  while board identity still uses the saved project path.

Choose follow-up work from real friction rather than restoring the old roadmap.
