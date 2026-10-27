import { describe, expect, test } from "bun:test";
import { ep, fixtureRows } from "./fixtures.ts";
import { isEndpoint } from "./openrouter.ts";
import {
  type Endpoint,
  freshProbes,
  gatewayOf,
  ineligibleReasons,
  locationReasons,
  matchesProvider,
  PROBE_TTL_DAYS,
  perMillion,
  pinRouting,
  probedFor,
  quantizationReported,
  quantLevel,
  probeOverrides,
  rank,
  referenceRunCost,
  toolChoiceSource,
  turnMs,
} from "./policy.ts";

const tags = (endpoints: Endpoint[]) => rank(endpoints).map(({ endpoint }) => endpoint.tag);

describe("eligibility", () => {
  test("a complete endpoint is eligible", () => {
    expect(ineligibleReasons(ep("a"))).toEqual([]);
  });

  test("an absent status counts as 0", () => {
    expect(ineligibleReasons(ep("a", { status: undefined }))).toEqual([]);
  });

  test("lists every reason", () => {
    const broken = ep("a", {
      status: -2,
      supported_parameters: [],
      supports_tool_choice: { none: true, auto: true, required: "yes" },
    });
    expect(ineligibleReasons(broken)).toEqual(["status -2", "no native tools", "tool_choice lacks required/function"]);
  });
});

describe("probe results", () => {
  const listedNo = ep("cf", { supports_tool_choice: { none: true, auto: true, required: false, function: true } });
  const now = Date.parse("2026-10-24T00:00:00Z");
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

  test("a pass makes a listed-no mode eligible, and the endpoint can be picked", () => {
    expect(ineligibleReasons(listedNo, { required: "pass" })).toEqual([]);
    const faster = { ...listedNo, latency_last_30m: { p50: 100 } };
    expect(rank([ep("a"), faster]).map(({ endpoint }) => endpoint.tag)).toEqual(["a"]);
    expect(rank([ep("a"), faster], new Map([["cf", { required: "pass" as const }]]))[0]?.endpoint.tag).toBe("cf");
    expect(probeOverrides(listedNo, { required: "pass", auto: "pass" })).toEqual({ pass: ["required"], fail: [] });
  });

  test("a fail makes a listed-yes mode ineligible", () => {
    expect(ineligibleReasons(ep("a"), { required: "fail" })).toEqual(["probed: required fail"]);
    expect(ineligibleReasons(listedNo, { required: "fail", none: "fail" })).toEqual(["probed: none/required fail"]);
    expect(probeOverrides(ep("a"), { required: "fail" })).toEqual({ pass: [], fail: ["required"] });
  });

  test("a probe overrides only tool_choice", () => {
    const noTools = ep("a", { status: -2, supported_parameters: [] });
    expect(ineligibleReasons(noTools, { none: "pass", auto: "pass", required: "pass", function: "pass" })).toEqual([
      "status -2",
      "no native tools",
    ]);
  });

  test("results older than PROBE_TTL_DAYS are ignored", () => {
    const store = {
      "m/x": {
        cf: {
          required: { result: "pass" as const, at: daysAgo(PROBE_TTL_DAYS - 1) },
          none: { result: "fail" as const, at: daysAgo(PROBE_TTL_DAYS + 1) },
        },
        old: { auto: { result: "pass" as const, at: daysAgo(30) } },
      },
    };
    expect(freshProbes(store, "m/x", now)).toEqual(new Map([["cf", { required: "pass" }]]));
    expect(freshProbes(store, "n/y", now)).toEqual(new Map());
    expect(toolChoiceSource({ required: "pass" })).toEqual({
      none: "listing",
      auto: "listing",
      required: "probe",
      function: "listing",
    });
  });
});

describe("locations", () => {
  test("excludes by headquarters or any datacenter", () => {
    expect(locationReasons({ headquarters: "CN", datacenters: [] }, ["CN"])).toEqual(["headquartered in CN"]);
    expect(locationReasons({ headquarters: "SG", datacenters: ["SG", "CN"] }, ["CN"])).toEqual(["datacenter in CN"]);
  });

  test("keeps unknown locations and anything when nothing is excluded", () => {
    expect(locationReasons(undefined, ["CN"])).toEqual([]);
    expect(locationReasons({ headquarters: null, datacenters: null }, ["CN"])).toEqual([]);
    expect(locationReasons({ headquarters: "CN" }, [])).toEqual([]);
  });
});

