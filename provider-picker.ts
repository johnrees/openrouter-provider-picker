#!/usr/bin/env bun
/**
 * opp (openrouter-provider-picker): rank OpenRouter's serving endpoints for a model and pick
 * one to pin.
 *
 * OpenRouter's default router chooses a provider per request and silently
 * falls back when one fails. For agentic work that hides what actually ran:
 * quantization, tool_choice support and chat templates differ by endpoint.
 * This tool ranks every endpoint of a model under an explicit policy and
 * prints the request routing that pins the winner with no fallback:
 *
 *   "provider": { "only": ["<endpoint tag>"], "allow_fallbacks": false }
 *
 * README.md explains the policy. Run with --help for usage.
 */

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

// ---- Policy -----------------------------------------------------------------

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
 * this multiple of the cheapest in the most reliable tier...
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

/** The command name, as installed by package.json "bin". */
const NAME = "opp";
const API = "https://openrouter.ai/api/v1";
const FETCH_TIMEOUT_MS = 30_000;
/** Generous for a one-tool-call reply; a pin that takes longer is not one to pick. */
const PROBE_TIMEOUT_MS = 30_000;
/** Room for a reasoning model to think briefly and still call the tool. Measured calls used 5 to 146 tokens. */
const PROBE_MAX_TOKENS = 512;
/** --verify starts no new probe after this long, so a run of hanging endpoints can't stall it for many minutes. */
const VERIFY_BUDGET_MS = 180_000;
/** Probe failures that mean "busy, try again shortly" rather than "this route is broken". */
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
/** Wait before retrying a transient failure, unless Retry-After asks for longer (up to the cap). */
const PROBE_RETRY_MS = 2_000;
const PROBE_RETRY_MAX_MS = 10_000;
const SLUG = /^[a-z0-9][\w.-]*\/[a-z0-9][\w.:-]*$/i;
const COUNTRY = /^[A-Z]{2}$/;

const USAGE = `Usage: ${NAME} <model/slug ...> [options]

Rank OpenRouter's serving endpoints for each model and pick one to pin.

Arguments:
  model/slug ...              One or more models to rank, e.g. z-ai/glm-5.3

Options:
  -p, --provider <name>       Keep endpoints whose provider name or tag
                              contains <name>, case-insensitively. A bare word
                              without "/" works too: z-ai/glm-5.3 together
  -x, --exclude-country <CC>  Drop endpoints whose provider is headquartered or
                              has a datacenter in this ISO country (repeatable
                              or comma-separated: -x CN,RU). Providers with no
                              known location are kept and shown with "?".
      --zdr                   Keep only zero-data-retention endpoints, per
                              OpenRouter's ZDR list. The zdr column shows each
                              endpoint's status either way.
      --verify                Send a tiny request that must call a tool through
                              each candidate's pin, best first, until one
                              serves (needs a key). A busy endpoint (HTTP 429,
                              5xx) is retried once, then skipped and reported
                              as busy. Stops starting probes after 3 minutes.
      --json                  Print machine-readable results
      --pick                  Print only each model's chosen endpoint tag, one
                              line per model, e.g. wafer/us. A model with no
                              pick prints its reason to stderr instead.
  -h, --help                  Show this help

Auth: OPENROUTER_API_KEY, else opencode's stored OpenRouter credential.
Exit status: 0 if every model has a pick, 1 if any has none, 2 on usage errors.`;

// ---- Types ------------------------------------------------------------------

type ToolChoiceMode = (typeof TOOL_CHOICE_MODES)[number];
type Percentiles = { p50?: number | null; p75?: number | null; p90?: number | null; p99?: number | null };

/** The fields this tool reads from an entry of GET /models/{slug}/endpoints. */
export type Endpoint = {
  model_id?: string | null;
  provider_name: string;
  /** Unique per endpoint, e.g. "baseten/fp4/us". provider_name is not unique. */
  tag: string;
  status?: number | null;
  quantization?: string | null;
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
  pricing: { prompt?: string | null; completion?: string | null; input_cache_read?: string | null };
};

