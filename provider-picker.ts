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
 *   "provider": { "only": ["<endpoint tag>"], "ignore": ["<longer sibling tags>"], "allow_fallbacks": false }
 *
 * README.md explains the policy. Run with --help for usage. This file is the
 * Bun command line; src/policy.ts ranks, src/openrouter.ts, src/vercel.ts and
 * src/opencode-go.ts fetch, and src/probe.ts sends the paid test requests, whose results
 * src/probe-store.ts keeps.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import {
  errorMessage,
  fetchEndpoints,
  fetchLocations,
  fetchModelIds,
  fetchZdr,
  sanitize,
  zdrKey,
} from "./src/openrouter.ts";
import {
  AUDIT_MAX_USD,
  AUDIT_PROMPT_TOKENS,
  type Audit,
  type Auth,
  COUNTRY,
  type Endpoint,
  freshProbes,
  GATEWAYS,
  type Gateway,
  gatewayOf,
  ineligibleReasons,
  listedToolChoice,
  type Location,
  locationReasons,
  matchesProvider,
  metric,
  type Options,
  PRICE_ELIM_DELTA_USD,
  PRICE_ELIM_RATIO,
  PRICE_FLOOR_USD,
  PRICE_WEIGHT,
  perMillion,
  pinnable,
  PROBE_TTL_DAYS,
  type Probe,
  type Probed,
  type ProbeStore,
  pinRouting,
  probedFor,
  probeOverrides,
  providerSlug,
  quantizationReported,
  REFERENCE_RUN,
  type Report,
  rank,
  TOOL_CHOICE_MODES,
  TURN_OUTPUT_TOKENS,
  toolChoiceSource,
  turnMs,
  UPTIME_SATURATION,
} from "./src/policy.ts";
import { fetchOpenCodeGoEndpoints, OPENCODE_GO_KEY_VAR, resolveOpenCodeGoAuth } from "./src/opencode-go.ts";
import { auditFallback, PROBE_MAX_TOKENS, probe, VERIFY_BUDGET_MS, verify } from "./src/probe.ts";
import { loadProbes, probeStorePath, recordProbes } from "./src/probe-store.ts";
import {
  borrowToolChoice,
  fetchVercelEndpoints,
  resolveVercelAuth,
  toOpenRouterSlug,
  toVercelSlug,
  VERCEL_KEY_VAR,
  vercelModel,
  vercelRouting,
} from "./src/vercel.ts";

/** The command name, as installed by package.json "bin". */
const NAME = "opp";
const SLUG = /^[a-z0-9][\w.-]*\/[a-z0-9][\w.:-]*$/i;
/** The most unpinned requests --audit-fallback sends per model. */
const AUDIT_MAX_REQUESTS = 50;

const USAGE = `Usage: ${NAME} <model/slug ...> [options]

Rank serving endpoints for each model and pick one to pin.

Models:
  model/slug ...                One or more models to rank, e.g. z-ai/glm-5.3

Sources:
      --gateway <name,...>      Where to list endpoints: openrouter (default),
                                vercel, opencode-go, cloudflare, or all (every
                                gateway with credentials). Repeatable or
                                comma-separated.
  Vercel lists tool_choice but not each mode, so a Vercel row takes OpenRouter's
  verdict for the same provider. A row whose provider isn't on OpenRouter is
  flagged tc? and ranks after the verified rows of its uptime tier.
  opencode-go lists the model whose id is the slug's model part (glm-5.3 for
  z-ai/glm-5.3), if your Go plan has it. Go publishes no providers, prices or
  uptime, so its row is flagged tc?, ranks after every row with figures, and
  can't be pinned: its pick has no routing. Without --verify it is picked only
  when no other row is ranked. --verify probes every Go row and shows its ttfb
  and cost (the plan allowance the probe used).

Eligibility:
  -p, --provider <name,...>     Show only endpoints whose provider name or tag
                                contains a name (any match), case-insensitively.
                                Repeatable or comma-separated. A view: ranking
                                still compares against all endpoints.
  -e, --exclude-provider <name,...>
                                Never rank or pick these providers, matched like
                                -p. Repeatable or comma-separated. Wins over -p.
  -x, --exclude-country <CC,...>
                                Drop endpoints whose provider is headquartered or
                                has a datacenter in these ISO countries.
                                Repeatable or comma-separated. Providers with no
                                known location are kept and shown with "?".
      --zdr                     Keep only zero-data-retention endpoints.

Probes (paid requests):
      --verify                  Send a tiny request that must call a tool through
                                each candidate's pin, best first, until one
                                serves. A busy endpoint is retried once, then
                                skipped. Stops starting probes after 3 minutes.
                                Go rows the walk didn't reach are probed too.
      --probe <tag>             With one model, send four paid requests to the
                                endpoint with this exact tag, whatever its
                                eligibility: tool_choice none, auto, required
                                and a named function. Repeatable. Exit 1 if any
                                mode fails or a tag is unknown. Takes one
                                gateway: openrouter (default) or opencode-go,
                                whose tag is the Go model id.
      --audit-fallback <n>      Send n (1 to ${AUDIT_MAX_REQUESTS}) identical tool-call requests with
                                no routing preferences, one at a time after
                                --verify and within its 3 minutes, and show which
                                providers OpenRouter's default routing served and
                                how many tool calls were unusable. -p, -e, -x and
                                --zdr don't apply. Shows the worst-case cost first
                                and refuses over $${AUDIT_MAX_USD.toFixed(2)}; stops sending once the
                                spend reaches it. Never changes the pick.
  Probe results from the last ${PROBE_TTL_DAYS} days override the listed tool_choice
  support for that endpoint and mode, either way. Only a verdict on a reply
  the endpoint finished is kept: not an error, nor a busy, misrouted or cut-off
  probe. They are stored in $XDG_CACHE_HOME/opp/probes.json; delete it to
  clear them.

Output:
      --json                    Print machine-readable results
      --pick                    Print only each model's chosen endpoint, one line
                                per model
      --completions zsh         Print a zsh completion function for model slugs
                                and flags (see README)
  -h, --help                    Show this help
  An endpoint whose listing doesn't report its quantization ranks below bf16
  and above fp8; a pin on one says "quantization not reported" (--json:
  pick.quantizationReported false). One with no uptime for the last 30 minutes
  keeps its day's figure but ranks after an endpoint measured in the window.
  Within an uptime tier, speed is weighed against price: turn time times
  ($run / cheapest $run)^${PRICE_WEIGHT}, so twice the price must buy a turn about
  ${Math.round((1 - 2 ** -PRICE_WEIGHT) * 100)}% shorter. An endpoint with no price ranks after the priced ones.

Auth: OPENROUTER_API_KEY, else opencode's stored OpenRouter credential;
${VERCEL_KEY_VAR} for Vercel probes; ${OPENCODE_GO_KEY_VAR} for OpenCode Go, even
to list its models.
Exit status: 0 if every model has a pick, 1 if any has none, 2 on usage errors.`;

