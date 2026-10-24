/**
 * The policy: which endpoints are eligible and how they rank, with the types
 * the rest of opp shares. No Bun APIs and no network, so any runtime can use it.
 */

/** Uptime at or above this percentage counts as fully up, so 98.5 and 100 tie. */
export const UPTIME_SATURATION = 98;
/**
 * Output tokens in a typical agent turn, used to combine time-to-first-token
 * and throughput into one speed figure. This is REFERENCE_RUN's completion
 * tokens spread over roughly 100 turns.
 */
export const TURN_OUTPUT_TOKENS = 300;
/**
 * An endpoint ranks after all others when its reference run costs more than
 * this multiple of the cheapest in the most reliable tier with equal or better
 * quantization...
 */
export const PRICE_ELIM_RATIO = 2;
/** ...and also more than this many dollars extra. Smaller gaps are noise. */
export const PRICE_ELIM_DELTA_USD = 1;
/**
 * Token mix of a long agentic session, used to compare prices as one number.
 * Agent loops resend their context, so cache reads dominate: measured sessions
 * read 6M to 29M cached tokens against 0.1M to 2M fresh.
 */
export const REFERENCE_RUN = { prompt: 500_000, cacheRead: 15_000_000, completion: 30_000 } as const;
/** An endpoint missing any of these silently degrades agent loops, so it is ineligible. */
export const TOOL_CHOICE_MODES = ["none", "auto", "required", "function"] as const;
/** A probe result older than this is ignored, and the listing decides that mode again. */
export const PROBE_TTL_DAYS = 7;
export const COUNTRY = /^[A-Z]{2}$/;
/**
 * Quantizations from lowest to highest precision; values in one group rank
 * equal. Missing and unlisted values rank with "unknown": below a reported
 * full precision, which wins a tie, but above fp8, so a provider that doesn't
 * report is never price-eliminated by a cheaper fp8 or fp4 row.
 */
export const QUANT_ORDER: readonly (readonly string[])[] = [
  ["fp4", "nvfp4", "int4"],
  ["fp6", "fp8", "int8"],
  ["unknown"],
  ["bf16", "fp16", "fp32"],
];
/** --audit-fallback's prompt tokens per request when bounding its cost. A measured request used 137. */
export const AUDIT_PROMPT_TOKENS = 200;
/** --audit-fallback refuses to start when its worst case over every model exceeds this many dollars. */
export const AUDIT_MAX_USD = 0.5;

export type ToolChoiceMode = (typeof TOOL_CHOICE_MODES)[number];
export type ProbeResult = { result: "pass" | "fail"; at: string };
/** Stored probe results: model slug, then endpoint tag, then mode. */
export type ProbeStore = Record<string, Record<string, Partial<Record<ToolChoiceMode, ProbeResult>>>>;
/** One endpoint's fresh probe results by mode. */
export type Probed = Partial<Record<ToolChoiceMode, ProbeResult["result"]>>;
type Percentiles = { p50?: number | null; p75?: number | null; p90?: number | null; p99?: number | null };

/** The fields this tool reads from an entry of GET /models/{slug}/endpoints. */
export type Endpoint = {
  model_id?: string | null;
  provider_name: string;
  /** Unique per endpoint, e.g. "baseten/fp4/us". provider_name is not unique. */
  tag: string;
  status?: number | null;
  quantization?: string | null;
  /** "priority", "flex" or "ultrafast" for a tier endpoint; null for a standard one. */
  service_tier?: string | null;
  max_completion_tokens?: number | null;
  supported_parameters: string[];
  supports_tool_choice?: Partial<Record<ToolChoiceMode, unknown>> | null;
  uptime_last_5m?: number | null;
  uptime_last_30m?: number | null;
  uptime_last_1d?: number | null;
  /** Percentiles are null for anonymous callers. */
  latency_last_30m?: Percentiles | null;
  throughput_last_30m?: Percentiles | null;
  perf_last_30m_by_workload?: { text_generation?: { request_count?: number | null } | null } | null;
  /** USD per token, as decimal strings. */
  pricing: {
    prompt?: string | null;
    completion?: string | null;
    input_cache_read?: string | null;
    internal_reasoning?: string | null;
    /** A flat fee per request, in USD. */
    request?: string | null;
  };
};

