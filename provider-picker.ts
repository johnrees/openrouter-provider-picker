#!/usr/bin/env bun
/**
 * Rank OpenRouter endpoints and print `model:provider` dispatcher pins.
 * Run: bun provider-picker.ts [model/slug ...] [--provider <part> | <part>] [--verify]
 * No model slugs uses the six-model ROSTER; -h/--help prints usage.
 * Provider filters match provider_name case-insensitively: one eligible match
 * prints its pin and full row; multiple matches form a ranked shortlist.
 * No eligible match or a per-model fetch failure sets exit code 1; other models
 * still run. Live ineligible endpoints are listed with their reasons.
 *
 * --verify walks the ranked eligible candidates per model (filtered first when
 * --provider is given) and makes a real minimal completion request to each
 * `model:provider` pin in order: a provider that errors (no such route,
 * account policy — e.g. zero-retention exclusions enforced at routing time —
 * timeout) or returns an empty completion is excluded, and the next candidate
 * is tried; the first provider that serves a non-empty completion is printed
 * as the VERIFIED PIN. This is the only honest check for account data
 * controls: compliance is enforced at routing time and exposed by no API
 * field. Verification costs ~1 output token per candidate tested.
 *
 * Eligible = tools + status 0 (absent = 0) + all four tool_choice modes true.
 * Rank: uptime 1d desc, uptime 30m desc (each >=98% ties as 100%), then
 * latency p50 asc, throughput p50 desc (both nulls last), max completion
 * tokens desc, then prompt, cache-read and completion prices asc as final
 * tiebreakers. Missing or invalid numeric metrics sort last.
 * Within the best eligible tier tied on BOTH uptime windows, a representative
 * run costing BOTH >2x its cheapest member AND >$1 more ranks LAST among
 * all eligible endpoints. Missing prices are unknown, never a cheap baseline.
 * Run cost = (500,000 * prompt + 7,000,000 * cache-read + 30,000 * completion)
 * / 1,000,000, with API per-token rates converted to dollars per million.
 * Price has no other ranking role. Ranking and this guard are computed
 * before provider filtering. Quantization is displayed only.
 */

const PRICE_ELIM_RATIO = 2;
const PRICE_ELIM_DELTA_USD = 1;
const UPTIME_SATURATION = 98;
const TOKENS_PER_MILLION = 1_000_000;
const REF_PROMPT_TOKENS = 500_000;
const REF_CACHE_READ_TOKENS = 7_000_000;
const REF_COMPLETION_TOKENS = 30_000;
const TOOL_CHOICE_MODES = ["none", "auto", "required", "function"] as const;
const ROSTER: readonly string[] = [
  "xiaomi/mimo-v2.6-flash",
  "deepseek/deepseek-v4.1-flash-1017",
  "z-ai/glm-5.3",
  "z-ai/glm-5.3-flash",
  "minimax/minimax-m3.1-flash",
  "qwen/qwen3.8-27b",
];

type Percentiles = { p50?: number | null; p75?: number | null; p90?: number | null; p99?: number | null };
type WorkloadPerf = {
  latency?: Percentiles | null;
  throughput?: Percentiles | null;
  request_count?: number | null;
};
type Endpoint = {
  provider_name: string;
  supported_parameters: string[];
  supports_tool_choice?: Partial<Record<(typeof TOOL_CHOICE_MODES)[number], unknown>> | null;
  status?: number | null;
  quantization?: string | null;
  uptime_last_5m?: number | null;
  uptime_last_30m?: number | null;
  uptime_last_1d?: number | null;
  throughput_last_30m?: Percentiles | null;
  latency_last_30m?: Percentiles | null;
  perf_last_30m_by_workload?: Record<string, WorkloadPerf> | null;
  max_completion_tokens?: number | null;
  pricing: { prompt?: string | null; input_cache_read?: string | null; completion?: string | null };
};
type Options = { slugs: readonly string[]; provider?: string; verify?: boolean };
type RankedEndpoint = { endpoint: Endpoint; priceEliminated: boolean };
type VerifyResult = { provider: string; ok: boolean; detail: string };

const USAGE = `Usage: bun provider-picker.ts [model/slug ...] [--provider <part> | <part>]

  No model slugs       Rank the default six-model roster
  model/slug ...       Rank the specified models
  --provider <part>    Filter provider names (case-insensitive substring)
  <part>              Bare provider filter, without a slash
  -h, --help          Show this help

One eligible filtered match prints model:provider and <== PIN (filtered).
Multiple matches print a ranked shortlist. No eligible match exits with code 1.`;