// ---- Arguments --------------------------------------------------------------

/** A repeatable, comma-separated option's values, trimmed and deduplicated. An empty value is a usage error. */
function listValues(raw: string[] | undefined, what: string): string[] {
  const values = (raw ?? []).flatMap((list) => list.split(",")).map((value) => value.trim());
  if (values.includes("")) throw new Error(`${what} must not be empty`);
  return [...new Set(values)];
}

/** --gateway's values: every gateway opp can list, one reserved for a later source, and all. */
const GATEWAY_NAMES: readonly string[] = [...GATEWAYS, "cloudflare", "all"];
const DEFAULT_GATEWAYS: Gateway[] = ["openrouter"];
/** The gateways --probe can test. */
const PROBE_GATEWAYS: readonly Gateway[] = ["openrouter", "opencode-go"];
const openRouterOnly = (gateways: Options["gateways"]): boolean =>
  gateways !== "all" && gateways.length === 1 && gateways[0] === "openrouter";

function parseGateways(raw: string[] | undefined): Options["gateways"] {
  const names = [...new Set(listValues(raw, "gateway").map((name) => name.toLowerCase()))];
  if (!names.length) return DEFAULT_GATEWAYS;
  const unknown = names.find((name) => !GATEWAY_NAMES.includes(name));
  if (unknown !== undefined) {
    throw new Error(
      `unknown gateway ${JSON.stringify(unknown)}; use openrouter, vercel, opencode-go, cloudflare or all`,
    );
  }
  if (names.includes("cloudflare")) throw new Error("--gateway cloudflare isn't supported yet");
  if (names.includes("all")) {
    if (names.length > 1) throw new Error("--gateway all can't be combined with other gateway names");
    return "all";
  }
  return GATEWAYS.filter((gateway) => names.includes(gateway));
}

export function parseOptions(argv: string[]): Options {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      gateway: { type: "string", multiple: true },
      provider: { type: "string", short: "p", multiple: true },
      "exclude-provider": { type: "string", short: "e", multiple: true },
      "exclude-country": { type: "string", short: "x", multiple: true },
      zdr: { type: "boolean" },
      verify: { type: "boolean" },
      probe: { type: "string", multiple: true },
      "audit-fallback": { type: "string" },
      json: { type: "boolean" },
      pick: { type: "boolean" },
      completions: { type: "string" },
      "list-models": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.json && values.pick) throw new Error("--json and --pick are alternative outputs; give one");
  const slugs = positionals.filter((arg) => arg.includes("/"));
  const probe = (values.probe ?? []).map((tag) => tag.trim());
  if (probe.some((tag) => tag === "")) throw new Error("--probe needs an endpoint tag");
  const gateways = parseGateways(values.gateway);
  const audit = values["audit-fallback"];
  if (audit !== undefined) {
    const n = /^\d+$/.test(audit) ? Number(audit) : NaN;
    if (!(n >= 1 && n <= AUDIT_MAX_REQUESTS))
      throw new Error(
        `--audit-fallback takes a whole number from 1 to ${AUDIT_MAX_REQUESTS}, not ${JSON.stringify(audit)}`,
      );
    if (values.pick) throw new Error("--audit-fallback can't be combined with --pick, whose output is only the pin");
    if (!openRouterOnly(gateways)) {
      throw new Error("--audit-fallback measures OpenRouter's default routing; it takes no --gateway but openrouter");
    }
  }
  if (probe.length) {
    if (values.verify || values.pick || values.json || audit !== undefined)
      throw new Error("--probe can't be combined with --verify, --audit-fallback, --pick or --json");
    if (slugs.length !== 1) throw new Error("--probe takes exactly one model slug");
    if (gateways === "all" || gateways.length !== 1 || !PROBE_GATEWAYS.includes(gateways[0]!))
      throw new Error(`--probe tests one gateway's endpoints; it takes --gateway ${PROBE_GATEWAYS.join(" or ")}`);
  }
  const bareWord = positionals.find((arg) => !arg.includes("/"));
  if (bareWord !== undefined) throw new Error(`${bareWord}: not a model slug; did you mean -p ${bareWord}?`);
  const providers = listValues(values.provider, "provider filter");
  if (!slugs.length && !values.help && values.completions === undefined && !values["list-models"])
    throw new Error("give at least one model slug, e.g. z-ai/glm-5.3");
  const badSlug = slugs.find((slug) => !SLUG.test(slug));
  if (badSlug !== undefined) throw new Error(`not a model slug: ${badSlug}`);
  const excludeProviders = listValues(values["exclude-provider"], "excluded provider");
  const excludeCountries = listValues(values["exclude-country"], "excluded country").map((code) => code.toUpperCase());
  const badCountry = excludeCountries.find((code) => !COUNTRY.test(code));
  if (badCountry !== undefined) throw new Error(`not a two-letter country code: ${JSON.stringify(badCountry)}`);
  return {
    slugs,
    gateways,
    providers,
    excludeProviders,
    excludeCountries: [...new Set(excludeCountries)],
    zdr: values.zdr ?? false,
    verify: values.verify ?? false,
    probe,
    json: values.json ?? false,
    pick: values.pick ?? false,
    help: values.help ?? false,
    ...(audit !== undefined && { auditFallback: Number(audit) }),
    ...(values.completions !== undefined && { completions: values.completions }),
    ...(values["list-models"] && { listModels: true }),
  };
}

// ---- Completion -------------------------------------------------------------

/** How long a fetched model list is reused, and how long a Tab press waits for a fresh one. */
const MODEL_LIST_TTL_HOURS = 24;
const MODEL_LIST_TIMEOUT_MS = 2000;

