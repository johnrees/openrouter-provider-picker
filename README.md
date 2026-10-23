# openrouter-provider-picker

Rank every endpoint that serves a model on [OpenRouter](https://openrouter.ai),
pick the best one under an explicit policy, and print the request routing that
pins it with no fallback.

OpenRouter's default router chooses a provider per request and silently falls
back when one fails. For agentic work that hides what actually ran.
Quantization, `tool_choice` support and uptime all differ by endpoint, and a
silent reroute makes a run impossible to attribute. Pinning one endpoint makes
an outage fail loudly instead.

```sh
opp z-ai/glm-5.3            # rank one model's endpoints (name as many models as you like)
opp z-ai/glm-5.3 -x CN      # drop providers based or hosting in China
opp z-ai/glm-5.3 -p baseten # only BaseTen's endpoints (or a bare word: … baseten)
opp z-ai/glm-5.3 --verify   # prove the pick serves for this account
opp z-ai/glm-5.3 --json     # machine-readable output
opp z-ai/glm-5.3 --pick     # just the chosen endpoint tag: wafer/us
```

## Install

The command is `opp`. It needs [Bun](https://bun.com) and has no other
dependencies. From a clone, link the script onto your PATH:

```sh
ln -s "$PWD/provider-picker.ts" ~/.local/bin/opp
```

Because it's a symlink and Bun runs TypeScript directly, there's no build step:
every run uses the current file, so an edit or a `git pull` takes effect
immediately. That includes switching branches in the clone. Without
installing, run `./provider-picker.ts` from the clone instead.

`package.json` maps `opp` to the script under `bin`, so an npm install creates
the same command whatever the package is published as. It is marked `private`
to prevent an accidental publish; remove that line to publish. Only the script
and this README are packed.

```text
## z-ai/glm-5.3 · 26 of 48 eligible
      #  endpoint           quant  hq  dc  up1d  up30m  up5m  turn_s  ttfb  tok/s  reqs  maxout    $in  $cache  $out  $run  …  note
  ▶   1  wafer/us           fp4    US  ?    100    100   100     3.0   443    116   58k    944k  0.079   0.078   1.4  0.63
      2  wafer/fp4          fp4    US  ?    100    100   100     3.1   380    109   22k    944k  0.179   0.178   1.4  1.38
      …
     13  together           ?      US  ?    100    100   100     3.7   755    103  4837    944k    1.4    0.26   4.4  2.65     price-elim
      …
  probe wafer/us: ok (served by Wafer, finish=stop)
  verified pin: z-ai/glm-5.3:wafer/us
  routing: "provider": {"only":["wafer/us"],"allow_fallbacks":false}
  ineligible:
    deepinfra/fp4             tool_choice lacks required
    baidu/fp8                 tool_choice lacks required/function; headquartered in CN
    …
```

## Pinning an endpoint

Put the `routing` line in the chat completion request:

```json
{
  "model": "z-ai/glm-5.3",
  "provider": { "only": ["wafer/us"], "allow_fallbacks": false },
  "messages": []
}
```

Pin by the endpoint **tag** (`wafer/us`), not the provider name. One provider
often runs several endpoints of the same model at different quantizations,
regions and prices. GLM-5.3 has four BaseTen endpoints, for example. A tag
names exactly one endpoint, and a provider name matches all of them.

A `model:provider` suffix such as `z-ai/glm-5.3:Together` does **not** pin
anything. OpenRouter ignores it and routes as usual. The `pin` line
(`model:tag`) is only a compact identifier for your own config. Whatever reads
it has to turn it into the `provider` object above.

For scripts, `--pick` prints only the chosen tag, one line per model in
argument order. It combines with every filter and with `--verify`:

```sh
tag=$(opp z-ai/glm-5.3 -x CN --verify --pick) || exit 1
```

A model with no pick writes its reason to stderr, prints nothing to stdout and
makes the exit status 1. With several models, check the exit status before
matching lines to models.

## Ranking policy

Uptime and speed come first. Price matters only when an endpoint would be far
more expensive.

1. **Eligibility.** Endpoints must have native `tools`, `status` 0, and all
   four `tool_choice` modes (`none`, `auto`, `required`, `function`). An
   endpoint without `required` or `function` silently breaks agent loops,
   which is worse than an outage. Endpoints excluded by `--exclude-country`
   are also ineligible. Every ineligible endpoint is listed with its reasons.
2. **Reliability.** Uptime over the last day, then the last 30 minutes. At or
   above 98% counts as fully up, so small differences don't outrank speed.
   The 1-day window wins conflicts: a clean day outranks a clean half hour.
3. **Speed.** `turn_s` estimates one agent turn: median time to first token
   plus 300 output tokens at median throughput. 300 is the reference run's
   output spread over about 100 turns. Combining the two matters because an
   endpoint that starts fast but streams at 20 tok/s is slow.
4. **Output headroom** (`maxout`), then **price** (`$run`), break any
   remaining ties.

**Price guard.** `$run` is the cost of a reference agentic session: 500k
fresh input tokens, 7M cache-read tokens and 30k output tokens. An endpoint
whose `$run` is both more than **2×** and more than **$1** above the cheapest
endpoint in the top reliability tier is marked `price-elim` and ranks after
every endpoint that isn't. It stays available as a last resort, and price-elim
endpoints keep their reliability and speed order among themselves. Requiring
both thresholds means a 3× gap on pennies doesn't count. Without a cache-read
price, cached tokens are charged at the input rate, since no cache price means
no cache discount. Missing input or output prices make `$run` unknown, never
cheap.

**Quantization** (`quant`) is shown but never ranked. Lower precision may cost
quality, but that is unproven per endpoint.

The constants at the top of `provider-picker.ts` hold every threshold.

## Filters

- `-p`, `--provider <name>` keeps endpoints whose provider name or tag
  contains `<name>`. It only narrows the view: the price guard still compares
  against every eligible endpoint.
- `-x`, `--exclude-country <CC>` drops endpoints whose provider is
  headquartered in, or has a datacenter in, any listed ISO country (`-x CN,RU`).
  This is a hard constraint applied before ranking. Locations come from
  OpenRouter's `/providers` API and are only as good as that data. Many
  providers list no datacenters (`?`). Unknown locations are kept, not
  excluded. OpenRouter lists some Chinese companies under a Singapore entity:
  Z.AI's headquarters show as `SG`, for example. Check the `hq` and `dc`
  columns for anything that matters.

## `--verify`

Some routing decisions are visible in no API field, such as account data
policies like zero-data-retention or training opt-outs. They are enforced only
when a request is routed. `--verify` sends one tiny pinned completion to each
candidate in rank order, at most 256 output tokens each. It stops at the first
endpoint that serves, then checks the response really came from that provider.
Candidates that fail are shown with the reason, for example `HTTP 404 No
allowed providers are available…`.

## Auth and secrets

OpenRouter only returns latency and throughput to authenticated callers. The
key comes from `OPENROUTER_API_KEY`, or from opencode's credential store
(`sqlite3 -readonly` on `$XDG_DATA_HOME/opencode/opencode.db`). Without a key
the tool still ranks, but without speed data. `--verify` requires a key.

The key is sent only to `https://openrouter.ai`. Redirects are refused, so it
can never be forwarded to another host. The provider-location lookup is public
and is sent without the key. The key is never printed. Upstream error text is
scrubbed of the key and anything shaped like `sk-or-…` before display, and
terminal control characters are stripped. Both happen before truncation.

## Exit status

`0` if every model has a pick (a verified one, with `--verify`), `1` if any
model has none or its fetch failed, `2` on a usage error.

## Development

```sh
bun install   # Bun's type definitions only; the script has no runtime dependencies
bun test      # policy, parsing and secret-handling tests
bun check     # strict typecheck (tsconfig.json)
bun fmt       # format (print width 120, set in bunfig.toml)
```