/** Where a provider says it operates, from GET /providers. Either field may be unknown. */
export type Location = { headquarters?: string | null; datacenters?: string[] | null };
export type Ranked = { endpoint: Endpoint; cost: number | undefined; priceEliminated: boolean };
export type Auth = { key: string; source: string };
/** `busy` marks a failure that was still transient after one retry: a rate limit or overload, not a dead route. */
type Probe = { endpoint: Endpoint; ok: boolean; busy: boolean; detail: string };
/** `unprobed` counts the candidates left untried when the time budget ran out. */
type Verification = { probes: Probe[]; verified?: Endpoint; unprobed?: number };
type Report = {
  slug: string;
  error?: string;
  total: number;
  malformed: number;
  ranked: Ranked[];
  ineligible: { endpoint: Endpoint; reasons: string[] }[];
  verification?: Verification;
};
export type Options = {
  slugs: string[];
  provider?: string;
  excludeCountries: string[];
  zdr: boolean;
  verify: boolean;
  json: boolean;
  pick: boolean;
  help: boolean;
};

// ---- Arguments --------------------------------------------------------------

export function parseOptions(argv: string[]): Options {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      provider: { type: "string", short: "p", multiple: true },
      "exclude-country": { type: "string", short: "x", multiple: true },
      zdr: { type: "boolean" },
      verify: { type: "boolean" },
      json: { type: "boolean" },
      pick: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.json && values.pick) throw new Error("--json and --pick are alternative outputs; give one");
  const slugs = positionals.filter((arg) => arg.includes("/"));
  const filters = [...(values.provider ?? []), ...positionals.filter((arg) => !arg.includes("/"))];
  if (filters.length > 1) throw new Error(`give at most one provider filter, got ${filters.join(", ")}`);
  const provider = filters[0]?.trim();
  if (provider === "") throw new Error("provider filter must not be empty");
  if (!slugs.length && !values.help) throw new Error("give at least one model slug, e.g. z-ai/glm-5.3");
  const badSlug = slugs.find((slug) => !SLUG.test(slug));
  if (badSlug !== undefined) throw new Error(`not a model slug: ${badSlug}`);
  const excludeCountries = (values["exclude-country"] ?? [])
    .flatMap((list) => list.split(","))
    .map((code) => code.trim().toUpperCase());
  const badCountry = excludeCountries.find((code) => !COUNTRY.test(code));
  if (badCountry !== undefined) throw new Error(`not a two-letter country code: ${JSON.stringify(badCountry)}`);
  return {
    slugs,
    provider,
    excludeCountries: [...new Set(excludeCountries)],
    zdr: values.zdr ?? false,
    verify: values.verify ?? false,
    json: values.json ?? false,
    pick: values.pick ?? false,
    help: values.help ?? false,
  };
}

// ---- Eligibility and ranking ------------------------------------------------