const ZSH_COMPLETION = `#compdef ${NAME}
# Completion for ${NAME}: model slugs (from \`${NAME} --list-models\`) and flags.
_${NAME}_models() {
  local -a models
  [[ \$PREFIX == -* ]] && return 1
  models=(\${(f)"\$(command ${NAME} --list-models 2>/dev/null)"})
  compadd -M 'm:{a-z}={A-Z} l:|=*' -a models
}
_${NAME}() {
  _arguments -s \\
    '*--gateway[where to list endpoints]:gateway:(openrouter vercel opencode-go all)' \\
    '*'{-p,--provider}'[show only these providers]:provider:' \\
    '*'{-e,--exclude-provider}'[never rank or pick these providers]:provider:' \\
    '*'{-x,--exclude-country}'[drop providers in these countries]:country code:' \\
    '--zdr[keep only zero-data-retention endpoints]' \\
    '--verify[prove the pick serves and makes a tool call]' \\
    '*--probe[test tool_choice modes on one endpoint]:endpoint tag:' \\
    '--audit-fallback[measure default routing]:requests (1-${AUDIT_MAX_REQUESTS}):' \\
    '--json[print machine-readable results]' \\
    '--pick[print only each chosen endpoint]' \\
    '--completions[print a completion function]:shell:(zsh)' \\
    '(- *)'{-h,--help}'[show help]' \\
    '*:model:_${NAME}_models'
}
if [[ \$funcstack[1] == _${NAME} ]]; then
  _${NAME} "\$@"
else
  compdef _${NAME} ${NAME}
fi
`;

/** Where the model list is cached, beside the probe store. */
function modelListPath(env: Record<string, string | undefined> = process.env): string | undefined {
  const store = probeStorePath(env);
  return store && `${dirname(store)}/models.json`;
}

/**
 * Model slugs for --list-models. A cache younger than MODEL_LIST_TTL_HOURS is
 * used without fetching; otherwise the list is fetched within a short timeout
 * and cached, and a failed fetch falls back to the stale cache, else nothing.
 */
export async function listModels(now = Date.now()): Promise<string[]> {
  const path = modelListPath();
  let cached: { at: number; slugs: string[] } | undefined;
  try {
    const raw = JSON.parse(readFileSync(path!, "utf8")) as { at?: unknown; slugs?: unknown };
    if (typeof raw.at === "number" && Array.isArray(raw.slugs) && raw.slugs.every((s) => typeof s === "string"))
      cached = { at: raw.at, slugs: raw.slugs };
  } catch {}
  if (cached && now - cached.at < MODEL_LIST_TTL_HOURS * 3_600_000) return cached.slugs;
  try {
    const slugs = (await fetchModelIds(MODEL_LIST_TIMEOUT_MS)).filter((id) => SLUG.test(id));
    if (path) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ at: now, slugs }));
      } catch {}
    }
    return slugs;
  } catch {
    return cached?.slugs ?? [];
  }
}

// ---- Auth -------------------------------------------------------------------

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
  let sqlite: Database | undefined;
  try {
    sqlite = new Database(db, { readonly: true });
    const row = sqlite
      .query<{ value: unknown }, []>("select value from credential where label = 'OpenRouter' and active = 1 limit 1")
      .get();
    if (typeof row?.value !== "string") return undefined;
    // The stored value is a JSON envelope, {"type":"key","key":"sk-or-..."}.
    // Anything else is ignored rather than sent as a bearer token.
    const envelope = JSON.parse(row.value) as { type?: unknown; key?: unknown } | null;
    const key = envelope?.type === "key" && typeof envelope.key === "string" ? envelope.key.trim() : "";
    return key ? { key, source: "opencode credential store" } : undefined;
  } catch {
    return undefined; // unreadable database, a different schema, or a value that is not an envelope
  } finally {
    sqlite?.close();
  }
}

// ---- Reports ----------------------------------------------------------------

/** Prints a warning when probe results could not be stored. */
function storeProbes(slug: string, results: Parameters<typeof recordProbes>[2]): void {
  const error = recordProbes(probeStorePath(), slug, results);
  if (error) console.error(`${NAME}: could not store probe results: ${error}`);
}

/**
 * Sends all four tool_choice modes to each named endpoint of one gateway, prints a line per tag and mode,
 * and stores the OpenRouter results. Go probes are never stored, since the store is keyed by OpenRouter tag.
 */
async function probeTags(
  slug: string,
  tags: readonly string[],
  gateway: Gateway,
  keys: Context["keys"],
): Promise<boolean> {
  const auth = keys[gateway]!;
  let ok = true;
  let endpoints: Endpoint[];
  try {
    endpoints = (
      gateway === "opencode-go" ? await fetchOpenCodeGoEndpoints(slug, auth.key) : await fetchEndpoints(slug, auth)
    ).endpoints;
  } catch (error) {
    console.error(`${NAME}: ${slug}: fetch failed: ${sanitize(errorMessage(error), secretsOf({ keys }))}`);
    return false;
  }
  for (const tag of tags) {
    const found = endpoints.find((e) => e.tag.toLowerCase() === tag.toLowerCase());
    if (!found) {
      console.log(`${tag}: no such endpoint for ${slug}`);
      ok = false;
      continue;
    }
    for (const mode of TOOL_CHOICE_MODES) {
      const outcome = await probe(slug, found, endpoints, auth, mode);
      ok &&= outcome.ok;
      const listed = found.tool_choice_unverified ? "?" : listedToolChoice(found, mode) ? "yes" : "no";
      const status = outcome.ok ? "ok" : outcome.busy ? "busy" : "fail";
      console.log(`${found.tag}  ${mode}  ${status}  listed: ${listed}  ${outcome.detail}`);
      if (gateway === "openrouter") storeProbes(slug, [{ probe: outcome, mode }]);
    }
  }
  return ok;
}

/** `auditBudget` is what the audits of every model may still spend, shared so the cap holds on actual spend. */
type Context = {
  options: Options;
  /** The gateways this run lists, with --gateway all resolved. */
  gateways: Gateway[];
  /** OpenRouter's key, sent only to OpenRouter. */
  auth?: Auth;
  /** Each gateway's key for probes, sent only to that gateway. */
  keys: Partial<Record<Gateway, Auth>>;
  locations?: Map<string, Location>;
  zdr?: Set<string>;
  auditBudget?: { usd: number };
  /** Stored probe results, read once at the start of the run. */
  probes: ProbeStore;
  now: Date;
};

/** Every key this run holds, so any of them is scrubbed from what it prints. */
const secretsOf = ({ keys }: Pick<Context, "keys">): (string | undefined)[] =>
  GATEWAYS.map((gateway) => keys[gateway]?.key);

/**
 * A provider's location, looked up under its OpenRouter slug: Vercel's slug goes through the alias map. Go
 * names no provider, so its rows have none.
 */
const locationOf = (ep: Endpoint, { locations }: Context): Location | undefined =>
  gatewayOf(ep) === "opencode-go"
    ? undefined
    : locations?.get(gatewayOf(ep) === "openrouter" ? providerSlug(ep) : toOpenRouterSlug(ep.tag).toLowerCase());

