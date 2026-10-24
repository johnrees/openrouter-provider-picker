/**
 * The probe: one tiny paid request through an endpoint's pin, judged on
 * whether it served and called the tool. No Bun APIs, so any runtime can use it.
 */

import { API, errorMessage, sanitize } from "./openrouter.ts";
import {
  type Audit,
  type AuditSample,
  type Auth,
  type Endpoint,
  pinRouting,
  type Probe,
  type Ranked,
  type ToolChoiceMode,
  type Verification,
} from "./policy.ts";

/** Generous for a one-tool-call reply; a pin that takes longer is not one to pick. */
const PROBE_TIMEOUT_MS = 30_000;
/** Room for a reasoning model to think briefly and still call the tool. Measured calls used 5 to 146 tokens. */
export const PROBE_MAX_TOKENS = 512;
/** --verify starts no new probe after this long, so a run of hanging endpoints can't stall it for many minutes. */
export const VERIFY_BUDGET_MS = 180_000;
/** Probe failures that mean "busy, try again shortly" rather than "this route is broken". */
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
/** Wait before retrying a transient failure, unless Retry-After asks for longer (up to the cap). */
const PROBE_RETRY_MS = 2_000;
const PROBE_RETRY_MAX_MS = 10_000;

type ChatResponse = {
  provider?: unknown;
  service_tier?: unknown;
  error?: { message?: unknown; code?: unknown };
  choices?: { finish_reason?: unknown; message?: { content?: unknown; tool_calls?: unknown } }[];
  usage?: { cost?: unknown };
};

const PROBE_TOOL = "ok";

/** Tool-call arguments as a JSON object string; empty means no arguments. */
function isArgumentObject(args: unknown): boolean {
  if (args === "") return true;
  if (typeof args !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** A tool call with a name and arguments an agent can parse. */
const usableCall = (c: unknown): boolean => {
  const fn = (c as { function?: { name?: unknown; arguments?: unknown } } | null)?.function;
  return fn?.name === PROBE_TOOL && isArgumentObject(fn.arguments);
};

/** One probe request's outcome. `retryInMs` is set when the failure is transient. */
type Attempt = { ok: boolean; detail: string; retryInMs?: number };

/** The tool_choice request value for each mode; the named function is the probe's own tool. */
export function toolChoiceFor(mode: ToolChoiceMode) {
  return mode === "function" ? { type: "function", function: { name: PROBE_TOOL } } : mode;
}

/**
 * The probe request body: one tiny completion pinned to `ep`, with the given tool_choice mode. With no `ep`
 * it carries no routing preferences, so OpenRouter's default routing chooses the provider.
 */
export function probeBody(slug: string, ep: Endpoint | null, endpoints: readonly Endpoint[], mode: ToolChoiceMode) {
  return {
    model: slug,
    ...(ep && { provider: pinRouting(ep, endpoints) }),
    max_tokens: PROBE_MAX_TOKENS,
    // Eligibility trusts the endpoint's advertised tool support, so the probe exercises it.
    tools: [{ type: "function", function: { name: PROBE_TOOL, parameters: { type: "object", properties: {} } } }],
    tool_choice: toolChoiceFor(mode),
    messages: [{ role: "user", content: `Call the ${PROBE_TOOL} tool.` }],
  };
}

/** How long to wait before retrying, from a Retry-After header in seconds, capped. */
export function retryDelay(header: string | null): number {
  const seconds = header === null || header.trim() === "" ? NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, PROBE_RETRY_MAX_MS) : PROBE_RETRY_MS;
}

/**
 * What is wrong with a completion as a reply under `mode`, or undefined when it passes. --verify, --probe and
 * --audit-fallback all judge a tool call by this rule.
 */
export function toolCallProblem(body: ChatResponse | null, mode: ToolChoiceMode = "required"): string | undefined {
  const choice = body?.choices?.[0];
  const finish = String(choice?.finish_reason ?? "none");
  const calls = choice?.message?.tool_calls;
  const call = Array.isArray(calls)
    ? (calls as ({ function?: { name?: unknown; arguments?: unknown } } | null)[]).find(
        (c) => c?.function?.name === PROBE_TOOL,
      )
    : undefined;
  // "none" passes on a plain reply, and any tool call then breaks the contract. "auto" may or may not call,
  // but a call it makes must be usable. Every mode needs a completion to judge.
  // A finished reply has a message and did not end on an error or a filter. A reply cut off by max_tokens still passes: length is no tool_choice failure.
  if (
    !choice?.message ||
    !["stop", "tool_calls", "length"].includes(finish) ||
    // Out of tokens before saying anything is inconclusive, not a pass.
    (finish === "length" && !(Array.isArray(calls) && calls.length) && !String(choice.message.content ?? "").trim())
  ) {
    return `no finished completion, finish=${finish}`;
  }
  if (mode === "none") {
    return (Array.isArray(calls) && calls.length) || finish === "tool_calls"
      ? `tool call despite tool_choice none, finish=${finish}`
      : undefined;
  }
  if (mode === "auto") {
    const made = Array.isArray(calls) ? calls : [];
    const bad =
      finish === "tool_calls"
        ? !made.length || !made.every(usableCall)
        : made.length > 0 && (finish === "length" || !made.every(usableCall));
    return bad ? `unusable tool call, finish=${finish}` : undefined;
  }
  if (!call) return `no ${PROBE_TOOL} tool call despite tool_choice ${mode}, finish=${finish}`;
  // A call cut off by max_tokens, or with arguments an agent can't parse, is no use to an agent loop.
  if (finish === "length" || !isArgumentObject(call.function?.arguments)) {
    return `unusable ${PROBE_TOOL} tool call, finish=${finish}`;
  }
  return undefined;
}

/**
 * Sends one minimal completion pinned to `ep`, retrying once if the endpoint
 * is busy. Account data controls, such as zero-retention or data-collection
 * exclusions, are enforced only at routing time and appear in no API field. A
 * real request is the only way to learn whether this account can use an
 * endpoint.
 */
export async function probe(
  slug: string,
  ep: Endpoint,
  endpoints: readonly Endpoint[],
  auth: Auth,
  mode: ToolChoiceMode = "required",
): Promise<Probe> {
  const first = await attempt(slug, ep, endpoints, auth, mode);
  if (first.retryInMs === undefined) return { endpoint: ep, ok: first.ok, busy: false, detail: first.detail };
  await new Promise((resolve) => setTimeout(resolve, first.retryInMs));
  const second = await attempt(slug, ep, endpoints, auth, mode);
  const busy = second.retryInMs !== undefined;
  return { endpoint: ep, ok: second.ok, busy, detail: `${second.detail}, ${second.ok ? "after a retry" : "retried"}` };
}

async function attempt(
  slug: string,
  ep: Endpoint,
  endpoints: readonly Endpoint[],
  auth: Auth,
  mode: ToolChoiceMode,
): Promise<Attempt> {
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
      body: JSON.stringify(probeBody(slug, ep, endpoints, mode)),
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
    // A provider's tier endpoints share its name, so check the tier too. Responses call the standard tier "default".
    const tier = body?.service_tier;
    const want = ep.service_tier ?? "default";
    if (typeof tier === "string" && tier !== want) return result(false, `served at tier ${tier}, expected ${want}`);
    const problem = toolCallProblem(body, mode);
    if (problem !== undefined) return result(false, problem);
    const finish = String(body?.choices?.[0]?.finish_reason ?? "none");
    return result(true, `served by ${servedBy}${mode === "none" ? ", no tool call" : ""}, finish=${finish}`);
  } catch (error) {
    return result(false, errorMessage(error));
  }
}

