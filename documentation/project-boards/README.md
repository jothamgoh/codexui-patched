# Project Boards

Start with [PROGRESS.md](PROGRESS.md) for the checkout state, verification, and
next action. Then read only the relevant product or implementation details:

- [PRD.md](PRD.md): current scope and behavior.
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md): architecture and delivery groups.
- [TEST_PLAN.md](TEST_PLAN.md): the small set of checks that protects the workflow.
- [UX_BACKLOG.md](../UX_BACKLOG.md): chat/board entry flows, delivered UX
  improvements, design references, and small follow-ups for dogfooding.

The focused scope removes the speculative full-MVP framework and
exhaustive test checklist. Future ideas are options, not release requirements.

## Everyday flow

Use chat for the conversation and the board for the project overview.

- Any folder can contain multiple independent boards. Each board runs one
  feature at a time, following its dependencies; another board in that folder
  can run alongside it. Create a new board for a separate initiative and extend
  the existing board for related work. Boards share the folder's files.
- **Work overview** collects current Leads, things needing you, recent results,
  and progress across boards. Open a named board for its feature cards or open
  a Lead for the conversation. Activity separates **Board work** from **Chats
  running**, with questions and approvals first.

- Boards are optional. Say **“Make a plan in the board”** in any existing chat
  to have it save a project brief and feature cards for review. Ordinary tasks
  and ordinary planning stay in chat. No extra coordinator chat is needed.
  A feature Lead can also plan a separate board when asked; the current board's
  active plan stays protected. Saving a new board does not change the chat's role.
- **Review board** appears in the linked chat. Review the brief, dependencies,
  done conditions, and Lead settings; ask the same chat to revise untouched
  cards, or edit them with typing/voice. Saving a plan starts no implementation.
  Choose **Run selected features** when ready; execution uses feature Lead chats.
- After work finishes, review the card's **Result**, recorded checks, and Lead
  chat. Use the existing chat's **Summary → Changes** for code changes. Multiple
  boards linked to a chat remain selectable; the original composer stays normal.
- The chat’s board icon offers **Open project board** to browse existing work
  and **Track on board** to create a feature. Opening the board creates nothing.
- Tracking starts from your unsent draft and selected text, or an empty brief;
  casual replies such as “ok done?” are never guessed to be the work. Dictate or edit the brief;
  leave the title blank to generate it locally. The feature starts with a
  read-only plan in its own Lead chat, linked to the original conversation.
- For a larger plan, choose **Create several feature cards** in that dialog,
  then review the proposed cards and dependencies before starting work. It keeps
  the selected destination board. On a populated board, **Add from a plan** adds
  draft cards there; it is not unfinished setup or a new board. Existing cards
  stay. Feature titles and new-plan board names can be left blank.
- **Board options** keeps permissions, continuation, and agent management out of
  the main card area on desktop and phones. **Coordinator settings** similarly
  keeps planning defaults out of the way until an override is needed.
- Individual starts open the Lead chat. Use its feature link or **View board**
  to return. A selected batch stays on the overview.
- Board work defaults to **Full access**: the Lead and its subagents can use files,
  commands, and network access without Codex approval prompts. **Board options →
  Work permissions** can switch a board to **Project access**. Planning stays
  read-only. The choice applies to new starts; running work and approved batches
  retain the access they started with.
- Leads inherit model and reasoning from the source chat unless a card or
  customized profile explicitly chooses otherwise. The planning chat can set
  either optional parameter when asked; omitted fields still inherit. Starter
  specialists inherit the Lead. Native clarification questions are enabled when
  supported and configurable, with the existing board-question fallback.
  The Lead chat and feature details show **This run** (or **Last run**) settings.
  **Confirmed by Codex** means the native runtime reported them after launch;
  **Requested** is shown when that read-back is unavailable.
- Reply in the Lead chat to steer active work or continue an idle feature.
  After completion, ask for links, explanations, or tests in the same chat.
  It shows **Conversation** while the card stays **Done** and another feature
  can run. If you request changes, the Lead reopens the affected work through
  the board tool before implementing, with existing dependency and access checks.
  Lead settings remain editable on the card. Failed sends retain the draft.
- **Stop run** ends the active attempt; completed code stays on disk. Stop before
  deleting a feature. Deletion removes its board records, keeping the code and
  Lead chat. Native approval requests are visible instead of looking like work.
- To switch model or reasoning, stop the feature, open **Model & reasoning**
  in feature details, save the new settings, then continue. This starts a new turn
  in the same Lead chat with its saved tasks. Stopping also halts its active
  descendants. New specialists inherit the changed defaults unless a profile
  overrides them; existing child chats are not automatically reconfigured.
- The sidebar labels tracked chats. Activity shows working Leads, exact approvals
  and questions, results, and stops. Completed features open their Lead results;
  a completed selected batch produces one summary alert. The board stays open
  for future work. Waiting Lead approvals also use your configured notification
  channels and disappear from Needs You when answered or cancelled.
- Activity groups native helpers beneath their Lead or ordinary parent chat.
  Expand **helpers** to inspect progress or open a helper, then use **Open Lead**
  to return and redirect work. Helpers do not add separate running/unread counts
  or completion rows. Blocking answer/approval requests still appear in Needs
  you. Async question forms remain in the chat that asked them.
- **All work** shows loading feedback and a refresh action if its screen cannot
  load. Maintained Lead, Product, Design, Engineer, and QA prompts update for
  existing boards too; custom profiles keep their own saved instructions.

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
attention hierarchy while retaining CodexUI themes and controls. Board shows
features; Needs You collects decisions and review/blockers; Runs records attempts
and links back to their work. Starter prompts can be customized into saved copies.

Real disposable native writing/review/repair and real Android form checks are now
recorded in PROGRESS.md. Physical iPhone Safari remains unverified. Before starting
a bridge fixture, follow TEST_PLAN.md notification/environment isolation; an
isolated board file alone is insufficient.