/** Where a provider says it operates, from GET /providers. Either field may be unknown. */
export type Location = { headquarters?: string | null; datacenters?: string[] | null };
export type Ranked = { endpoint: Endpoint; cost: number | undefined; priceEliminated: boolean };
export type Auth = { key: string; source: string };
/**
 * `busy` marks a transient failure, a rate limit, overload or timeout that
 * still failed after any retry. `conclusive` is true only for a verdict on the
 * endpoint's tool_choice support (see probe.ts); anything else says nothing
 * about the endpoint, so it is never stored.
 */
export type Probe = {
  endpoint: Endpoint;
  ok: boolean;
  busy: boolean;
  conclusive: boolean;
  detail: string;
  /** When the probe got its answer, as an ISO time. */
  at: string;
};
/** `unprobed` counts the candidates left untried when the time budget ran out. */
export type Verification = { probes: Probe[]; verified?: Endpoint; unprobed?: number };
/** One unpinned request's outcome under OpenRouter's default routing. A null provider means no response. */
export type AuditSample = {
  provider: string | null;
  quantization: string | null;
  serviceTier: string | null;
  toolCallValid: boolean;
  ms: number;
};
/**
 * `unsent` counts the requests left when the time budget ran out. `usd` sums the responses' usage.cost, and
 * `uncosted` counts the requests whose cost is unknown: served without one, or lost to a timeout.
 */
export type Audit = { samples: AuditSample[]; unsent: number; usd: number; uncosted: number };
export type Report = {
  slug: string;
  error?: string;
  total: number;
  malformed: number;
  /** Every well-formed endpoint of the model, filtered or not: any of them can match a pin. */
  endpoints: Endpoint[];
  ranked: Ranked[];
  ineligible: { endpoint: Endpoint; reasons: string[] }[];
  verification?: Verification;
  audit?: Audit;
  /** Fresh probe results by endpoint tag, which replace the listing's tool_choice support. */
  probed: ReadonlyMap<string, Probed>;
};
export type Options = {
  slugs: string[];
  providers: string[];
  excludeProviders: string[];
  excludeCountries: string[];
  zdr: boolean;
  verify: boolean;
  probe: string[];
  json: boolean;
  pick: boolean;
  help: boolean;
  /** Unpinned requests to send per model with --audit-fallback. */
  auditFallback?: number;
  /** Set by --completions: the shell to print a completion function for. */
  completions?: string;
  /** Set by the hidden --list-models. */
  listModels?: boolean;
};

const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/** A model's probe results no older than PROBE_TTL_DAYS at `now` (ms), by endpoint tag. */
export function freshProbes(store: ProbeStore, slug: string, now: number): Map<string, Probed> {
  const fresh = new Map<string, Probed>();
  for (const [tag, modes] of Object.entries(own(store, slug) ?? {})) {
    const probed: Probed = {};
    for (const mode of TOOL_CHOICE_MODES) {
      const entry = own(modes, mode);
      const age = now - Date.parse(entry?.at ?? "");
      if (entry && age >= 0 && age <= PROBE_TTL_DAYS * 86_400_000) probed[mode] = entry.result;
    }
    if (Object.keys(probed).length) fresh.set(tag, probed);
  }
  return fresh;
}

export const listedToolChoice = (ep: Endpoint, mode: ToolChoiceMode): boolean =>
  ep.supports_tool_choice?.[mode] === true;

/** Where each mode's support comes from: a fresh probe result replaces the listing. */
export const toolChoiceSource = (probed: Probed = {}): Record<ToolChoiceMode, "listing" | "probe"> =>
  Object.fromEntries(
    TOOL_CHOICE_MODES.map((mode) => [mode, probed[mode] === undefined ? "listing" : "probe"]),
  ) as Record<ToolChoiceMode, "listing" | "probe">;

