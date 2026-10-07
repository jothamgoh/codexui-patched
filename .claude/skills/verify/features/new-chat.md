# New chat and composer

A user picks a workspace folder, chooses the model and reasoning effort, types a message, and
sees Codex reply in a new thread that appears in the sidebar.

## Sub-features

- `chat-workspace` chooses or creates the folder the chat can edit.
- `chat-effort` changes the reasoning effort from the composer.
- `chat-send` sends the first message, opens `#/thread/<id>`, and streams the reply.
- `chat-sidebar` shows the new thread under its folder with a `RUNNING` badge while it works.

## How to get to it (user POV)

- Open `#/` (the `New thread` heading) or choose `New chat` in the sidebar.
- Choose `start new thread <folder>` on a folder row in the sidebar.

## Driving it with Playwright

Preconditions:

- The instance was started with `--live-auth`. Without it, `Send message` fails.
- `VERIFY_WORKSPACE` points to `$VERIFY_DIR/workspace`, which `start --live-auth` creates.

- **Choose workspace.** Use `getByRole('button', { name: 'Choose workspace folder' })`, then
  `getByRole('button', { name: 'Create folder or enter a path' })`. Fill
  `getByRole('textbox', { name: 'Project name or absolute path' })` with the workspace path and
  choose `getByRole('button', { name: 'Open', exact: true })`.
- **Lower effort.** Choose `getByRole('button', { name: 'Extra high' })`, then
  `getByRole('button', { name: 'Low' })`. The composer chip reads `Low`.
- **Send.** Fill `getByRole('textbox', { name: /^Type a message/ })` with
  `Reply with exactly the word VERIFYOK and nothing else.` and choose
  `getByRole('button', { name: 'Send message' })`. The URL changes to `#/thread/<id>`.
- **Reply.** Wait for `.conversation-item` with the text `VERIFYOK` (allow 120 seconds).
- **Proof.** Take a screenshot of the thread. Confirm that `$VERIFY_DIR/codex-home/sessions/**/rollout-*<id>.jsonl` exists.

## Gotchas

- The reply text can appear before the turn finishes. The screenshot may still show
  `Writing response` and a `RUNNING` badge. Wait for `Running 0` in `Filter chats` when the
  final state matters.
- The workspace copy runs Codex with `danger-full-access`. Use only the scratch workspace.
- Each run spends the user's Codex quota. Keep prompts to one word with `Low` effort.
- The sidebar's `Use reset` and `Sign out` act on the user's real account. Never click them.
