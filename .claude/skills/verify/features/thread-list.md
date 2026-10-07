# Thread list

The sidebar groups chats by folder. The user can filter, pin, rename, archive, and search chats.

## Sub-features

- `threads-filter` covers the `Filter chats` navigation: `All N`, `Running N`, `Unread N`.
- `threads-pin` pins a chat to the top.
- `threads-rename` renames a chat in place.
- `threads-archive` archives a chat.
- `threads-search` opens chat search from `Search ⌘K` under `Tools`.

## How to get to it (user POV)

- The left sidebar on every route. On a narrow screen the sidebar can be collapsed; reopen it before driving rows.

## Driving it with Playwright

Preconditions:

- At least one chat exists. Create one first by following [new-chat.md](./new-chat.md) with `--live-auth`.

- **Row controls.** Each `listitem` under a folder `article` has buttons `pin`,
  `<title> <provider>`, `Edit chat name`, and `archive_thread`. Scope locators to the row with
  `page.getByRole('listitem').filter({ hasText: '<title>' })`.
- **Filter.** Choose `Running N` while a turn runs, then `All N`.
- **Proof.** After pin or archive, reload and screenshot. Pins persist in
  `$VERIFY_DIR/codex-home/codexui-pinned-threads.json`.

## Gotchas

- Folder rows have a `project_menu` button and a `start new thread <folder>` button nested inside
  the folder button. Use `exact: true` or scope to the `article`.
- The list shows `Show more` after five chats per folder.