function parseArgs(args: string[]): Options {
  const slugs: string[] = [];
  let provider: string | undefined;
  let verify = false;
  const setProvider = (value: string): void => {
    if (!value.trim()) throw new Error("provider filter must not be empty");
    if (provider !== undefined) throw new Error("specify only one provider filter");
    provider = value.trim();
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--provider") {
      const value = args[++i];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--provider requires a provider name fragment");
      }
      setProvider(value);
    } else if (arg === "--verify") {
      if (verify) throw new Error("--verify specified twice");
      verify = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else if (arg.includes("/")) {
      slugs.push(arg);
    } else {
      setProvider(arg);
    }
  }
  return { slugs: slugs.length ? slugs : ROSTER, provider, verify };
}

function missingToolChoice(ep: Endpoint): string[] {
  return TOOL_CHOICE_MODES.filter((mode) => ep.supports_tool_choice?.[mode] !== true);
}

function ineligibleReasons(ep: Endpoint): string[] {
  const reasons: string[] = [];
  if (!ep.supported_parameters.includes("tools")) reasons.push("no native tools");
  if ((ep.status ?? 0) !== 0) reasons.push(`status=${ep.status}`);
  const missing = missingToolChoice(ep);
  if (missing.length) reasons.push(`tool_choice missing ${missing.join("/")}`);
  return reasons;
}

function price(value: string | null | undefined): number {
  if (value == null || value.trim() === "") return Infinity;
  const parsed = Number(value);
  // OpenRouter endpoint prices are USD/token; all local prices are USD/million.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * TOKENS_PER_MILLION : Infinity;
}

function runCost(ep: Endpoint): number {
  return (
    REF_PROMPT_TOKENS * price(ep.pricing.prompt) +
    REF_CACHE_READ_TOKENS * price(ep.pricing.input_cache_read) +
    REF_COMPLETION_TOKENS * price(ep.pricing.completion)
  ) / TOKENS_PER_MILLION;
}

// Short agent turns favor median TTFB first; throughput breaks ties for long outputs.
const p50 = (p?: Percentiles | null): number => finiteNonnegative(p?.p50);
function finiteNonnegative(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : Number.NaN;
}
// Apply direction before the missing-value sentinel, especially for descending keys.
const nullsLast = (value: number, descending = false): number =>
  Number.isNaN(value) ? Infinity : descending ? -value : value;
const uptime = (value: number | null | undefined): number => {
  const valid = finiteNonnegative(value);
  return valid >= UPTIME_SATURATION ? 100 : valid;
};
// The 1-day window wins conflicts; 30-minute uptime discriminates only below 98%.
const uptimeKeys = (ep: Endpoint): readonly number[] => [
  nullsLast(uptime(ep.uptime_last_1d), true),
  nullsLast(uptime(ep.uptime_last_30m), true),
];

function rankKey(ep: Endpoint): readonly number[] {
  return [
    ...uptimeKeys(ep),
    nullsLast(p50(ep.latency_last_30m)), // median TTFB ms
    nullsLast(p50(ep.throughput_last_30m), true), // median tok/s
    nullsLast(finiteNonnegative(ep.max_completion_tokens), true), // headroom
    price(ep.pricing.prompt),
    price(ep.pricing.input_cache_read),
    price(ep.pricing.completion),
  ];
}

function rank(endpoints: Endpoint[]): RankedEndpoint[] {
  const eligible = endpoints.filter((ep) => ineligibleReasons(ep).length === 0);
  if (!eligible.length) return [];
  // Use the same saturation buckets as ordering, not raw uptime equality.
  const bestUp1d = Math.min(...eligible.map((ep) => uptimeKeys(ep)[0]!));
  const up1dTier = eligible.filter((ep) => uptimeKeys(ep)[0] === bestUp1d);
  const bestUp30 = Math.min(...up1dTier.map((ep) => uptimeKeys(ep)[1]!));
  const tier = new Set(up1dTier.filter((ep) => uptimeKeys(ep)[1] === bestUp30));
  const cheapest = Math.min(...[...tier].map(runCost));
  return eligible.map((endpoint): RankedEndpoint => {
    const cost = runCost(endpoint);
    return {
      endpoint,
      priceEliminated: tier.has(endpoint) && Number.isFinite(cheapest) &&
        cost > cheapest * PRICE_ELIM_RATIO && cost - cheapest > PRICE_ELIM_DELTA_USD,
    };
  }).sort((a, b) => {
    if (a.priceEliminated !== b.priceEliminated) return a.priceEliminated ? 1 : -1;
    const ka = rankKey(a.endpoint);
    const kb = rankKey(b.endpoint);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? -1 : 1;
    }
    return 0;
  });
}

