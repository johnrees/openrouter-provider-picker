/**
 * Vercel AI Gateway as a second endpoint source: fetching a model's endpoints with no key, normalising them
 * to opp's Endpoint, and pinning one. No Bun APIs, so any runtime can use it.
 */

import { FETCH_TIMEOUT_MS, isEndpoint } from "./openrouter.ts";
import { type Endpoint, listedToolChoice, metric, providerSlug, TOOL_CHOICE_MODES } from "./policy.ts";

export const VERCEL_API = "https://ai-gateway.vercel.sh/v1";
/** The environment variable that holds the key for Vercel probes. Listing endpoints needs none. */
export const VERCEL_KEY_VAR = "AI_GATEWAY_API_KEY";

/**
 * OpenRouter slug to Vercel slug, for a model's creator and for providers. A slug not listed here is the
 * same on both. Matched exactly: no fuzzy matching.
 */
export const ALIASES: Readonly<Record<string, string>> = {
  "z-ai": "zai",
  together: "togetherai",
  "amazon-bedrock": "bedrock",
  "google-vertex": "vertex",
};
const REVERSE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ALIASES).map(([openrouter, vercel]) => [vercel, openrouter]),
);

const lookup = (map: Readonly<Record<string, string>>, slug: string): string =>
  Object.hasOwn(map, slug.toLowerCase()) ? map[slug.toLowerCase()]! : slug;
export const toVercelSlug = (slug: string): string => lookup(ALIASES, slug);
export const toOpenRouterSlug = (slug: string): string => lookup(REVERSE, slug);

/** Vercel's id for an OpenRouter model slug: its creator through the alias map, e.g. z-ai/glm-5.3 → zai/glm-5.3. */
export function vercelModel(slug: string): string {
  const [creator, ...rest] = slug.split("/");
  return [toVercelSlug(creator!), ...rest].join("/");
}

/** The p50 of a Vercel percentile object, the only percentile ranking reads. */
const median = (percentiles: unknown): { p50: number | null } | null =>
  typeof percentiles === "object" && percentiles !== null
    ? { p50: metric((percentiles as { p50?: unknown }).p50) ?? null }
    : null;

/**
 * One row of Vercel's GET /models/{creator}/{model}/endpoints as an Endpoint, or undefined when it fails
 * the checks every OpenRouter row passes. The tag is Vercel's provider slug. Vercel's windows are longer
 * than OpenRouter's, so the 1-hour uptime fills the 30-minute slot that ranking uses, the 15-minute uptime
 * the 5-minute one (display only), and 1-hour p50 latency and throughput the 30-minute ones. Pricing is
 * the row's listed rate: `discount` and `inference_regions[].pricing` are left out, since a pin chooses no
 * region. Quantization is kept as listed.
 */
export function normalise(row: unknown): Endpoint | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const r = row as Record<string, unknown>;
  const pricing = r.pricing as Record<string, unknown> | null | undefined;
  const candidate = {
    gateway: "vercel",
    provider_name: r.provider_name,
    tag: r.provider_name,
    status: r.status,
    quantization: r.quantization,
    max_completion_tokens: r.max_completion_tokens,
    supported_parameters: r.supported_parameters,
    has_zdr: typeof r.has_zdr === "boolean" ? r.has_zdr : null,
    uptime_last_5m: r.uptime_last_15m,
    uptime_last_30m: r.uptime_last_1h,
    uptime_last_1d: r.uptime_last_1d,
    latency_last_30m: median(r.latency_last_1h),
    throughput_last_30m: median(r.throughput_last_1h),
    pricing:
      typeof pricing === "object" && pricing !== null
        ? {
            prompt: pricing.prompt,
            completion: pricing.completion,
            input_cache_read: pricing.input_cache_read,
            internal_reasoning: pricing.internal_reasoning,
            request: pricing.request,
          }
        : pricing,
  };
  return isEndpoint(candidate) ? candidate : undefined;
}

/** A model's Vercel endpoints. Public data, so no key is sent. */
export async function fetchVercelEndpoints(slug: string): Promise<{ endpoints: Endpoint[]; malformed: number }> {
  const path = vercelModel(slug).split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${VERCEL_API}/models/${path}/endpoints`, {
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as {
    data?: { endpoints?: unknown };
    error?: { message?: unknown } | string;
  } | null;
  if (!res.ok) {
    const message = typeof body?.error === "string" ? body.error : body?.error?.message;
    throw new Error(`HTTP ${res.status}${message == null ? "" : `: ${String(message)}`}`);
  }
  const raw = body?.data?.endpoints;
  if (!Array.isArray(raw)) throw new Error("unexpected response: no data.endpoints array");
  const endpoints = raw.map(normalise).filter((ep) => ep !== undefined);
  return { endpoints, malformed: raw.length - endpoints.length };
}

/**
 * Vercel lists tool_choice but no per-mode support, so each Vercel row that lists it borrows OpenRouter's
 * verdict when its provider (through the alias map) serves the model there: a mode counts only if every
 * OpenRouter endpoint of that provider lists it. A row with no such provider is marked unverified. Only
 * the listings count; stored probe results stay with the OpenRouter rows they were taken on. `openrouter`
 * is undefined when OpenRouter's endpoints could not be fetched.
 */
export function borrowToolChoice(rows: readonly Endpoint[], openrouter: readonly Endpoint[] | undefined): Endpoint[] {
  return rows.map((ep) => {
    if (!ep.supported_parameters.includes("tool_choice")) return ep;
    const provider = toOpenRouterSlug(ep.tag).toLowerCase();
    const peers = (openrouter ?? []).filter((peer) => providerSlug(peer) === provider);
    if (!peers.length) return { ...ep, tool_choice_unverified: true };
    const supports = Object.fromEntries(
      TOOL_CHOICE_MODES.map((mode) => [mode, peers.every((peer) => listedToolChoice(peer, mode))]),
    );
    return { ...ep, supports_tool_choice: supports, tool_choice_from: provider };
  });
}

/** The `providerOptions` value that pins a Vercel endpoint: `only` restricts routing and fallbacks to it. */
export const vercelRouting = (ep: Endpoint) => ({ gateway: { only: [ep.tag] } });

type Routing = { finalProvider?: unknown; resolvedProvider?: unknown };
type VercelReply = { choices?: { message?: { provider_metadata?: { gateway?: { routing?: Routing } } } }[] } | null;

/**
 * The provider that served a Vercel chat completion: `choices[0].message.provider_metadata.gateway.routing`'s
 * finalProvider, else its resolvedProvider, or undefined when the response names neither.
 */
export function servedProvider(body: unknown): string | undefined {
  const routing = (body as VercelReply)?.choices?.[0]?.message?.provider_metadata?.gateway?.routing;
  const provider = routing?.finalProvider ?? routing?.resolvedProvider;
  return typeof provider === "string" ? provider : undefined;
}

/** The key for Vercel probes, or undefined when it is not set. It is sent only to Vercel and never printed. */
export function resolveVercelAuth(
  env: Record<string, string | undefined>,
): { key: string; source: string } | undefined {
  const key = env[VERCEL_KEY_VAR]?.trim();
  return key ? { key, source: VERCEL_KEY_VAR } : undefined;
}
