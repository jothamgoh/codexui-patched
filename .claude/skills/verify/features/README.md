# CodexUI verification map

This folder is the maintained source for verifying CodexUI's user-facing behavior. Read
`../SKILL.md` for launch, doctor, and cleanup. Then use the matching feature file as the recipe.

## Baseline preconditions

- `instance.sh start` (or `start --live-auth`) printed `ready: http://127.0.0.1:5181`, and
  `instance.sh doctor` ends with `doctor: OK`.
- The scratch home starts empty: no chats, boards, tasks, or pins. Each `start` after a `stop`
  begins clean. Re-running a scenario against the same instance stacks its earlier data, so
  write assertions on counts that tolerate this, or restart between runs.
- Never drive an instance this run did not start, and never drive port 5999.

## Driving conventions

- Write scenarios in `output/verify/<run>/scenario.mjs` using `scripts/session.mjs`.
- Use ARIA roles and accessible names. Several icon buttons have machine-style names
  (`pin`, `archive_thread`, `project_menu`). Use those exact strings.
- Routes are hash routes: `s.go('/boards')` opens `http://127.0.0.1:5181/#/boards`.
- Drive desktop first. Repeat with `{ mobile: true }` when the change affects layout, the
  composer, or touch.

## Proof and skip reporting

- Take a screenshot before and after each user action that matters, and reload to prove
  persistence.
- Check the stored value in `$VERIFY_DIR/codex-home` after any mutation.
- `log.txt` must show no `pageerror` lines.
- When a path needs `--live-auth` and you ran UI-only, report it as skipped. Do not report it
  as verified through another path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph. It then has four H2 sections:
`Sub-features`, `How to get to it (user POV)`, `Driving it with Playwright`, and `Gotchas`.

## Features

- [New chat and composer](./new-chat.md): choose a workspace, pick the model and effort, send a message, get a reply. Needs `--live-auth`.
- [Scheduled tasks](./scheduled-tasks.md): create, pause, edit, and delete tasks. UI-only.
- [Project boards](./project-boards.md): the work overview and the plan dialog. UI-only, except that a real planning run needs `--live-auth`.
- [Thread list](./thread-list.md): sidebar filters, pin, rename, archive, and search. Needs at least one chat, so use `--live-auth`.
- [Sidebar settings](./sidebar-settings.md): dark mode, UI font size, speed, the questions toggle, and accounts. UI-only.
