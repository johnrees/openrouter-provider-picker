/**
 * OpenCode Go as a third endpoint source: listing the models a Go key can use and normalising each to an
 * unnamed Endpoint. Go publishes no providers, prices or uptime, so a row carries none; its figures come
 * from opp's own probe. No Bun APIs, so any runtime can use it.
 */

import pkg from "../package.json";
import { FETCH_TIMEOUT_MS, isEndpoint } from "./openrouter.ts";
import { type Endpoint, metric } from "./policy.ts";

export const OPENCODE_GO_API = "https://opencode.ai/inference/go/v1";
/** The environment variable that holds the key for Go. Listing needs it too. */
export const OPENCODE_GO_KEY_VAR = "OPENCODE_GO_KEY";
/** Go asks clients to identify themselves, and to group a run's requests under one session. */
export const OPENCODE_GO_USER_AGENT = `opp/${pkg.version}`;
export const OPENCODE_GO_SESSION = crypto.randomUUID();

/** Go's id for an OpenRouter model slug: its model part, so z-ai/glm-5.3-flash is glm-5.3-flash. Lowercase and exact. */
export const opencodeGoModel = (slug: string): string => slug.slice(slug.indexOf("/") + 1).toLowerCase();

/**
 * One entry of Go's GET /models as an Endpoint, or undefined when it fails the checks every OpenRouter row
 * passes. Go's id is the tag and the provider name. Every ranking stat is unknown. A row is eligible because
 * Go serves tools; tool_choice is unverified, which --verify proves.
 */
export function normalise(row: unknown): Endpoint | undefined {
  const id = (row as { id?: unknown } | null)?.id;
  const candidate = {
    gateway: "opencode-go",
    provider_name: id,
    tag: id,
    status: 0,
    supported_parameters: ["tools", "tool_choice"],
    tool_choice_unverified: true,
    pricing: {},
  };
  return id !== "" && isEndpoint(candidate) ? candidate : undefined;
}

/**
 * The Go row for a model, from Go's model list, which only a Go key can fetch. Go lists a model by the
 * model part of its OpenRouter slug; a model with no such id isn't on Go, which is an error.
 */
export async function fetchOpenCodeGoEndpoints(
  slug: string,
  key: string,
): Promise<{ endpoints: Endpoint[]; malformed: number }> {
  const res = await fetch(`${OPENCODE_GO_API}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as {
    data?: unknown;
    error?: { message?: unknown } | string;
  } | null;
  if (!res.ok) {
    const message = typeof body?.error === "string" ? body.error : body?.error?.message;
    throw new Error(`HTTP ${res.status}${message == null ? "" : `: ${String(message)}`}`);
  }
  if (!Array.isArray(body?.data)) throw new Error("unexpected response: no data array");
  const id = opencodeGoModel(slug);
  const listed = body.data.filter((row) => {
    const listedId = (row as { id?: unknown } | null)?.id;
    return typeof listedId === "string" && listedId.toLowerCase() === id;
  });
  if (!listed.length) throw new Error("not listed");
  const endpoints = listed.map(normalise).filter((ep) => ep !== undefined);
  return { endpoints, malformed: listed.length - endpoints.length };
}

/** What a Go chat completion charged the plan, in USD: `usage.opencode.allowance`, or undefined when absent. */
export const allowanceOf = (body: unknown): number | undefined =>
  metric((body as { usage?: { opencode?: { allowance?: unknown } } } | null)?.usage?.opencode?.allowance);

/** An allowance for the probe line: four decimals, or two significant figures below a hundredth of a cent. */
export const fmtAllowance = (usd: number): string =>
  `$${usd.toFixed(usd === 0 || usd >= 0.0001 ? 4 : Math.min(20, Math.ceil(-Math.log10(usd)) + 1))}`;

/** The key for Go, or undefined when it is not set. It is sent only to opencode.ai and never printed. */
export function resolveOpenCodeGoAuth(
  env: Record<string, string | undefined>,
): { key: string; source: string } | undefined {
  const key = env[OPENCODE_GO_KEY_VAR]?.trim();
  return key ? { key, source: OPENCODE_GO_KEY_VAR } : undefined;
}
