# Project Boards implementation plan

Scope revised: 2026-09-05. Finish the current workflow before adding framework
features. `PROGRESS.md` owns completion status and evidence.

## Architecture to keep

| Module | Responsibility |
|---|---|
| `src/types/projectBoards.ts` | Shared records and public inputs. |
| `src/server/projectBoardStore.ts` | Validation, serialized transitions, persistence. |
| `src/server/projectBoardService.ts` | Lead threads, bounded tool, lifecycle, continuation. |
| `src/server/codexAppServerBridge.ts` | Existing HTTP and app-server event integration. |
| `src/api/projectBoards.ts` | Browser API calls. |
| `src/composables/useProjectBoards.ts` | Snapshot, mutations, event refresh. |
| `src/components/content/ProjectBoardsHub.vue` | Boards, cards, detail, forms, roster. |
| `src/utils/projectBoardNotifications.ts` | Redacted notification and exact deep link. |

Reuse the existing Vue/Reka components, Express bridge, native threads/turns,
notification transport, and approval UI. Do not split out generic dispatch,
route, audit, or policy frameworks without a concrete need.

## Delivery groups

### 1. Reliable state and execution

- Keep public card input separate from server-owned execution/progress fields.
- Apply manual transitions and feature completion atomically with dependency,
  active-run, question, and QA checks.
- Require QA to follow implementation; reject missing/deleted dependencies and
  capacity overflow.
- Bind dynamic writes to the active thread/turn/run.
- Interrupt runs and release project locks on app-server exit and restart.
- Require explicit workspace-write authorization and retain native approval
  behavior. Describe shared sandbox limits honestly in the Lead prompt.
- Keep QA-batch execution unavailable until it has a complete useful workflow.

Store and service changes may proceed together with agreed method signatures.
Use focused behavioral tests after this group stabilizes; do not rerun all
repository tests after each internal edit.

### 2. Usable integrated board

- Keep project/board route selection consistent and clear stale feature detail.
- Select the exact linked question and preserve inputs after failed mutations.
- Use theme tokens and existing accessible dialogs.
- Respect server transition guards; show meaningful errors.
- Explain workspace-write access at Start.
- Keep narrow-width scrolling contained and preserve ordinary chat navigation.

UI work can proceed alongside group 1 where contracts are agreed. Run one
integrated browser smoke after both groups are ready.

### 3. Feature-boundary verification and release

1. Run `npm run check:project-boards`: full tests (which include board tests),
   production build, then one disposable browser smoke.
2. Inspect the desktop, dark, and mobile screenshots in `output/project-boards/`.
3. Review the entire diff/status, and run `gitleaks dir --redact .` if available.
4. Commit coherent store, execution, UI, and documentation changes separately.
5. Push main and verify GitHub Actions as required by repository `AGENTS.md`.
6. Follow the machine-local restart handoff. A server/dependency change needs a
   restart; never restart the hosting process from its own turn. Verify health
   after reconnecting.

Repeat checks only after a relevant change or failure. A passing build does not
clear a discovered correctness defect. Record skipped or simulated checks
honestly in `PROGRESS.md`.

## Next development cycle

The user clarified that agents should compose and each should have its own
editable prompt. Finish this as one coherent feature:

1. Route plans by exact profile ID and classify verification on tasks.
2. Apply the selected profile on every turn, including resumed chats.
3. Make profile creation/editing/copying clear, preserve drafts, and scope new
   roster membership to the current board. Keep the editor usable on mobile.
4. Run the grouped check, then one bounded real-runtime dogfood in disposable
   state. Record what native execution actually proves, including prompt edits.
5. Review, scan, commit, push, verify CI, and use the authorized one-shot restart
   handoff. Keep machine-specific details outside the repository.

Use native Codex for agent trees; durable nested specialist runs, a global agent
chat/memory service, and visual organization charts remain separate future work.