/**
 * Whether an endpoint is zero-data-retention, or undefined when unknown: OpenRouter rows are looked up in
 * its ZDR list, which covers no other gateway, and Vercel rows carry their own flag.
 */
const zdrOf = (ep: Endpoint, slug: string, { zdr }: Context): boolean | undefined =>
  gatewayOf(ep) === "openrouter" ? zdr?.has(zdrKey(ep.model_id ?? slug, ep.tag)) : (ep.has_zdr ?? undefined);

/** The provider's slug on the other gateway, through the alias map. */
const aliasOf = (ep: Endpoint): string =>
  (gatewayOf(ep) === "openrouter" ? toVercelSlug(providerSlug(ep)) : toOpenRouterSlug(ep.tag)).toLowerCase();

/**
 * -p and -e match a provider by either gateway's spelling, as a substring like matchesProvider, so -p amazon
 * keeps Vercel's bedrock and -e togetherai drops OpenRouter's together as well as Vercel's togetherai.
 */
const matches = (ep: Endpoint, name: string): boolean =>
  matchesProvider(ep, name) || aliasOf(ep).includes(name.toLowerCase());

/**
 * What --pick prints for an endpoint: the bare tag on OpenRouter, `<gateway>:<route>` on any other gateway.
 * OpenRouter tags never contain ":", so each line parses unambiguously.
 */
export const routeOf = (ep: Endpoint): string =>
  gatewayOf(ep) === "openrouter" ? ep.tag : `${gatewayOf(ep)}:${ep.tag}`;

/** The gateway's id for the model: Go's is the endpoint's own tag. */
const modelOn = (ep: Endpoint, slug: string): string =>
  gatewayOf(ep) === "vercel" ? vercelModel(slug) : gatewayOf(ep) === "opencode-go" ? ep.tag : slug;

/** The pin as text: `model:tag` on OpenRouter, `<model> <gateway>:<route>` on another gateway, ending in --pick's line. */
const pinOf = (ep: Endpoint, slug: string): string =>
  gatewayOf(ep) === "openrouter" ? `${slug}:${ep.tag}` : `${modelOn(ep, slug)} ${routeOf(ep)}`;

/** The request field that pins an endpoint in its gateway's syntax, and its value; undefined for a row that can't be pinned. */
const routingOf = (ep: Endpoint, report: Report) =>
  !pinnable(ep)
    ? undefined
    : gatewayOf(ep) === "openrouter"
      ? { field: "provider", value: pinRouting(ep, report.endpoints) as object }
      : { field: "providerOptions", value: vercelRouting(ep) as object };

/** Where each mode's tool_choice support comes from. Another gateway's rows borrow OpenRouter's verdict or have none. */
function choiceSource(ep: Endpoint, report: Report): Record<string, string> {
  if (gatewayOf(ep) === "openrouter") return toolChoiceSource(probedFor(report.probed, ep));
  const source =
    ep.tool_choice_from !== undefined ? "openrouter" : ep.tool_choice_unverified ? "unverified" : "listing";
  return Object.fromEntries(TOOL_CHOICE_MODES.map((mode) => [mode, source]));
}

/**
 * Fetches a model's endpoints from every gateway this run lists. OpenRouter's are fetched whenever Vercel is
 * listed too, for the tool_choice verdicts its rows borrow. A gateway whose fetch fails is noted and the
 * others' rows rank alone; the report is an error only when every gateway failed.
 */
async function fetchRows(
  slug: string,
  ctx: Context,
): Promise<{ endpoints: Endpoint[]; malformed: number; errors: { gateway: Gateway; error: string }[] }> {
  const { gateways, auth, keys } = ctx;
  const none = Promise.resolve({ endpoints: [] as Endpoint[], malformed: 0 });
  const [openrouter, vercel, go] = await Promise.allSettled([
    gateways.includes("openrouter") || gateways.includes("vercel") ? fetchEndpoints(slug, auth) : none,
    gateways.includes("vercel") ? fetchVercelEndpoints(slug) : none,
    gateways.includes("opencode-go") ? fetchOpenCodeGoEndpoints(slug, keys["opencode-go"]!.key) : none,
  ]);
  const settled = { openrouter, vercel, "opencode-go": go };
  const verdicts = openrouter.status === "fulfilled" ? openrouter.value.endpoints : undefined;
  const failed = (gateway: Gateway, reason: unknown) => ({
    gateway,
    error: sanitize(errorMessage(reason), secretsOf(ctx)),
  });
  const endpoints: Endpoint[] = [];
  let malformed = 0;
  const errors: { gateway: Gateway; error: string }[] = [];
  for (const gateway of gateways) {
    const result = settled[gateway];
    if (result.status === "rejected") {
      errors.push(failed(gateway, result.reason));
      continue;
    }
    endpoints.push(
      ...(gateway === "vercel" ? borrowToolChoice(result.value.endpoints, verdicts) : result.value.endpoints),
    );
    malformed += result.value.malformed;
  }
  // Without OpenRouter's endpoints, Vercel's rows have no verdict to borrow; say why they are unverified.
  if (gateways.includes("vercel") && !gateways.includes("openrouter") && openrouter.status === "rejected") {
    errors.push(failed("openrouter", openrouter.reason));
  }
  return { endpoints, malformed, errors };
}

async function buildReport(slug: string, ctx: Context): Promise<Report> {
  const { options, gateways } = ctx;
  try {
    const { endpoints, malformed, errors } = await fetchRows(slug, ctx);
    // Only the listed gateways' failures can empty the report; OpenRouter's verdict fetch failing is a note.
    const failed = errors.filter(({ gateway }) => gateways.includes(gateway));
    if (failed.length === gateways.length) {
      throw new Error(
        openRouterOnly(gateways)
          ? failed[0]!.error
          : failed.map(({ gateway, error }) => `${gateway}: ${error}`).join("; "),
      );
    }
    const excludedBy = (ep: Endpoint) => [
      ...options.excludeProviders.filter((name) => matches(ep, name)).map((name) => `excluded: ${name}`),
      ...locationReasons(locationOf(ep, ctx), options.excludeCountries),
      ...(options.zdr && !zdrOf(ep, slug, ctx) ? [zdrOf(ep, slug, ctx) === undefined ? "ZDR unknown" : "not ZDR"] : []),
    ];
    const kept = (ep: Endpoint) => !options.providers.length || options.providers.some((name) => matches(ep, name));
    // Excluded providers, excluded countries and --zdr are hard constraints, so they apply before
    // ranking and can't set the price guard's baseline. The provider filter is
    // only a view: it applies after ranking so the guard still compares against
    // the whole tier.
    const probed = freshProbes(ctx.probes, slug, ctx.now.getTime());
    const ranked = rank(
      endpoints.filter((ep) => !excludedBy(ep).length),
      probed,
    ).filter(({ endpoint }) => kept(endpoint));
    const ineligible = endpoints
      .filter(kept)
      .map((endpoint) => ({
        endpoint,
        reasons: [...ineligibleReasons(endpoint, probedFor(probed, endpoint)), ...excludedBy(endpoint)],
      }))
      .filter(({ reasons }) => reasons.length);
    return {
      slug,
      total: endpoints.length,
      malformed,
      endpoints,
      ranked,
      ineligible,
      probed,
      ...(errors.length && { gatewayErrors: errors }),
    };
  } catch (error) {
    return {
      slug,
      error: sanitize(errorMessage(error), secretsOf(ctx)),
      total: 0,
      malformed: 0,
      endpoints: [],
      ranked: [],
      ineligible: [],
      probed: new Map(),
    };
  }
}

