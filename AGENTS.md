Let code and tests carry the design; keep docs minimal and say nothing the code or another doc already says. `README.md` is for people using `opp`, not a design log. No time estimates anywhere.

- A change to the ranking or its Policy constants updates README's "How it picks" and `--help` in the same PR.
- Work comes from issues in the order `agent-gh next` gives. Take one with `agent-gh claim <n>`; run `agent-gh review sweep` before each push; before `gh pr ready`, run `agent-gh review full` and answer each finding with `agent-gh reply`.
- New issues follow `.github/ISSUE_TEMPLATE/task.md`; PR bodies follow `.github/PULL_REQUEST_TEMPLATE.md`. The claim's draft body is a placeholder; fill the template before `gh pr ready`.
- Bun-native tooling only: no `tsc`, prettier or other toolchain dependencies; dependencies at their latest versions.
- Tests never touch the network. Live runs (`--verify` sends paid requests) are evidence for the PR body, not tests. Never print, log or post an API key; keys live in the ignored `.env`.
- Fixtures are synthetic. Never commit a gateway's real responses or publish its measurements (OpenRouter's and Vercel's terms restrict both); anything published holds only `opp`'s own probe results.
- A review finding is work: fix it, or, when the issue's spec is what's in dispute, John decides, the issue is amended and the review re-run. Don't ask for a waiver.
- A measured discrepancy in a gateway's published data (a probe contradicts its listing) is filed here as a `finding` issue: neutral, dated, with reproduction commands, the limits of the evidence and a **Done when** for re-verification. Nothing goes upstream unless John asks.
- Labels explain themselves on GitHub; only John adds `ready`. A milestone's description holds its goal and pass criteria, then a `Decisions:` list with one line per closed issue (`#N: what was decided, where it lives. PR #M.`).
- Record results and decisions on the issue they answer. When you finish an issue, do what its **When done, update** line says.
