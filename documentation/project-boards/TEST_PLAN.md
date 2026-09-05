# Project Boards verification

Scope revised: 2026-09-05. Protect meaningful behavior with a small suite. Do not
write tests that repeat implementation details or add a matrix for deferred
features.

## When to validate

Develop a coherent feature/fix group, then validate it. Small independent edits
can share one final verification pass. Validate earlier when downstream work
needs a proven contract, the risk is material, or a failure needs isolation.

| Command | Use |
|---|---|
| `npm run test:project-boards` | Focused diagnosis while changing store/service/notifications. |
| `npm run check:project-boards` | Feature boundary: full tests, production build, browser smoke. |
| `npm run test:e2e:project-boards` | Rerun only the browser smoke after a UI-specific fix. |

`npm test` already includes the focused board tests. Running both before an
unchanged build adds no evidence. Existing unrelated regression tests remain in
the full repository suite.

## Focused behavior coverage

Keep related assertions in a few realistic scenarios:

- **Durability:** idempotent default board, additional board/roster, round trip,
  serialized mutations, recovery, and explicit rejection of capacity overflow.
- **Workflow truth:** public input cannot set execution ownership or fabricate
  completion; dependencies and questions block completion; deletion cannot
  strand a dependent; independent QA follows the final implementation.
- **Execution:** build a native Lead thread with existing tools retained, bind
  mutations to its exact active turn, record run provenance, and complete the
  task/question/verification flow through a fake adapter.
- **Composition:** route two profiles with the same specialty by exact ID;
  reject unavailable assignments; verify task purpose survives profile edits;
  apply current coordinator instructions on a continued chat. Preserve legacy
  records without fabricating verification evidence.
- **Failure:** failed turn, app-server exit, interrupted restart, duplicate or
  stale events, and bounded continuation cannot strand a project lock or imply
  success. Write execution requires explicit consent.
- **Notifications:** exact deep links, deduplication, permission, and redacted
  payloads using a stubbed Notification API.

Tests use temporary state/project directories and fake execution. No unit or
smoke test sends messages, pushes, deploys, restarts production, or uses real
user prompts or credentials.

## One browser smoke flow

Use disposable state, a disposable project, an isolated dev server, and headless
Chromium. The pre-seeded fixture tests the real browser/server persistence path:

- Five lanes and feature detail render; create/edit/move persists or shows the
  server's transition reason.
- Notification center opens the exact question; answering resolves it.
- Project switching and board/feature/query changes do not leak stale details.
- Failed saves retain form input; dialog keyboard behavior works.
- Custom prompts can be created, edited, saved, and selected to lead; starter
  customization is a copy. The agent editor is readable on desktop and mobile.
- Start explains shared workspace-write access, without executing a real Lead.
- Ordinary chat navigation still works.
- Dark/light surfaces are readable and narrow layouts contain horizontal scroll.

Capture representative screenshots to ignored `output/project-boards/` and
inspect them. Screenshots supplement behavioral assertions.

This smoke starts with synthetic Needs You state. The service tests exercise
orchestration separately through a fake adapter. Together they do **not** prove a
real Codex Lead/subagent workflow. A real execution check is a separate dogfood
step in a safe project, not a release-time test with real credentials by default.

## Evidence and release

Record command outcomes, test counts, screenshots inspected, and known limits in
`PROGRESS.md`. Never promote deferred behavior based on a passing stub. Run the
repository's diff review, secret scan, commit/push/CI, and local health workflow
once the integrated feature passes.

No requirement to add leases, frozen QA batches, immutable profiles, exhaustive
schema fixtures, load tests, or broad accessibility matrices merely to test a
feature this release does not implement.