/**
 * Sends a report's paid requests: --verify first, since it decides the pick, then the audit in whatever is
 * left of the same time budget.
 */
async function sendProbes(report: Report, { options, auth, keys, auditBudget }: Context): Promise<Report> {
  const n = options.auditFallback;
  if (report.error || (!options.verify && n === undefined)) return report;
  // Probes on every gateway share one time budget.
  const deadline = Date.now() + VERIFY_BUDGET_MS;
  const verification =
    options.verify && report.ranked.length
      ? await verify(report.slug, report.ranked, report.endpoints, keys, deadline)
      : undefined;
  // --verify probes in the default mode, required, through each candidate's pin. Only OpenRouter probes are
  // stored, since the store is keyed by OpenRouter tag. The audit is unpinned, so it says nothing about any one
  // endpoint and is never stored.
  const stored = (verification?.probes ?? []).filter(({ endpoint }) => gatewayOf(endpoint) === "openrouter");
  if (stored.length)
    storeProbes(
      report.slug,
      stored.map((probe) => ({ probe, mode: "required" as const })),
    );
  const audit =
    n === undefined || !auth
      ? undefined
      : await auditFallback(report.slug, n, report.endpoints, auth, deadline, auditBudget);
  return { ...report, ...(verification && { verification }), ...(audit && { audit }) };
}

/** An optional charge in USD (per unit of `scale`): 0 when unlisted, undefined when listed but unreadable. */
const optionalRate = (rate: unknown, scale = 1): number | undefined =>
  rate == null || rate === "" ? 0 : typeof rate === "string" ? metric(Number(rate) * scale) : undefined;

/**
 * The most `n` unpinned requests can cost in USD: default routing may choose any endpoint, so take the highest
 * prices, including a flat per-request fee. undefined when an endpoint's prices can't bound it.
 */
function auditWorstCase(endpoints: readonly Endpoint[], n: number): number | undefined {
  let input = 0;
  let output = 0;
  let fee = 0;
  for (const { pricing } of endpoints) {
    const prompt = perMillion(pricing.prompt);
    const completion = perMillion(pricing.completion);
    const reasoning = optionalRate(pricing.internal_reasoning, 1_000_000);
    const request = optionalRate(pricing.request);
    if (prompt === undefined || completion === undefined || reasoning === undefined || request === undefined) {
      return undefined;
    }
    input = Math.max(input, prompt);
    output = Math.max(output, completion, reasoning);
    fee = Math.max(fee, request);
  }
  return n * ((AUDIT_PROMPT_TOKENS * input + PROBE_MAX_TOKENS * output) / 1_000_000 + fee);
}

/**
 * The pick: the first endpoint to serve under --verify, else the best ranked. A Go row ranks above price-eliminated
 * rows, but without a probe it is picked only when no other row is ranked.
 */
const pickOf = (report: Report): Endpoint | undefined =>
  report.verification
    ? report.verification.verified
    : (report.ranked.find(({ endpoint }) => pinnable(endpoint)) ?? report.ranked[0])?.endpoint;

const budgetNote = `--verify stops after ${VERIFY_BUDGET_MS / 60_000} minutes`;

function noPickReason(report: Report): string {
  if (report.error) return `fetch failed: ${report.error}`;
  if (report.verification) {
    const { probes, unprobed } = report.verification;
    const notes = [busyNote(report), haltNote(report), unprobed ? `${unprobed} not probed: ${budgetNote}` : ""].filter(
      Boolean,
    );
    return `no candidate served after ${probes.length} probe(s)${notes.length ? ` (${notes.join("; ")})` : ""}`;
  }
  return "no eligible endpoint";
}

/**
 * Names each gateway that refused the account and how many of its candidates were skipped; "" when none did.
 * The gateway's own message is in its probe's detail, printed once.
 */
function haltNote(report: Report): string {
  return (report.verification?.halted ?? [])
    .map(({ gateway, status, skipped }) => `${gateway} refused the account (HTTP ${status}), ${skipped} not probed`)
    .join("; ");
}

/** The probe with which each gateway refused the account. */
const refusals = (report: Report) => report.verification?.probes.filter(({ refused }) => refused !== undefined) ?? [];

/** Names the endpoints that were only busy when probed, since a re-run may pick one; "" when there are none. */
function busyNote(report: Report): string {
  const busy = report.verification?.probes.filter(({ busy }) => busy).map(({ endpoint }) => routeOf(endpoint)) ?? [];
  return busy.length ? `${busy.join(", ")} ${busy.length === 1 ? "was" : "were"} busy; re-run to retry` : "";
}

/** Notes the modes a fresh probe passed although the listing lacks them; "" when there are none. */
function probeNote(ep: Endpoint, probed: Probed | undefined): string {
  const { pass } = probeOverrides(ep, probed);
  return pass.length ? `probed: ${pass.join("/")} pass (listed no)` : "";
}

/** Whether a probe result contradicted the listing for any endpoint the report shows. */
const probeOverrode = (report: Report): boolean =>
  [...report.ranked, ...report.ineligible].some(({ endpoint }) => {
    const { pass, fail } = probeOverrides(endpoint, probedFor(report.probed, endpoint));
    return pass.length + fail.length > 0;
  });

// ---- Rendering --------------------------------------------------------------

