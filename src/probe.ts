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
  type Gateway,
  gatewayOf,
  pinRouting,
  type Probe,
  type Ranked,
  type ToolChoiceMode,
  type Verification,
} from "./policy.ts";
import {
  allowanceOf,
  fmtAllowance,
  OPENCODE_GO_API,
  OPENCODE_GO_SESSION,
  OPENCODE_GO_USER_AGENT,
} from "./opencode-go.ts";
import { servedProvider, VERCEL_API, vercelModel, vercelRouting } from "./vercel.ts";

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

/**
 * One probe request's outcome. `retryInMs` is set when the failure is transient
 * and worth retrying. `timedOut` marks a request that got no reply in time:
 * transient too, but a retry could hang as long again. `judged` marks a
 * verdict on the endpoint's tool_choice support, read from a reply the
 * endpoint finished. Anything else (no reply, an HTTP error, a reply from the
 * wrong endpoint, or one cut off by the token budget) says nothing about
 * support, apart from a tool call under tool_choice none.
 */
type Attempt = {
  ok: boolean;
  detail: string;
  retryInMs?: number;
  timedOut?: boolean;
  judged?: boolean;
  refused?: number;
  ttfbMs?: number;
  cost?: number;
};

const isTimeout = (error: unknown): boolean => error instanceof Error && error.name === "TimeoutError";

/** The tool_choice request value for each mode; the named function is the probe's own tool. */
export function toolChoiceFor(mode: ToolChoiceMode) {
  return mode === "function" ? { type: "function", function: { name: PROBE_TOOL } } : mode;
}

/** Each gateway's chat completions URL. A probe goes to the gateway that lists its endpoint. */
const CHAT_URL: Record<Gateway, string> = {
  openrouter: `${API}/chat/completions`,
  vercel: `${VERCEL_API}/chat/completions`,
  "opencode-go": `${OPENCODE_GO_API}/chat/completions`,
};

/**
 * The probe request body: one tiny completion pinned to `ep` in its gateway's syntax, with the given
 * tool_choice mode. With no `ep` it carries no routing preferences, so OpenRouter's default routing chooses
 * the provider. A Go request names Go's model id and no routing, since Go can't pin a provider.
 */
