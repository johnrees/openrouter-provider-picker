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
 * Bun command line; src/policy.ts ranks, src/openrouter.ts fetches and
 * src/probe.ts sends the paid test requests.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { errorMessage, fetchEndpoints, fetchLocations, fetchZdr, sanitize, zdrKey } from "./src/openrouter.ts";
import {
  AUDIT_MAX_USD,
  AUDIT_PROMPT_TOKENS,
  type Audit,
  type Auth,
  COUNTRY,
  type Endpoint,
  ineligibleReasons,
  type Location,
  locationReasons,
  matchesProvider,
  metric,
  type Options,
  PRICE_ELIM_DELTA_USD,
  PRICE_ELIM_RATIO,
  perMillion,
  pinRouting,
  providerSlug,
  REFERENCE_RUN,
  type Report,
  rank,
  TOOL_CHOICE_MODES,
  TURN_OUTPUT_TOKENS,
  turnMs,
  UPTIME_SATURATION,
} from "./src/policy.ts";
import { auditFallback, PROBE_MAX_TOKENS, probe, VERIFY_BUDGET_MS, verify } from "./src/probe.ts";

/** The command name, as installed by package.json "bin". */
const NAME = "opp";
const SLUG = /^[a-z0-9][\w.-]*\/[a-z0-9][\w.:-]*$/i;
/** The most unpinned requests --audit-fallback sends per model. */
const AUDIT_MAX_REQUESTS = 50;

const USAGE = `Usage: ${NAME} <model/slug ...> [options]

Rank serving endpoints for each model and pick one to pin.

Models:
  model/slug ...                One or more models to rank, e.g. z-ai/glm-5.3

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
      --probe <tag>             With one model, send four paid requests to the
                                endpoint with this exact tag, whatever its
                                eligibility: tool_choice none, auto, required
                                and a named function. Repeatable. Exit 1 if any
                                mode fails or a tag is unknown.
      --audit-fallback <n>      Send n (1 to ${AUDIT_MAX_REQUESTS}) identical tool-call requests with
                                no routing preferences, one at a time after
                                --verify and within its 3 minutes, and show which
                                providers OpenRouter's default routing served and
                                how many tool calls were unusable. -p, -e, -x and
                                --zdr don't apply. Shows the worst-case cost first
                                and refuses over $${AUDIT_MAX_USD.toFixed(2)}; stops sending once the
                                spend reaches it. Never changes the pick.

Output:
      --json                    Print machine-readable results
      --pick                    Print only each model's chosen endpoint, one line
                                per model
  -h, --help                    Show this help

Auth: OPENROUTER_API_KEY, else opencode's stored OpenRouter credential.
Exit status: 0 if every model has a pick, 1 if any has none, 2 on usage errors.`;

// ---- Arguments --------------------------------------------------------------

/** A repeatable, comma-separated option's values, trimmed and deduplicated. An empty value is a usage error. */
function listValues(raw: string[] | undefined, what: string): string[] {
  const values = (raw ?? []).flatMap((list) => list.split(",")).map((value) => value.trim());
  if (values.includes("")) throw new Error(`${what} must not be empty`);
  return [...new Set(values)];
}

