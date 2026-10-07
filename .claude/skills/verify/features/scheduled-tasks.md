# Scheduled tasks

A user creates a one-time or repeating task that the CodexUI server runs on schedule. The user
can pause, edit, or delete the task, and review previous runs.

## Sub-features

- `task-create` creates a task from the `New scheduled task` dialog.
- `task-pause` saves a task as paused (`Active` unchecked) or toggles it from the list.
- `task-edit` reopens a task and saves changes.
- `task-delete` deletes a task from the editor.
- `task-filter` counts tasks in `All`, `Active`, `Paused`, and `Completed`.

## How to get to it (user POV)

- Open `Tools` in the sidebar and choose `Scheduled tasks`, or open `#/scheduled`.
- Ask Codex in a chat to schedule something (needs `--live-auth`; this is the automation tool path).

## Driving it with Playwright

Preconditions:

- Any mode. UI-only is enough for create, edit, and delete.

- **Open dialog.** Choose `getByRole('button', { name: 'New task' })`. The
  `dialog` named `New scheduled task` appears.
- **Fill.** Fill textbox `Name`, textbox `Instructions`, and textbox `Project folder`. In group
  `Destination`, choose `New chat`. Uncheck checkbox `/^Active/` so the task never runs.
- **Create.** Choose `Create task`. The dialog closes, the task name appears in the list, and
  the `Paused` filter count goes up by one.
- **Persist.** Reload the page. The task is still listed.
- **Proof.** `$VERIFY_DIR/codex-home/codexui-automations.json` contains the task with
  `"status":"PAUSED"`.

## Gotchas

- Before 2026-10-08, `Create task` and `Delete` did nothing. The handlers were written as
  `void saveTask` without a call. A dialog that stays open after `Create task` means this
  bug has come back.
- Leave new tasks paused. An active task can start a real Codex run in live-auth mode.
- Re-running against the same instance stacks tasks. Assert on a count increase, not on
  `Paused 1`.