const dash = (value: string | undefined): string => value ?? "-";
/** The probe that tested an endpoint in this report's --verify, if any. */
const probeOf = (report: Report, ep: Endpoint): Probe | undefined =>
  report.verification?.probes.find(({ endpoint }) => endpoint === ep);
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
  const filter = options.providers.length
    ? ` · provider ~ ${options.providers.map((name) => JSON.stringify(name)).join(", ")}`
    : "";
  if (report.error) return `\n## ${report.slug}${filter}\n  fetch failed: ${report.error}`;

  const count = !options.providers.length
    ? `${report.total - report.ineligible.length} of ${report.total}`
    : String(report.ranked.length);
  const lines = [`\n## ${report.slug}${filter} · ${count} eligible`];
  if (report.malformed)
    lines.push(`  (skipped ${report.malformed} malformed endpoint${report.malformed === 1 ? "" : "s"})`);
  for (const { gateway, error } of report.gatewayErrors ?? []) lines.push(`  ${gateway}: ${error}`);
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
    // One table across gateways: a gateway column follows # when more than one is listed.
    const multi = ctx.gateways.length > 1;
    if (multi) header.splice(2, 0, "gateway");
    const rows = report.ranked.map(({ endpoint: ep, cost, priceEliminated }, i) => [
      ep === pick ? "▶" : "",
      String(i + 1),
      ...(multi ? [gatewayOf(ep)] : []),
      ep.tag,
      ep.quantization && ep.quantization !== "unknown" ? ep.quantization : "?",
      ...fmtWhere(locationOf(ep, ctx)),
      fmtZdr(zdrOf(ep, report.slug, ctx)),
      fmtPct(ep.uptime_last_1d),
      fmtPct(ep.uptime_last_30m),
      fmtPct(ep.uptime_last_5m),
      fmtSeconds(turnMs(ep)),
      // Go publishes no latency, so its cell is --verify's measured time to the reply.
      fmtInt(ep.latency_last_30m?.p50 ?? probeOf(report, ep)?.ttfbMs),
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
      [
        priceEliminated ? "price-elim" : "",
        ep.tool_choice_unverified ? "tc?" : "",
        probeNote(ep, probedFor(report.probed, ep)),
      ]
        .filter(Boolean)
        .join("; "),
    ]);
    const numeric = [
      "#",
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
    ];
    lines.push(...table(header, rows, new Set(numeric.map((name) => header.indexOf(name)))));
  } else {
    lines.push(`  no eligible endpoint${options.providers.length ? ` matches ${options.providers.join(", ")}` : ""}`);
  }

  for (const { endpoint, ok, busy, detail } of report.verification?.probes ?? []) {
    lines.push(`  probe ${routeOf(endpoint)}: ${ok ? "ok" : busy ? "busy" : "FAILED"} (${detail})`);
  }
  if (pick) {
    const routing = routingOf(pick, report);
    const caveat = !pinnable(pick)
      ? " (not pinnable: Go names no provider)"
      : quantizationReported(pick)
        ? ""
        : " (quantization not reported)";
    lines.push(`  ${report.verification ? "verified pin" : "pin"}: ${pinOf(pick, report.slug)}${caveat}`);
    if (routing) lines.push(`  routing: "${routing.field}": ${JSON.stringify(routing.value)}`);
    const note = [busyNote(report), haltNote(report)].filter(Boolean).join("; ");
    if (note) lines.push(`  note: ${note}`);
  } else if (report.verification) {
    lines.push(`  ${noPickReason(report)}`);
  }

  if (report.ineligible.length) {
    lines.push(`  ineligible:`);
    const width = Math.max(...report.ineligible.map(({ endpoint }) => routeOf(endpoint).length));
    for (const { endpoint, reasons } of report.ineligible) {
      const zdr = fmtZdr(zdrOf(endpoint, report.slug, ctx));
      const listedYes = probeOverrides(endpoint, probedFor(report.probed, endpoint)).fail;
      const shown = reasons.map((reason) =>
        reason.startsWith("probed: ") && listedYes.length ? `${reason} (listed yes: ${listedYes.join("/")})` : reason,
      );
      lines.push(`    ${routeOf(endpoint).padEnd(width)}  zdr ${zdr}  ${shown.join("; ")}`);
    }
  }
  if (report.audit) lines.push(...renderAudit(report.audit));
  return lines.join("\n");
}

/** Dollars to the cent, or to a hundredth of a cent below ten cents. */
const fmtUsd = (usd: number): string => `$${usd.toFixed(usd >= 0.1 ? 2 : 4)}`;

/** What an audit spent, and how many of its requests reported no cost. */
const spent = ({ usd, uncosted }: Audit, where = ""): string =>
  `${fmtUsd(usd)} spent${where}${uncosted ? `, plus ${uncosted} request${uncosted === 1 ? "" : "s"} of unknown cost` : ""}`;

/** One row per provider and tier that served, most served first, with failed requests in one last row. */
function renderAudit(audit: Audit): string[] {
  const { samples, unsent } = audit;
  const lines = [
    `  audit: ${samples.length} unpinned requests, OpenRouter default routing; ` +
      "-p/-e/-x/--zdr not applied, account settings apply",
  ];
  const groups = new Map<
    string,
    { provider: string | null; tier: string | null; quant: string | null; served: number; invalid: number }
  >();
  for (const { provider, serviceTier, quantization, toolCallValid } of samples) {
    const key = JSON.stringify([provider, serviceTier]);
    const group = groups.get(key) ?? { provider, tier: serviceTier, quant: quantization, served: 0, invalid: 0 };
    group.served += 1;
    if (!toolCallValid) group.invalid += 1;
    groups.set(key, group);
  }
  const rows = [...groups.values()]
    .sort(
      (a, b) =>
        Number(a.provider === null) - Number(b.provider === null) ||
        b.served - a.served ||
        (a.provider ?? "").localeCompare(b.provider ?? "") ||
        (a.tier ?? "").localeCompare(b.tier ?? ""),
    )
    .map(({ provider, tier, quant, served, invalid }) => [
      provider ?? "(no response)",
      String(served),
      `${Math.round((100 * served) / samples.length)}%`,
      String(invalid),
      provider === null ? "" : (quant ?? "?"),
      provider === null ? "" : dash(tier ?? undefined),
    ]);
  if (rows.length) {
    lines.push(...table(["provider", "served", "share", "invalid", "quant", "tier"], rows, new Set([1, 2, 3])));
  }
  lines.push(`  audit: ${spent(audit)}, ${unsent} unsent`);
  return lines;
}

