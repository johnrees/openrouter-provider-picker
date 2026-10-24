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

For zsh completion of model slugs and flags, add this to `.zshrc` after `compinit`:

```sh
eval "$(opp --completions zsh)"
```

Or save the output as `_opp` in a directory on your `fpath`. `opp deeps<Tab>` completes
to `deepseek/deepseek-` and a second Tab lists the matches, and `opp v4-pro<Tab>` finds `deepseek/deepseek-v4-pro`. The model list
comes from OpenRouter's public model list and is cached for a day in
`$XDG_CACHE_HOME/opp/models.json`; a Tab press never waits more than two seconds.

To highlight the current match as you press Tab, use zsh's menu selection: `zstyle ':completion:*' menu select` for every command, or `zstyle ':completion:*:*:opp:*' menu select` for `opp` only. It's a zsh setting that the completion script doesn't change.

## Use

```sh
opp z-ai/glm-5.3            # ranked table and the pick (several models are fine)
opp z-ai/glm-5.3 --pick     # just the chosen endpoint tag, e.g. wafer/us
opp z-ai/glm-5.3 --verify   # prove the pick serves and makes a tool call
opp z-ai/glm-5.3 --probe cloudflare   # test all four tool_choice modes on one named endpoint, eligible or not (4 paid requests)
opp z-ai/glm-5.3 --audit-fallback 20   # send 20 unpinned requests and count which providers OpenRouter's default routing served, and their unusable tool calls (refuses if the worst case is over $0.50)
opp z-ai/glm-5.3 --zdr      # zero-data-retention endpoints only
opp z-ai/glm-5.3 -x RU      # drop providers headquartered or hosting in Russia
opp z-ai/glm-5.3 -e inference-net  # never rank or pick InferenceNet
opp z-ai/glm-5.3 -p baseten,together  # only these providers' endpoints (a view: ranking still sees all)
opp z-ai/glm-5.3 --json     # machine-readable
opp z-ai/glm-5.3 --gateway openrouter,vercel  # rank OpenRouter's and Vercel AI Gateway's endpoints in one table
```

`opp --help` lists every option.

Set `OPENROUTER_API_KEY`, or have opencode logged in to OpenRouter. Without a
key, OpenRouter hides latency and throughput, so speed can't be ranked. Listing
Vercel's endpoints needs no key; `--verify` on them needs `AI_GATEWAY_API_KEY`.
Each key is only sent to its own gateway and never printed. `--gateway all`
skips a gateway whose key the run needs but lacks, and says so. When Vercel
answers a probe with HTTP 401 or 403 (a bad key, no card on file, or a free tier
without the model), `--verify` stops probing Vercel and prints its message once.

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

A pick on another gateway is pinned in that gateway's syntax. `--pick` prints an
OpenRouter pick as its bare tag and any other as `<gateway>:<route>`, such as
`vercel:fireworks`; OpenRouter tags never contain `:`. A Vercel pin:

```json
{
  "model": "zai/glm-5.3",
  "providerOptions": { "gateway": { "only": ["fireworks"] } }
}
```

Some slugs differ between the two (`z-ai` is `zai`, `together` is `togetherai`,
`amazon-bedrock` is `bedrock`, `google-vertex` is `vertex`); `opp` maps them, and
`-p`, `-e` and `-x` accept either. OpenRouter adds 5.5% (min $0.80) to card credit purchases and Vercel AI
Gateway adds no markup; `$run` includes neither.

## How it picks

1. **Eligible:** native tools, status 0, and every `tool_choice` mode. Missing
   `required` or `function` silently breaks agent loops. A `--probe` or
   `--verify` result from the last 7 days overrides the listed `tool_choice`
   support for that mode, in either direction, and the row is noted. `--zdr`,
   `-e` and `-x` also exclude here. Everything excluded is listed with its
   reasons. Vercel lists `tool_choice` but not each mode, so a Vercel row takes
   OpenRouter's verdict for the same provider: a mode counts only if every
   OpenRouter endpoint of that provider lists it. A row whose provider isn't on
   OpenRouter stays eligible, flagged `tc?`, and ranks after every verified
   row of its uptime tier; `--verify` is the proof.
2. **Uptime first:** the last day, then the last 30 minutes (the last hour on
   Vercel, whose speed figures are hourly too). 98% or more counts as fully up.
3. **Then speed:** estimated time for a 300-token agent turn (time to first
   token plus streaming). When uptime and speed tie, higher quantization wins:
   fp4 < fp8 < not reported < bf16.
4. **Price only when it's far higher:** an endpoint costing more than 2× _and_
   more than $1 above the cheapest fully reliable one of equal or better
   quantization, per reference agentic session, drops to the bottom
   (`price-elim`). So a cheap fp4 endpoint never eliminates an fp8 one, and a
   `tc?` row never eliminates a verified one. Otherwise price only breaks ties.

Quantization comes only from the gateway's listing. An endpoint that doesn't
report one is assumed close to full precision, which metadata can't confirm, so
a pick like that says `quantization not reported` (`pick.quantizationReported:
false` in `--json`). When precision matters, check the provider's own
documentation.

ZDR status is shown too, and only counts with `--zdr`: OpenRouter's ZDR list
for its rows, Vercel's own `has_zdr` for Vercel's. Vercel rows are priced at
their listed rate, without discounts or regional prices. The thresholds are
constants at the top of `src/policy.ts`.

## Development

```sh
bun install && bun test && bun check && bun fmt
```