/** The modes whose fresh probe result contradicts the listing, by result. */
export function probeOverrides(ep: Endpoint, probed: Probed = {}): Record<ProbeResult["result"], ToolChoiceMode[]> {
  return {
    pass: TOOL_CHOICE_MODES.filter((mode) => probed[mode] === "pass" && !listedToolChoice(ep, mode)),
    fail: TOOL_CHOICE_MODES.filter((mode) => probed[mode] === "fail" && listedToolChoice(ep, mode)),
  };
}

/**
 * Why an endpoint can't be ranked. A fresh probe result for a tool_choice mode
 * replaces the listing's value for that mode; every other rule reads the listing.
 */
export function ineligibleReasons(ep: Endpoint, probed: Probed = {}): string[] {
  const reasons: string[] = [];
  if ((ep.status ?? 0) !== 0) reasons.push(`status ${ep.status}`);
  if (!ep.supported_parameters.includes("tools")) reasons.push("no native tools");
  const missing = TOOL_CHOICE_MODES.filter((mode) => probed[mode] === undefined && !listedToolChoice(ep, mode));
  if (missing.length) reasons.push(`tool_choice lacks ${missing.join("/")}`);
  const failed = TOOL_CHOICE_MODES.filter((mode) => probed[mode] === "fail");
  if (failed.length) reasons.push(`probed: ${failed.join("/")} fail`);
  return reasons;
}

/** The provider part of an endpoint tag, which is its slug in GET /providers. */
export const providerSlug = (ep: Endpoint): string => ep.tag.split("/")[0]!.toLowerCase();

/** Why a provider's location rules it out. Unknown locations are never excluded. */
export function locationReasons(location: Location | undefined, excluded: readonly string[]): string[] {
  const reasons: string[] = [];
  const hq = location?.headquarters;
  if (hq && excluded.includes(hq)) reasons.push(`headquartered in ${hq}`);
  const datacenters = (location?.datacenters ?? []).filter((code) => excluded.includes(code));
  if (datacenters.length) reasons.push(`datacenter in ${datacenters.join("/")}`);
  return reasons;
}

/** A finite, non-negative number, or undefined for anything missing or malformed. */
export const metric = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Converts an OpenRouter rate (USD per token, as a string) to USD per million tokens. */
export function perMillion(rate: string | null | undefined): number | undefined {
  if (rate == null || rate.trim() === "") return undefined;
  return metric(Number(rate) * 1_000_000);
}

/** USD for one REFERENCE_RUN on this endpoint, or undefined when its prices are unknown. */
export function referenceRunCost(ep: Endpoint): number | undefined {
  const input = perMillion(ep.pricing.prompt);
  const output = perMillion(ep.pricing.completion);
  if (input === undefined || output === undefined) return undefined;
  // No cache-read price means no cache discount: cached tokens bill as input.
  const cacheRead = perMillion(ep.pricing.input_cache_read) ?? input;
  const { prompt, cacheRead: cached, completion } = REFERENCE_RUN;
  return (prompt * input + cached * cacheRead + completion * output) / 1_000_000;
}

/** Estimated milliseconds for a typical agent turn: median TTFB plus TURN_OUTPUT_TOKENS at median speed. */
export function turnMs(ep: Endpoint): number | undefined {
  const ttfb = metric(ep.latency_last_30m?.p50);
  const tps = metric(ep.throughput_last_30m?.p50);
  if (ttfb === undefined || !tps) return undefined;
  return ttfb + (TURN_OUTPUT_TOKENS / tps) * 1000;
}

const uptimeBucket = (value: unknown): number | undefined => {
  const uptime = metric(value);
  return uptime !== undefined && uptime >= UPTIME_SATURATION ? 100 : uptime;
};

// Sort keys ascend. Missing values sort last in either direction.
const asc = (value: number | undefined): number => value ?? Infinity;
const desc = (value: number | undefined): number => (value === undefined ? Infinity : -value);

/**
 * The 1-day window outranks the 30-minute one: a clean day beats a clean half
 * hour. An endpoint with no traffic in the last 30 minutes has no 30-minute
 * uptime, so its day stands in rather than ranking it below a measured failure.
 */
