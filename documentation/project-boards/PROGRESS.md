# Project Boards progress

Updated: 2026-09-05

Status: composable agents and the prompt editor are released through `222b0ac`,
[CI passed](https://github.com/jothamgoh/codexui-patched/actions/runs/33968139456),
and the authorized production restart is complete. The new service process is
running; local bridge and board API returned HTTP 200 with valid JSON, and the
public URL redirects to the authenticated gateway. No restart remains pending.

## Goal and scope

Make larger builds easy to steer: see progress across features/chats, let a Lead
use specialists where they help, and bring decisions back to the user. Validate
at the larger feature boundary unless dependencies or risk require earlier
checks. Existing work is replaceable; the old full-MVP framework is not a release
requirement.

This continuation reviewed the original five board documents, repository
architecture and deployment instructions, existing store/transport/UI patterns,
local app-server schemas, and the installed integrated Codex UI patterns.
The follow-up also reviewed official OpenClaw and Hermes agent/profile/delegation
documentation and Squad's documentation plus public interactive profile/prompt
editor demo. Sources and adopted choices are recorded in `PRD.md`.

## Composability and prompt-editor follow-up

The user clarified that any reusable agent should be able to lead and delegate,
with a custom prompt and a polished interface. Current changes:

- Exact agent IDs replace role-based selection in new plans; verification is a
  task purpose, independent of the profile's specialty.
- Disabled/missing assigned agents require reassignment or re-enabling.
- Per-turn application context identifies the current coordinator; native
  resume overrides alone may be ignored by an already loaded Codex thread.
- Searchable profile library, editable prompts, starter copies, draft/save
  states, mobile focus, and explicit current-board membership. Creating an agent
  no longer enables it on unrelated boards.
- Focused regression additions protect assignment/purpose compatibility.
  The integrated smoke covers creating/editing/copying a prompt and selecting a
  custom agent to lead. A separate disposable real-runtime check passed.

Follow-up verification: `npm run check:project-boards` passed with 181 tests
(17 focused board tests), type-check/frontend/CLI build, and browser smoke.
Only two new test cases were added; related assertions extend existing flows.
The first browser pass found ambiguous select labels and a prompt field whose
shared textarea sizing ignored its rows. Fixed explicit labels/editor height,
then inspected desktop, dark, and mobile screenshots. Mobile retains the close
control while scrolling the editor. The final grouped pass is green.

The real-runtime probe used installed app-server `0.153.1` with disposable
read-only state/project and an isolated home. A custom coordinator assigned two
tasks by exact ID, used a real native child for fresh verification, and finished
the feature. Editing its prompt changed the observed marker from PROFILE_ALPHA
to PROFILE_BETA on the same chat: one thread/start, one thread/resume, two
completed runs. The probe also confirmed the native child's model/effort.
The temporary auth symlink was removed and the process stopped. No production
board data or global configuration was changed. This verifies a small read-only
delegation and prompt-update flow, not parallel writers or deep nested trees.

The probe exposed a missing handoff detail: replace_plan returned a count without
generated task IDs. It now returns the saved assignments/dependencies so work can
start directly; the final grouped tests include this response.

Legacy records remain readable. Old verification plans missing dependencies on
research/design/product work can block under the stricter final-feature check;
replan rather than rewriting historical evidence. Existing native chats retain
their original dynamic-tool schema; legacy role arguments remain supported.

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
  helper fix. Final baseline [CI passed](https://github.com/jothamgoh/codexui-patched/actions/runs/33962943770)
  for `75ceef3`.

The automated browser smoke tests persistence/development events; service unit
tests use a fake adapter. The separate follow-up probe above is the real native
execution evidence. Keep those scopes distinct.

## Commits

- `65be68c`: frontend API/composable foundation from the previous session.
- `dec3972`: durable store, workflow guards, and focused store tests.
- `8c5721a`: bounded Lead execution, lifecycle handling, and service tests.
- `92f10ba`: integrated board UI, notifications, development transport, and smoke.
- `5a1e44e`: simplified requirements, delivery/test plans, and handoff evidence.
- `75ceef3`: fixes the CI stdin race without changing application behavior.
- `0bc76ee`: exact profile assignment, task purpose, and current-board membership.
- `83b28dd`: current coordinator context on native turns and useful plan IDs.
- `12e47b1`: searchable prompt editor, starter copies, and responsive UX.
- `222b0ac`: design references, behavior contract, and real-runtime evidence.

## Native app comparison

Rechecked extracted integrated Codex `26.901.31953` for theme surface tokens,
focus restoration, task-panel interactions, and Working/Needs input/Ready/Blocked
labels. The board follows nearby native theme/focus/detail patterns. There is no
equivalent durable project board, so this is an intentional CodexUI extension.
The parity skill records the inspected areas and reusable findings.

## Exact next step

1. Refresh CodexUI. In Project boards → Agents, customize a starter or create a
   profile with the desired instructions. Select it as Lead for a feature.
2. Use one real feature to assess the complete development workflow; record
   concrete friction and improve it before expanding the framework. Choose a
   final self-check or fresh independent verification proportional to that work.
3. Keep validation at the feature boundary. No additional release/restart work
   is pending for this source change.

The initial Terminal handoff failed before restarting. Process-start evidence
confirmed no restart occurred. Opening a fresh independent Terminal instance
ran the same one-shot command successfully; the user confirmed completion and
post-restart checks verified a new service process. No direct self-restart,
scheduler, or restart loop was used. Keep machine-specific commands outside Git.

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