export function ineligibleReasons(ep: Endpoint): string[] {
  const reasons: string[] = [];
  if ((ep.status ?? 0) !== 0) reasons.push(`status ${ep.status}`);
  if (!ep.supported_parameters.includes("tools")) reasons.push("no native tools");
  const missing = TOOL_CHOICE_MODES.filter((mode) => ep.supports_tool_choice?.[mode] !== true);
  if (missing.length) reasons.push(`tool_choice lacks ${missing.join("/")}`);
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
const metric = (value: unknown): number | undefined =>
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

/** The 1-day window outranks the 30-minute one: a clean day beats a clean half hour. */
const reliabilityKey = (ep: Endpoint): number[] => [
  desc(uptimeBucket(ep.uptime_last_1d)),
  desc(uptimeBucket(ep.uptime_last_30m)),
];

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/** Ranks eligible endpoints best first and drops the ineligible ones. */
export function rank(endpoints: readonly Endpoint[]): Ranked[] {
  const eligible = endpoints.filter((ep) => ineligibleReasons(ep).length === 0);
  if (!eligible.length) return [];

  // Price guard baseline: the cheapest endpoint in the most reliable tier, the
  // cost of a choice that gives up nothing on uptime. Anything far pricier
  // ranks after every endpoint that isn't, keeping its order among its peers.
  const best = eligible.map(reliabilityKey).reduce((a, b) => (compareKeys(a, b) <= 0 ? a : b));
  const topTierCosts = eligible
    .filter((ep) => compareKeys(reliabilityKey(ep), best) === 0)
    .map(referenceRunCost)
    .filter((cost) => cost !== undefined);
  const cheapest = Math.min(...topTierCosts);

  const key = ({ endpoint: ep, cost, priceEliminated }: Ranked): number[] => [
    priceEliminated ? 1 : 0,
    ...reliabilityKey(ep),
    asc(turnMs(ep)),
    asc(metric(ep.latency_last_30m?.p50)), // when throughput is unknown
    desc(metric(ep.max_completion_tokens)), // output headroom
    asc(cost), // price only breaks ties
  ];
  return eligible
    .map((endpoint): Ranked => {
      const cost = referenceRunCost(endpoint);
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
 * as usual.
 */
export const pinRouting = (ep: Endpoint) => ({ only: [ep.tag], allow_fallbacks: false });

// ---- Auth and output hygiene ------------------------------------------------

/**
 * Finds an OpenRouter key: OPENROUTER_API_KEY, else opencode's credential
 * store. Without a key, OpenRouter returns null latency and throughput, so
 * ranking falls back to uptime, headroom and price. The key is only sent to
 * openrouter.ai and never printed.
 */
export function resolveAuth(env: Record<string, string | undefined> = process.env): Auth | undefined {
  const fromEnv = env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "OPENROUTER_API_KEY" };
  const dataHome = env.XDG_DATA_HOME || (env.HOME && `${env.HOME}/.local/share`);
  const db = dataHome && `${dataHome}/opencode/opencode.db`;
  if (!db || !existsSync(db)) return undefined;
  try {
    const proc = Bun.spawnSync(
      ["sqlite3", "-readonly", db, "select value from credential where label = 'OpenRouter' and active = 1 limit 1"],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5_000 },
    );
    if (proc.exitCode !== 0) return undefined;
    // The stored value is a JSON envelope, {"type":"key","key":"sk-or-..."}.
    // Anything else is ignored rather than sent as a bearer token.
    const envelope = JSON.parse(proc.stdout.toString()) as { type?: unknown; key?: unknown } | null;
    const key = envelope?.type === "key" && typeof envelope.key === "string" ? envelope.key.trim() : "";
    return key ? { key, source: "opencode credential store" } : undefined;
  } catch {
    return undefined; // no sqlite3, unreadable database, or a value that is not an envelope
  }
}

/**
 * Makes upstream text safe to print. It scrubs the key and anything shaped
 * like an OpenRouter key, removes terminal control characters and newlines,
 * and truncates. Scrubbing runs before truncation so a cut can't hide a key.
 */
export function sanitize(text: string, secret?: string, max = 200): string {
  let out = secret ? text.split(secret).join("[redacted]") : text;
  out = out
    .replace(/sk-or-[\w-]+/g, "[redacted]")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---- OpenRouter -------------------------------------------------------------

const PRINTABLE = /^[^\u0000-\u001f\u007f-\u009f]+$/;
const isRate = (rate: unknown): boolean => rate == null || typeof rate === "string";

function isEndpoint(value: unknown): value is Endpoint {
  if (typeof value !== "object" || value === null) return false;
  const ep = value as Record<string, unknown>;
  const pricing = ep.pricing as Record<string, unknown> | null | undefined;
  return (
    typeof ep.provider_name === "string" &&
    PRINTABLE.test(ep.provider_name) &&
    typeof ep.tag === "string" &&
    PRINTABLE.test(ep.tag) &&
    Array.isArray(ep.supported_parameters) &&
    ep.supported_parameters.every((p) => typeof p === "string") &&
    typeof pricing === "object" &&
    pricing !== null &&
    isRate(pricing.prompt) &&
    isRate(pricing.completion) &&
    isRate(pricing.input_cache_read)
  );
}

/** GET a public OpenRouter path. The key, when given, is sent only here and never to a redirect target. */
async function getData(path: string, auth?: Auth): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    headers: auth ? { Authorization: `Bearer ${auth.key}` } : {},
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as { data?: unknown; error?: { message?: unknown } } | null;
  if (!res.ok) {
    const message = body?.error?.message;
    throw new Error(`HTTP ${res.status}${message == null ? "" : `: ${String(message)}`}`);
  }
  return body?.data;
}

async function fetchEndpoints(slug: string, auth?: Auth): Promise<{ endpoints: Endpoint[]; malformed: number }> {
  const path = slug.split("/").map(encodeURIComponent).join("/");
  const raw = ((await getData(`/models/${path}/endpoints`, auth)) as { endpoints?: unknown } | undefined)?.endpoints;
  if (!Array.isArray(raw)) throw new Error("unexpected response: no data.endpoints array");
  const endpoints = raw.filter(isEndpoint);
  return { endpoints, malformed: raw.length - endpoints.length };
}

/** Provider locations by slug. Public data, so no key is sent. */
async function fetchLocations(): Promise<Map<string, Location>> {
  const raw = await getData("/providers");
  if (!Array.isArray(raw)) throw new Error("unexpected response: no data array");
  const code = (value: unknown): string | undefined =>
    typeof value === "string" && COUNTRY.test(value.toUpperCase()) ? value.toUpperCase() : undefined;
  const locations = new Map<string, Location>();
  for (const provider of raw as { slug?: unknown; headquarters?: unknown; datacenters?: unknown }[]) {
    if (typeof provider?.slug !== "string") continue;
    locations.set(provider.slug.toLowerCase(), {
      headquarters: code(provider.headquarters) ?? null,
      datacenters: Array.isArray(provider.datacenters)
        ? provider.datacenters.map(code).filter((c) => c !== undefined)
        : null,
    });
  }
  return locations;
}

/** Keys an endpoint by model and tag, the identity OpenRouter's ZDR list uses. */
const zdrKey = (model: string, tag: string): string => `${model}\u0000${tag}`;

/** Every zero-data-retention endpoint, as zdrKey values. Public data, so no key is sent. */
async function fetchZdr(): Promise<Set<string>> {
  const raw = await getData("/endpoints/zdr");
  if (!Array.isArray(raw)) throw new Error("unexpected response: no data array");
  const keys = new Set<string>();
  for (const ep of raw as { model_id?: unknown; tag?: unknown }[]) {
    if (typeof ep?.model_id === "string" && typeof ep.tag === "string") keys.add(zdrKey(ep.model_id, ep.tag));
  }
  return keys;
}

type ChatResponse = {
  provider?: unknown;
  error?: { message?: unknown; code?: unknown };
  choices?: { finish_reason?: unknown; message?: { tool_calls?: unknown } }[];
};

const PROBE_TOOL = "ok";

/** One probe request's outcome. `retryInMs` is set when the failure is transient. */
type Attempt = { ok: boolean; detail: string; retryInMs?: number };

/** How long to wait before retrying, from a Retry-After header in seconds, capped. */
export function retryDelay(header: string | null): number {
  const seconds = header === null || header.trim() === "" ? NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, PROBE_RETRY_MAX_MS) : PROBE_RETRY_MS;
}

/**
 * Sends one minimal completion pinned to `ep`, retrying once if the endpoint
 * is busy. Account data controls, such as zero-retention or data-collection
 * exclusions, are enforced only at routing time and appear in no API field. A
 * real request is the only way to learn whether this account can use an
 * endpoint.
 */
async function probe(slug: string, ep: Endpoint, auth: Auth): Promise<Probe> {
  const first = await attempt(slug, ep, auth);
  if (first.retryInMs === undefined) return { endpoint: ep, ok: first.ok, busy: false, detail: first.detail };
  await Bun.sleep(first.retryInMs);
  const second = await attempt(slug, ep, auth);
  const busy = second.retryInMs !== undefined;
  return { endpoint: ep, ok: second.ok, busy, detail: `${second.detail}, ${second.ok ? "after a retry" : "retried"}` };
}

async function attempt(slug: string, ep: Endpoint, auth: Auth): Promise<Attempt> {
  const result = (ok: boolean, detail: string, retryInMs?: number): Attempt => ({
    ok,
    detail: sanitize(detail, auth.key),
    ...(retryInMs !== undefined && { retryInMs }),
  });
  try {
    const res = await fetch(`${API}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.key}`, "Content-Type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      body: JSON.stringify({
        model: slug,
        provider: pinRouting(ep),
        max_tokens: PROBE_MAX_TOKENS,
        // Eligibility trusts the endpoint's advertised tool support, so the probe exercises it.
        tools: [{ type: "function", function: { name: PROBE_TOOL, parameters: { type: "object", properties: {} } } }],
        tool_choice: "required",
        messages: [{ role: "user", content: `Call the ${PROBE_TOOL} tool.` }],
      }),
    });
    const body = (await res.json().catch(() => null)) as ChatResponse | null;
    const upstream = body?.error?.message;
    if (!res.ok || upstream != null) {
      // OpenRouter can also report an upstream rate limit as an error body on a 200.
      const status = res.ok ? Number(body?.error?.code) : res.status;
      const retryInMs = TRANSIENT_STATUSES.has(status) ? retryDelay(res.headers.get("retry-after")) : undefined;
      return result(false, `HTTP ${status || res.status}${upstream == null ? "" : ` ${String(upstream)}`}`, retryInMs);
    }
    // Pinning makes this unreachable unless OpenRouter changes semantics. Check anyway, since verifying is the point.
    const servedBy = typeof body?.provider === "string" ? body.provider : "an unknown provider";
    if (servedBy.toLowerCase() !== ep.provider_name.toLowerCase()) return result(false, `served by ${servedBy}`);
    const choice = body?.choices?.[0];
    const finish = String(choice?.finish_reason ?? "none");
    const calls = choice?.message?.tool_calls;
    const called =
      Array.isArray(calls) &&
      calls.some((call: { function?: { name?: unknown } } | null) => call?.function?.name === PROBE_TOOL);
    return called
      ? result(true, `served by ${servedBy}, finish=${finish}`)
      : result(false, `no ${PROBE_TOOL} tool call despite tool_choice required, finish=${finish}`);
  } catch (error) {
    return result(false, errorMessage(error));
  }
}