const reliabilityKey = (ep: Endpoint): number[] => [
  desc(uptimeBucket(ep.uptime_last_1d)),
  desc(uptimeBucket(ep.uptime_last_30m) ?? uptimeBucket(ep.uptime_last_1d)),
];

const UNKNOWN_QUANT_LEVEL = QUANT_ORDER.findIndex((group) => group.includes("unknown"));

/** An endpoint's place in QUANT_ORDER; higher is more precise. */
export function quantLevel(ep: Endpoint): number {
  const quantization = ep.quantization?.toLowerCase() ?? "";
  const level = QUANT_ORDER.findIndex((group) => group.includes(quantization));
  return level === -1 ? UNKNOWN_QUANT_LEVEL : level;
}

/**
 * Whether the listing gives a quantization QUANT_ORDER knows. One it doesn't
 * know ranks as unknown, so it counts as not reported too.
 */
export const quantizationReported = (ep: Endpoint): boolean => quantLevel(ep) !== UNKNOWN_QUANT_LEVEL;

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/** Ranks eligible endpoints best first and drops the ineligible ones. */
export function rank(endpoints: readonly Endpoint[], probed: ReadonlyMap<string, Probed> = new Map()): Ranked[] {
  const eligible = endpoints.filter((ep) => ineligibleReasons(ep, probed.get(ep.tag)).length === 0);
  if (!eligible.length) return [];

  // Price guard baseline: the cheapest endpoint in the most reliable tier with
  // equal or better quantization, the cost of a choice that gives up nothing on
  // uptime or precision. Anything far pricier ranks after every endpoint that
  // isn't, keeping its order among its peers. An endpoint with no such
  // baseline is never eliminated.
  const best = eligible.map(reliabilityKey).reduce((a, b) => (compareKeys(a, b) <= 0 ? a : b));
  const topTier = eligible
    .filter((ep) => compareKeys(reliabilityKey(ep), best) === 0)
    .map((ep) => ({ level: quantLevel(ep), cost: referenceRunCost(ep) }));
  const baseline = (ep: Endpoint): number => {
    const level = quantLevel(ep);
    const costs = topTier.filter((row) => row.level >= level).map(({ cost }) => cost);
    return Math.min(...costs.filter((cost) => cost !== undefined));
  };

  const key = ({ endpoint: ep, cost, priceEliminated }: Ranked): number[] => [
    priceEliminated ? 1 : 0,
    ...reliabilityKey(ep),
    asc(turnMs(ep)),
    asc(metric(ep.latency_last_30m?.p50)), // when throughput is unknown
    desc(quantLevel(ep)),
    desc(metric(ep.max_completion_tokens)), // output headroom
    asc(cost), // price only breaks ties
  ];
  return eligible
    .map((endpoint): Ranked => {
      const cost = referenceRunCost(endpoint);
      const cheapest = baseline(endpoint);
      const priceEliminated =
        cost !== undefined &&
        Number.isFinite(cheapest) &&
        cost > cheapest * PRICE_ELIM_RATIO &&
        cost - cheapest > PRICE_ELIM_DELTA_USD;
      return { endpoint, cost, priceEliminated };
    })
    .sort((a, b) => compareKeys(key(a), key(b)) || a.endpoint.tag.localeCompare(b.endpoint.tag));
}

export function matchesProvider(ep: Endpoint, filter: string): boolean {
  const needle = filter.toLowerCase();
  return ep.provider_name.toLowerCase().includes(needle) || ep.tag.toLowerCase().includes(needle);
}

/**
 * The `provider` object for a chat request that pins this one endpoint. A
 * `model:provider` suffix does not do this: OpenRouter ignores it and routes
 * as usual. `only` matches by prefix, so a pin on "fireworks" also matches
 * "fireworks/fast"; `ignore` lists every such longer tag among `endpoints`
 * and is left out when there is none.
 */
export function pinRouting(ep: Endpoint, endpoints: readonly Endpoint[]) {
  const ignore = endpoints.map(({ tag }) => tag).filter((tag) => tag.startsWith(`${ep.tag}/`));
  return { only: [ep.tag], ...(ignore.length ? { ignore: ignore.sort() } : {}), allow_fallbacks: false };
}
