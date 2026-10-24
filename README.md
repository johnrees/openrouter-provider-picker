# openrouter-provider-picker

![opp demo](https://github.com/user-attachments/assets/a4e33acb-8d1a-4f1d-bd06-e5dd606321c1)

I really don't get on with openrouter's default provider picking logic. OPP is my solution.

---

Rank every endpoint that serves a model on [OpenRouter](https://openrouter.ai),
pick the best, and print the routing that pins it with no fallback, so an
outage fails loudly instead of silently switching providers.

## Install

Needs [Bun](https://bun.com). From a clone:

```sh
ln -s "$PWD/provider-picker.ts" ~/.local/bin/opp
```

There's no build step, so edits and `git pull` take effect immediately.

## Use

```sh
opp z-ai/glm-5.3            # ranked table and the pick (several models are fine)
opp z-ai/glm-5.3 --pick     # just the chosen endpoint tag, e.g. wafer/us
opp z-ai/glm-5.3 --verify   # prove the pick serves and makes a tool call
opp z-ai/glm-5.3 --probe cloudflare   # test all four tool_choice modes on one named endpoint, eligible or not (4 paid requests)
opp z-ai/glm-5.3 --zdr      # zero-data-retention endpoints only
opp z-ai/glm-5.3 -x RU      # drop providers headquartered or hosting in Russia
opp z-ai/glm-5.3 -e inference-net  # never rank or pick InferenceNet
opp z-ai/glm-5.3 -p baseten,together  # only these providers' endpoints (a view: ranking still sees all)
opp z-ai/glm-5.3 --json     # machine-readable
```

`opp --help` lists every option.

Set `OPENROUTER_API_KEY`, or have opencode logged in to OpenRouter. Without a
key, OpenRouter hides latency and throughput, so speed can't be ranked. The key
is only sent to openrouter.ai and never printed.

## Pinning

Put the printed routing in your request:

```json
{
  "model": "z-ai/glm-5.3",
  "provider": { "only": ["fireworks"], "ignore": ["fireworks/fast", "fireworks/spot"], "allow_fallbacks": false }
}
```

Pin by endpoint **tag** (`fireworks`), not provider name: one provider often
runs several endpoints of a model at different quantizations and prices. A
`model:provider` suffix such as `z-ai/glm-5.3:Together` does nothing;
OpenRouter ignores it. OpenRouter's `only` matches every endpoint whose tag
starts with the pinned tag plus `/`, so `opp` lists those in `ignore`. Scripts
should take the routing from `--json` (`.models[].pick.routing`) rather than
build `only: [tag]` from `--pick`.

## How it picks

1. **Eligible:** native tools, status 0, and every `tool_choice` mode. Missing
   `required` or `function` silently breaks agent loops. `--zdr`, `-e` and `-x`
   also exclude here. Everything excluded is listed with its reasons.
2. **Uptime first:** the last day, then the last 30 minutes. 98% or more counts
   as fully up.
3. **Then speed:** estimated time for a 300-token agent turn (time to first
   token plus streaming).
4. **Price only when it's far higher:** an endpoint costing more than 2× _and_
   more than $1 above the cheapest fully reliable one, per reference agentic
   session, drops to the bottom (`price-elim`). Otherwise price only breaks
   ties.

Quantization is shown but never ranked. ZDR status is shown too, and only
counts with `--zdr`. The thresholds are constants at the top of
`provider-picker.ts`.

## Development

```sh
bun install && bun test && bun check && bun fmt
```