/** Probes candidates in rank order and stops at the first that serves. */
async function verify(slug: string, candidates: readonly Ranked[], auth: Auth): Promise<Verification> {
  const deadline = Date.now() + VERIFY_BUDGET_MS;
  const probes: Probe[] = [];
  for (const { endpoint } of candidates) {
    if (Date.now() >= deadline) return { probes, unprobed: candidates.length - probes.length };
    const outcome = await probe(slug, endpoint, auth);
    probes.push(outcome);
    if (outcome.ok) return { probes, verified: endpoint };
  }
  return { probes };
}

type Context = { options: Options; auth?: Auth; locations?: Map<string, Location>; zdr?: Set<string> };

const locationOf = (ep: Endpoint, { locations }: Context): Location | undefined => locations?.get(providerSlug(ep));

/** Whether an endpoint is zero-data-retention, or undefined when the ZDR list is unavailable. */
const zdrOf = (ep: Endpoint, slug: string, { zdr }: Context): boolean | undefined =>
  zdr?.has(zdrKey(ep.model_id ?? slug, ep.tag));

async function buildReport(slug: string, ctx: Context): Promise<Report> {
  const { options, auth } = ctx;
  try {
    const { endpoints, malformed } = await fetchEndpoints(slug, auth);
    const excludedBy = (ep: Endpoint) => [
      ...locationReasons(locationOf(ep, ctx), options.excludeCountries),
      ...(options.zdr && !zdrOf(ep, slug, ctx) ? ["not ZDR"] : []),
    ];
    const kept = (ep: Endpoint) => options.provider === undefined || matchesProvider(ep, options.provider);
    // Excluded countries and --zdr are hard constraints, so they apply before
    // ranking and can't set the price guard's baseline. The provider filter is
    // only a view: it applies after ranking so the guard still compares against
    // the whole tier.
    const ranked = rank(endpoints.filter((ep) => !excludedBy(ep).length)).filter(({ endpoint }) => kept(endpoint));
    const ineligible = endpoints
      .filter(kept)
      .map((endpoint) => ({ endpoint, reasons: [...ineligibleReasons(endpoint), ...excludedBy(endpoint)] }))
      .filter(({ reasons }) => reasons.length);
    const verification = options.verify && auth && ranked.length ? await verify(slug, ranked, auth) : undefined;
    return { slug, total: endpoints.length, malformed, ranked, ineligible, verification };
  } catch (error) {
    return {
      slug,
      error: sanitize(errorMessage(error), auth?.key),
      total: 0,
      malformed: 0,
      ranked: [],
      ineligible: [],
    };
  }
}