function reportJson(report: Report, ctx: Context) {
  const pick = pickOf(report);
  return {
    model: report.slug,
    ...(report.error === undefined ? {} : { error: report.error }),
    ...(report.gatewayErrors && { gatewayErrors: report.gatewayErrors }),
    pick: pick
      ? {
          pin: pinOf(pick, report.slug),
          gateway: gatewayOf(pick),
          model: modelOn(pick, report.slug),
          endpoint: pick.tag,
          provider: pick.provider_name,
          // The value of the request field the gateway reads: `provider` on OpenRouter, `providerOptions` on
          // Vercel, and null on Go, which can't pin.
          routing: routingOf(pick, report)?.value ?? null,
          verified: report.verification !== undefined,
          quantizationReported: quantizationReported(pick),
        }
      : null,
    ranked: report.ranked.map(({ endpoint: ep, cost, priceEliminated }, i) => {
      const location = locationOf(ep, ctx);
      return {
        rank: i + 1,
        gateway: gatewayOf(ep),
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
        pinnable: pinnable(ep),
        structuredOutputs: ep.supported_parameters.includes("structured_outputs"),
        reasoning: ep.supported_parameters.includes("reasoning"),
        reasoningEffort: ep.supported_parameters.includes("reasoning_effort"),
        toolChoiceVerified: !ep.tool_choice_unverified,
        toolChoiceSource: choiceSource(ep, report),
      };
    }),
    ineligible: report.ineligible.map(({ endpoint, reasons }) => ({
      gateway: gatewayOf(endpoint),
      endpoint: endpoint.tag,
      provider: endpoint.provider_name,
      zdr: zdrOf(endpoint, report.slug, ctx) ?? null,
      reasons,
      toolChoiceVerified: !endpoint.tool_choice_unverified,
      toolChoiceSource: choiceSource(endpoint, report),
    })),
    ...(report.verification && {
      probes: report.verification.probes.map(({ endpoint, ok, busy, detail, ttfbMs, cost }) => ({
        gateway: gatewayOf(endpoint),
        endpoint: endpoint.tag,
        ok,
        busy,
        detail,
        ttfbMs: ttfbMs ?? null,
        cost: cost ?? null,
      })),
      notProbed: report.verification.unprobed ?? 0,
      halted: report.verification.halted ?? [],
    }),
    audit: report.audit?.samples ?? null,
    auditUnsent: report.audit?.unsent ?? null,
    auditUsd: report.audit ? Number(report.audit.usd.toFixed(8)) : null,
    auditUncosted: report.audit?.uncosted ?? null,
  };
}

// ---- Main -------------------------------------------------------------------

const KEY_VARS: Record<Gateway, string> = {
  openrouter: "OPENROUTER_API_KEY",
  vercel: VERCEL_KEY_VAR,
  "opencode-go": OPENCODE_GO_KEY_VAR,
};

/**
 * The gateways this run lists. Listing needs a key only on Go; --verify needs the key of each gateway it
 * probes. A named gateway without it is a usage error (undefined, after printing why); --gateway all skips
 * it and says so on one stderr line.
 */
