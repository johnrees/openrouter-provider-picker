import { describe, expect, test } from "bun:test";
import { ep, fixtureRows } from "./fixtures.ts";
import { isEndpoint } from "./openrouter.ts";
import {
  type Endpoint,
  ineligibleReasons,
  locationReasons,
  matchesProvider,
  perMillion,
  pinRouting,
  quantLevel,
  rank,
  referenceRunCost,
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

  test("quantization orders fp4 < fp8 < bf16 < unknown, grouping by bit width", () => {
    const level = (quantization?: string | null) => quantLevel(ep("a", { quantization }));
    expect([level("fp4"), level("nvfp4"), level("int4")]).toEqual([0, 0, 0]);
    expect([level("fp6"), level("fp8"), level("int8")]).toEqual([1, 1, 1]);
    expect([level("bf16"), level("fp16"), level("FP32")]).toEqual([2, 2, 2]);
    expect([level("unknown"), level(null), level(undefined), level("constructor")]).toEqual([3, 3, 3, 3]);
  });

  test("among rows equal on reliability and speed, higher quantization ranks first", () => {
    // Tags, headroom and price all favour the fp4 row, so only quantization can put fp8 first.
    const fp4 = ep("a-fp4", { quantization: "fp4", max_completion_tokens: 200_000 });
    const fp8 = ep("b-fp8", { quantization: "fp8" });
    expect(tags([fp4, fp8])).toEqual(["b-fp8", "a-fp4"]);
    expect(tags([fp8, ep("c-unknown")])).toEqual(["c-unknown", "b-fp8"]);
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
      "india",
      "charlie/fp8",
      "delta/fp8",
      "alpha/fp4",
      "bravo/fp4",
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