const pickOf = (report: Report): Endpoint | undefined =>
  report.verification ? report.verification.verified : report.ranked[0]?.endpoint;

const budgetNote = `--verify stops after ${VERIFY_BUDGET_MS / 60_000} minutes`;

function noPickReason(report: Report): string {
  if (report.error) return `fetch failed: ${report.error}`;
  if (report.verification) {
    const { probes, unprobed } = report.verification;
    const notes = [busyNote(report), unprobed ? `${unprobed} not probed: ${budgetNote}` : ""].filter(Boolean);
    return `no candidate served after ${probes.length} probe(s)${notes.length ? ` (${notes.join("; ")})` : ""}`;
  }
  return "no eligible endpoint";
}

/** Tags that were only busy when probed. A re-run may pick one of them instead. */
/** Names the endpoints that were only busy when probed, since a re-run may pick one; "" when there are none. */
function busyNote(report: Report): string {
  const busy = report.verification?.probes.filter(({ busy }) => busy).map(({ endpoint }) => endpoint.tag) ?? [];
  return busy.length ? `${busy.join(", ")} ${busy.length === 1 ? "was" : "were"} busy; re-run to retry` : "";
}

// ---- Rendering --------------------------------------------------------------

const dash = (value: string | undefined): string => value ?? "-";
const fmtPct = (value: unknown): string => dash(metric(value)?.toFixed(1).replace(/\.0$/, ""));
const fmtInt = (value: unknown): string => dash(metric(value)?.toFixed(0));
const fmtSeconds = (ms: number | undefined): string => dash(ms === undefined ? undefined : (ms / 1000).toFixed(1));
/** Three significant figures without trailing zeros or exponent notation: 100, 1.4, 0.079, 1230. */
export const fmtRate = (rate: string | null | undefined): string => {
  const usd = perMillion(rate);
  return usd === undefined ? "-" : String(Number(usd.toPrecision(3)));
};
const fmtCount = (value: unknown): string => {
  const n = metric(value);
  if (n === undefined) return "-";
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  return n.toFixed(0);
};
const fmtZdr = (zdr: boolean | undefined): string => (zdr === undefined ? "?" : zdr ? "Y" : "-");
const yesNo = (ep: Endpoint, parameter: string): string => (ep.supported_parameters.includes(parameter) ? "Y" : "-");
const fmtWhere = (location: Location | undefined): [string, string] => [
  location?.headquarters ?? "?",
  location?.datacenters?.length ? location.datacenters.join(",") : "?",
];

