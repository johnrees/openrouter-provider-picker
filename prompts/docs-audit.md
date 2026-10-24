# Docs audit

A periodic maintenance pass: every doc checked against the code at current `main`. Rules: `AGENTS.md`. This file: judgment only.

- Read: every Markdown file (`README.md`, `AGENTS.md`, `CLAUDE.md`, `prompts/`), the header, section and doc comments in `provider-picker.ts`, `src/` and their tests, `opp --help`, `.github/` workflow comments and config, `package.json` and `bunfig.toml`.
- Standard: code is the source of truth. A line earns its place only by stating a decision, a rule, or a fact the code cannot. Nothing stale, nothing said twice (keep the one nearest its use, point to it), nothing a reader gets by reading the code the line points at.
- Method: per file, list its claims; verify each by reading the code or running the command, never from memory. Delete before rewording; add only a real gap that cannot live in code.
- Look for: flags, options and names that no longer exist, commands that no longer run as written (README's examples and Development line included), policy thresholds and ranking steps in README's "How it picks" that disagree with the constants and `rank` in `src/policy.ts`, counts and results copied from code or runs, forward pointers to closed issues, narrative of what a test already asserts.
- `--help` text is program output, not a doc: a stale line there is a finding on the issue, fixed by a code PR, not in the audit.
- A doc sentence that wants to be a guardrail (a test, a check, CI) stays; note it on the issue as a candidate, never build it in the audit.
- Skip files an open PR touches (`gh pr list --json number,files`); say on the issue what was skipped and why.
- Output: one PR of text-only changes (no behaviour, code or test changes beyond comments; `bun test`, `bun check` and `bun fmt --check` still pass), and on the issue and in the PR body a per-file table: removed / corrected / added, a phrase each, plus what was checked and left, what could not be verified, and the guardrail candidates.
