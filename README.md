# openrouter-provider-picker

Rank OpenRouter's serving endpoints per model and pick one to **pin** — the
`model:provider` suffix that makes a dispatch id an explicit allowlist of a
single serving endpoint (no fallback, so an outage fails loudly instead of
silently rerouting). Replaces OpenRouter's default price/speed router for
workloads where a run should be attributable to the model, not the serving
path.

Run: `bun provider-picker.ts [model/slug ...] [--provider <part> | <part>] [--verify]`

## Modes

```sh
bun provider-picker.ts                                # default roster
bun provider-picker.ts z-ai/glm-5.3                   # specified models
bun provider-picker.ts z-ai/glm-5.3 --provider google # ranked shortlist (filtered)
bun provider-picker.ts z-ai/glm-5.3 together           # bare positional filter
bun provider-picker.ts z-ai/glm-5.3 --verify           # probe the ranked candidates
bun provider-picker.ts --help
```

With `--provider`, one eligible match prints its pin id (`model:provider`);
several print a ranked shortlist; none exits 1.

## Ranking policy

- **Eligible**: native `tools`, `status` 0, and full `tool_choice` support
  (`none`/`auto`/`required`/`function`, all strictly `true` — a provider
  without `required`/`function` corrupts agentic runs invisibly, worse than a
  stall).
- **Rank**: reliability first with an uptime saturation tolerance (≥98 on a
  window counts as tied; `uptime_last_1d` decides over 30m when they
  conflict — clean last-24h outranks stale 30-day incidents), then speed
  heavily (median TTFB ascending first — short agent turns — then median
  tok/s), then output headroom (nulls last).
- **Price** ($in / $cache_read / $out per M) is the final tiebreaker only,
  never a ranking key — except the significant-difference guard: within the
  competitive tier (tied on both uptime windows), a provider whose
  representative run costs both >2x the tier's cheapest and more than $1
  extra ranks last, flagged `PRICE-ELIMINATED`. Under-$1 differences are
  noise.
- **Quantization** is displayed (`q=`), never ranked — suspected, unproven.
- Rows print capability columns (`tools`, `tool_choice`, structured outputs,
  reasoning, `reasoning_effort`), uptime windows, speed percentiles,
  request volume, limits, and all three price rates.

## `--verify`: account data controls

OpenRouter enforces per-account data controls (e.g. zero-retention
exclusions) at **routing time** and exposes compliance in no API field — so
the only honest check is a real request. `--verify` walks each model's
ranked candidates with a minimal completion per `model:provider` pin: a
provider that errors (no such route, policy, timeout) or returns an empty
completion is excluded and the next candidate is tried; the first that
serves prints `VERIFIED PIN`. Costs ~130 tokens per probe.

## Auth

Latency/throughput percentiles are null for anonymous calls, so the tool
authenticates when it can: `OPENROUTER_API_KEY`, else the local opencode
credential store (`sqlite3 -readonly` on `opencode.db`). The key is never
printed. Without auth the tool still ranks — on uptime, limits and price,
with speed keys tied.