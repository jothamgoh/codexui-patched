# Project Boards requirements

Scope revised: 2026-09-05. This document describes the small working release;
`PROGRESS.md` records what is implemented and verified.

## Purpose

Help a user track larger work across Codex chats: what is planned, what is
running, what needs a decision, and what has been checked. Ordinary chats remain
available. The board adds durable workflow state; it does not replace chat or
create a second agent runtime.

## Current scope

- One default board per project directory, with optional additional boards.
- Feature cards with a brief, acceptance criteria, priority, dependencies, and
  verification policy. A feature may own tasks and one persistent Lead chat.
- Reusable agents with editable prompts and a board roster. Lead, Product,
  Design, Engineer, and QA are starter profiles. Use specialists when useful.
- Native Codex execution with a bounded board-update tool. The server validates
  transitions and owns execution IDs; model prose is not workflow truth.
- Durable questions, answers, comments, artifacts, and compact run history.
- Needs You in the notification center, with exact board/feature/question links.
  Browser notifications require permission and an open connected CodexUI page.
- A responsive five-lane board and feature details using the current Vue,
  Tailwind, and Reka UI components.

## States

| Stored state | Visible lane | Meaning |
|---|---|---|
| `backlog` | Backlog | Captured work. |
| `working` | In Progress | Work is underway. |
| `needs_input` | Needs You | An unanswered question prevents continuation. |
| `blocked` | Needs You | A dependency, failure, or interruption needs attention. |
| `review` | Review | Work awaits verification or a manual review decision. |
| `done` | Done | The completion contract is satisfied. |

Moving a card is a workflow request, not an override. The server rejects moves
that conflict with an active run, unanswered question, dependency, or required
verification and the UI explains the error. Thread ownership, run correlation,
progress notes, and completion evidence are server-owned. Deleting cards must
not leave another card referring to a missing dependency.

## Execution

Lead is a responsibility for a feature. Any enabled agent can coordinate it;
specialty labels do not grant exclusive capabilities. Users can create as many
profiles as they need, including several with the same specialty. Execution
still obeys native Codex concurrency/depth limits and the shared-project writer
constraint. Nested delegation uses native Codex, without another runtime or a
mandatory hierarchy editor.

Plans assign tasks by exact agent ID. Each task states whether its purpose is
work or verification, independently of the agent's specialty. An unavailable
assigned agent requires re-enabling or reassignment; do not silently substitute
another agent. A fresh verifier may reuse the same profile; changing its name
alone is not evidence of independence.

Starting a feature creates or resumes its Lead chat in the project directory.
The Lead proposes the smallest useful task graph and works through eligible
tasks. Independent read-only specialists may run together; multiple writers in
one project must not run together. The service permits one orchestrated feature
per project directory at a time.

Native subagents share the Lead thread sandbox. Persona labels are guidance,
not separate security boundaries. Before a write-capable start, the UI explains
that the Lead and its subagents can edit project files and the start request
must explicitly authorize workspace writes. Automatic continuations stay within
that authorization. Existing Codex approvals remain separate from board
questions and must use the existing approval flow.

A board tool mutation must come from the feature's active thread and exact turn.
Question and artifact records retain the originating run. Reading context does
not authorize a mutation. A valid task handoff records what was done; feature
completion checks the current task/dependency/question/verification state in
one serialized mutation.

Automatic handoffs are optional and bounded. Failed or interrupted runs become
Blocked with an explanation. App-server exit and service restart must release
active work without treating it as success. A user can retry after reviewing
partial work. This release does not promise live recovery of a running agent.

Starting work is not blanket authorization to push, deploy, release, delete
external data, contact people, or bypass tool approvals. Existing user and
repository instructions still govern those actions.

## Verification proportional to the work

| Policy | Completion requirement |
|---|---|
| `none` | No separate verification task; use for explicitly low-risk work. |
| `self` | The Lead/implementer records meaningful checks for the completed feature. |
| `independent` | A verification task checks the delivered feature in fresh context after all work tasks. |
| `batch` | Work stays in Review awaiting combined verification. |

Small related edits may share one feature-level verification task. Tests after
every edit or specialist handoff are unnecessary. Validate sooner when a
dependent task needs a verified result, the risk is material, or failures would
be hard to isolate later. Final verification must depend on all work it certifies,
including research/design work, so an earlier review cannot satisfy completion.