export function probeBody(slug: string, ep: Endpoint | null, endpoints: readonly Endpoint[], mode: ToolChoiceMode) {
  const gateway = ep === null ? "openrouter" : gatewayOf(ep);
  const routing: { provider?: object; providerOptions?: object } =
    ep === null || gateway === "opencode-go"
      ? {}
      : gateway === "vercel"
        ? { providerOptions: vercelRouting(ep) }
        : { provider: pinRouting(ep, endpoints) };
  return {
    model: gateway === "vercel" ? vercelModel(slug) : gateway === "opencode-go" ? ep!.tag : slug,
    ...routing,
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
 * Sends one minimal completion pinned to `ep` through its gateway with that
 * gateway's key, retrying once if the endpoint is busy. Account data controls, such as zero-retention or data-collection
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
  if (first.retryInMs === undefined) {
    const busy = first.timedOut === true;
    return {
      endpoint: ep,
      ok: first.ok,
      busy,
      conclusive: !busy && first.judged === true,
      detail: first.detail,
      at: new Date().toISOString(),
      ...(first.refused !== undefined && { refused: first.refused }),
      ...measured(first),
    };
  }
  await new Promise((resolve) => setTimeout(resolve, first.retryInMs));
  const second = await attempt(slug, ep, endpoints, auth, mode);
  const busy = second.retryInMs !== undefined || second.timedOut === true;
  return {
    endpoint: ep,
    ok: second.ok,
    busy,
    conclusive: !busy && second.judged === true,
    at: new Date().toISOString(),
    detail: `${second.detail}, ${second.ok ? "after a retry" : "retried"}`,
    ...(second.refused !== undefined && { refused: second.refused }),
    ...measured(second),
  };
}

/** The figures a Go attempt measured, when it measured any. */
const measured = ({ ttfbMs, cost }: Attempt) => ({
  ...(ttfbMs !== undefined && { ttfbMs }),
  ...(cost !== undefined && { cost }),
});

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
  const verdict = (ok: boolean, detail: string): Attempt => ({ ...result(ok, detail), judged: true });
  const go = gatewayOf(ep) === "opencode-go";
  try {
    const started = performance.now();
    const res = await fetch(CHAT_URL[gatewayOf(ep)], {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.key}`,
        "Content-Type": "application/json",
        ...(go && { "User-Agent": OPENCODE_GO_USER_AGENT, "x-opencode-session": OPENCODE_GO_SESSION }),
      },
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      body: JSON.stringify(probeBody(slug, ep, endpoints, mode)),
    });
    // A non-streamed reply, so the time to the headers is the whole reply's latency.
    const ttfbMs = Math.round(performance.now() - started);
    // A body that is not JSON is judged below. A failure while reading it, such as a timeout or a reset, is no reply.
    const text = await res.text();
    const body = ((): ChatResponse | null => {
      try {
        return JSON.parse(text) as ChatResponse | null;
      } catch {
        return null;
      }
    })();
    // Vercel may give the error as a plain string.
    const error = body?.error as ChatResponse["error"] | string | undefined;
    const upstream = typeof error === "string" ? error : error?.message;
    if (!res.ok || upstream != null) {
      // OpenRouter can also report an upstream rate limit as an error body on a 200.
      const status = res.ok ? Number(body?.error?.code) : res.status;
      const retryInMs = TRANSIENT_STATUSES.has(status) ? retryDelay(res.headers.get("retry-after")) : undefined;
      // An error can come from the account, routing or the request as a whole, so it is no verdict on tool_choice.
      const failed = result(
        false,
        `HTTP ${status || res.status}${upstream == null ? "" : ` ${String(upstream)}`}`,
        retryInMs,
      );
      // Vercel answers 401 or 403 for the account or model as a whole (no key, no card, a free tier without the
      // model), so every other endpoint there would get the same answer.
      const refused = gatewayOf(ep) === "vercel" && (res.status === 401 || res.status === 403);
      return refused ? { ...failed, refused: res.status } : failed;
    }
    // Pinning makes this unreachable unless the gateway changes semantics. Check anyway, since verifying is the point.
    // OpenRouter names the provider in `provider`; Vercel in its gateway metadata's routing.finalProvider.
    // Go names none and pins none, so there is nothing to check.
    const vercel = gatewayOf(ep) === "vercel";
    const named = vercel ? servedProvider(body) : typeof body?.provider === "string" ? body.provider : undefined;
    const servedBy = named ?? "an unknown provider";
    if (!go && servedBy.toLowerCase() !== ep.provider_name.toLowerCase()) return result(false, `served by ${servedBy}`);
    // A provider's tier endpoints share its name, so check the tier too. Responses call the standard tier "default".
    const tier = body?.service_tier;
    const want = ep.service_tier ?? "default";
    if (!go && !vercel && typeof tier === "string" && tier !== want) {
      return result(false, `served at tier ${tier}, expected ${want}`);
    }
    const problem = toolCallProblem(body, mode);
    const finish = String(body?.choices?.[0]?.finish_reason ?? "none");
    const ok = problem === undefined;
    // Go's own figures: the reply's latency, and what it charged the plan.
    const cost = go ? allowanceOf(body) : undefined;
    const figures = go ? [`ttfb ${ttfbMs} ms`, ...(cost === undefined ? [] : [`allowance ${fmtAllowance(cost)}`])] : [];
    const served = go ? figures.join(", ") : `served by ${servedBy}`;
    const detail = problem ?? `${served}${mode === "none" ? ", no tool call" : ""}, finish=${finish}`;
    // An unfinished, errored or filtered reply says nothing about tool_choice support, and nor does one cut off
    // by the token budget, except for a tool call under none. Those fail or pass for this run but are not stored.
    const unfinished = problem?.startsWith("no finished completion") === true;
    const cutOff = finish === "length" && (ok || mode !== "none");
    const outcome = (unfinished || cutOff ? result : verdict)(ok, detail);
    return go ? { ...outcome, ttfbMs, ...(cost !== undefined && { cost }) } : outcome;
  } catch (error) {
    // No reply at all, from a timeout, reset or DNS failure, is no evidence about the endpoint.
    return { ...result(false, errorMessage(error)), ...(isTimeout(error) && { timedOut: true }) };
  }
}

/**
 * Probes candidates in rank order and stops at the first that serves. Each probe uses the key of its
 * endpoint's gateway, so a key only ever goes to its own gateway. Once a gateway refuses the account, its
 * remaining candidates are skipped and the walk goes on through the other gateways' candidates. A Go row's
 * probe is its only source of figures, so once the walk stops, any Go row it did not reach is probed too,
 * within the same deadline; the pick is still the first to serve.
 */
export async function verify(
  slug: string,
  candidates: readonly Ranked[],
  endpoints: readonly Endpoint[],
  keys: Partial<Record<Gateway, Auth>>,
  deadline = Date.now() + VERIFY_BUDGET_MS,
): Promise<Verification> {
  const probes: Probe[] = [];
  const halted: NonNullable<Verification["halted"]> = [];
  const result = (rest: Partial<Verification>): Verification => ({ probes, ...(halted.length && { halted }), ...rest });
  let verified: Endpoint | undefined;
  for (const [i, { endpoint }] of candidates.entries()) {
    if (Date.now() >= deadline) return result({ unprobed: candidates.length - i });
    const gateway = gatewayOf(endpoint);
    const stopped = halted.find((entry) => entry.gateway === gateway);
    if (stopped) {
      stopped.skipped += 1;
      continue;
    }
    const auth = keys[gateway];
    if (!auth) {
      const detail = `no key for ${gateway}`;
      probes.push({ endpoint, ok: false, busy: false, conclusive: false, detail, at: new Date().toISOString() });
      continue;
    }
    const outcome = await probe(slug, endpoint, endpoints, auth);
    probes.push(outcome);
    if (outcome.ok) {
      verified = endpoint;
      break;
    }
    if (outcome.refused !== undefined) halted.push({ gateway, status: outcome.refused, skipped: 0 });
  }
  if (verified === undefined) return result({});
  const rest = candidates.filter(
    ({ endpoint }) => gatewayOf(endpoint) === "opencode-go" && !probes.some((p) => p.endpoint === endpoint),
  );
  for (const [i, { endpoint }] of rest.entries()) {
    if (Date.now() >= deadline) return result({ verified, unprobed: rest.length - i });
    const auth = keys["opencode-go"];
    if (auth) probes.push(await probe(slug, endpoint, endpoints, auth));
  }
  return result({ verified });
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
): Promise<{ sample: AuditSample; usd: number | undefined }> {
  const started = performance.now();
  const sample = (body: ChatResponse | null, served: boolean): AuditSample => {
    const provider = served && typeof body?.provider === "string" ? body.provider : null;
    const serviceTier = served && typeof body?.service_tier === "string" ? body.service_tier : null;
    // Raw values match endpoints; the recorded ones reach the terminal and JSON, so they are made safe to print.
    const label = (text: string | null) => (text === null ? null : sanitize(text, auth.key));
    return {
      provider: label(provider),
      quantization: provider === null ? null : servedQuantization(provider, serviceTier, endpoints),
      serviceTier: label(serviceTier),
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
    // OpenRouter can also report an upstream failure as an error body on a 200.
    const served = res.ok && body?.error?.message == null;
    const cost = body?.usage?.cost;
    const known = typeof cost === "number" && Number.isFinite(cost) && cost >= 0;
    // A failure OpenRouter answered is not billed; a served response without a cost is unknown, not free.
    return { sample: sample(body, served), usd: known ? cost : served ? undefined : 0 };
  } catch {
    // A timeout or dropped connection may still have been billed upstream.
    return { sample: sample(null, false), usd: undefined };
  }
}

/**
 * Sends `n` identical tool-call requests with no routing preferences, one at a time, and records which
 * provider OpenRouter's default routing served each. Requests not started by `deadline`, or once the reported
 * spend has used up `budget` (which concurrent audits share), stay unsent.
 */
export async function auditFallback(
  slug: string,
  n: number,
  endpoints: readonly Endpoint[],
  auth: Auth,
  deadline: number,
  budget: { usd: number } = { usd: Infinity },
): Promise<Audit> {
  const samples: AuditSample[] = [];
  let usd = 0;
  let uncosted = 0;
  while (samples.length < n && Date.now() < deadline && budget.usd > 0) {
    const outcome = await auditOne(slug, endpoints, auth);
    samples.push(outcome.sample);
    if (outcome.usd === undefined) uncosted += 1;
    else usd += outcome.usd;
    budget.usd -= outcome.usd ?? 0;
  }
  return { samples, unsent: n - samples.length, usd, uncosted };
}