describe("prices", () => {
  test("converts USD per token to USD per million", () => {
    expect(perMillion("0.0000014")).toBeCloseTo(1.4);
    expect(perMillion("0")).toBe(0);
    for (const bad of [undefined, null, "", " ", "abc", "-1"]) expect(perMillion(bad)).toBeUndefined();
  });

  test("reference run is 500k in + 15M cache read + 30k out", () => {
    expect(referenceRunCost(ep("a"))).toBeCloseTo(0.5 + 1.5 + 0.12);
  });

  test("without a cache-read price, cached tokens bill at the input rate", () => {
    const noCache = ep("a", { pricing: { prompt: "0.000001", completion: "0.000004" } });
    expect(referenceRunCost(noCache)).toBeCloseTo(0.5 + 15 + 0.12);
  });

  test("missing input or output price makes the cost unknown", () => {
    expect(referenceRunCost(ep("a", { pricing: { completion: "0.000004" } }))).toBeUndefined();
  });
});

describe("rank", () => {
  test("drops ineligible endpoints", () => {
    expect(tags([ep("good"), ep("bad", { status: -1 })])).toEqual(["good"]);
    expect(rank([ep("bad", { supported_parameters: [] })])).toEqual([]);
  });

  test("uptime at or above saturation ties, so speed decides", () => {
    const flawless = ep("flawless", { latency_last_30m: { p50: 900 } });
    const nearly = ep("nearly", { uptime_last_1d: 98.2, latency_last_30m: { p50: 300 } });
    expect(tags([flawless, nearly])).toEqual(["nearly", "flawless"]);
  });

  test("no traffic in 30 minutes is not worse than a measured failure", () => {
    const idle = ep("idle", { uptime_last_30m: null, latency_last_30m: { p50: 900 } });
    const failing = ep("failing", { uptime_last_1d: 99, uptime_last_30m: 50, latency_last_30m: { p50: 100 } });
    expect(tags([failing, idle])).toEqual(["idle", "failing"]);
  });

  test("without throughput, time to first token decides speed", () => {
    // Tags sort the other way, so only the TTFB key can put "z-quick" first.
    const quick = ep("z-quick", { throughput_last_30m: null, latency_last_30m: { p50: 200 } });
    const slow = ep("a-slow", { throughput_last_30m: null, latency_last_30m: { p50: 800 } });
    expect(tags([slow, quick])).toEqual(["z-quick", "a-slow"]);
  });

  test("below saturation, the 1-day window outranks the 30-minute one", () => {
    const steadyDay = ep("steady-day", { uptime_last_1d: 99, uptime_last_30m: 90 });
    const goodHalfHour = ep("good-half-hour", {
      uptime_last_1d: 95,
      uptime_last_30m: 100,
      latency_last_30m: { p50: 1 },
    });
    expect(tags([goodHalfHour, steadyDay])).toEqual(["steady-day", "good-half-hour"]);
  });

  test("speed combines time to first token and throughput", () => {
    // 300 tokens: 400 ms + 15 s versus 600 ms + 2 s.
    const quickStart = ep("quick-start", { latency_last_30m: { p50: 400 }, throughput_last_30m: { p50: 20 } });
    const fastStream = ep("fast-stream", { latency_last_30m: { p50: 600 }, throughput_last_30m: { p50: 150 } });
    expect(turnMs(fastStream)).toBe(2600);
    expect(tags([quickStart, fastStream])).toEqual(["fast-stream", "quick-start"]);
  });

  test("missing speed data sorts last, then headroom and price break ties", () => {
    const unknown = ep("unknown", { latency_last_30m: null, throughput_last_30m: null });
    const roomy = ep("roomy", { max_completion_tokens: 200_000 });
    const cheap = ep("cheap", {
      pricing: { prompt: "0.0000005", input_cache_read: "0.00000005", completion: "0.000002" },
    });
    expect(tags([unknown, ep("plain"), roomy, cheap])).toEqual(["roomy", "cheap", "plain", "unknown"]);
  });

  test("an endpoint both >2x and >$1 pricier than the cheapest reliable one ranks after all others", () => {
    const pricey = ep("pricey", {
      latency_last_30m: { p50: 1 },
      pricing: { prompt: "0.000003", input_cache_read: "0.0000003", completion: "0.000012" },
    });
    const flaky = ep("flaky", { uptime_last_1d: 80 });
    const flakyAndPricey = ep("flaky-pricey", { uptime_last_1d: 80, pricing: pricey.pricing });
    const ranked = rank([pricey, flakyAndPricey, flaky, ep("baseline")]);
    expect(ranked.map(({ endpoint }) => endpoint.tag)).toEqual(["baseline", "flaky", "pricey", "flaky-pricey"]);
    expect(ranked.map(({ priceEliminated }) => priceEliminated)).toEqual([false, false, true, true]);
  });

  test("the price guard needs both legs", () => {
    // 3x the price but only $0.26 more: noise.
    const smallBaseline = { prompt: "0.0000001", input_cache_read: "0.00000001", completion: "0.0000004" };
    const tripled = { prompt: "0.0000003", input_cache_read: "0.00000003", completion: "0.0000012" };
    expect(
      rank([ep("a", { pricing: smallBaseline }), ep("b", { pricing: tripled })]).some((r) => r.priceEliminated),
    ).toBe(false);
    // $1.20 more but under 2x.
    const almostDouble = { prompt: "0.000002", input_cache_read: "0.0000002", completion: "0.000004" };
    expect(rank([ep("a"), ep("b", { pricing: almostDouble })]).some((r) => r.priceEliminated)).toBe(false);
  });

  test("unknown prices are never the baseline and never eliminated", () => {
    const unpriced = ep("unpriced", { pricing: {} });
    const ranked = rank([unpriced, ep("a")]);
    expect(ranked.find(({ endpoint }) => endpoint === unpriced)?.priceEliminated).toBe(false);
    expect(ranked.map(({ endpoint }) => endpoint.tag)).toEqual(["a", "unpriced"]);
  });

  test("quantization orders fp4 < fp8 < unknown < bf16, grouping by bit width", () => {
    const level = (quantization?: string | null) => quantLevel(ep("a", { quantization }));
    expect([level("fp4"), level("nvfp4"), level("int4")]).toEqual([0, 0, 0]);
    expect([level("fp6"), level("fp8"), level("int8")]).toEqual([1, 1, 1]);
    expect([level("unknown"), level(null), level(undefined), level("constructor")]).toEqual([2, 2, 2, 2]);
    expect([level("bf16"), level("fp16"), level("FP32")]).toEqual([3, 3, 3]);
  });

  test("a quantization counts as reported only when QUANT_ORDER places it below or above unknown", () => {
    const reported = (quantization?: string | null) => quantizationReported(ep("a", { quantization }));
    expect([reported("fp4"), reported("FP8"), reported("bf16")]).toEqual([true, true, true]);
    expect([reported("unknown"), reported(null), reported(undefined), reported("constructor")]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  test("among rows equal on reliability and speed, higher quantization ranks first", () => {
    // Tag and headroom favour the lower row ("a-"), so only quantization can put the higher one first.
    const lower = (quantization: string | null) => ep("a-lower", { quantization, max_completion_tokens: 200_000 });
    const higher = (quantization: string | null) => ep("b-higher", { quantization });
    for (const [low, high] of [
      ["fp4", "fp8"],
      ["fp8", null],
      [null, "bf16"],
    ] as const) {
      expect(tags([lower(low), higher(high)])).toEqual(["b-higher", "a-lower"]);
    }
  });

  test("an unknown row's price baseline ignores cheaper fp8 and fp4 rows but not a cheaper bf16 row", () => {
    const pricey = { prompt: "0.000003", input_cache_read: "0.0000003", completion: "0.000012" };
    const unknown = ep("pricey-unknown", { pricing: pricey });
    const eliminated = (cheap: Endpoint) => rank([cheap, unknown]).at(-1)?.priceEliminated;
    expect(eliminated(ep("cheap-fp4", { quantization: "fp4" }))).toBe(false);
    expect(eliminated(ep("cheap-fp8", { quantization: "fp8" }))).toBe(false);
    expect(eliminated(ep("cheap-bf16", { quantization: "bf16" }))).toBe(true);
    expect(eliminated(ep("cheap-unknown"))).toBe(true);
  });

  test("the price guard compares a row only with equal or better quantization", () => {
    const pricey = { prompt: "0.000003", input_cache_read: "0.0000003", completion: "0.000012" };
    const cheapFp4 = ep("cheap-fp4", { quantization: "fp4" });
    const ranked = rank([
      cheapFp4,
      ep("pricey-fp4", { quantization: "fp4", pricing: pricey }),
      ep("pricey-fp8", { quantization: "fp8", pricing: pricey }),
    ]);
    const eliminated = Object.fromEntries(
      ranked.map(({ endpoint, priceEliminated }) => [endpoint.tag, priceEliminated]),
    );
    expect(eliminated).toEqual({ "cheap-fp4": false, "pricey-fp4": true, "pricey-fp8": false });
    // A cheap row of better quantization still sets the baseline.
    const cheapBf16 = ep("cheap-bf16", { quantization: "bf16" });
    expect(rank([cheapBf16, ep("pricey-fp8", { quantization: "fp8", pricing: pricey })]).at(-1)?.priceEliminated).toBe(
      true,
    );
  });

  test("a row with no equal-or-better quantization in the top tier is never price-eliminated", () => {
    const pricey = { prompt: "0.000003", input_cache_read: "0.0000003", completion: "0.000012" };
    const ranked = rank([
      ep("cheap-fp4", { quantization: "fp4" }),
      ep("flaky-pricey", { uptime_last_1d: 80, pricing: pricey }),
    ]);
    expect(ranked.some(({ priceEliminated }) => priceEliminated)).toBe(false);
  });

  test("on the fixture, unknown-quantization rows are measured against unknown-quantization rows", () => {
    const endpoints = fixtureRows.filter(isEndpoint);
    expect(endpoints).toHaveLength(fixtureRows.length);
    const ranked = rank(endpoints);
    const eliminated = ranked.filter(({ priceEliminated }) => priceEliminated).map(({ endpoint }) => endpoint.tag);
    // golf, hotel and india ($4.73) are over 2× and $1 above the cheapest fp4 row
    // ($1.25) but not above the cheapest unknown one, so they stay; kilo ($13.25) is.
    expect(eliminated.sort()).toEqual(["echo/fp4", "foxtrot/fp4", "juliet/fp8", "kilo"]);
    expect(ranked.map(({ endpoint }) => endpoint.tag)).toEqual([
      "golf",
      "hotel",
      "charlie/fp8",
      "delta/fp8",
      "alpha/fp4",
      "bravo/fp4",
      "india", // no 30-minute uptime: after every measured row of its tier, before lima's 97.4% day
      "lima",
      "kilo",
      "juliet/fp8",
      "echo/fp4",
      "foxtrot/fp4",
    ]);
  });

  test("full ties fall back to the tag, so output is deterministic", () => {
    expect(tags([ep("b"), ep("a")])).toEqual(["a", "b"]);
  });
});

describe("pinning", () => {
  test("the provider filter matches provider name or tag, case-insensitively", () => {
    const endpoint = ep("baseten/fp4/us", { provider_name: "BaseTen" });
    expect(matchesProvider(endpoint, "BASETEN")).toBe(true);
    expect(matchesProvider(endpoint, "fp4/us")).toBe(true);
    expect(matchesProvider(endpoint, "together")).toBe(false);
  });

  test("routing pins the exact endpoint with no fallback", () => {
    const endpoint = ep("baseten/fp4/us");
    expect(pinRouting(endpoint, [ep("baseten/fp4"), endpoint])).toEqual({
      only: ["baseten/fp4/us"],
      allow_fallbacks: false,
    });
  });

  test("routing ignores every longer tag the pin would match by prefix", () => {
    const list = [ep("fireworks"), ep("fireworks/spot"), ep("fireworks/fast"), ep("fireworks-ai"), ep("other")];
    expect(pinRouting(list[0]!, list)).toEqual({
      only: ["fireworks"],
      ignore: ["fireworks/fast", "fireworks/spot"],
      allow_fallbacks: false,
    });
    expect(pinRouting(list[1]!, list)).toEqual({ only: ["fireworks/spot"], allow_fallbacks: false });
    expect("ignore" in pinRouting(list[1]!, list)).toBe(false);
  });
});

describe("gateways", () => {
  const vercel = (tag: string, overrides: Partial<Endpoint> = {}) => ep(tag, { gateway: "vercel", ...overrides });

  test("an unverified row stays eligible and ranks after every verified row of its reliability tier only", () => {
    const unverified = vercel("fast", {
      supports_tool_choice: null,
      tool_choice_unverified: true,
      latency_last_30m: { p50: 50 },
    });
    const flaky = ep("flaky", { uptime_last_1d: 90 });
    expect(ineligibleReasons(unverified)).toEqual([]);
    expect(tags([flaky, unverified, ep("slow", { latency_last_30m: { p50: 2000 } })])).toEqual([
      "slow",
      "fast",
      "flaky",
    ]);
  });

  test("an unverified row never sets the price baseline, so it can't eliminate a verified row", () => {
    const cheap = { prompt: "0.0000001", input_cache_read: "0.00000001", completion: "0.0000004" };
    const unverified = vercel("cheap", { supports_tool_choice: null, tool_choice_unverified: true, pricing: cheap });
    const ranked = rank([unverified, ep("verified")]);
    expect(ranked.map(({ endpoint, priceEliminated }) => [endpoint.tag, priceEliminated])).toEqual([
      ["verified", false],
      ["cheap", false],
    ]);
    // A verified row still sets the baseline that an unverified row is measured against.
    const pricey = { prompt: "0.00001", input_cache_read: "0.000001", completion: "0.00004" };
    const priceyUnverified = { ...unverified, pricing: pricey };
    expect(rank([priceyUnverified, ep("verified")]).at(-1)?.priceEliminated).toBe(true);
    // A less reliable verified row is no baseline for the top tier, even when only unverified rows are in it.
    const flaky = ep("flaky", { uptime_last_1d: 80 });
    expect(
      rank([priceyUnverified, flaky]).map(({ endpoint, priceEliminated }) => [endpoint.tag, priceEliminated]),
    ).toEqual([
      ["cheap", false],
      ["flaky", false],
    ]);
    // Among unverified rows the guard still holds: a far pricier one ranks after a cheap one, though faster.
    const fastPricey = { ...priceyUnverified, tag: "fast-pricey", latency_last_30m: { p50: 50 } };
    expect(
      rank([fastPricey, unverified]).map(({ endpoint, priceEliminated }) => [endpoint.tag, priceEliminated]),
    ).toEqual([
      ["cheap", false],
      ["fast-pricey", true],
    ]);
  });

  test("a borrowed verdict names the OpenRouter provider it came from", () => {
    const borrowed = vercel("m", {
      supports_tool_choice: { none: true, auto: true, required: false, function: false },
      tool_choice_from: "m",
    });
    expect(ineligibleReasons(borrowed)).toEqual(["tool_choice lacks required/function (from openrouter m)"]);
  });

  test("stored probes apply to OpenRouter rows only, though tags can match across gateways", () => {
    const probed = new Map([["a", { required: "fail" as const }]]);
    expect(probedFor(probed, ep("a"))).toEqual({ required: "fail" });
    expect(probedFor(probed, vercel("a"))).toBeUndefined();
    expect(rank([ep("a"), vercel("a")], probed).map(({ endpoint }) => gatewayOf(endpoint))).toEqual(["vercel"]);
  });

  test("full ties break on tag, then gateway", () => {
    const ranked = rank([vercel("a"), ep("b"), ep("a", { gateway: "openrouter" })]);
    expect(ranked.map(({ endpoint }) => `${gatewayOf(endpoint)}:${endpoint.tag}`)).toEqual([
      "openrouter:a",
      "vercel:a",
      "openrouter:b",
    ]);
  });

  test("an OpenRouter pin's ignore list comes from OpenRouter rows only", () => {
    const pick = ep("fireworks");
    expect(pinRouting(pick, [pick, vercel("fireworks/x"), ep("fireworks/fast")])).toEqual({
      only: ["fireworks"],
      ignore: ["fireworks/fast"],
      allow_fallbacks: false,
    });
  });
});

describe("an unreported 30-minute window", () => {
  // A quiet endpoint has no 30-minute uptime, so its clean day stands in and it
  // ties a busy one; before this key it then won on a faster first token.
  const busy = ep("busy", { uptime_last_30m: 100, latency_last_30m: { p50: 900 } });
  const quiet = ep("quiet", { uptime_last_30m: undefined, latency_last_30m: { p50: 300 } });

  test("loses the tie to a measured clean half hour, whatever the speed", () => {
    expect(tags([quiet, busy])).toEqual(["busy", "quiet"]);
  });

  test("still ranks above a measured failure", () => {
    const failing = ep("failing", { uptime_last_30m: 90, latency_last_30m: { p50: 100 } });
    expect(tags([failing, quiet])).toEqual(["quiet", "failing"]);
  });
});
