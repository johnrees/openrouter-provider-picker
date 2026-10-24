import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Endpoint,
  fmtRate,
  ineligibleReasons,
  isEndpoint,
  locationReasons,
  main,
  matchesProvider,
  parseOptions,
  perMillion,
  pinRouting,
  rank,
  referenceRunCost,
  resolveAuth,
  retryDelay,
  sanitize,
  turnMs,
} from "./provider-picker.ts";

/** An eligible, fully up endpoint: $1/M in, $0.1/M cache read, $4/M out ($2.12 per reference run). */
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
      excludeProviders: [],
      excludeCountries: [],
      zdr: false,
      verify: false,
      probe: [],
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

  test("excluded providers are split, trimmed and deduplicated", () => {
    expect(parseOptions(["m/x", "-e", "a, b", "--exclude-provider", "b", "-e", "c"]).excludeProviders).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test.each([
    [["m/x", "-e", ""], /excluded provider must not be empty/],
    [["m/x", "-e", "a,,b"], /excluded provider must not be empty/],
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

  test("reference run is 500k in + 15M cache read + 30k out", () => {
    expect(referenceRunCost(ep("a"))).toBeCloseTo(0.5 + 1.5 + 0.12);
  });

  test("without a cache-read price, cached tokens bill at the input rate", () => {
    const noCache = ep("a", { pricing: { prompt: "0.000001", completion: "0.000004" } });
    expect(referenceRunCost(noCache)).toBeCloseTo(0.5 + 15 + 0.12);
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

  test("resolveAuth reads opencode's stored OpenRouter key, and only a key envelope", () => {
    const dataHome = mkdtempSync(join(tmpdir(), "opp-test-"));
    try {
      mkdirSync(join(dataHome, "opencode"));
      const db = new Database(join(dataHome, "opencode", "opencode.db"));
      db.run("create table credential (label text, active integer, value text)");
      const store = (value: string) => {
        db.run("delete from credential");
        db.run("insert into credential values ('OpenRouter', 1, ?)", [value]);
      };
      store(JSON.stringify({ type: "key", key: " sk-or-v1-stored " }));
      expect(resolveAuth({ XDG_DATA_HOME: dataHome })).toEqual({
        key: "sk-or-v1-stored",
        source: "opencode credential store",
      });
      store(JSON.stringify({ type: "oauth", access: "token" }));
      expect(resolveAuth({ XDG_DATA_HOME: dataHome })).toBeUndefined();
      store("not json");
      expect(resolveAuth({ XDG_DATA_HOME: dataHome })).toBeUndefined();
      db.run("drop table credential");
      db.close();
      expect(resolveAuth({ XDG_DATA_HOME: dataHome })).toBeUndefined();
    } finally {
      rmSync(dataHome, { recursive: true, force: true });
    }
  });

  test("endpoints whose printed fields carry control characters are malformed", () => {
    expect(isEndpoint(ep("ok"))).toBe(true);
    expect(isEndpoint(ep("ok", { quantization: "fp8" }))).toBe(true);
    expect(isEndpoint(ep("ok", { quantization: "fp8\u001b[2J" }))).toBe(false);
    expect(isEndpoint(ep("ok", { service_tier: "priority" }))).toBe(true);
    expect(isEndpoint(ep("ok", { service_tier: "priority\u001b[2J" }))).toBe(false);
    expect(isEndpoint(ep("ok", { service_tier: 1 as unknown as string }))).toBe(false);
    expect(isEndpoint(ep("ok", { status: "0\u001b[2J" as unknown as number }))).toBe(false);
    expect(isEndpoint(ep("bad\ntag"))).toBe(false);
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

  /** OpenRouter's ZDR list for the mock: only wafer/us is zero-data-retention. null makes the lookup fail. */
  const ZDR_LIST = {
    data: [
      { model_id: "m/x", tag: "wafer/us" },
      { model_id: "m/x", tag: "broken" },
      { model_id: "n/y", tag: "wafer/us" },
    ],
  };

  /**
   * Runs main against a fake OpenRouter whose router answers each pinned probe
   * as `servedBy(tag)`: a provider name, a raw Response, or no provider.
   */
  /** A successful probe reply: the forced call to the probe's tool. */
  const TOOL_CALL = {
    finish_reason: "tool_calls",
    message: { tool_calls: [{ type: "function", function: { name: "ok", arguments: "{}" } }] },
  };

  async function run(
    servedBy: (tag: string) => string | Response | undefined,
    argv = ["m/x", "--verify"],
    zdrList: unknown = ZDR_LIST,
    { list = endpoints, providers = [] as unknown[] } = {},
  ) {
    const calls: { url: string; init: RequestInit }[] = [];
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/providers")) return json({ data: providers });
      if (url.endsWith("/endpoints/zdr"))
        return zdrList === null ? new Response("down", { status: 503 }) : json(zdrList);
      if (url.endsWith("/models/n/y/endpoints")) return json({ data: { endpoints: endpoints.slice(1) } });
      if (url.endsWith("/endpoints")) {
        await Bun.sleep(10); // m/x answers after n/y, so output order can't follow arrival order
        return json({ data: { endpoints: list } });
      }
      const served = servedBy(JSON.parse(String(init.body)).provider.only[0]);
      if (served instanceof Response) return served;
      return json({
        ...(served && { provider: served }),
        choices: [TOOL_CALL],
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

  /** A rate limit or overload that asks for no wait, so the retry is immediate. */
  const busy = (status = 429) =>
    new Response(JSON.stringify({ error: { message: "Provider returned error", code: status } }), {
      status,
      headers: { "Retry-After": "0" },
    });

  test.each([408, 429, 500, 502, 503, 504])(
    "a probe busy once with HTTP %d is retried and keeps the pin",
    async (status) => {
      let calls = 0;
      const { code, output, probes } = await run((tag) =>
        tag === "together" && calls++ === 0 ? busy(status) : "Together",
      );
      expect(probes.map(({ provider }) => provider.only[0])).toEqual(["together", "together"]);
      expect(output).toContain("probe together: ok (served by Together, finish=tool_calls, after a retry)");
      expect(output).toContain("verified pin: m/x:together");
      expect(output).not.toContain("busy;");
      expect(code).toBe(0);
    },
  );

  test("a probe still busy after its retry is reported as busy, not failed", async () => {
    const { code, output, probes } = await run((tag) => (tag === "together" ? busy() : "Wafer"));
    expect(probes.map(({ provider }) => provider.only[0])).toEqual(["together", "together", "wafer/us"]);
    expect(output).toContain("probe together: busy (HTTP 429 Provider returned error, retried)");
    expect(output).toContain("verified pin: m/x:wafer/us");
    expect(output).toContain("note: together was busy; re-run to retry");
    expect(code).toBe(0);
  });

  test("a rate limit reported in a 200 body is busy too", async () => {
    const limited = () => new Response(JSON.stringify({ error: { message: "Rate limited", code: 429 } }));
    const { output } = await run((tag) => (tag === "together" ? limited() : "Wafer"));
    expect(output).toContain("probe together: busy (HTTP 429 Rate limited, retried)");
  });

  test("the probe forces a tool call, and a text reply fails it", async () => {
    const text = () =>
      new Response(
        JSON.stringify({ provider: "Together", choices: [{ finish_reason: "stop", message: { content: "OK" } }] }),
      );
    const { output, probes } = await run((tag) => (tag === "together" ? text() : "Wafer"));
    expect(probes[0]).toMatchObject({ tool_choice: "required", tools: [{ function: { name: "ok" } }] });
    expect(output).toContain("probe together: FAILED (no ok tool call despite tool_choice required, finish=stop)");
    expect(output).toContain("verified pin: m/x:wafer/us");
  });

  test.each([
    ["truncated arguments", "length", "{"],
    ["arguments that are not JSON", "tool_calls", "ok"],
    ["arguments that are not an object", "tool_calls", "[]"],
    ["a call cut off at max_tokens", "length", "{}"],
  ])("a tool call with %s fails the probe", async (_, finish, args) => {
    const call = () =>
      new Response(
        JSON.stringify({
          provider: "Together",
          choices: [
            { finish_reason: finish, message: { tool_calls: [{ function: { name: "ok", arguments: args } }] } },
          ],
        }),
      );
    const { output } = await run((tag) => (tag === "together" ? call() : "Wafer"));
    expect(output).toContain(`probe together: FAILED (unusable ok tool call, finish=${finish})`);
    expect(output).toContain("verified pin: m/x:wafer/us");
  });

  test("--verify stops starting probes when its time budget runs out", async () => {
    let now = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => (now += 100_000)); // 100s per reading
    try {
      const { code, output, probes, stdout } = await run(() => undefined);
      expect(probes).toHaveLength(1);
      expect(output).toContain("no candidate served after 1 probe(s) (1 not probed: --verify stops after 3 minutes)");
      expect(code).toBe(1);
      const json = await run(() => undefined, ["m/x", "--json", "--verify"]);
      expect(JSON.parse(json.stdout).models[0].notProbed).toBe(1);
      expect(stdout).not.toContain("verified pin");
    } finally {
      clock.mockRestore();
    }
  });

  test("a hard failure is not retried", async () => {
    const gone = () => new Response(JSON.stringify({ error: { message: "No allowed providers" } }), { status: 404 });
    const { output, probes } = await run((tag) => (tag === "together" ? gone() : "Wafer"));
    expect(probes.map(({ provider }) => provider.only[0])).toEqual(["together", "wafer/us"]);
    expect(output).toContain("probe together: FAILED (HTTP 404 No allowed providers)");
    expect(output).not.toContain("busy");
  });

  test("--pick names skipped busy endpoints on stderr; --json marks them", async () => {
    const picked = await run((tag) => (tag === "together" ? busy() : "Wafer"), ["m/x", "--pick", "--verify"]);
    expect(picked.stdout).toBe("wafer/us");
    expect(picked.stderr).toContain("m/x: picked wafer/us, but together was busy; re-run to retry");
    const { stdout } = await run(() => busy(), ["m/x", "--json", "--verify"]);
    const probes = JSON.parse(stdout).models[0].probes;
    expect(probes.map(({ busy }: { busy: boolean }) => busy)).toEqual([true, true]);
  });

  test("Retry-After sets the retry wait, capped, with a default when absent or a date", () => {
    expect(retryDelay("0")).toBe(0);
    expect(retryDelay("3")).toBe(3_000);
    expect(retryDelay("120")).toBe(10_000);
    expect(retryDelay(null)).toBe(2_000);
    expect(retryDelay("")).toBe(2_000);
    expect(retryDelay("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(2_000);
  });

  describe("a provider with tier and sibling endpoints", () => {
    // "fireworks" ranks first. Its pin would match both longer tags, the
    // ineligible priority tier among them.
    const list = [
      ep("fireworks", { latency_last_30m: { p50: 100 } }),
      ep("fireworks/spot"),
      ep("fireworks/fast", { status: -1, service_tier: "priority" }),
    ];
    const pinned = { only: ["fireworks"], ignore: ["fireworks/fast", "fireworks/spot"], allow_fallbacks: false };
    const reply = (tier: string) =>
      new Response(JSON.stringify({ provider: "Fireworks", service_tier: tier, choices: [TOOL_CALL] }));

    test("the probe ignores the siblings, and a reply from the wrong tier fails it", async () => {
      const { code, output, probes } = await run(
        (tag) => reply(tag === "fireworks" ? "priority" : "default"),
        undefined,
        ZDR_LIST,
        { list },
      );
      expect(probes.map(({ provider }) => provider)).toEqual([
        pinned,
        { only: ["fireworks/spot"], allow_fallbacks: false },
      ]);
      expect(output).toContain("probe fireworks: FAILED (served at tier priority, expected default)");
      expect(output).toContain("probe fireworks/spot: ok");
      expect(output).toContain(
        `routing: "provider": ${JSON.stringify({ only: ["fireworks/spot"], allow_fallbacks: false })}`,
      );
      expect(code).toBe(0);
    });

    test("the printed routing matches the probe's, even for siblings filtered out", async () => {
      const verified = await run(() => reply("default"), ["m/x", "--json", "--verify"], ZDR_LIST, { list });
      expect(verified.probes[0].provider).toEqual(pinned);
      expect(JSON.parse(verified.stdout).models[0].pick.routing).toEqual(pinned);
      // --zdr drops both siblings from the ranking, but OpenRouter could still route to them.
      const zdrList = { data: [{ model_id: "m/x", tag: "fireworks" }] };
      const { stdout } = await run(() => undefined, ["m/x", "--zdr"], zdrList, { list });
      expect(stdout).toContain(`routing: "provider": ${JSON.stringify(pinned)}`);
    });

    test("a tier endpoint served at its own tier passes", async () => {
      const fast = ep("fireworks/fast", { service_tier: "priority", latency_last_30m: { p50: 50 } });
      const { output, probes } = await run(() => reply("priority"), undefined, ZDR_LIST, {
        list: [list[0]!, list[1]!, fast],
      });
      expect(probes.map(({ provider }) => provider.only[0])).toEqual(["fireworks/fast"]);
      expect(output).toContain("verified pin: m/x:fireworks/fast");
    });

    test("--pick prints the bare tag and warns on stderr that the pin needs ignore", async () => {
      const { code, stdout, stderr } = await run(() => undefined, ["m/x", "--pick"], ZDR_LIST, { list });
      expect(stdout).toBe("fireworks");
      expect(stderr).toBe(
        "opp: m/x: pin needs ignore [fireworks/fast, fireworks/spot]; take routing from --json .models[].pick.routing",
      );
      expect(code).toBe(0);
      const plain = await run(() => undefined, ["m/x", "--pick"]);
      expect(plain.stdout).toBe("together");
      expect(plain.stderr).not.toContain("pin needs ignore");
    });
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

  test("-x drops providers by headquarters or datacenter and says why", async () => {
    const providers = [{ slug: "together", headquarters: "US", datacenters: ["US", "RU"] }];
    expect((await run(() => undefined, ["m/x", "--pick", "-x", "RU"], ZDR_LIST, { providers })).stdout).toBe(
      "wafer/us",
    );
    const { stdout } = await run(() => undefined, ["m/x", "-x", "RU"], ZDR_LIST, { providers });
    expect(stdout).toMatch(/together .*datacenter in RU/);
  });

  test("-e excludes the top endpoint: it is never picked, probed or ranked", async () => {
    expect((await run(() => undefined, ["m/x", "--pick", "-e", "TOGETHER"])).stdout).toBe("wafer/us");
    const { stdout } = await run(() => undefined, ["m/x", "-e", "together"]);
    expect(stdout).toMatch(/together .*excluded: together/);
    expect(stdout).toContain(", excluding together");
    const { probes } = await run(
      (tag) => (tag === "wafer/us" ? "Wafer" : undefined),
      ["m/x", "--verify", "-e", "together"],
    );
    expect(probes.map(({ provider }) => provider.only[0])).toEqual(["wafer/us"]);
    const json = JSON.parse((await run(() => undefined, ["m/x", "--json", "-e", "together"])).stdout);
    expect(json.excludeProviders).toEqual(["together"]);
    expect(json.models[0].ranked.map(({ endpoint }: { endpoint: string }) => endpoint)).toEqual(["wafer/us"]);
    expect(json.models[0].ineligible).toContainEqual(
      expect.objectContaining({ endpoint: "together", reasons: ["excluded: together"] }),
    );
  });

  test("-e removes the excluded endpoint from the price guard's baseline", async () => {
    const cheap = { prompt: "0.000001", input_cache_read: "0.0000001", completion: "0.000004" };
    const costly = { prompt: "0.00001", input_cache_read: "0.000001", completion: "0.00004" };
    const list = [
      ep("cheap", { pricing: cheap }),
      ep("costly", { pricing: costly }),
      ep("flaky", { pricing: cheap, uptime_last_1d: 90, uptime_last_30m: 90 }),
    ];
    expect((await run(() => undefined, ["m/x", "--pick"], ZDR_LIST, { list })).stdout).toBe("cheap");
    expect((await run(() => undefined, ["m/x", "--pick", "-e", "cheap"], ZDR_LIST, { list })).stdout).toBe("costly");
  });

  test("-e wins over -p when an endpoint matches both", async () => {
    const { code, stdout } = await run(() => undefined, ["m/x", "--pick", "-p", "together", "-e", "together"]);
    expect(stdout).toBe("");
    expect(code).toBe(1);
  });

  test("-p only filters the view: the price guard still compares against every endpoint", async () => {
    const pricey = ep("pricey", {
      pricing: { prompt: "0.00001", input_cache_read: "0.000001", completion: "0.00004" },
    });
    const list = [ep("cheap"), pricey];
    const { stdout } = await run(() => undefined, ["m/x", "--json", "-p", "pricey"], ZDR_LIST, { list });
    const ranked = JSON.parse(stdout).models[0].ranked;
    expect(ranked.map(({ endpoint }: { endpoint: string }) => endpoint)).toEqual(["pricey"]);
    expect(ranked[0].priceEliminated).toBe(true);
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

describe("--probe", () => {
  const KEY = "sk-or-v1-test-secret-key";
  const CALL = { type: "function", function: { name: "ok", arguments: "{}" } };
  // cf lacks most modes in its listing and is ineligible; cf/fp8 is a longer sibling tag.
  const list = [
    ep("cf", { provider_name: "Cloudflare", supports_tool_choice: { auto: true } }),
    ep("cf/fp8", { provider_name: "Cloudflare" }),
  ];

  async function run(argv: string[], reply: (mode: unknown) => unknown, key: string | null = KEY) {
    const bodies: { provider: unknown; tool_choice: unknown }[] = [];
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/endpoints")) return new Response(JSON.stringify({ data: { endpoints: list } }));
      if (!url.endsWith("/chat/completions")) return new Response(JSON.stringify({ data: [] }));
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return new Response(JSON.stringify(reply(body.tool_choice)));
    }) as unknown as typeof fetch);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const saved = { key: process.env.OPENROUTER_API_KEY, home: process.env.HOME, xdg: process.env.XDG_DATA_HOME };
    if (key === null) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = key;
    process.env.HOME = "/nonexistent";
    delete process.env.XDG_DATA_HOME;
    try {
      const code = await main(argv);
      return { code, bodies, stdout: log.mock.calls.flat().join("\n") };
    } finally {
      for (const [name, value] of [
        ["OPENROUTER_API_KEY", saved.key],
        ["HOME", saved.home],
        ["XDG_DATA_HOME", saved.xdg],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fetchMock.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
  }

  const good = (mode: unknown) => ({
    provider: "Cloudflare",
    choices: [
      mode === "none" || mode === "auto"
        ? { finish_reason: "stop", message: { content: "hi" } }
        : { finish_reason: "tool_calls", message: { tool_calls: [CALL] } },
    ],
  });

  test("parses a repeatable flag and rejects bad combinations", () => {
    expect(parseOptions(["m/x", "--probe", "a", "--probe", "b/c"]).probe).toEqual(["a", "b/c"]);
    expect(parseOptions(["m/x"]).probe).toEqual([]);
    for (const argv of [
      ["--probe", "a"],
      ["m/x", "n/y", "--probe", "a"],
      ["m/x", "--probe", "a", "--verify"],
      ["m/x", "--probe", "a", "--pick"],
      ["m/x", "--probe", "a", "--json"],
      ["m/x", "--probe"],
    ]) {
      expect(() => parseOptions(argv)).toThrow();
    }
  });

  test("usage errors exit 2", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await main(["m/x", "--probe", "a", "--verify"])).toBe(2);
    } finally {
      error.mockRestore();
    }
  });

  test("no key exits 2 and sends no chat request", async () => {
    const { code, bodies } = await run(["m/x", "--probe", "cf"], good, null);
    expect(code).toBe(2);
    expect(bodies).toHaveLength(0);
  });

  test("probes an ineligible endpoint with its pin and the four modes, exiting 0", async () => {
    const { code, bodies, stdout } = await run(["m/x", "--probe", "CF"], good);
    expect(code).toBe(0);
    expect(bodies.map((b) => b.tool_choice)).toEqual([
      "none",
      "auto",
      "required",
      { type: "function", function: { name: "ok" } },
    ]);
    for (const b of bodies) expect(b.provider).toEqual({ only: ["cf"], ignore: ["cf/fp8"], allow_fallbacks: false });
    expect(stdout).toContain("cf  none  ok  listed: no");
    expect(stdout).toContain("cf  auto  ok  listed: yes");
  });

  test("a failing mode exits 1, and a tool call under none fails", async () => {
    const withCall = {
      provider: "Cloudflare",
      choices: [{ finish_reason: "tool_calls", message: { tool_calls: [CALL] } }],
    };
    const { code, stdout } = await run(["m/x", "--probe", "cf"], (mode) => (mode === "none" ? withCall : good(mode)));
    expect(code).toBe(1);
    expect(stdout).toContain("cf  none  fail  listed: no  tool call despite tool_choice none");
    const noCall = { provider: "Cloudflare", choices: [{ finish_reason: "stop", message: {} }] };
    const missing = await run(["m/x", "--probe", "cf"], (mode) => (typeof mode === "object" ? noCall : good(mode)));
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain("no ok tool call despite tool_choice function, finish=stop");
  });

  test("an unknown tag exits 1 without requests", async () => {
    const { code, bodies, stdout } = await run(["m/x", "--probe", "nope"], good);
    expect(code).toBe(1);
    expect(bodies).toHaveLength(0);
    expect(stdout).toContain("nope: no such endpoint for m/x");
  });
});