/** Probes candidates in rank order and stops at the first that serves. */
export async function verify(
  slug: string,
  candidates: readonly Ranked[],
  endpoints: readonly Endpoint[],
  auth: Auth,
  deadline = Date.now() + VERIFY_BUDGET_MS,
): Promise<Verification> {
  const probes: Probe[] = [];
  for (const { endpoint } of candidates) {
    if (Date.now() >= deadline) return { probes, unprobed: candidates.length - probes.length };
    const outcome = await probe(slug, endpoint, endpoints, auth);
    probes.push(outcome);
    if (outcome.ok) return { probes, verified: endpoint };
  }
  return { probes };
}

/**
 * The quantization of the endpoints that could have served a response: those of `provider`, at `serviceTier`
 * when the response names one. null when none match or they disagree.
 */
export function servedQuantization(
  provider: string,
  serviceTier: string | null,
  endpoints: readonly Endpoint[],
): string | null {
  const matching = endpoints.filter(
    (ep) =>
      ep.provider_name.toLowerCase() === provider.toLowerCase() &&
      (serviceTier === null || (ep.service_tier ?? "default") === serviceTier),
  );
  const quantizations = new Set(matching.map((ep) => ep.quantization ?? null));
  return quantizations.size === 1 ? [...quantizations][0]! : null;
}

/** Sends one unpinned request, with no retry: a failure is what an unpinned caller sees after OpenRouter's fallback. */
async function auditOne(
  slug: string,
  endpoints: readonly Endpoint[],
  auth: Auth,
): Promise<{ sample: AuditSample; usd: number }> {
  const started = performance.now();
  const sample = (body: ChatResponse | null, served: boolean): AuditSample => {
    const provider = served && typeof body?.provider === "string" ? body.provider : null;
    const serviceTier = served && typeof body?.service_tier === "string" ? body.service_tier : null;
    return {
      provider,
      quantization: provider === null ? null : servedQuantization(provider, serviceTier, endpoints),
      serviceTier,
      toolCallValid: served && toolCallProblem(body) === undefined,
      ms: Math.round(performance.now() - started),
    };
  };
  try {
    const res = await fetch(`${API}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.key}`, "Content-Type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      body: JSON.stringify(probeBody(slug, null, endpoints, "required")),
    });
    const body = (await res.json().catch(() => null)) as ChatResponse | null;
    const cost = body?.usage?.cost;
    const usd = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : 0;
    // OpenRouter can also report an upstream failure as an error body on a 200.
    return { sample: sample(body, res.ok && body?.error?.message == null), usd };
  } catch {
    return { sample: sample(null, false), usd: 0 };
  }
}

/**
 * Sends `n` identical tool-call requests with no routing preferences, one at a time, and records which
 * provider OpenRouter's default routing served each. Requests not started by `deadline` stay unsent.
 */
export async function auditFallback(
  slug: string,
  n: number,
  endpoints: readonly Endpoint[],
  auth: Auth,
  deadline: number,
): Promise<Audit> {
  const samples: AuditSample[] = [];
  let usd = 0;
  while (samples.length < n && Date.now() < deadline) {
    const outcome = await auditOne(slug, endpoints, auth);
    samples.push(outcome.sample);
    usd += outcome.usd;
  }
  return { samples, unsent: n - samples.length, usd };
}