Cross-feature automated batch QA is deferred. The form creates features, without
a QA-batch type selector. Existing `qa_batch` records remain readable but cannot
start an orchestrated run. The `batch` policy appears as **Review later**; a
feature in Review is not evidence that combined QA passed. Prefer one larger
feature with a final verification task for related changes.

## UI behavior

The Agent library separates saved profiles from current-board membership.
Checkbox changes save immediately. Creating an agent enables it on the current
board only. Search supports a growing roster. Users can edit a custom prompt or
customize a starter into a named copy, see save feedback, and retain a draft after
failed saves or closing the dialog. Switching profiles must not discard edits.
On mobile, choosing Edit brings the editor into view. Assigned-agent access is
locked with an explanation and a copy action; ordinary prompt edits remain easy.

The Instructions field is the agent's reusable prompt, combined with the task
brief and board coordination instructions. Saved profile changes apply on the
next feature start/continuation, not halfway through a running task. Each turn
explicitly identifies the current profile so resumed chats do not retain an old
coordinator's identity. Native subagents receive their selected profile through
the coordinator's delegation brief; they are not independent always-on services.

Project, board, and selected feature must agree with the URL. Switching project
or board clears stale details. A feature from another board is never displayed
under the current board. A question deep link selects the exact open question.
Failed saves preserve user input and display the server's reason.

Desktop feature details dock beside the board. Narrow layouts use a modal
surface with focus trapping, Escape dismissal, and focus restoration. Forms
use accessible dialogs. Board scrolling stays inside the lane area; controls,
empty states, and forms remain usable on narrow screens and in both themes.

The installed Codex desktop app supplies nearby interaction and theme patterns;
it has no equivalent durable project board. The board is a deliberate CodexUI
extension. Ordinary chat navigation and native approval handling remain intact.

## Persistence and boundaries

A versioned JSON file at `$CODEX_HOME/codexui-project-boards.json` stores boards,
typed cards, profiles, questions, comments, artifacts, and runs. Mutations are
serialized and saved through a mode-600 temporary file and atomic rename.
Capacity limits reject writes instead of silently discarding durable work.
Invalid JSON or an unsupported top-level state format must produce an error
rather than an empty board.

Do not introduce SQL storage, distributed locks, leases, a generic dispatcher,
or an event-sourced framework for this single-process release. Add stronger
storage/conflict mechanisms only when an observed use case requires them.

Project paths identify projects in this release. Multi-tab mutations are
serialized, but there is no optimistic revision conflict UI. Agent profiles are
mutable; historical runs are not immutable execution snapshots. The external
authentication boundary documented in repository `AGENTS.md` remains required.

## Deferred until dogfooding establishes a need

- Closed-browser Web Push/Telegram Needs You delivery and reminder policies.
- Rich live specialist telemetry and separate durable specialist runs.
- Automatic batch membership, result fan-out, partial reopen, and waivers.
- Multiple concurrent features/worktrees, leases, or live restart reconciliation.
- Multi-tab conflict resolution, project identity across directory moves, and
  immutable agent-profile snapshots.
- Existing-chat conversion, saved views, workflow templates, and portfolio views.

These are not an ordered roadmap or requirements for the current release.

## Reference products and design choices

Reviewed the official documentation and Squad's public interactive demo on
2026-09-05. These inform the design; they are not implementation dependencies.

- [Hermes profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles/)
  provide per-agent instructions/configuration. Its
  [Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban)
  separates durable tasks/handoffs from temporary delegation. Adopt that
  distinction without copying its process dispatcher or storage framework.
- [Hermes delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)
  supports configurable nested orchestration. Its temporary children receive
  explicit briefs, unlike persistent named profiles.
- [OpenClaw agents](https://docs.openclaw.ai/concepts/multi-agent) have their own
  instruction files and state;
  [delegation](https://docs.openclaw.ai/tools/subagents) targets configured IDs
  with allowed targets and depth limits. Adopt explicit identity and bounded
  composition, without adding a separate workspace/auth store per profile.
- [Squad](https://squad.so/resources/docs/what-is-mchq) organizes work around
  teammates, missions, decisions, runs, and docs. Its
  [roster](https://squad.so/resources/docs/meet-squad) has a designated Lead and
  specialist levels; it does not establish arbitrary interchangeable Leads.
  The public demo exposes a roomy per-agent notes/personality editor and current
  work. Adopt clear ownership, editable prompts, and focused decisions while
  keeping CodexUI's existing theme, dialogs, and chat model.
