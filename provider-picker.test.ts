import { describe, expect, spyOn, test } from "bun:test";
import {
  type Endpoint,
  fmtRate,
  ineligibleReasons,
  locationReasons,
  main,
  matchesProvider,
  parseOptions,
  perMillion,
  pinRouting,
  rank,
  referenceRunCost,
  resolveAuth,
  sanitize,
  turnMs,
} from "./provider-picker.ts";

/** An eligible, fully up endpoint: $1/M in, $0.1/M cache read, $4/M out ($1.32 per reference run). */
function ep(tag: string, overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    provider_name: tag.split("/")[0]!,
    tag,
    status: 0,
    supported_parameters: ["tools", "tool_choice"],
    supports_tool_choice: { none: true, auto: true, required: true, function: true },
    uptime_last_1d: 100,
    uptime_last_30m: 100,
    latency_last_30m: { p50: 500 },
    throughput_last_30m: { p50: 100 },
    max_completion_tokens: 100_000,
    pricing: { prompt: "0.000001", input_cache_read: "0.0000001", completion: "0.000004" },
    ...overrides,
  };
}

const tags = (endpoints: Endpoint[]) => rank(endpoints).map(({ endpoint }) => endpoint.tag);

describe("parseOptions", () => {
  test("defaults", () => {
    expect(parseOptions(["z-ai/glm-5.3"])).toEqual({
      slugs: ["z-ai/glm-5.3"],
      provider: undefined,
      excludeCountries: [],
      zdr: false,
      verify: false,
      json: false,
      pick: false,
      help: false,
    });
  });

  test("words with a slash are models, a bare word is the provider filter", () => {
    const options = parseOptions(["z-ai/glm-5.3", "together", "--verify"]);
    expect(options.slugs).toEqual(["z-ai/glm-5.3"]);
    expect(options.provider).toBe("together");
    expect(options.verify).toBe(true);
  });

  test("--help needs no model", () => {
    expect(parseOptions(["--help"]).help).toBe(true);
  });

  test("country codes are split, uppercased and deduplicated", () => {
    expect(parseOptions(["m/x", "-x", "cn,ru", "--exclude-country", "CN"]).excludeCountries).toEqual(["CN", "RU"]);
  });

  test.each([
    [["--provider", "a", "b"], /at most one provider filter/],
    [["--provider", " "], /must not be empty/],
    [["../etc/passwd"], /not a model slug/],
    [["a/.."], /not a model slug/],
    [["m/x", "-x", "china"], /two-letter country code/],
    [["--json", "--pick"], /alternative outputs/],
    [[], /at least one model slug/],
    [["together"], /at least one model slug/],
    [["--nope"], /Unknown option/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseOptions(argv)).toThrow(message);
  });
});

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

  test("reference run is 500k in + 7M cache read + 30k out", () => {
    expect(referenceRunCost(ep("a"))).toBeCloseTo(0.5 + 0.7 + 0.12);
  });

  test("without a cache-read price, cached tokens bill at the input rate", () => {
    const noCache = ep("a", { pricing: { prompt: "0.000001", completion: "0.000004" } });
    expect(referenceRunCost(noCache)).toBeCloseTo(0.5 + 7 + 0.12);
  });

  test("display keeps integer zeros and avoids exponents", () => {
    expect(fmtRate("0.0001")).toBe("100");
    expect(fmtRate("0.00001")).toBe("10");
    expect(fmtRate("0.0000014")).toBe("1.4");
    expect(fmtRate("0.000000079")).toBe("0.079");
    expect(fmtRate("0.0012345")).toBe("1230");
    expect(fmtRate(undefined)).toBe("-");
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
    expect(pinRouting(ep("baseten/fp4/us"))).toEqual({ only: ["baseten/fp4/us"], allow_fallbacks: false });
  });
});

describe("secrets", () => {
  test("sanitize scrubs the key, key-shaped strings and control characters", () => {
    const secret = "custom-secret-123";
    const out = sanitize(`bad key ${secret}, also sk-or-v1-abcDEF_09\n\u001b[31mred\u0007`, secret);
    expect(out).toBe("bad key [redacted], also [redacted] [31mred");
  });

  test("sanitize scrubs before truncating, so a cut can't expose part of the key", () => {
    const secret = "x".repeat(50);
    const out = sanitize(`${"a".repeat(30)}${secret}`, secret, 40);
    expect(out).not.toContain("x");
  });

  test("resolveAuth prefers OPENROUTER_API_KEY and reports only its source", () => {
    expect(resolveAuth({ OPENROUTER_API_KEY: "  k  " })).toEqual({ key: "k", source: "OPENROUTER_API_KEY" });
  });

  test("resolveAuth finds nothing without a key or credential store", () => {
    expect(resolveAuth({ HOME: "/nonexistent" })).toBeUndefined();
    expect(resolveAuth({})).toBeUndefined();
  });
});

