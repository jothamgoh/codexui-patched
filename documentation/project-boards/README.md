# Project Boards

Start with [PROGRESS.md](PROGRESS.md) for the checkout state, verification, and
next action. Then read only the relevant product or implementation details:

- [PRD.md](PRD.md): current scope and behavior.
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md): architecture and delivery groups.
- [TEST_PLAN.md](TEST_PLAN.md): the small set of checks that protects the workflow.
- [UX_BACKLOG.md](../UX_BACKLOG.md): chat/board entry flows, delivered UX
  improvements, design references, and small follow-ups for dogfooding.

The 2026-09-05 scope revision removes the speculative full-MVP framework and
exhaustive test checklist. Future ideas are options, not release requirements.

## Continuing development

1. Read `PROGRESS.md`, repository `AGENTS.md`, and `git status`.
2. Pick one coherent feature or fix group. Preserve unrelated checkout changes.
3. Reuse the existing store, service, and UI. Add abstractions only when current
   behavior needs them.
4. Validate the integrated feature when ready. Validate earlier if another task
   depends on its result or a failure would be expensive to diagnose later.
5. Review and commit the discrete changes, update progress with actual evidence,
   then follow the repository push/CI/deployment workflow.

Do not rerun the full suite after every small edit. At a Project Boards release
boundary, `npm run check:project-boards` runs the full tests (including the focused
board tests), production build, and one disposable browser smoke flow.
For browser checks, install the matching engines once with
`npx playwright install chromium`. The board smoke includes desktop and phone/
touch contexts; unit tests do not require browsers. An optional Safari-engine
pass uses `npx playwright install webkit`, then
`CODEXUI_MOBILE_BROWSER=webkit npm run test:e2e:project-boards` on a supported host.

Generated screenshots belong in ignored `output/project-boards/`. Runtime board
state belongs outside the repository. The browser smoke uses synthetic board
state; it does not prove a real Lead/subagent session completed.

Voice fields reuse Codex transcription. Tap a field's microphone, speak, stop,
then review and save. Long-chat and voice browser checks are separate isolated
fixtures; see TEST_PLAN.md. The board UI borrows Squad's clear ownership and
attention hierarchy while retaining CodexUI themes and controls.