function resolveGateways(options: Options, keys: Context["keys"]): Gateway[] | undefined {
  const lacking = (gateway: Gateway) => !keys[gateway] && (gateway === "opencode-go" || options.verify);
  const needKey = (vars: string) => `${NAME}: --verify sends real requests and needs an API key; set ${vars}`;
  if (options.gateways !== "all") {
    const missing = options.gateways.filter(lacking);
    if (!missing.length) return options.gateways;
    if (missing.includes("opencode-go")) {
      console.error(`${NAME}: --gateway opencode-go needs ${OPENCODE_GO_KEY_VAR} to list Go's models`);
    }
    const others = missing.filter((gateway) => gateway !== "opencode-go");
    if (others.length) console.error(needKey(others.map((gateway) => KEY_VARS[gateway]).join(" and ")));
    return undefined;
  }
  const skipped = GATEWAYS.filter(lacking);
  if (skipped.length) {
    const why = skipped.map((gateway) => `${gateway} (no ${KEY_VARS[gateway]})`).join(", ");
    console.error(`${NAME}: --gateway all: skipping ${why}`);
  }
  const gateways = GATEWAYS.filter((gateway) => !lacking(gateway));
  if (gateways.length) return gateways;
  console.error(needKey(GATEWAYS.map((gateway) => KEY_VARS[gateway]).join(" or ")));
  return undefined;
}

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

  if (options.listModels) {
    console.log((await listModels()).join("\n"));
    return 0;
  }
  if (options.completions !== undefined) {
    if (options.completions !== "zsh") {
      console.error(`${NAME}: --completions supports only zsh, not ${JSON.stringify(options.completions)}`);
      return 2;
    }
    console.log(ZSH_COMPLETION.trimEnd());
    return 0;
  }

  const auth = resolveAuth();
  const keys: Context["keys"] = {
    openrouter: auth,
    vercel: resolveVercelAuth(process.env),
    "opencode-go": resolveOpenCodeGoAuth(process.env),
  };
  const gateways = resolveGateways(options, keys);
  if (gateways === undefined) return 2;
  if (options.auditFallback !== undefined && !auth) {
    console.error(`${NAME}: --audit-fallback sends real requests and needs an API key; set OPENROUTER_API_KEY`);
    return 2;
  }
  if (options.probe.length) {
    // Parsing allowed exactly one gateway, and a missing Go key has already exited.
    const gateway = gateways[0]!;
    if (!keys[gateway]) {
      console.error(`${NAME}: --probe sends real requests and needs an API key; set ${KEY_VARS[gateway]}`);
      return 2;
    }
    return (await probeTags(options.slugs[0]!, options.probe, gateway, keys)) ? 0 : 1;
  }
  if (!auth && gateways.includes("openrouter")) {
    console.error(
      `${NAME}: no API key found. OpenRouter hides latency and throughput from anonymous callers, ` +
        "so speed is not ranked. Set OPENROUTER_API_KEY.",
    );
  }

  // Reference data for the location and ZDR columns. A filter that needs it
  // can't run without it; otherwise its column just shows "?".
  const settle = <T>(lookup: Promise<T>) =>
    lookup.catch((error: unknown) => new Error(sanitize(errorMessage(error), secretsOf({ keys }))));
  // OpenRouter's ZDR list covers only its own endpoints.
  const [locations, zdr] = await Promise.all([
    settle(fetchLocations()),
    gateways.includes("openrouter") ? settle(fetchZdr()) : undefined,
  ]);
  const lookups = [
    {
      result: locations,
      what: "provider locations",
      flag: "--exclude-country",
      needed: options.excludeCountries.length > 0,
    },
    // With another gateway listed, --zdr still runs without OpenRouter's list: its rows are excluded as unknown.
    { result: zdr, what: "the ZDR endpoint list", flag: "--zdr", needed: options.zdr && openRouterOnly(gateways) },
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
    auditBudget: { usd: AUDIT_MAX_USD },
    options,
    gateways,
    auth,
    keys,
    locations: locations instanceof Error ? undefined : locations,
    zdr: zdr instanceof Error ? undefined : zdr,
    probes: loadProbes(probeStorePath()),
    now: new Date(),
  };
  const fetched = options.slugs.map((slug) => buildReport(slug, ctx));
  const n = options.auditFallback;
  if (n !== undefined) {
    // The audit's cost is bounded over every model before any paid request, --verify's included, is sent.
    const audited = (await Promise.all(fetched)).filter((report) => !report.error);
    // Default routing may choose an endpoint with no usable price, or one opp skipped as malformed, so neither can be bounded.
    const bounds = audited.map(({ endpoints, malformed }) => (malformed ? undefined : auditWorstCase(endpoints, n)));
    const unpriced = audited.filter((_, i) => bounds[i] === undefined);
    if (unpriced.length) {
      const slugs = unpriced.map(({ slug }) => slug).join(", ");
      console.error(`${NAME}: --audit-fallback: can't bound the cost of ${slugs}: an endpoint has no usable price`);
      return 2;
    }
    const usd = bounds.reduce((sum: number, bound) => sum + bound!, 0);
    const estimate = `up to ${fmtUsd(usd)} for ${n * audited.length} requests to ${audited.map(({ slug }) => slug).join(", ")}`;
    if (usd > AUDIT_MAX_USD) {
      console.error(`${NAME}: --audit-fallback: ${estimate}, over the ${fmtUsd(AUDIT_MAX_USD)} cap; ask for fewer`);
      return 2;
    }
    if (audited.length) console.error(`${NAME}: --audit-fallback: ${estimate}`);
  }
  const pending = fetched.map((next) => next.then((report) => sendProbes(report, ctx)));
  let ok = true;
  if (options.pick) {
    // stdout carries only tags, so `$(opp model --pick)` captures just the answer.
    for (const next of pending) {
      const report = await next;
      const pick = pickOf(report);
      // A gateway that failed left the comparison incomplete; stdout still carries only the pick.
      for (const { gateway, error } of report.gatewayErrors ?? []) {
        console.error(`${NAME}: ${report.slug}: ${gateway}: ${error}`);
      }
      // stdout has no probe lines, so a gateway's refusal is told here, once.
      for (const { endpoint, detail } of refusals(report)) {
        console.error(`${NAME}: ${report.slug}: ${gatewayOf(endpoint)}: ${detail}`);
      }
      if (pick) {
        console.log(routeOf(pick));
        // A script that builds `only: [tag]` from this alone would let the pin's siblings serve it.
        const { ignore } = gatewayOf(pick) === "openrouter" ? pinRouting(pick, report.endpoints) : {};
        if (ignore) {
          console.error(
            `${NAME}: ${report.slug}: pin needs ignore [${ignore.join(", ")}]; ` +
              "take routing from --json .models[].pick.routing",
          );
        }
        const note = busyNote(report);
        if (note) console.error(`${NAME}: ${report.slug}: picked ${routeOf(pick)}, but ${note}`);
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
          excludeProviders: options.excludeProviders,
          excludeCountries: options.excludeCountries,
          gateways,
          zdrOnly: options.zdr,
          models: reports.map((report) => reportJson(report, ctx)),
        },
        null,
        2,
      ),
    );
    // A script reading only stdout still sees what the audit spent.
    for (const { slug, audit } of reports) {
      if (audit) console.error(`${NAME}: --audit-fallback: ${spent(audit, ` on ${slug}`)}`);
    }
  } else {
    // The eligibility line says whether a probe overrode a listing, so it waits for every report.
    const reports = await Promise.all(pending);
    const sources = openRouterOnly(gateways) ? "" : ` (${gateways.join(", ")})`;
    const vercel = gateways.includes("vercel");
    const go = gateways.includes("opencode-go");
    console.log(
      `# ${sources ? "Endpoint" : "OpenRouter endpoint"} ranking · ${new Date().toISOString()} · ` +
        `auth: ${auth?.source ?? "anonymous"}`,
    );
    console.log(
      `# eligible${sources}: native tools, status 0, tool_choice ${TOOL_CHOICE_MODES.join("/")}` +
        (reports.some(probeOverrode) ? ", probe results override listings" : "") +
        (options.excludeProviders.length ? `, excluding ${options.excludeProviders.join(", ")}` : "") +
        (options.excludeCountries.length ? `, not in ${options.excludeCountries.join("/")}` : "") +
        (options.zdr ? ", ZDR only" : ""),
    );
    console.log(
      `# rank: uptime 1d > uptime 30m (>=${UPTIME_SATURATION}% ties; measured beats unreported) > ${vercel || go ? "verified tool_choice > " : ""}` +
        `priced > turn_s × ($run / cheapest $run)^${PRICE_WEIGHT} > ttfb × the same > quant > maxout > $run, ` +
        `price-elim last; turn_s = ttfb + ${TURN_OUTPUT_TOKENS} tokens at tok/s; $run counts as at least $${PRICE_FLOOR_USD}; ` +
        `quant fp4 < fp8 < ? (not reported) < bf16`,
    );
    console.log(
      `# price-elim: $run >${PRICE_ELIM_RATIO}x and >$${PRICE_ELIM_DELTA_USD} more than the cheapest ` +
        `top-uptime endpoint of equal or better quant; ranks after all others`,
    );
    console.log(
      `# prices: USD per million tokens; $run = ${REFERENCE_RUN.prompt / 1000}k in + ` +
        `${REFERENCE_RUN.cacheRead / 1_000_000}M cache read + ${REFERENCE_RUN.completion / 1000}k out`,
    );
    if (vercel) console.log("# vercel rows: up30m = uptime 1h, up5m = uptime 15m, ttfb and tok/s = 1h p50");
    if (go) console.log("# opencode-go rows: no listed stats; --verify fills ttfb, and its allowance is the cost");
    if (vercel || go) {
      console.log("# tc?: tool_choice listed without per-mode support or an OpenRouter verdict; --verify proves it");
    }
    for (const report of reports) {
      ok &&= pickOf(report) !== undefined;
      console.log(renderReport(report, ctx));
    }
    if (vercel || go) {
      const fees = [
        "OpenRouter adds 5.5% (min $0.80) to card credit purchases",
        ...(vercel ? ["Vercel AI Gateway adds no markup"] : []),
        ...(go ? ["OpenCode Go is a flat-rate subscription"] : []),
      ];
      console.log(`\n# fees: ${fees.join("; ")}. $run includes ${fees.length > 2 ? "none of them" : "neither"}.`);
    }
  }
  return ok ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(Bun.argv.slice(2));
