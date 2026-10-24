Let code and tests carry the design; keep docs minimal and say nothing the code or another doc already says. `README.md` is for people using `opp`, not a design log. No time estimates anywhere.

- A change to the ranking or its Policy constants updates README's "How it picks" and `--help` in the same PR.
- Work comes from issues in the order `agent-gh next` gives. Take one with `agent-gh claim <n>`; run `agent-gh review sweep` before each push; before `gh pr ready`, run `agent-gh review full` and answer each finding with `agent-gh reply`.
- New issues follow `.github/ISSUE_TEMPLATE/task.md`; PR bodies follow `.github/PULL_REQUEST_TEMPLATE.md`. The claim's draft body is a placeholder; fill the template before `gh pr ready`.
- Bun-native tooling only: no `tsc`, prettier or other toolchain dependencies; dependencies at their latest versions.
- Tests never touch the network. Live runs (`--verify` sends paid requests) are evidence for the PR body, not tests. Never print, log or post the OpenRouter key.
- Labels explain themselves on GitHub; only John adds `ready`. A milestone's description holds its goal and pass criteria, then a `Decisions:` list with one line per closed issue (`#N: what was decided, where it lives. PR #M.`).
- Record results and decisions on the issue they answer. When you finish an issue, do what its **When done, update** line says.