export function parseOptions(argv: string[]): Options {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      provider: { type: "string", short: "p", multiple: true },
      "exclude-provider": { type: "string", short: "e", multiple: true },
      "exclude-country": { type: "string", short: "x", multiple: true },
      zdr: { type: "boolean" },
      verify: { type: "boolean" },
      probe: { type: "string", multiple: true },
      "audit-fallback": { type: "string" },
      json: { type: "boolean" },
      pick: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.json && values.pick) throw new Error("--json and --pick are alternative outputs; give one");
  const slugs = positionals.filter((arg) => arg.includes("/"));
  const probe = (values.probe ?? []).map((tag) => tag.trim());
  if (probe.some((tag) => tag === "")) throw new Error("--probe needs an endpoint tag");
  const audit = values["audit-fallback"];
  if (audit !== undefined) {
    const n = /^\d+$/.test(audit) ? Number(audit) : NaN;
    if (!(n >= 1 && n <= AUDIT_MAX_REQUESTS))
      throw new Error(
        `--audit-fallback takes a whole number from 1 to ${AUDIT_MAX_REQUESTS}, not ${JSON.stringify(audit)}`,
      );
    if (values.pick) throw new Error("--audit-fallback can't be combined with --pick, whose output is only the pin");
  }
  if (probe.length) {
    if (values.verify || values.pick || values.json || audit !== undefined)
      throw new Error("--probe can't be combined with --verify, --audit-fallback, --pick or --json");
    if (slugs.length !== 1) throw new Error("--probe takes exactly one model slug");
  }
  const bareWord = positionals.find((arg) => !arg.includes("/"));
  if (bareWord !== undefined) throw new Error(`${bareWord}: not a model slug; did you mean -p ${bareWord}?`);
  const providers = listValues(values.provider, "provider filter");
  if (!slugs.length && !values.help) throw new Error("give at least one model slug, e.g. z-ai/glm-5.3");
  const badSlug = slugs.find((slug) => !SLUG.test(slug));
  if (badSlug !== undefined) throw new Error(`not a model slug: ${badSlug}`);
  const excludeProviders = listValues(values["exclude-provider"], "excluded provider");
  const excludeCountries = listValues(values["exclude-country"], "excluded country").map((code) => code.toUpperCase());
  const badCountry = excludeCountries.find((code) => !COUNTRY.test(code));
  if (badCountry !== undefined) throw new Error(`not a two-letter country code: ${JSON.stringify(badCountry)}`);
  return {
    slugs,
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
  };
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

/** Sends all four tool_choice modes to each named endpoint and prints a line per tag and mode. */
async function probeTags(slug: string, tags: readonly string[], auth: Auth): Promise<boolean> {
  let ok = true;
  let endpoints: Endpoint[];
  try {
    endpoints = (await fetchEndpoints(slug, auth)).endpoints;
  } catch (error) {
    console.error(`${NAME}: ${slug}: fetch failed: ${sanitize(errorMessage(error), auth.key)}`);
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
      const listed = found.supports_tool_choice?.[mode] === true ? "yes" : "no";
      const status = outcome.ok ? "ok" : outcome.busy ? "busy" : "fail";
      console.log(`${found.tag}  ${mode}  ${status}  listed: ${listed}  ${outcome.detail}`);
    }
  }
  return ok;
}

/** `auditBudget` is what the audits of every model may still spend, shared so the cap holds on actual spend. */
type Context = {
  options: Options;
  auth?: Auth;
  locations?: Map<string, Location>;
  zdr?: Set<string>;
  auditBudget?: { usd: number };
};

const locationOf = (ep: Endpoint, { locations }: Context): Location | undefined => locations?.get(providerSlug(ep));

/** Whether an endpoint is zero-data-retention, or undefined when the ZDR list is unavailable. */
const zdrOf = (ep: Endpoint, slug: string, { zdr }: Context): boolean | undefined =>
  zdr?.has(zdrKey(ep.model_id ?? slug, ep.tag));

async function buildReport(slug: string, ctx: Context): Promise<Report> {
  const { options, auth } = ctx;
  try {
    const { endpoints, malformed } = await fetchEndpoints(slug, auth);
    const excludedBy = (ep: Endpoint) => [
      ...options.excludeProviders.filter((name) => matchesProvider(ep, name)).map((name) => `excluded: ${name}`),
      ...locationReasons(locationOf(ep, ctx), options.excludeCountries),
      ...(options.zdr && !zdrOf(ep, slug, ctx) ? ["not ZDR"] : []),
    ];
    const kept = (ep: Endpoint) =>
      !options.providers.length || options.providers.some((name) => matchesProvider(ep, name));
    // Excluded providers, excluded countries and --zdr are hard constraints, so they apply before
    // ranking and can't set the price guard's baseline. The provider filter is
    // only a view: it applies after ranking so the guard still compares against
    // the whole tier.
    const ranked = rank(endpoints.filter((ep) => !excludedBy(ep).length)).filter(({ endpoint }) => kept(endpoint));
    const ineligible = endpoints
      .filter(kept)
      .map((endpoint) => ({ endpoint, reasons: [...ineligibleReasons(endpoint), ...excludedBy(endpoint)] }))
      .filter(({ reasons }) => reasons.length);
    return { slug, total: endpoints.length, malformed, endpoints, ranked, ineligible };
  } catch (error) {
    return {
      slug,
      error: sanitize(errorMessage(error), auth?.key),
      total: 0,
      malformed: 0,
      endpoints: [],
      ranked: [],
      ineligible: [],
    };
  }
}