/** Pads cells into columns. Text columns align left, numeric columns align right. */
function table(header: string[], rows: string[][], numeric: ReadonlySet<number>, indent = "  "): string[] {
  const widths = header.map((h, col) => Math.max(h.length, ...rows.map((row) => row[col]!.length)));
  return [header, ...rows].map(
    (row) =>
      indent +
      row
        .map((cell, col) => (numeric.has(col) ? cell.padStart(widths[col]!) : cell.padEnd(widths[col]!)))
        .join("  ")
        .trimEnd(),
  );
}

function renderReport(report: Report, ctx: Context): string {
  const { options } = ctx;
  const filter = options.provider === undefined ? "" : ` · provider ~ ${JSON.stringify(options.provider)}`;
  if (report.error) return `\n## ${report.slug}${filter}\n  fetch failed: ${report.error}`;

  const count =
    options.provider === undefined
      ? `${report.total - report.ineligible.length} of ${report.total}`
      : String(report.ranked.length);
  const lines = [`\n## ${report.slug}${filter} · ${count} eligible`];
  if (report.malformed)
    lines.push(`  (skipped ${report.malformed} malformed endpoint${report.malformed === 1 ? "" : "s"})`);
  const pick = pickOf(report);

  if (report.ranked.length) {
    const header = [
      "",
      "#",
      "endpoint",
      "quant",
      "hq",
      "dc",
      "zdr",
      "up1d",
      "up30m",
      "up5m",
      "turn_s",
      "ttfb",
      "tok/s",
      "reqs",
      "maxout",
      "$in",
      "$cache",
      "$out",
      "$run",
      "so",
      "rsn",
      "eff",
      "note",
    ];
    const rows = report.ranked.map(({ endpoint: ep, cost, priceEliminated }, i) => [
      ep === pick ? "▶" : "",
      String(i + 1),
      ep.tag,
      ep.quantization && ep.quantization !== "unknown" ? ep.quantization : "?",
      ...fmtWhere(locationOf(ep, ctx)),
      fmtZdr(zdrOf(ep, report.slug, ctx)),
      fmtPct(ep.uptime_last_1d),
      fmtPct(ep.uptime_last_30m),
      fmtPct(ep.uptime_last_5m),
      fmtSeconds(turnMs(ep)),
      fmtInt(ep.latency_last_30m?.p50),
      fmtInt(ep.throughput_last_30m?.p50),
      fmtCount(ep.perf_last_30m_by_workload?.text_generation?.request_count),
      fmtCount(ep.max_completion_tokens),
      fmtRate(ep.pricing.prompt),
      fmtRate(ep.pricing.input_cache_read),
      fmtRate(ep.pricing.completion),
      cost === undefined ? "-" : cost.toFixed(2),
      yesNo(ep, "structured_outputs"),
      yesNo(ep, "reasoning"),
      yesNo(ep, "reasoning_effort"),
      priceEliminated ? "price-elim" : "",
    ]);
    lines.push(...table(header, rows, new Set([1, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18])));
  } else {
    lines.push(`  no eligible endpoint${options.provider === undefined ? "" : " matches"}`);
  }

  for (const { endpoint, ok, busy, detail } of report.verification?.probes ?? []) {
    lines.push(`  probe ${endpoint.tag}: ${ok ? "ok" : busy ? "busy" : "FAILED"} (${detail})`);
  }
  if (pick) {
    lines.push(
      `  ${report.verification ? "verified pin" : "pin"}: ${report.slug}:${pick.tag}`,
      `  routing: "provider": ${JSON.stringify(pinRouting(pick))}`,
    );
    const note = busyNote(report);
    if (note) lines.push(`  note: ${note}`);
  } else if (report.verification) {
    lines.push(`  ${noPickReason(report)}`);
  }

  if (report.ineligible.length) {
    lines.push(`  ineligible:`);
    const width = Math.max(...report.ineligible.map(({ endpoint }) => endpoint.tag.length));
    for (const { endpoint, reasons } of report.ineligible) {
      const zdr = fmtZdr(zdrOf(endpoint, report.slug, ctx));
      lines.push(`    ${endpoint.tag.padEnd(width)}  zdr ${zdr}  ${reasons.join("; ")}`);
    }
  }
  return lines.join("\n");
}

