/** OpenRouter's public API: fetching a model's endpoints, provider locations and the ZDR list, and checking their shape. */

import { type Auth, COUNTRY, type Endpoint, type Location } from "./policy.ts";

export const API = "https://openrouter.ai/api/v1";
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * Makes upstream text safe to print. It scrubs the keys and anything shaped
 * like an OpenRouter key, removes terminal control characters and newlines,
 * and truncates. Scrubbing runs before truncation so a cut can't hide a key.
 */
export function sanitize(text: string, secrets?: string | readonly (string | undefined)[], max = 200): string {
  let out = text;
  for (const secret of typeof secrets === "string" ? [secrets] : (secrets ?? [])) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  out = out
    .replace(/sk-or-[\w-]+/g, "[redacted]")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const PRINTABLE = /^[^\u0000-\u001f\u007f-\u009f]+$/;
const isRate = (rate: unknown): boolean => rate == null || typeof rate === "string";
/** Optional text that reaches the terminal unescaped, so it must be printable too. */
const isLabel = (label: unknown): boolean => label == null || (typeof label === "string" && PRINTABLE.test(label));

export function isEndpoint(value: unknown): value is Endpoint {
  if (typeof value !== "object" || value === null) return false;
  const ep = value as Record<string, unknown>;
  const pricing = ep.pricing as Record<string, unknown> | null | undefined;
  return (
    typeof ep.provider_name === "string" &&
    PRINTABLE.test(ep.provider_name) &&
    typeof ep.tag === "string" &&
    PRINTABLE.test(ep.tag) &&
    isLabel(ep.quantization) &&
    isLabel(ep.service_tier) &&
    (ep.status == null || Number.isInteger(ep.status)) &&
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
async function getData(path: string, auth?: Auth, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    headers: auth ? { Authorization: `Bearer ${auth.key}` } : {},
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => null)) as { data?: unknown; error?: { message?: unknown } } | null;
  if (!res.ok) {
    const message = body?.error?.message;
    throw new Error(`HTTP ${res.status}${message == null ? "" : `: ${String(message)}`}`);
  }
  return body?.data;
}

export async function fetchEndpoints(slug: string, auth?: Auth): Promise<{ endpoints: Endpoint[]; malformed: number }> {
  const path = slug.split("/").map(encodeURIComponent).join("/");
  const raw = ((await getData(`/models/${path}/endpoints`, auth)) as { endpoints?: unknown } | undefined)?.endpoints;
  if (!Array.isArray(raw)) throw new Error("unexpected response: no data.endpoints array");
  const endpoints = raw.filter(isEndpoint).map((ep): Endpoint => ({ ...ep, gateway: "openrouter" }));
  return { endpoints, malformed: raw.length - endpoints.length };
}

/** Provider locations by slug. Public data, so no key is sent. */
export async function fetchLocations(): Promise<Map<string, Location>> {
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
export const zdrKey = (model: string, tag: string): string => `${model}\u0000${tag}`;

/** Every zero-data-retention endpoint, as zdrKey values. Public data, so no key is sent. */
export async function fetchZdr(): Promise<Set<string>> {
  const raw = await getData("/endpoints/zdr");
  if (!Array.isArray(raw)) throw new Error("unexpected response: no data array");
  const keys = new Set<string>();
  for (const ep of raw as { model_id?: unknown; tag?: unknown }[]) {
    if (typeof ep?.model_id === "string" && typeof ep.tag === "string") keys.add(zdrKey(ep.model_id, ep.tag));
  }
  return keys;
}

/** Every model's id, from the public model list, which needs no key. */
export async function fetchModelIds(timeoutMs: number): Promise<string[]> {
  const raw = await getData("/models", undefined, timeoutMs);
  if (!Array.isArray(raw)) throw new Error("unexpected response: no data array");
  return (raw as { id?: unknown }[]).flatMap((model) => (typeof model?.id === "string" ? [model.id] : []));
}