/**
 * Sends a report's paid requests: --verify first, since it decides the pick, then the audit in whatever is
 * left of the same time budget.
 */
async function sendProbes(report: Report, { options, auth, auditBudget }: Context): Promise<Report> {
  const n = options.auditFallback;
  if (report.error || !auth || (!options.verify && n === undefined)) return report;
  const deadline = Date.now() + VERIFY_BUDGET_MS;
  const verification =
    options.verify && report.ranked.length
      ? await verify(report.slug, report.ranked, report.endpoints, auth, deadline)
      : undefined;
  const audit =
    n === undefined ? undefined : await auditFallback(report.slug, n, report.endpoints, auth, deadline, auditBudget);
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
    lines.push(`  no eligible endpoint${options.providers.length ? ` matches ${options.providers.join(", ")}` : ""}`);
  }

  for (const { endpoint, ok, busy, detail } of report.verification?.probes ?? []) {
    lines.push(`  probe ${endpoint.tag}: ${ok ? "ok" : busy ? "busy" : "FAILED"} (${detail})`);
  }
  if (pick) {
    lines.push(
      `  ${report.verification ? "verified pin" : "pin"}: ${report.slug}:${pick.tag}`,
      `  routing: "provider": ${JSON.stringify(pinRouting(pick, report.endpoints))}`,
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
    pick: pick
      ? {
          pin: `${report.slug}:${pick.tag}`,
          endpoint: pick.tag,
          provider: pick.provider_name,
          routing: pinRouting(pick, report.endpoints),
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
    audit: report.audit?.samples ?? null,
    auditUnsent: report.audit?.unsent ?? null,
    auditUsd: report.audit ? Number(report.audit.usd.toFixed(8)) : null,
    auditUncosted: report.audit?.uncosted ?? null,
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
  if (options.auditFallback !== undefined && !auth) {
    console.error(`${NAME}: --audit-fallback sends real requests and needs an API key; set OPENROUTER_API_KEY`);
    return 2;
  }
  if (options.probe.length) {
    if (!auth) {
      console.error(`${NAME}: --probe sends real requests and needs an API key; set OPENROUTER_API_KEY`);
      return 2;
    }
    return (await probeTags(options.slugs[0]!, options.probe, auth)) ? 0 : 1;
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
    auditBudget: { usd: AUDIT_MAX_USD },
    options,
    auth,
    locations: locations instanceof Error ? undefined : locations,
    zdr: zdr instanceof Error ? undefined : zdr,
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
      if (pick) {
        console.log(pick.tag);
        // A script that builds `only: [tag]` from this alone would let the pin's siblings serve it.
        const { ignore } = pinRouting(pick, report.endpoints);
        if (ignore) {
          console.error(
            `${NAME}: ${report.slug}: pin needs ignore [${ignore.join(", ")}]; ` +
              "take routing from --json .models[].pick.routing",
          );
        }
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
          excludeProviders: options.excludeProviders,
          excludeCountries: options.excludeCountries,
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
    console.log(`# OpenRouter endpoint ranking · ${new Date().toISOString()} · auth: ${auth?.source ?? "anonymous"}`);
    console.log(
      `# eligible: native tools, status 0, tool_choice ${TOOL_CHOICE_MODES.join("/")}` +
        (options.excludeProviders.length ? `, excluding ${options.excludeProviders.join(", ")}` : "") +
        (options.excludeCountries.length ? `, not in ${options.excludeCountries.join("/")}` : "") +
        (options.zdr ? ", ZDR only" : ""),
    );
    console.log(
      `# rank: uptime 1d > uptime 30m (>=${UPTIME_SATURATION}% ties) > turn_s > ttfb > quant > maxout > $run, ` +
        `price-elim last; turn_s = ttfb + ${TURN_OUTPUT_TOKENS} tokens at tok/s`,
    );
    console.log(
      `# price-elim: $run >${PRICE_ELIM_RATIO}x and >$${PRICE_ELIM_DELTA_USD} more than the cheapest ` +
        `top-uptime endpoint of equal or better quant; ranks after all others`,
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