describe("main", () => {
  test("usage errors exit 2 and --help exits 0", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main(["--bogus"])).toBe(2);
      expect(await main([])).toBe(2);
      expect(await main(["--help"])).toBe(0);
      expect(log.mock.calls[0]?.[0]).toContain("--exclude-country");
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });
});

describe("command name", () => {
  test("package.json installs the script as opp, and it calls itself opp", async () => {
    const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json();
    expect(pkg.bin).toEqual({ opp: "./provider-picker.ts" });
    const error = spyOn(console, "error").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await main(["--help"]);
      await main(["--bogus"]);
      expect(log.mock.calls[0]?.[0]).toStartWith("Usage: opp ");
      expect(error.mock.calls[0]?.[0]).toStartWith("opp: ");
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });
});

describe("end to end against a mocked OpenRouter", () => {
  const KEY = "sk-or-v1-test-secret-key";
  // "together" ranks first on TTFB, so it is probed first.
  const endpoints = [
    ep("together", { provider_name: "Together" }),
    ep("wafer/us", { provider_name: "Wafer", latency_last_30m: { p50: 900 } }),
    ep("broken", { status: -2 }), // ZDR but ineligible: never ranked or probed
  ];

  /** Runs main against a fake OpenRouter whose router serves `servedBy(tag)` for each pinned probe. */
  /** OpenRouter's ZDR list for the mock: only wafer/us is zero-data-retention. null makes the lookup fail. */
  const ZDR_LIST = {
    data: [
      { model_id: "m/x", tag: "wafer/us" },
      { model_id: "m/x", tag: "broken" },
      { model_id: "n/y", tag: "wafer/us" },
    ],
  };

  async function run(
    servedBy: (tag: string) => string | undefined,
    argv = ["m/x", "--verify"],
    zdrList: unknown = ZDR_LIST,
  ) {
    const calls: { url: string; init: RequestInit }[] = [];
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/providers")) return json({ data: [] });
      if (url.endsWith("/endpoints/zdr"))
        return zdrList === null ? new Response("down", { status: 503 }) : json(zdrList);
      if (url.endsWith("/models/n/y/endpoints")) return json({ data: { endpoints: endpoints.slice(1) } });
      if (url.endsWith("/endpoints")) {
        await Bun.sleep(10); // m/x answers after n/y, so output order can't follow arrival order
        return json({ data: { endpoints } });
      }
      const served = servedBy(JSON.parse(String(init.body)).provider.only[0]);
      return json({
        ...(served && { provider: served }),
        choices: [{ finish_reason: "stop", message: { content: "OK" } }],
      });
    }) as unknown as typeof fetch);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const saved = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = KEY;
    try {
      const code = await main(argv);
      const stdout = log.mock.calls.flat().join("\n");
      const stderr = error.mock.calls.flat().join("\n");
      const output = `${stdout}\n${stderr}`;
      const probes = calls
        .filter(({ url }) => url.endsWith("/chat/completions"))
        .map(({ init }) => JSON.parse(String(init.body)));
      return { code, stdout, stderr, output, calls, probes };
    } finally {
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
      fetchMock.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
  }

  test("a probe served by a different provider is rejected and the walk continues", async () => {
    // The original bug: the router ignored the pin and Wafer served everything.
    const { code, output, probes } = await run(() => "Wafer");
    expect(probes.map(({ model, provider }) => ({ model, provider }))).toEqual([
      { model: "m/x", provider: { only: ["together"], allow_fallbacks: false } },
      { model: "m/x", provider: { only: ["wafer/us"], allow_fallbacks: false } },
    ]);
    expect(output).toContain("probe together: FAILED (served by Wafer)");
    expect(output).toContain("verified pin: m/x:wafer/us");
    expect(code).toBe(0);
  });

  test("a response with no provider is rejected, and no serving candidate exits 1", async () => {
    const { code, output, probes } = await run(() => undefined);
    expect(probes).toHaveLength(2);
    expect(output).toContain("served by an unknown provider");
    expect(output).toContain("no candidate served after 2 probe(s)");
    expect(output).not.toContain("verified pin");
    expect(code).toBe(1);
  });

  test("the key goes only where it is needed and is never printed", async () => {
    const { output, calls } = await run((tag) => (tag === "together" ? "Together" : undefined));
    expect(calls.every(({ init }) => init.redirect === "error")).toBe(true);
    const auth = (url: string) =>
      (calls.find((call) => call.url.endsWith(url))?.init.headers as Record<string, string>).Authorization;
    expect(auth("/providers")).toBeUndefined();
    expect(auth("/endpoints/zdr")).toBeUndefined();
    expect(auth("/endpoints")).toBe(`Bearer ${KEY}`);
    expect(output).not.toContain(KEY);
  });

  test("--pick prints only the chosen tag", async () => {
    const { code, stdout, probes } = await run(() => undefined, ["m/x", "--pick"]);
    expect(stdout).toBe("together");
    expect(probes).toHaveLength(0);
    expect(code).toBe(0);
  });

  test("--pick prints one line per model, in argument order", async () => {
    // n/y offers only wafer/us and its fetch finishes first.
    expect((await run(() => undefined, ["m/x", "n/y", "--pick"])).stdout).toBe("together\nwafer/us");
    expect((await run(() => undefined, ["n/y", "m/x", "--pick"])).stdout).toBe("wafer/us\ntogether");
  });

  test("--pick with --verify prints the verified tag", async () => {
    const { code, stdout } = await run(() => "Wafer", ["m/x", "--pick", "--verify"]);
    expect(stdout).toBe("wafer/us");
    expect(code).toBe(0);
  });

  test("--pick with no pick keeps stdout empty and explains on stderr", async () => {
    const { code, stdout, stderr } = await run(() => undefined, ["m/x", "--pick", "--verify"]);
    expect(stdout).toBe("");
    expect(stderr).toContain("m/x: no candidate served after 2 probe(s)");
    expect(code).toBe(1);
  });

  test("without --zdr, a faster non-ZDR endpoint still wins", async () => {
    const { stdout } = await run(() => undefined, ["m/x", "--pick"]);
    expect(stdout).toBe("together");
  });

  test("--zdr keeps only ZDR endpoints and lists the rest as ineligible", async () => {
    expect((await run(() => undefined, ["m/x", "--pick", "--zdr"])).stdout).toBe("wafer/us");
    const { stdout } = await run(() => undefined, ["m/x", "--zdr"]);
    expect(stdout).toMatch(/together +zdr - +not ZDR/);
    expect(stdout).toContain("ZDR only");
  });

  test("the zdr column shows each endpoint's status, or ? when the list is unavailable", async () => {
    // The table row's cells after the tag are quant, hq, dc, zdr.
    const zdrCell = (stdout: string, tag: string) => {
      const cells = stdout
        .split("\n")
        .find((line) => line.includes(` ${tag} `))!
        .trim()
        .split(/ +/);
      return cells[cells.indexOf(tag) + 4];
    };
    const shown = await run(() => undefined, ["m/x"]);
    expect(zdrCell(shown.stdout, "wafer/us")).toBe("Y");
    expect(zdrCell(shown.stdout, "together")).toBe("-");
    const unknown = await run(() => undefined, ["m/x"], null);
    expect(zdrCell(unknown.stdout, "wafer/us")).toBe("?");
    expect(unknown.stderr).toContain("ZDR endpoint list unavailable");
    expect(unknown.code).toBe(0);
  });

  test("--zdr fails rather than guessing when the ZDR list is unavailable", async () => {
    const { code, stdout, stderr } = await run(() => undefined, ["m/x", "--pick", "--zdr"], null);
    expect(stdout).toBe("");
    expect(stderr).toContain("cannot apply --zdr");
    expect(code).toBe(1);
  });

  test("--json reports zdr per endpoint", async () => {
    const { stdout } = await run(() => undefined, ["m/x", "--json"]);
    const ranked = JSON.parse(stdout).models[0].ranked as { endpoint: string; zdr: boolean | null }[];
    expect(Object.fromEntries(ranked.map(({ endpoint, zdr }) => [endpoint, zdr]))).toEqual({
      together: false,
      "wafer/us": true,
    });
  });

  test("ineligible endpoints show their ZDR status too", async () => {
    const text = await run(() => undefined, ["m/x"]);
    expect(text.stdout).toMatch(/broken +zdr Y +status -2/);
    const { models } = JSON.parse((await run(() => undefined, ["m/x", "--json"])).stdout);
    expect(models[0].ineligible).toEqual([
      { endpoint: "broken", provider: "broken", zdr: true, reasons: ["status -2"] },
    ]);
  });
});
