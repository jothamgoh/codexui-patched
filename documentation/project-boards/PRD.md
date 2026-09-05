# Project Boards requirements

Scope revised: 2026-09-06. This document describes the focused product scope;
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
- Existing Activity, Web Push, and Telegram deliver questions, completed
  features, project plan results, and failures through current preferences.
  Closed-browser delivery requires configured Web Push/Telegram and a running
  server; generic Lead-turn completion alerts are suppressed.
- A responsive five-lane board and feature details using the current Vue,
  Tailwind, and Reka UI components.

## From a plan to delivery

Chat is the primary working view; the board is the project overview. From a
normal chat, Track on board creates one linked feature with a brief and optional
title. Missing titles are generated locally from the brief and remain editable.
The original chat stays a reference; a fresh prepared Lead chat owns execution.
Choose Create several feature cards for a larger plan, or Plan features on a board. The editable brief includes a bounded recent source
excerpt and a link back to the chat. A read-only coordinator creates distinct
feature cards with dependencies; planning itself does not start implementation.
Retries retain drafts and reuse a board already created by that attempt.

For a feature, Plan first saves a read-only task plan and returns it for review.
Start work resumes and opens that same Lead chat. The chat header links to its
feature, board, and source conversation. Selected batches stay on the overview. Plan & start remains the direct path
for a clear brief. Completed task history is preserved during targeted repair;
new chats support reopening affected tasks before fresh verification.

Run selected features advances approved dependency-ready cards sequentially.
It pauses for questions, failure, review, or changed approved scope. New cards
do not join the selection automatically. Selection and continuation consent are
session-scoped; after restart, review partial work and select remaining cards.
Continue within features controls bounded continuation within a feature; it is
distinct from selecting a cross-feature queue. Turning it off cancels pending
continuations, including a start waiting on model metadata. A running turn may
finish. Pausing or replacing a queue also prevents its old pending starts or
failures from affecting replacement work.

Features optionally override their Lead's model and reasoning effort. Defaults
inherit the selected profile; available choices come from advertised runtime
capabilities and unsupported explicit settings fail visibly. Each run retains
its resolved requested settings after profile edits. These are launch requests,
not independently observed specialist telemetry.

Shared groundwork belongs in one prerequisite feature, or one larger feature
when edits are tightly coupled. The coordinator sees compact sibling scope and
dependency outcomes, and can retrieve full cards/profiles when needed. This
helps planning but is not automatic semantic overlap detection. Queue
advancement is event-driven and consumes no LLM polling turns.

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

Lead chat replies use the board service. During an active run they steer the
exact current turn; a stale turn cannot silently become a new run. Idle replies
create a new tracked run in the same chat using current profile, dependency,
project-lock, and write-consent checks. Planning chats remain read-only. A done
feature requires explicit reopening, retaining prior handoffs and respecting
its dependents. Ordinary turn/start and goal continuation cannot bypass this
lifecycle. Submission errors retain the full composer draft. Stop revokes pending
continuation/queue consent and targets the current run; a stale Stop cannot
cancel a newer attempt. Cancellation is confirmed for the Lead and its owned
native subagents before releasing the project lock; uncertainty keeps the run
locked with retry guidance. Active work must stop before deletion. Idle unanswered
questions may be deleted with their feature without fabricating answers; code
files and the Lead conversation remain intact.

The project sidebar reveals the selected Lead without replacing manual chat
ordering. Working Leads and native approvals are visible in Activity even when
the ordinary thread list has not caught up. Feature completion opens its Lead
result, with a board fallback when unavailable. During an approved selected
batch, individual results remain in Activity quietly; the final completed batch
emits one summary. Native Lead approvals/questions use the existing device alert
channels and resolve from history when answered or cancelled. Questions and
unexpected interruptions notify promptly; explicit user stops stay in history
without another device alert. A board is an
ongoing container, not a single completable job.

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
Built-in prompts provide practical role guidance, bounded delegation, useful
handoffs, proportional checks, and an explicit review/repair loop. Their text is
maintained by the app; customized copies keep their saved instructions.
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
use accessible dialogs. Horizontal board scrolling stays inside the lane area;
on phones, the whole board page can scroll vertically so controls do not hide
the cards. Controls, empty states, and forms remain usable in both themes.

Board text fields offer the existing Codex microphone/transcription path:
names, briefs, acceptance criteria, plans, prompts, answers, comments, and
search. Text inserts into the selected field and stays editable. Saving waits
for recording/transcription or retained retry/overflow text to be resolved;
stopping speech never submits the form. Native text fields remain available
for ordinary keyboard and OS dictation input.

Squad-inspired Board/Needs You/Runs views share the existing durable state.
Board shows the feature lanes; Needs You lists exact unanswered decisions plus
blocked work and items awaiting review. Runs shows recent attempts, outcomes,
requested settings, and links to the actual feature or chat when available.
Counts represent the attention items in that view; run receipts do not pretend
to be live specialist telemetry. Feature search helps larger boards.

Ordinary chats also render native requestUserInput questions as clear cards,
with described choices, recommendations, progress, optional free text/voice,
explicit submission, preserved drafts, and retry. Secret answers are masked and
have no microphone. These native replies and durable board questions remain
separate from Codex approval requests.

The browser-local Questions in new chats setting defaults on when the runtime
advertises support and managed policy allows it. It controls optional structured
questions outside Plan mode for new ordinary chats; it does not force the agent
to ask a question or retrofit loaded chats. Unsupported runtimes receive no
unknown override. PROGRESS.md records the setting's current verification state.

The installed Codex desktop app supplies nearby interaction and theme patterns;
it has no equivalent durable project board. The board is a deliberate CodexUI
extension. Ordinary chat navigation and native approval handling remain intact.

## Persistence and boundaries

A versioned JSON file at `$CODEX_HOME/codexui-project-boards.json` stores boards,
typed cards, profiles, questions, comments, artifacts, and runs. Mutations are
serialized and saved through a mode-600 temporary file and atomic rename.
Default Web Push subscriber/history state and Telegram preferences also follow
CODEX_HOME; an explicit push-state path remains supported. Development fixtures
must isolate environment loading and delivery credentials as well as board data.
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

- Reminder policies and digests beyond existing notification delivery.
- Rich live specialist telemetry and separate durable specialist runs.
- Automatic batch membership, result fan-out, and waivers.
- Multiple concurrent features/worktrees, leases, or live restart reconciliation.
- Multi-tab conflict resolution, project identity across directory moves, and
  immutable agent-profile snapshots.
- Saved views, project workflow templates, portfolio views, and provider/account
  rotation. Chat plan import is supported; it does not convert a historical
  ordinary chat into a board-authorized execution thread.

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

- Rechecked [Squad's public demo](https://squad.so/) and
  [board guide](https://squad.so/resources/docs/missions-board): adopt visible
  ownership, concise work status, attention/completion counts, and readable
  detail panels. Do not imitate advertised integrations or account features
  that CodexUI does not implement.
- [Orca's orchestration guide](https://github.com/stablyai/orca/blob/main/skill-guides/orchestration.md)
  supports optional coordination, compact context, explicit attempt outcomes,
  durable questions, and concrete handoffs. Its skill file is a discovery stub;
  the full guide and completion/question/receipt source were inspected.
  Retain native Codex orchestration and add requested settings to run history.
  Orca's [documentation](https://github.com/stablyai/orca/blob/main/docs/site/content/docs/cli/orchestration.mdx)
  calls orchestration experimental; do not describe it as proof of reliability.
  Durable retry receipts across completed HTTP attempts remain a possible
  future resilience improvement, not a new framework requirement.