function reportJson(report: Report, ctx: Context) {
  const pick = pickOf(report);
  return {
    model: report.slug,
    ...(report.error === undefined ? {} : { error: report.error }),
    pick: pick
      ? {
          pin: `${report.slug}:${pick.tag}`,
          endpoint: pick.tag,
          provider: pick.provider_name,
          routing: pinRouting(pick),
          verified: report.verification !== undefined,
        }
      : null,
    ranked: report.ranked.map(({ endpoint: ep, cost, priceEliminated }, i) => {
      const location = locationOf(ep, ctx);
      return {
        rank: i + 1,
        endpoint: ep.tag,
        provider: ep.provider_name,
        quantization: ep.quantization ?? null,
        headquarters: location?.headquarters ?? null,
        datacenters: location?.datacenters ?? null,
        zdr: zdrOf(ep, report.slug, ctx) ?? null,
        uptime: {
          last1d: metric(ep.uptime_last_1d) ?? null,
          last30m: metric(ep.uptime_last_30m) ?? null,
          last5m: metric(ep.uptime_last_5m) ?? null,
        },
        turnMs: turnMs(ep) ?? null,
        ttfbMsP50: metric(ep.latency_last_30m?.p50) ?? null,
        tokensPerSecondP50: metric(ep.throughput_last_30m?.p50) ?? null,
        requests30m: metric(ep.perf_last_30m_by_workload?.text_generation?.request_count) ?? null,
        maxCompletionTokens: metric(ep.max_completion_tokens) ?? null,
        usdPerMillion: {
          input: perMillion(ep.pricing.prompt) ?? null,
          cacheRead: perMillion(ep.pricing.input_cache_read) ?? null,
          output: perMillion(ep.pricing.completion) ?? null,
        },
        referenceRunUsd: cost ?? null,
        priceEliminated,
        structuredOutputs: ep.supported_parameters.includes("structured_outputs"),
        reasoning: ep.supported_parameters.includes("reasoning"),
        reasoningEffort: ep.supported_parameters.includes("reasoning_effort"),
      };
    }),
    ineligible: report.ineligible.map(({ endpoint, reasons }) => ({
      endpoint: endpoint.tag,
      provider: endpoint.provider_name,
      zdr: zdrOf(endpoint, report.slug, ctx) ?? null,
      reasons,
    })),
    ...(report.verification && {
      probes: report.verification.probes.map(({ endpoint, ok, busy, detail }) => ({
        endpoint: endpoint.tag,
        ok,
        busy,
        detail,
      })),
      notProbed: report.verification.unprobed ?? 0,
    }),
  };
}

