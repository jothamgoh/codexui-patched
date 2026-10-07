# Project boards

Project boards turn a goal into a plan of features that a team of agents works through. The
work overview lists boards and anything that needs the user.

## Sub-features

- `boards-overview` lists boards, with a project filter and an empty state.
- `boards-plan-dialog` collects a goal, a board name, and a project folder (typed or browsed).
- `boards-plan-run` starts a planning run (needs `--live-auth`, and spends quota).

## How to get to it (user POV)

- Choose `Project boards` in the sidebar (shortcut `⌘B`), or open `#/boards`.
- Open a board at `#/board/<id>`.

## Driving it with Playwright

Preconditions:

- UI-only for the overview and the dialog. `--live-auth` for an actual plan.

- **Overview.** Open `#/boards`. The heading is `Work overview`. Region `Your boards` shows
  `No boards yet. Create a plan to review and track its features.` on a fresh instance.
- **Plan dialog.** Choose `New plan`. The dialog `Plan project features` has textboxes
  `Goal or plan`, `Board name`, and `Project folder`, a `Browse computer folders` button, the
  checkbox `Create this folder if it does not exist`, and `Create feature plan`.
- **Folder browse keeps the draft.** Fill the goal and board name, choose
  `Browse computer folders`, pick a folder in dialog `Choose a folder` with `Use folder`, and
  confirm that the goal and board name still hold their values.
- **Proof.** Take a screenshot of the dialog before and after browsing. After a live plan,
  `$VERIFY_DIR/codex-home/codexui-project-boards.json` contains the board.

## Gotchas

- `npm run test:e2e:project-boards` already covers deep board flows against mocked data. Use
  this skill when the change needs the real bridge.
- In UI-only mode, `Browse computer folders` lists the real home directory. Browsing is
  read-only, but do not create folders outside `$VERIFY_DIR`.
