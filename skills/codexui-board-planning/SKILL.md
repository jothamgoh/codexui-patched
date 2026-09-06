---
name: codexui-board-planning
description: "Create or revise reviewable feature cards in CodexUI only when the user explicitly asks to put a plan in a board, or inspect board results when asked to review that work. Do not use for ordinary tasks, ordinary planning, or merely because a project is large."
---

# Optional board planning from chat

Any chat can plan a board, including an existing conversation or feature Lead.
Keep this conversation as the user's planning and coordination chat. Use the
helper connection (`--url`, `--thread`) supplied by CodexUI's application context.
Never guess the active chat, port, project, or another service's address. If that
context is unavailable, keep the plan in chat and explain the missing connection.

## Plan and save

1. Read `context` once. Extend the user's existing board when the request belongs
   to that initiative. For a separate initiative, create a named board with a new
   UUID, even when another board uses the same project folder. A folder can have
   several independent boards; its default board is only a navigation default.
   For multiple relevant candidates, use the user's named board or ask a focused
   question. An existing board is not automatically consent to replace its plan.
   Read relevant code, project instructions, and the conversation's agreed
   product decisions.
2. Propose the fewest separately useful features. Keep overlapping edits together;
   put shared groundwork in one prerequisite card and reference its ID in
   dependents. Small implementation steps belong inside a feature, not new cards.
3. Write a concise project `summary`: outcome, scope, key flow, exclusions, and
   unresolved decisions. Each card's `description` is a mini brief: intended
   behavior, approach, important cases, and boundaries. `acceptanceCriteria`
   states observable done conditions and proportionate checks. Link a longer
   PRD only when useful; do not create a document for every small card.
4. Choose an enabled `agentId` as Lead, normally `builtin-lead`; any enabled agent
   can lead. Omit `model` and `reasoningEffort` to inherit this conversation's
   settings unless the selected profile has an explicit override. If the user
   specifies either field, set that optional card parameter; the other field
   still inherits. Blank specialist settings inherit the executing Lead.
   Use a separate reviewer when the risk warrants it; do not
   add agents or tests mechanically. Delegated Product/research agents can return
   briefs to this chat; one coordinator saves the batch.
5. Generate board/card UUIDs once before saving (Node `crypto.randomUUID()`).
   Save one JSON file and submit it with the current `expectedVersion`. Existing
   card IDs mean revision; new IDs mean new cards. Only untouched Backlog features
   can be revised. Omitted cards remain. Read `--feature` detail before revising
   a card; preserve existing choices and unrelated scope. When the project
   summary is truncated, use `context --board BOARD_ID --full-plan` before editing it.
   A running board's plan cannot be revised. From its Lead chat, an explicitly
   requested separate initiative can be saved to a new board while current work
   continues. Do not change that Lead's current feature or start the new board.
6. Report the saved board name and how to open **Review board** in this chat.
   Highlight the feature order and any decision the user still needs to make.
   Stop after saving. Planning does not authorize implementation, a queue,
   writing project files, or launching writing agents. The user reviews/edits
   cards and chooses **Run selected features** (or starts one feature) in the board.

This is metadata-only planning, not a sandbox change. Respect the current chat's
permissions. Resolve routine details from context; ask only when a missing answer
materially changes the plan. Do not block saving useful draft cards just because
an explicitly recorded product question remains.

## Helper

Run the bundled `scripts/board.mjs` with Node. Substitute the exact connection
from application context; quote paths and arguments using normal shell quoting.

```sh
node /path/to/scripts/board.mjs --url http://127.0.0.1:PORT --thread THREAD context
node /path/to/scripts/board.mjs --url http://127.0.0.1:PORT --thread THREAD context --board BOARD_ID --feature FEATURE_ID
node /path/to/scripts/board.mjs --url http://127.0.0.1:PORT --thread THREAD save --file /tmp/board-plan.json
```

Save-file shape (use actual UUIDs, not these labels):

```json
{
  "boardId": "BOARD_UUID",
  "expectedVersion": 1,
  "name": "Checkout improvements",
  "summary": "Make checkout understandable and recoverable. Exclude new payment methods.",
  "features": [{
    "id": "FEATURE_UUID",
    "title": "Recover an interrupted checkout",
    "description": "Retain the basket and show a clear retry after a failed request. Reuse the existing payment boundary; never duplicate a charge.",
    "acceptanceCriteria": "Retry preserves the basket and avoids duplicate payment. Verify one successful checkout and a failed request followed by retry.",
    "agentId": "builtin-lead",
    "verificationPolicy": "independent",
    "dependsOn": []
  }]
}
```

`title` is optional and defaults from the brief. Optional `model` and
`reasoningEffort` use runtime-supported values; use the UI's existing model
choices if uncertain. The bridge derives the project from the supplied chat.
Context returns up to 30 compact card summaries; use `--offset NEXT_OFFSET`
when `nextOffset` is present to inspect remaining cards before splitting new work.
`--feature` includes its full brief, tasks, handoffs, and artifact references.
No repeated full-chat uploads or polling.

If save fails or times out, reread context before retrying. Reuse the same IDs;
check whether the intended changes already landed. A stale version means someone
changed the board: reconcile with that state before submitting again. Never bump
the version blindly, regenerate IDs on retry, or overwrite completed work.

## Review finished work

When asked to review board work, read context and then the relevant feature's
detail. Compare its result, tasks, artifacts, and actually recorded checks with
the acceptance criteria. Inspect referenced files/diffs when needed. Distinguish
reported completion from verification you performed. The board's feature detail
shows the result and opens the feature's Lead chat for the full discussion.
Recommend a follow-up or use the existing explicit reopen flow for changes to
started/completed work; draft-plan saving must not erase its history.