// ---- Main -------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    console.error(`${NAME}: ${errorMessage(error)}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const auth = resolveAuth();
  if (options.verify && !auth) {
    console.error(`${NAME}: --verify sends real requests and needs an API key; set OPENROUTER_API_KEY`);
    return 2;
  }
  if (!auth) {
    console.error(
      `${NAME}: no API key found. OpenRouter hides latency and throughput from anonymous callers, ` +
        "so speed is not ranked. Set OPENROUTER_API_KEY.",
    );
  }

  // Reference data for the location and ZDR columns. A filter that needs it
  // can't run without it; otherwise its column just shows "?".
  const settle = <T>(lookup: Promise<T>) =>
    lookup.catch((error: unknown) => new Error(sanitize(errorMessage(error), auth?.key)));
  const [locations, zdr] = await Promise.all([settle(fetchLocations()), settle(fetchZdr())]);
  const lookups = [
    {
      result: locations,
      what: "provider locations",
      flag: "--exclude-country",
      needed: options.excludeCountries.length > 0,
    },
    { result: zdr, what: "the ZDR endpoint list", flag: "--zdr", needed: options.zdr },
  ];
  for (const { result, what, flag, needed } of lookups) {
    if (!(result instanceof Error)) continue;
    if (needed) {
      console.error(`${NAME}: cannot apply ${flag} without ${what} (${result.message})`);
      return 1;
    }
    console.error(`${NAME}: ${what} unavailable (${result.message})`);
  }

  // Fetch every model concurrently, but print in argument order.
  const ctx: Context = {
    options,
    auth,
    locations: locations instanceof Error ? undefined : locations,
    zdr: zdr instanceof Error ? undefined : zdr,
  };
  const pending = options.slugs.map((slug) => buildReport(slug, ctx));
  let ok = true;
  if (options.pick) {
    // stdout carries only tags, so `$(opp model --pick)` captures just the answer.
    for (const next of pending) {
      const report = await next;
      const pick = pickOf(report);
      if (pick) {
        console.log(pick.tag);
        const note = busyNote(report);
        if (note) console.error(`${NAME}: ${report.slug}: picked ${pick.tag}, but ${note}`);
      } else {
        ok = false;
        console.error(`${NAME}: ${report.slug}: ${noPickReason(report)}`);
      }
    }
  } else if (options.json) {
    const reports = await Promise.all(pending);
    ok = reports.every((report) => pickOf(report) !== undefined);
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          authenticated: auth !== undefined,
          excludeCountries: options.excludeCountries,
          zdrOnly: options.zdr,
          models: reports.map((report) => reportJson(report, ctx)),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`# OpenRouter endpoint ranking · ${new Date().toISOString()} · auth: ${auth?.source ?? "anonymous"}`);
    console.log(
      `# eligible: native tools, status 0, tool_choice ${TOOL_CHOICE_MODES.join("/")}` +
        (options.excludeCountries.length ? `, not in ${options.excludeCountries.join("/")}` : "") +
        (options.zdr ? ", ZDR only" : ""),
    );
    console.log(
      `# rank: uptime 1d > uptime 30m (>=${UPTIME_SATURATION}% ties) > turn_s > maxout > $run; ` +
        `turn_s = ttfb + ${TURN_OUTPUT_TOKENS} tokens at tok/s`,
    );
    console.log(
      `# price-elim: $run >${PRICE_ELIM_RATIO}x and >$${PRICE_ELIM_DELTA_USD} more than the cheapest ` +
        `top-uptime endpoint; ranks after all others`,
    );
    console.log(
      `# prices: USD per million tokens; $run = ${REFERENCE_RUN.prompt / 1000}k in + ` +
        `${REFERENCE_RUN.cacheRead / 1_000_000}M cache read + ${REFERENCE_RUN.completion / 1000}k out`,
    );
    for (const next of pending) {
      const report = await next;
      ok &&= pickOf(report) !== undefined;
      console.log(renderReport(report, ctx));
    }
  }
  return ok ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(Bun.argv.slice(2));
