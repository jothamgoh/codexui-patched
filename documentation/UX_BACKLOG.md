# CodexUI workflow improvements

Updated 2026-09-05. The requested focused cycle is implemented; release status
and evidence live in [Project Boards progress](project-boards/PROGRESS.md).

## How to use it

| Starting point | Flow |
|---|---|
| Existing planning chat | Turn this chat into a board → review the prefilled plan/project → coordinator creates cards. |
| New board | Plan features → describe the goal or reference a project plan → review cards and dependencies. |
| Straightforward feature | Add a brief and acceptance criteria → Plan & start. |
| Explore before building | Plan first → review tasks → Start work in the same Lead chat. |
| Many features | Review/select the cards → Run selected features → one ready feature at a time. |
| Shared groundwork | Put it in one prerequisite feature; dependent cards receive its saved outcome. Combine tightly coupled work when that is simpler. |
| Decision needed | Lead asks on the feature → Needs You and existing notifications → answer → continue if enabled, otherwise Start. A paused queue needs explicit resume. |
| Review finds a defect | Lead reopens affected work, retains previous handoffs, repairs, and verifies after the changes. |
| Restart/interruption | Partial work remains visible and blocked; review it and explicitly retry/select remaining cards. |

Any reusable agent may lead. Each profile has editable instructions and starter
copies. Each feature can inherit Lead model/reasoning settings or override them.
Specialists use their own settings. The Lead decides when delegation is useful.

## Delivered UI and efficiency work

- Final answers and Worked for separators stay attached to the correct turn.
- Heavy offscreen message bodies unmount; markdown/inactive history caches are
  bounded. The active raw transcript and lightweight shells still consume memory.
- Recording → Transcribing → Ready, transcription retry, preserved original-chat
  drafts, and manual Add/Send make selected-text comments safer to compose.
- Board fields also offer voice input for plans, prompts, briefs, answers, and
  names. Stop transcribes; the user reviews and saves. Pending retry/overflow
  text cannot silently be omitted by saving the form.
- Project plans, dependency labels, explicit planning versus implementation,
  compact handoffs, and one selected queue make the next action visible.
- Questions, completed features, planning results, and failures use the existing
  Activity/notification delivery system and preferences.
- Bounded source excerpts and on-demand full profile/card reads limit repeated
  context. Deterministic queue advancement uses no LLM polling.
- Squad-inspired ownership, attention/completion counts, and feature search
  improve scanning. Run history preserves requested execution settings even
  after a profile changes.
- Native subagent activity shows names, status, and child-chat links. Phone
  layouts use touch controls, scrollable forms, and reachable board cards;
  the sidebar no longer covers a fresh mobile visit.

## Keep the framework small

Validate at the coherent feature boundary; test earlier if a dependent feature
needs proof. A later change can invalidate an earlier check, so finish related
work with a relevant integration check. Done records what was checked at that
time, not immunity from future regressions.

A required QA selector, a second agent runtime, workflow engine migration,
organization-chart editor, concurrent writer fleet, broad test matrix, and
automatic account rotation are not part of this cycle.

## Next improvements only if dogfooding justifies them

1. Try a small repository build with shared groundwork → dependent change →
   final review/fix. Record friction instead of adding speculative framework.
2. Profile native transcript retrieval if backend memory still causes lag.
   Current gains chiefly reduce browser rendering and inactive cache retention.
3. Consider direct reviewer-run links, richer specialist activity, or saved
   project templates when the simpler workflow proves insufficient.
4. Provider/account support remains a separate project with explicit execution
   and authentication contracts.

## Patterns used as design references

- [Hermes Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban):
  durable dependencies, tasks, and handoff comments.
- [LangGraph workflows](https://docs.langchain.com/oss/python/langgraph/workflows-agents):
  a coordinator divides work and combines results; reviewers return findings.
- [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts):
  save state, present the exact decision, resume the same work.
- [Squad missions](https://squad.so/resources/docs/missions-board):
  clear ownership, visible progress, and decisions attached to work.
- [Orca orchestration](https://github.com/stablyai/orca/blob/main/skill-guides/orchestration.md):
  optional delegation, durable attempts/questions, compact context, explicit
  handoffs, and retry-aware launch records. Its orchestration is experimental;
  source review is not proof that it is battle-tested.

These references informed the design, not a framework dependency or a feature
parity claim. See PRD.md for OpenClaw, Hermes profiles, and Squad roster sources.