// OpenRouter hides latency/throughput percentiles from unauthenticated calls
// (they come back null). Read the key from the environment, falling back to
// opencode's own credential store (value is a JSON envelope: {"type":"key",
// "key":"sk-or-..."}). Capture the subprocess output explicitly; never print it.
function openrouterKey(): string | undefined {
  const envKey = process.env.OPENROUTER_API_KEY?.trim();
  if (envKey) return envKey;
  try {
    if (!process.env.HOME) return undefined;
    const db = `${process.env.HOME}/.local/share/opencode/opencode.db`;
    const proc = Bun.spawnSync(["sqlite3", "-readonly", db, "select value from credential where label='OpenRouter' and active=1 limit 1"], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    if (proc.exitCode !== 0) return undefined;
    const raw = proc.stdout.toString().trim();
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { type?: string; key?: string };
      return parsed?.type === "key" && typeof parsed.key === "string"
        ? parsed.key.trim() || undefined : undefined;
    } catch {
      return undefined; // never send a raw non-envelope value
    }
  } catch {
    return undefined;
  }
}

async function fetchEndpoints(slug: string, apiKey?: string): Promise<Endpoint[]> {
  const path = slug.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`https://openrouter.ai/api/v1/models/${path}/endpoints`, {
    signal: AbortSignal.timeout(30_000),
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const body = await res.json() as { data?: { endpoints?: Endpoint[] } } | null;
  if (!Array.isArray(body?.data?.endpoints)) throw new Error("invalid response: expected data.endpoints array");
  // Reject malformed required fields before ranking; keep failures per model.
  for (const ep of body.data.endpoints) {
    if (!ep || typeof ep.provider_name !== "string" || !ep.provider_name.trim() ||
        !Array.isArray(ep.supported_parameters) ||
        !ep.supported_parameters.every((parameter) => typeof parameter === "string") ||
        !ep.pricing || typeof ep.pricing !== "object" ||
        ![ep.pricing.prompt, ep.pricing.input_cache_read, ep.pricing.completion]
          .every((rate) => rate == null || typeof rate === "string")) {
      throw new Error("invalid response: malformed endpoint");
    }
  }
  return body.data.endpoints;
}

// --verify probe: one real minimal completion through the model:provider pin.
// Account data controls (e.g. zero-retention exclusions) are enforced at
// routing time and exposed by no API field, so a served request is the only
// honest check. A provider that errors (no such route, policy, timeout) or
// returns an empty completion is excluded; the walk tries the next
// candidate in rank order.
async function probePin(slug: string, provider: string, apiKey: string): Promise<VerifyResult> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `${slug}:${provider}`,
        messages: [{ role: "user", content: "Reply with exactly: ROUTED-OK" }],
        // Reasoning models burn tokens on thinking before any text; a tiny
        // budget would surface as finish=length with empty content and
        // wrongly exclude a serving provider (witnessed on minimax).
        max_tokens: 128,
      }),
    });
    const body = await res.json().catch(() => null) as
      | { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; error?: { message?: unknown } }
      | null;
    let detail = `HTTP ${res.status} ${res.statusText}`.trim();
    if (body?.error?.message != null) detail += ` ${String(body.error.message).slice(0, 160)}`;
    if (!res.ok) return { provider, ok: false, detail };
    const choice = body?.choices?.[0];
    const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
    const finish = typeof choice?.finish_reason === "string" ? choice.finish_reason : "?";
    if (text.trim()) return { provider, ok: true, detail: `non-empty completion (finish=${finish})` };
    return { provider, ok: false, detail: `empty completion (finish=${finish})` };
  } catch (error) {
    return { provider, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function row(ep: Endpoint): string {
  const rate = (value: string | null | undefined): string => {
    const parsed = price(value);
    return Number.isFinite(parsed) ? Number(parsed.toPrecision(12)).toString() : "-";
  };
  const up = (value: number | null | undefined): string =>
    Number.isNaN(finiteNonnegative(value)) ? "-" : value!.toFixed(2);
  const has = (parameter: string): string => ep.supported_parameters.includes(parameter) ? "Y" : "N";
  const missing = missingToolChoice(ep);
  const tc = missing.length ? `partial(${missing.join("/")})` : "full";
  const ttfb = p50(ep.latency_last_30m);
  const tps = p50(ep.throughput_last_30m);
  const gen = ep.perf_last_30m_by_workload?.text_generation;
  const reqs = gen?.request_count ?? "-";
  return `${ep.provider_name.padEnd(14)} tools=${has("tools")} tc=${tc.padEnd(21)} so=${has("structured_outputs")} re=${has("reasoning")} reff=${has("reasoning_effort")} q=${ep.quantization ?? "-"} up5m=${up(ep.uptime_last_5m)} up30=${up(ep.uptime_last_30m)} up1d=${up(ep.uptime_last_1d)} tps=${Number.isNaN(tps) ? "-" : tps} ttfb_ms=${Number.isNaN(ttfb) ? "-" : ttfb} reqs30m=${reqs} maxout=${ep.max_completion_tokens ?? "-"} $in/m=${rate(ep.pricing.prompt)} $cr/m=${rate(ep.pricing.input_cache_read)} $out/m=${rate(ep.pricing.completion)}`;
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return;
  }
  let options: Options;
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const filter = options.provider?.toLowerCase();
  const apiKey = openrouterKey();
  console.log(`# provider pin ranking — ${new Date().toISOString()}`);
  console.log(`# policy: uptime 1d desc, uptime 30m desc (each >=${UPTIME_SATURATION}% ties as 100%); TTFB p50 asc, throughput p50 desc, maxout desc (missing last); prompt/cache-read/completion price asc final tiebreakers; best uptime tier: BOTH >${PRICE_ELIM_RATIO}x cheapest AND >$${PRICE_ELIM_DELTA_USD.toFixed(2)} extra per REF run ranks last; REF=500k prompt+7m cache-read+30k completion; prices USD/million; unknown prices never a cheap baseline; rank before filtering; q display-only`);
  console.log(`# auth: ${apiKey ? "authenticated (latency/throughput visible)" : "ANONYMOUS (latency/throughput null — set OPENROUTER_API_KEY)"}`);
  for (const slug of options.slugs) {
    console.log(`\n## ${slug}${options.provider === undefined ? "" : ` — provider contains ${JSON.stringify(options.provider)}`}`);
    try {
      const endpoints = await fetchEndpoints(slug, apiKey);
      const matches = (ep: Endpoint): boolean => filter === undefined || ep.provider_name.toLowerCase().includes(filter);
      const sorted = rank(endpoints).filter(({ endpoint }) => matches(endpoint));
      if (!sorted.length) {
        console.log(`  no eligible provider${filter === undefined ? "" : ` matching ${JSON.stringify(options.provider)}`} (tools + full tool_choice + status 0)`);
        process.exitCode = 1;
      } else if (filter !== undefined && sorted.length === 1) {
        console.log(`  PIN: ${slug}:${sorted[0]!.endpoint.provider_name}`);
      } else if (filter !== undefined) {
        console.log(`  shortlist: ${sorted.length} eligible providers`);
      }
      sorted.forEach(({ endpoint, priceEliminated }, i) => {
        const pin = filter === undefined ? (i === 0 ? "  <== PIN" : "")
          : sorted.length === 1 ? "  <== PIN (filtered)" : "";
        console.log(`  ${row(endpoint)}${pin}${priceEliminated ? " PRICE-ELIMINATED" : ""}`);
      });
      for (const ep of endpoints) {
        if (!matches(ep) || (ep.status ?? 0) !== 0) continue;
        const reasons = ineligibleReasons(ep);
        if (reasons.length) console.log(`  (ineligible, ${reasons.join("; ")}: ${ep.provider_name})`);
      }
      if (options.verify && sorted.length) {
        if (!apiKey) {
          console.log("  --verify requires an API key (OPENROUTER_API_KEY or the opencode credential store)");
          process.exitCode = 1;
        } else {
          let served: VerifyResult | undefined;
          let probes = 0;
          for (const { endpoint } of sorted) {
            const r = await probePin(slug, endpoint.provider_name, apiKey);
            probes++;
            console.log(`  probe ${slug}:${r.provider} — ${r.ok ? "SERVED" : `EXCLUDED (${r.detail})`}`);
            if (r.ok) {
              served = r;
              break;
            }
          }
          if (served) {
            console.log(`  VERIFIED PIN: ${slug}:${served.provider} (${probes} probe${probes === 1 ? "" : "s"}, ${served.detail})`);
          } else {
            console.log(`  no serving candidate after ${probes} probe${probes === 1 ? "" : "s"}`);
            process.exitCode = 1;
          }
        }
      }
    } catch (error) {
      console.log(`  fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}

await main();
