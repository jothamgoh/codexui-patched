# Sidebar settings

The `Tools` section of the sidebar holds navigation to hubs and per-device or all-device
settings. The `Accounts` region shows provider sign-in state.

## Sub-features

- `settings-theme` toggles dark mode (`Switch to dark mode` / light).
- `settings-font` sets the UI font size for this device (`14 px`, `15 px`, `16 px`).
- `settings-speed` sets the default speed for all devices (`Standard`, `Fast`).
- `settings-questions` toggles optional questions in new chats for this browser.
- `settings-accounts` shows Claude and Codex sign-in state with `Refresh accounts`.
- `settings-claude-accounts` saves Claude logins, selects the active account, and
  configures automatic switching with usage for every saved account.

## How to get to it (user POV)

- Choose `Tools` in the sidebar to expand it. Settings sit under the hub links.

## Driving it with Playwright

Preconditions:

- Any mode.

- **Expand.** Choose `getByRole('button', { name: 'Tools' })`. It reports `[expanded]`.
- **Theme.** Choose `Switch to dark mode`. Take a screenshot. `document.documentElement.dataset.theme` becomes
  `dark` (stored in this browser's localStorage).
- **Font size.** `getByRole('combobox', { name: 'UI font size for this device' }).selectOption('16 px')`.
  Reload the page. The value is still `16 px` (stored in this browser only).
- **Speed.** `getByRole('combobox', { name: 'Speed setting for all devices' }).selectOption('Fast')`.
  Reload the page. The value is still `fast`. It is written to
  `$VERIFY_DIR/codex-home/config.toml`, so it applies to all devices.
- **Questions.** Toggle `getByRole('switch', { name: 'Questions in new chats' })`.
- **Accounts.** Region `AI provider accounts` shows `Not signed in` for both providers in
  UI-only mode, and the Codex email in `--live-auth` mode.

## Gotchas

- **Saved Claude accounts.** With a scratch `CODEXUI_CSWAP_PATH` fixture, choose
  `Active Claude account`, toggle `Automatically switch Claude accounts`, and
  set `Claude automatic switch threshold`. Open `Manage saved accounts`, choose
  `Remove <email>` then `Confirm remove <email>` to delete a fixture account.
  Reload to check the selected account and settings, and read
  `$VERIFY_DIR/codex-home/codexui-claude-accounts.json` for settings side effects.
  The fixture must use fake accounts and a private metadata file, never real
  credentials or the real cswap executable. Verify both desktop and phone.

- Font size and the questions toggle live in browser storage. Each `openSession` starts with a
  fresh browser context, so reset only matters within one scenario.
- `Sign in` starts a real OAuth flow. Do not complete it from a scenario.
