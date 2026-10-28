import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fmtRate, main, parseOptions, resolveAuth } from "./provider-picker.ts";
import { ep, opencodeGoFixture, vercelFixture } from "./src/fixtures.ts";
import type { Endpoint } from "./src/policy.ts";

/** A new, empty XDG_CACHE_HOME, so probe results never reach the real store or leak between runs. */
const freshCache = (): string => mkdtempSync(join(tmpdir(), "opp-cache-"));
beforeEach(() => {
  process.env.XDG_CACHE_HOME = freshCache();
});

/** Writes a probe store into `cache`, as --probe or --verify would have. */
function seedProbes(cache: string, store: unknown): void {
  mkdirSync(join(cache, "opp"), { recursive: true });
  writeFileSync(join(cache, "opp", "probes.json"), JSON.stringify(store));
}
const readProbes = (cache: string): unknown => JSON.parse(readFileSync(join(cache, "opp", "probes.json"), "utf8"));

describe("parseOptions", () => {
  test("defaults", () => {
    expect(parseOptions(["z-ai/glm-5.3"])).toEqual({
      slugs: ["z-ai/glm-5.3"],
      gateways: ["openrouter"],
      providers: [],
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

  test("a bare word is not a model: it is an error that suggests -p", () => {
    expect(() => parseOptions(["z-ai/glm-5.3", "together", "--verify"])).toThrow(
      "together: not a model slug; did you mean -p together?",
    );
  });

  test("the old --provider a b case is a valid two-value filter as --provider a --provider b", () => {
    expect(parseOptions(["m/x", "--provider", "a", "--provider", "b"]).providers).toEqual(["a", "b"]);
    expect(() => parseOptions(["m/x", "--provider", "a", "b"])).toThrow("did you mean -p b?");
  });

  test("provider filters are split, trimmed and deduplicated", () => {
    expect(parseOptions(["m/x", "-p", "a,b", "-p", " c", "--provider", "a"]).providers).toEqual(["a", "b", "c"]);
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
    [["m/x", "-p", ""], /provider filter must not be empty/],
    [["m/x", "-p", "a,,b"], /provider filter must not be empty/],
    [["m/x", "-p", " "], /provider filter must not be empty/],
    [["m/x", "-x", "CN,"], /excluded country must not be empty/],
    [["../etc/passwd"], /not a model slug/],
    [["a/.."], /not a model slug/],
    [["m/x", "-x", "china"], /two-letter country code/],
    [["--json", "--pick"], /alternative outputs/],
    [[], /at least one model slug/],
    [["together"], /did you mean -p together\?/],
    [["--nope"], /Unknown option/],
    [["m/x", "--audit-fallback"], /argument missing/],
    [["m/x", "--audit-fallback", "0"], /whole number from 1 to 50/],
    [["m/x", "--audit-fallback", "51"], /whole number from 1 to 50/],
    [["m/x", "--audit-fallback", "2.5"], /whole number from 1 to 50/],
    [["m/x", "--audit-fallback", "abc"], /whole number from 1 to 50/],
    [["m/x", "--audit-fallback", "5", "--pick"], /can't be combined with --pick/],
    [["m/x", "--audit-fallback", "5", "--probe", "a"], /--probe can't be combined/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseOptions(argv)).toThrow(message);
  });

  test("--audit-fallback takes a request count", () => {
    expect(parseOptions(["m/x", "--audit-fallback", "50"]).auditFallback).toBe(50);
    expect(parseOptions(["m/x"])).not.toHaveProperty("auditFallback");
  });
});

describe("prices", () => {
  test("display keeps integer zeros and avoids exponents", () => {
    expect(fmtRate("0.0001")).toBe("100");
    expect(fmtRate("0.00001")).toBe("10");
    expect(fmtRate("0.0000014")).toBe("1.4");
    expect(fmtRate("0.000000079")).toBe("0.079");
    expect(fmtRate("0.0012345")).toBe("1230");
    expect(fmtRate(undefined)).toBe("-");
  });
});

describe("secrets", () => {
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
      for (const value of [[], ["0"], ["51"], ["2.5"], ["abc"]]) {
        expect(await main(["m/x", "--audit-fallback", ...value])).toBe(2);
      }
      expect(await main(["m/x", "--audit-fallback", "5", "--pick"])).toBe(2);
      expect(await main(["--help"])).toBe(0);
      const help = String(log.mock.calls[0]?.[0]);
      const headings = [
        "Models:",
        "Sources:",
        "Eligibility:",
        "Probes (paid requests)",
        "Output:",
        "Auth:",
        "Exit status:",
      ];
      const at = headings.map((heading) => help.indexOf(`\n${heading}`));
      expect(at.every((index) => index > 0)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect(help.slice(at[1], at[2])).toContain("--gateway <name,...>");
      expect(help.slice(at[1], at[2])).toContain("flagged tc? and ranks after the verified rows");
      expect(help.slice(at[2], at[3])).toContain("--exclude-country");
      expect(help.slice(at[3], at[4])).toContain("--probe");
      expect(help.slice(at[3], at[4])).toContain("--audit-fallback <n>");
      expect(help.slice(at[5], at[6])).toContain("AI_GATEWAY_API_KEY");
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

  /** A successful probe reply: the forced call to the probe's tool. */
  const TOOL_CALL = {
    finish_reason: "tool_calls",
    message: { tool_calls: [{ type: "function", function: { name: "ok", arguments: "{}" } }] },
  };

  /**
   * Runs main against a fake OpenRouter whose router answers each pinned probe
   * as `servedBy(tag)`: a provider name, a raw Response, or no provider. An
   * unpinned request has no tag. A null key leaves the run with no key at all.
   */
  async function run(
    servedBy: (tag: string | undefined) => string | Response | undefined,
    argv = ["m/x", "--verify"],
    zdrList: unknown = ZDR_LIST,
    { list = endpoints, providers = [] as unknown[], key = KEY as string | null, cache = freshCache() } = {},
  ) {
    process.env.XDG_CACHE_HOME = cache;
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
      const served = servedBy(JSON.parse(String(init.body)).provider?.only[0]);
      if (served instanceof Response) return served;
      return json({
        ...(served && { provider: served }),
        choices: [TOOL_CALL],
      });
    }) as unknown as typeof fetch);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const saved = { key: process.env.OPENROUTER_API_KEY, home: process.env.HOME, xdg: process.env.XDG_DATA_HOME };
    if (key === null) {
      // No opencode credential store either.
      delete process.env.OPENROUTER_API_KEY;
      process.env.HOME = "/nonexistent";
      delete process.env.XDG_DATA_HOME;
    } else process.env.OPENROUTER_API_KEY = key;
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

  test("-p with several values keeps endpoints of any of them; the price guard still sees every endpoint", async () => {
    const pricey = { prompt: "0.00001", input_cache_read: "0.000001", completion: "0.00004" };
    const list = [ep("cheap"), ep("pricey", { pricing: pricey }), ep("other", { pricing: pricey })];
    const { stdout } = await run(() => undefined, ["m/x", "--json", "-p", "pricey,cheap", "-p", "nomatch"], ZDR_LIST, {
      list,
    });
    const ranked = JSON.parse(stdout).models[0].ranked;
    expect(ranked.map(({ endpoint }: { endpoint: string }) => endpoint).sort()).toEqual(["cheap", "pricey"]);
    expect(ranked.find(({ endpoint }: { endpoint: string }) => endpoint === "pricey").priceEliminated).toBe(true);
    expect(ranked.find(({ endpoint }: { endpoint: string }) => endpoint === "cheap").priceEliminated).toBe(false);
  });

  test("-p lists every value when nothing matches", async () => {
    const { stdout } = await run(() => undefined, ["m/x", "-p", "absent,missing"]);
    expect(stdout).toContain("no eligible endpoint matches absent, missing");
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

  test("a pick whose quantization isn't reported says so", async () => {
    const pickOf = async (list: typeof endpoints) => {
      const text = await run(() => undefined, ["m/x"], ZDR_LIST, { list });
      const json = await run(() => undefined, ["m/x", "--json"], ZDR_LIST, { list });
      return {
        line: text.stdout.split("\n").find((line) => line.startsWith("  pin: ")),
        reported: JSON.parse(json.stdout).models[0].pick.quantizationReported,
      };
    };
    expect(await pickOf(endpoints)).toEqual({
      line: "  pin: m/x:together (quantization not reported)",
      reported: false,
    });
    const bf16 = [ep("together", { provider_name: "Together", quantization: "bf16" })];
    expect(await pickOf(bf16)).toEqual({ line: "  pin: m/x:together", reported: true });
    const { stdout } = await run(() => undefined, ["m/x"]);
    expect(stdout).toContain("quant fp4 < fp8 < ? (not reported) < bf16");
  });

  test("ineligible endpoints show their ZDR status too", async () => {
    const text = await run(() => undefined, ["m/x"]);
    expect(text.stdout).toMatch(/broken +zdr Y +status -2/);
    const { models } = JSON.parse((await run(() => undefined, ["m/x", "--json"])).stdout);
    expect(models[0].ineligible).toEqual([
      {
        gateway: "openrouter",
        endpoint: "broken",
        provider: "broken",
        zdr: true,
        reasons: ["status -2"],
        toolChoiceVerified: true,
        toolChoiceSource: { none: "listing", auto: "listing", required: "listing", function: "listing" },
      },
    ]);
  });

  describe("--audit-fallback", () => {
    /** An unpinned reply from `provider` with an ok tool call carrying `args`. */
    const served =
      (provider: string, { args = "{}", cost = 0.001, tier }: { args?: string; cost?: number; tier?: string } = {}) =>
      () =>
        new Response(
          JSON.stringify({
            provider,
            ...(tier && { service_tier: tier }),
            usage: { cost },
            choices: [
              { finish_reason: "tool_calls", message: { tool_calls: [{ function: { name: "ok", arguments: args } }] } },
            ],
          }),
        );
    const limited = () =>
      new Response(JSON.stringify({ error: { message: "Rate limited", code: 429 } }), { status: 429 });
    /** Pinned probes are served by their own provider; unpinned requests get `replies` in turn. */
    const routing = (replies: (() => Response)[]) => {
      let next = 0;
      return (tag: string | undefined) =>
        tag === undefined
          ? replies[next++ % replies.length]!()
          : tag.split("/")[0] === "together"
            ? "Together"
            : "Wafer";
    };
    const mixed = () =>
      routing([served("Together"), served("Wafer"), served("Together"), served("Wafer", { args: "[]" }), limited]);

    test("sends unpinned requests that force a tool call, and stores none of them", async () => {
      const cache = freshCache();
      const { probes } = await run(mixed(), ["m/x", "--audit-fallback", "2"], ZDR_LIST, { cache });
      expect(probes).toHaveLength(2);
      expect(existsSync(join(cache, "opp", "probes.json"))).toBe(false);
      for (const body of probes) {
        expect(body).not.toHaveProperty("provider");
        expect(body).toMatchObject({ model: "m/x", tool_choice: "required", tools: [{ function: { name: "ok" } }] });
      }
    });

    test("counts served, share and unusable tool calls per provider, with failures in one row", async () => {
      const { stdout, stderr, code } = await run(mixed(), ["m/x", "--audit-fallback", "5"]);
      expect(code).toBe(0);
      expect(stderr).toContain("opp: --audit-fallback: up to $0.0112 for 5 requests to m/x");
      expect(stdout).toContain("audit: 5 unpinned requests, OpenRouter default routing; -p/-e/-x/--zdr not applied");
      const rows = stdout.split("\n").filter((line) => /^ {2}(Together|Wafer|\(no response\)) /.test(line));
      expect(rows.map((row) => row.trim().split(/ {2,}/))).toEqual([
        ["Together", "2", "40%", "0", "?", "-"],
        ["Wafer", "2", "40%", "1", "?", "-"],
        ["(no response)", "1", "20%", "1"],
      ]);
      expect(stdout).toContain("audit: $0.0040 spent, 0 unsent");
      const json = await run(mixed(), ["m/x", "--audit-fallback", "5", "--json"]);
      const model = JSON.parse(json.stdout).models[0];
      expect(model.audit.map(({ ms: _, ...rest }: { ms: number }) => rest)).toEqual([
        { provider: "Together", quantization: null, serviceTier: null, toolCallValid: true },
        { provider: "Wafer", quantization: null, serviceTier: null, toolCallValid: true },
        { provider: "Together", quantization: null, serviceTier: null, toolCallValid: true },
        { provider: "Wafer", quantization: null, serviceTier: null, toolCallValid: false },
        { provider: null, quantization: null, serviceTier: null, toolCallValid: false },
      ]);
      expect(model.auditUnsent).toBe(0);
      expect(model.auditUsd).toBe(0.004);
    });

    test("quantization resolves from one matching endpoint and is null when matching endpoints differ", async () => {
      const list = [
        ep("together/fp8", { provider_name: "Together", quantization: "fp8" }),
        ep("wafer/fp8", { provider_name: "Wafer", quantization: "fp8" }),
        ep("wafer/bf16", { provider_name: "Wafer", quantization: "bf16" }),
        ep("wafer/flex", { provider_name: "Wafer", quantization: "fp4", service_tier: "flex" }),
      ];
      const replies = routing([served("together"), served("Wafer"), served("Wafer", { tier: "flex" })]);
      const { stdout } = await run(replies, ["m/x", "--audit-fallback", "3", "--json"], ZDR_LIST, { list });
      expect(JSON.parse(stdout).models[0].audit.map((s: { quantization: unknown }) => s.quantization)).toEqual([
        "fp8",
        null,
        "fp4",
      ]);
    });

    test("-p and --zdr don't change the requests", async () => {
      const plain = await run(mixed(), ["m/x", "--audit-fallback", "3"]);
      const filtered = await run(mixed(), ["m/x", "--audit-fallback", "3", "-p", "wafer", "--zdr"]);
      expect(filtered.probes).toEqual(plain.probes);
    });

    test("the pick and exit status are the same with and without the audit", async () => {
      for (const servedBy of [() => "Wafer", () => undefined]) {
        const without = await run(servedBy, ["m/x", "--verify", "--json"]);
        const withAudit = await run(servedBy, ["m/x", "--verify", "--json", "--audit-fallback", "2"]);
        expect(withAudit.code).toBe(without.code);
        expect(JSON.parse(withAudit.stdout).models[0].pick).toEqual(JSON.parse(without.stdout).models[0].pick);
        expect(JSON.parse(withAudit.stdout).models[0].audit).toHaveLength(2);
      }
      const plain = await run(() => "Together", ["m/x", "--json"]);
      expect(plain.code).toBe(0);
      const { models } = JSON.parse(plain.stdout);
      expect([models[0].audit, models[0].auditUnsent, models[0].auditUsd]).toEqual([null, null, null]);
    });

    test("requests not sent by the deadline are counted as unsent", async () => {
      let now = 0;
      const clock = spyOn(Date, "now").mockImplementation(() => (now += 100_000)); // 100s per reading
      try {
        const { stdout, probes } = await run(mixed(), ["m/x", "--audit-fallback", "5", "--json"]);
        const model = JSON.parse(stdout).models[0];
        expect(probes).toHaveLength(1);
        expect(model.audit).toHaveLength(1);
        expect(model.auditUnsent).toBe(4);
      } finally {
        clock.mockRestore();
      }
    });

    test("--verify and the audit share one deadline, so time --verify used is gone", async () => {
      let now = 0;
      const clock = spyOn(Date, "now").mockImplementation(() => (now += 100_000)); // 100s per reading
      try {
        const { stdout, probes } = await run(mixed(), ["m/x", "--verify", "--audit-fallback", "5", "--json"]);
        const model = JSON.parse(stdout).models[0];
        expect(probes.map(({ provider }) => provider?.only[0])).toEqual(["together"]);
        expect(model.pick.endpoint).toBe("together");
        expect(model.audit).toEqual([]);
        expect(model.auditUnsent).toBe(5);
      } finally {
        clock.mockRestore();
      }
    });

    test("the cap applies to the worst case summed over every model", async () => {
      // m/x alone: 50 × 512 × $15.625/M = $0.40. n/y adds 50 × (200 × $1/M + 512 × $4/M) = $0.11.
      const list = [ep("dear", { pricing: { prompt: "0", completion: "0.000015625" } })];
      const one = await run(mixed(), ["m/x", "--audit-fallback", "50"], ZDR_LIST, { list });
      expect(one.stderr).toContain("up to $0.40 for 50 requests to m/x");
      expect(one.code).toBe(0);
      const both = await run(mixed(), ["m/x", "n/y", "--audit-fallback", "50"], ZDR_LIST, { list });
      expect(both.code).toBe(2);
      expect(both.probes).toHaveLength(0);
      expect(both.stderr).toContain("up to $0.51 for 100 requests to m/x, n/y, over the $0.50 cap");
    });

    test("under --json the spend goes to stderr and stdout stays valid JSON", async () => {
      const { stdout, stderr } = await run(mixed(), ["m/x", "--audit-fallback", "2", "--json"]);
      expect(JSON.parse(stdout).models[0].auditUsd).toBe(0.002);
      expect(stderr).toContain("opp: --audit-fallback: $0.0020 spent on m/x");
    });

    test("no key exits 2 and sends no chat request", async () => {
      const { code, probes, stderr } = await run(mixed(), ["m/x", "--audit-fallback", "2"], ZDR_LIST, { key: null });
      expect(code).toBe(2);
      expect(probes).toHaveLength(0);
      expect(stderr).toContain("--audit-fallback sends real requests and needs an API key");
    });

    test.each([
      ["no price", { pricing: { prompt: null, completion: "0.000004" } }],
      ["a price that isn't a number", { pricing: { prompt: "0.000001", completion: "free" } }],
      ["a request fee that isn't a number", { pricing: { prompt: "0", completion: "0", request: "n/a" } }],
    ])("an endpoint with %s can't be bounded, so it exits 2 before any request", async (_, overrides) => {
      const list = [ep("unpriced", overrides), ...endpoints];
      const { code, probes, stderr } = await run(mixed(), ["m/x", "--verify", "--audit-fallback", "1"], ZDR_LIST, {
        list,
      });
      expect(code).toBe(2);
      expect(probes).toHaveLength(0);
      expect(stderr).toContain("can't bound the cost of m/x");
    });

    test("a malformed endpoint can't be bounded either", async () => {
      const list = [{ provider_name: "Broken" }, ...endpoints] as typeof endpoints;
      const { code, probes } = await run(mixed(), ["m/x", "--audit-fallback", "1"], ZDR_LIST, { list });
      expect(code).toBe(2);
      expect(probes).toHaveLength(0);
    });

    test("provider and tier labels from a response are made safe to print", async () => {
      const { stdout, output } = await run(routing([served(`Evil\u001b[2J${KEY}`, { tier: "flex\u0007" })]), [
        "m/x",
        "--audit-fallback",
        "1",
        "--json",
      ]);
      expect(output).not.toContain(KEY);
      expect(output).not.toContain("\u001b");
      expect(JSON.parse(stdout).models[0].audit[0]).toMatchObject({
        provider: "Evil [2J[redacted]",
        serviceTier: "flex",
      });
    });

    test("a served response with no cost is counted as unknown, not free", async () => {
      const uncosted = () => new Response(JSON.stringify({ provider: "Wafer", choices: [TOOL_CALL] }));
      const replies = routing([served("Together"), uncosted, limited]);
      const { stdout } = await run(replies, ["m/x", "--audit-fallback", "3"]);
      expect(stdout).toContain("audit: $0.0010 spent, plus 1 request of unknown cost, 0 unsent");
      const json = await run(routing([served("Together"), uncosted, limited]), [
        "m/x",
        "--audit-fallback",
        "3",
        "--json",
      ]);
      expect(JSON.parse(json.stdout).models[0]).toMatchObject({ auditUsd: 0.001, auditUncosted: 1 });
      expect(json.stderr).toContain("$0.0010 spent on m/x, plus 1 request of unknown cost");
    });

    test("sending stops once the reported spend reaches the cap", async () => {
      const replies = routing([served("Together", { cost: 0.3 })]);
      const { stdout } = await run(replies, ["m/x", "--audit-fallback", "5", "--json"]);
      expect(JSON.parse(stdout).models[0]).toMatchObject({ auditUnsent: 3, auditUsd: 0.6 });
    });

    test("a per-request fee counts toward the worst case", async () => {
      // Free tokens but $0.02 a request: 50 requests can cost $1.00.
      const list = [ep("fee", { pricing: { prompt: "0", completion: "0", request: "0.02" } }), ...endpoints];
      const { code, probes, stderr } = await run(mixed(), ["m/x", "--audit-fallback", "50"], ZDR_LIST, { list });
      expect(code).toBe(2);
      expect(probes).toHaveLength(0);
      expect(stderr).toContain("up to $1.11 for 50 requests to m/x, over the $0.50 cap");
    });

    test("a worst case over the cap exits 2 before any request, --verify's included", async () => {
      // $100/M in and out: 50 requests can cost 50 × (200 + 512) × $0.0001 = $3.56.
      const list = [ep("pricey", { pricing: { prompt: "0.0001", completion: "0.0001" } }), ...endpoints];
      const { code, probes, stderr } = await run(mixed(), ["m/x", "--verify", "--audit-fallback", "50"], ZDR_LIST, {
        list,
      });
      expect(code).toBe(2);
      expect(probes).toHaveLength(0);
      expect(stderr).toContain("up to $3.56 for 50 requests to m/x, over the $0.50 cap");
    });
  });

  describe("stored probe results", () => {
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    // cf is the fastest endpoint, but its listing lacks required.
    const cf = ep("cf", {
      provider_name: "Cloudflare",
      latency_last_30m: { p50: 100 },
      supports_tool_choice: { none: true, auto: true, required: false, function: true },
    });
    const list = [cf, ...endpoints];

    test("a fresh pass makes a listed-no mode eligible, and the endpoint can be picked", async () => {
      const cache = freshCache();
      seedProbes(cache, { "m/x": { cf: { required: { result: "pass", at: at(1) } } } });
      const text = await run(() => undefined, ["m/x"], ZDR_LIST, { list, cache });
      expect(text.stdout).toContain(
        "# eligible: native tools, status 0, tool_choice none/auto/required/function, probe results override listings",
      );
      expect(text.stdout).toMatch(/▶ +1 +cf .*probed: required pass \(listed no\)/);
      expect(text.stdout).toContain("pin: m/x:cf");
      const picked = await run(() => undefined, ["m/x", "--pick"], ZDR_LIST, { list, cache });
      expect(picked.stdout).toBe("cf");
      const { models } = JSON.parse((await run(() => undefined, ["m/x", "--json"], ZDR_LIST, { list, cache })).stdout);
      expect(models[0].ranked[0]).toMatchObject({
        endpoint: "cf",
        toolChoiceSource: { none: "listing", auto: "listing", required: "probe", function: "listing" },
      });
      expect(models[0].ranked[1].toolChoiceSource.required).toBe("listing");
    });

    test("a fresh fail makes a listed-yes mode ineligible", async () => {
      const cache = freshCache();
      seedProbes(cache, { "m/x": { together: { function: { result: "fail", at: at(0) } } } });
      const { stdout } = await run(() => undefined, ["m/x"], ZDR_LIST, { cache });
      expect(stdout).toContain("probe results override listings");
      expect(stdout).toMatch(/together +zdr - +probed: function fail \(listed yes: function\)/);
      expect(stdout).toContain("pin: m/x:wafer/us");
    });

    test("a result older than PROBE_TTL_DAYS is ignored", async () => {
      const cache = freshCache();
      seedProbes(cache, { "m/x": { cf: { required: { result: "pass", at: at(8) } } } });
      const { stdout } = await run(() => undefined, ["m/x"], ZDR_LIST, { list, cache });
      expect(stdout).not.toContain("probe results override listings");
      expect(stdout).toMatch(/cf +zdr - +tool_choice lacks required/);
    });

    test("--verify stores each conclusive probe in required mode, but not a busy one", async () => {
      const cache = freshCache();
      const { output } = await run((tag) => (tag === "together" ? busy() : "Wafer"), ["m/x", "--verify"], ZDR_LIST, {
        cache,
      });
      expect(output).toContain("verified pin: m/x:wafer/us");
      expect(readProbes(cache)).toEqual({
        "m/x": { "wafer/us": { required: { result: "pass", at: expect.any(String) } } },
      });
      // A plain reply under tool_choice required is a verdict; a reply from the wrong provider is not.
      const text = () =>
        new Response(
          JSON.stringify({ provider: "Wafer", choices: [{ finish_reason: "stop", message: { content: "OK" } }] }),
        );
      await run((tag) => (tag === "wafer/us" ? text() : "Wafer"), ["m/x", "--verify"], ZDR_LIST, { cache });
      expect(readProbes(cache)).toEqual({
        "m/x": { "wafer/us": { required: { result: "fail", at: expect.any(String) } } },
      });
    });
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

  test("none and auto need a completion, and an auto tool call must be usable", async () => {
    const empty = { provider: "Cloudflare", choices: [] };
    const none = await run(["m/x", "--probe", "cf"], (mode) => (mode === "none" ? empty : good(mode)));
    expect(none.code).toBe(1);
    expect(none.stdout).toContain("cf  none  fail");
    const auto = await run(["m/x", "--probe", "cf"], (mode) => (mode === "auto" ? empty : good(mode)));
    expect(auto.code).toBe(1);
    const badArgs = {
      provider: "Cloudflare",
      choices: [
        { finish_reason: "tool_calls", message: { tool_calls: [{ function: { name: "ok", arguments: "{oops" } }] } },
      ],
    };
    const broken = await run(["m/x", "--probe", "cf"], (mode) => (mode === "auto" ? badArgs : good(mode)));
    expect(broken.code).toBe(1);
    expect(broken.stdout).toContain("cf  auto  fail  listed: yes  unusable tool call");
    const cutCall = { provider: "Cloudflare", choices: [{ finish_reason: "length", message: { tool_calls: [CALL] } }] };
    expect((await run(["m/x", "--probe", "cf"], (mode) => (mode === "auto" ? cutCall : good(mode)))).code).toBe(1);
    const invented = {
      ...badArgs,
      choices: [
        { finish_reason: "tool_calls", message: { tool_calls: [{ function: { name: "nope", arguments: "{}" } }] } },
      ],
    };
    expect((await run(["m/x", "--probe", "cf"], (mode) => (mode === "auto" ? invented : good(mode)))).code).toBe(1);
    for (const choice of [
      {},
      {
        finish_reason: "length",
        message: { content: null, tool_calls: [{ function: { name: "ok", arguments: "{" } }] },
      },
      { finish_reason: "error", message: { content: null } },
      { finish_reason: "length", message: { content: null } },
      { finish_reason: "tool_calls", message: { content: null, tool_calls: [] } },
    ]) {
      const truncated = { provider: "Cloudflare", choices: [choice] };
      expect((await run(["m/x", "--probe", "cf"], (mode) => (mode === "none" ? truncated : good(mode)))).code).toBe(1);
    }
  });

  test.each(["required", "function"])(
    "%s fails on an error, a filter or no completion despite an ok call",
    async (name) => {
      const isMode = (mode: unknown) => (name === "function" ? typeof mode === "object" : mode === name);
      for (const finish_reason of ["content_filter", "error"]) {
        const bad = { provider: "Cloudflare", choices: [{ finish_reason, message: { tool_calls: [CALL] } }] };
        const { code, stdout } = await run(["m/x", "--probe", "cf"], (mode) => (isMode(mode) ? bad : good(mode)));
        expect(code).toBe(1);
        expect(stdout).toContain(`${name}  fail`);
      }
      const none = { provider: "Cloudflare", choices: [] };
      expect((await run(["m/x", "--probe", "cf"], (mode) => (isMode(mode) ? none : good(mode)))).code).toBe(1);
    },
  );

  test("a plain reply cut off by max_tokens still passes none and auto", async () => {
    const cut = { provider: "Cloudflare", choices: [{ finish_reason: "length", message: { content: "hi" } }] };
    const { code } = await run(["m/x", "--probe", "cf"], (mode) =>
      mode === "none" || mode === "auto" ? cut : good(mode),
    );
    expect(code).toBe(0);
  });

  test("stores each mode's result under the model and the endpoint's own tag", async () => {
    const withCall = {
      provider: "Cloudflare",
      choices: [{ finish_reason: "tool_calls", message: { tool_calls: [CALL] } }],
    };
    await run(["m/x", "--probe", "CF"], (mode) => (mode === "none" ? withCall : good(mode)));
    const entry = (result: string) => ({ result, at: expect.any(String) });
    expect(readProbes(process.env.XDG_CACHE_HOME!)).toEqual({
      "m/x": { cf: { none: entry("fail"), auto: entry("pass"), required: entry("pass"), function: entry("pass") } },
    });
  });

  test("an unknown tag exits 1 without requests", async () => {
    const { code, bodies, stdout } = await run(["m/x", "--probe", "nope"], good);
    expect(code).toBe(1);
    expect(bodies).toHaveLength(0);
    expect(stdout).toContain("nope: no such endpoint for m/x");
  });
});

describe("completion", () => {
  const MODELS = { data: [{ id: "deepseek/deepseek-v4-pro" }, { id: "z-ai/glm-5.3" }, { id: 7 }, { id: "bad slug" }] };

  async function run(argv: string[], fetchImpl: (init?: RequestInit) => Response | Promise<Response>) {
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) =>
      fetchImpl(init)) as unknown as typeof fetch);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await main(argv);
      return {
        code,
        stdout: log.mock.calls.flat().join("\n"),
        stderr: error.mock.calls.flat().join("\n"),
        fetches: fetchMock.mock.calls.length,
      };
    } finally {
      fetchMock.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
  }
  const ok = () => new Response(JSON.stringify(MODELS));
  const down = () => new Response("down", { status: 503 });

  test("--completions zsh prints a zsh function; any other shell exits 2", async () => {
    const zsh = await run(["--completions", "zsh"], ok);
    expect(zsh.code).toBe(0);
    expect(zsh.stdout.startsWith("#compdef opp")).toBe(true);
    expect(zsh.stdout).toContain("'*--gateway[where to list endpoints]:gateway:(openrouter vercel opencode-go all)'");
    expect(zsh.fetches).toBe(0);
    const bash = await run(["--completions", "bash"], ok);
    expect(bash.code).toBe(2);
    expect(bash.stdout).toBe("");
  });

  test("--list-models prints the slugs of the model list and caches them", async () => {
    const out = await run(["--list-models"], ok);
    expect(out.stdout).toBe("deepseek/deepseek-v4-pro\nz-ai/glm-5.3");
    expect(out.stderr).toBe("");
    const cached = await run(["--list-models"], down);
    expect(cached.stdout).toBe(out.stdout);
    expect(cached.fetches).toBe(0);
  });

  test("a stale cache is refetched, and kept when the fetch fails", async () => {
    const cache = process.env.XDG_CACHE_HOME!;
    mkdirSync(join(cache, "opp"), { recursive: true });
    const stale = Date.now() - 25 * 3_600_000;
    writeFileSync(join(cache, "opp", "models.json"), JSON.stringify({ at: stale, slugs: ["old/model"] }));
    const failed = await run(["--list-models"], down);
    expect(failed.fetches).toBe(1);
    expect(failed.stdout).toBe("old/model");
    expect(failed.stderr).toBe("");
    const refreshed = await run(["--list-models"], ok);
    expect(refreshed.stdout).toContain("z-ai/glm-5.3");
  });

  test("a stalled fetch is abandoned after about two seconds and the stale cache is used", async () => {
    const cache = process.env.XDG_CACHE_HOME!;
    mkdirSync(join(cache, "opp"), { recursive: true });
    writeFileSync(join(cache, "opp", "models.json"), JSON.stringify({ at: 0, slugs: ["old/model"] }));
    const stalled = (init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    const started = Date.now();
    const out = await run(["--list-models"], stalled);
    expect(out).toMatchObject({ code: 0, stdout: "old/model", stderr: "" });
    expect(Date.now() - started).toBeLessThan(4000);
  }, 10_000);

  test("with no cache and no network, --list-models prints nothing and no error", async () => {
    const out = await run(["--list-models"], down);
    expect(out).toMatchObject({ code: 0, stdout: "", stderr: "" });
  });
});

describe("--gateway", () => {
  const OR_KEY = "sk-or-v1-test-secret-key";
  const AI_KEY = "test-ai-gateway-secret";
  const SLUG = "z-ai/glm-5.3";
  const VERCEL = "https://ai-gateway.vercel.sh/v1";
  const GO = "https://opencode.ai/inference/go/v1";
  const GO_KEY = "test-go-secret-key";
  // OpenRouter serves alpha (eligible, top tier), mike (lacks required and function), quebec (down, but listing every
  // mode) and lima (a lower tier). The Vercel fixture adds alpha, mike and quebec under the same names, plus oscar and
  // papa, which OpenRouter lacks.
  const openrouter = [
    ep("alpha/fp8", { provider_name: "Alpha", quantization: "fp8" }),
    ep("mike/fp8", {
      provider_name: "Mike",
      quantization: "fp8",
      supports_tool_choice: { none: true, auto: true, required: false, function: false },
    }),
    ep("quebec", { provider_name: "Quebec", status: -1 }),
    ep("lima", { provider_name: "Lima", uptime_last_1d: 90, uptime_last_30m: 90 }),
  ];
  const TOOL_CALL = {
    finish_reason: "tool_calls",
    message: { tool_calls: [{ type: "function", function: { name: "ok", arguments: "{}" } }] },
  };

  // Go's chat reply: a tool call, and what the plan was charged.
  const GO_CALL = {
    choices: [TOOL_CALL],
    usage: { opencode: { billing_source: "go", list_cost: 0.002, allowance: 0.0012, tokens: {} } },
  };

  type Call = { url: string; init: RequestInit };
  /**
   * Runs main against a fake OpenRouter and Vercel. `serve` names the provider that answers a pinned probe on
   * each gateway; by default the pinned one. `vercel` is the Vercel listing, or a function giving a raw Response.
   * `go` is Go's model list, likewise, and `goReply` answers its chat requests; it is listed only with a `goKey`.
   */
  async function run(
    argv: string[],
    {
      orKey = OR_KEY as string | null,
      aiKey = AI_KEY as string | null,
      goKey = null as string | null,
      go = opencodeGoFixture as unknown,
      goReply = (_body: Record<string, unknown>): Response => new Response(JSON.stringify(GO_CALL)),
      vercel = vercelFixture as unknown,
      providers = [] as unknown[],
      zdrList = { data: [] } as unknown,
      list = openrouter as Endpoint[] | null,
      serve = (_gateway: string, provider: string): string | undefined => provider,
      vercelReply = undefined as (() => Response) | undefined,
    } = {},
  ) {
    const calls: Call[] = [];
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith(GO)) {
        if (url.endsWith("/models")) return typeof go === "function" ? go() : json(go);
        return goReply(JSON.parse(String(init.body)));
      }
      if (url.startsWith(VERCEL)) {
        if (url.endsWith("/endpoints")) return typeof vercel === "function" ? vercel() : json(vercel);
        if (vercelReply) return vercelReply();
        const slug = JSON.parse(String(init.body)).providerOptions.gateway.only[0];
        const served = serve("vercel", slug);
        const metadata = served && { provider_metadata: { gateway: { routing: { finalProvider: served } } } };
        return json({ choices: [{ ...TOOL_CALL, message: { ...TOOL_CALL.message, ...metadata } }] });
      }
      if (url.endsWith("/providers")) return json({ data: providers });
      if (url.endsWith("/endpoints/zdr"))
        return zdrList === null ? new Response("down", { status: 503 }) : json(zdrList);
      if (url.endsWith("/endpoints")) {
        return list === null ? new Response("down", { status: 503 }) : json({ data: { endpoints: list } });
      }
      const tag = JSON.parse(String(init.body)).provider.only[0];
      const served = serve("openrouter", list!.find((e) => e.tag === tag)!.provider_name);
      return json({ ...(served && { provider: served }), choices: [TOOL_CALL] });
    }) as unknown as typeof fetch);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const names = ["OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "OPENCODE_GO_KEY", "HOME", "XDG_DATA_HOME"] as const;
    const saved = names.map((name) => [name, process.env[name]] as const);
    for (const [name, value] of [
      ["OPENROUTER_API_KEY", orKey],
      ["AI_GATEWAY_API_KEY", aiKey],
      ["OPENCODE_GO_KEY", goKey],
      ["XDG_DATA_HOME", null],
    ] as const) {
      if (value === null) delete process.env[name];
      else process.env[name] = value;
    }
    process.env.HOME = "/nonexistent"; // no opencode credential store
    try {
      const code = await main(argv);
      const stdout = log.mock.calls.flat().join("\n");
      const stderr = error.mock.calls.flat().join("\n");
      const toVercel = calls.filter(({ url }) => url.startsWith(VERCEL));
      const toGo = calls.filter(({ url }) => url.startsWith(GO));
      const probes = calls
        .filter(({ url }) => url.endsWith("/chat/completions"))
        .map(({ url, init }) => ({ url, body: JSON.parse(String(init.body)) }));
      return { code, stdout, stderr, output: `${stdout}\n${stderr}`, calls, toVercel, toGo, probes };
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fetchMock.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
  }

  type Row = { gateway: string; endpoint: string };
  const ids = (rows: Row[]) => rows.map(({ gateway, endpoint }) => `${gateway}:${endpoint}`);
  const jsonModel = async (argv: string[], options?: Parameters<typeof run>[1]) =>
    JSON.parse((await run([SLUG, "--json", ...argv], options)).stdout).models[0];

  describe("parsing", () => {
    test("one flag, repeatable or comma-separated, deduplicated, in a fixed order", () => {
      expect(parseOptions(["m/x", "--gateway", "vercel"]).gateways).toEqual(["vercel"]);
      expect(parseOptions(["m/x", "--gateway=vercel"]).gateways).toEqual(["vercel"]);
      expect(parseOptions(["m/x", "--gateway", "vercel", "--gateway", "openrouter"]).gateways).toEqual([
        "openrouter",
        "vercel",
      ]);
      expect(parseOptions(["m/x", "--gateway", "vercel,OpenRouter,vercel"]).gateways).toEqual(["openrouter", "vercel"]);
      expect(parseOptions(["m/x", "--gateway", "all"]).gateways).toBe("all");
      expect(parseOptions(["m/x", "--gateway", "openrouter", "--audit-fallback", "2"]).gateways).toEqual([
        "openrouter",
      ]);
    });

    test.each([
      [["--gateway", ""], /gateway must not be empty/],
      [["--gateway="], /gateway must not be empty/],
      [["--gateway", "vercel,"], /gateway must not be empty/],
      [["--gateway", "nope"], /unknown gateway "nope"/],
      [["--gateway", "all,vercel"], /all can't be combined/],
      [["--gateway", "all", "--gateway", "openrouter"], /all can't be combined/],
      [["--gateway", "cloudflare"], /cloudflare isn't supported yet/],
      [["--gateway", "vercel", "--audit-fallback", "2"], /--audit-fallback measures OpenRouter's default routing/],
      [["--gateway", "all", "--audit-fallback", "2"], /--audit-fallback measures OpenRouter's default routing/],
      [["--gateway", "vercel", "--probe", "a"], /--probe tests one gateway's endpoints/],
      [["--gateway", "openrouter,opencode-go", "--probe", "a"], /--probe tests one gateway's endpoints/],
      [["--gateway", "all", "--probe", "a"], /--probe tests one gateway's endpoints/],
      [["--gateway", "opencode-go", "--audit-fallback", "2"], /--audit-fallback measures OpenRouter's default routing/],
    ])("rejects %j, exiting 2", async (argv, message) => {
      expect(() => parseOptions(["m/x", ...argv])).toThrow(message);
      const { code, calls } = await run(["m/x", ...argv]);
      expect(code).toBe(2);
      expect(calls).toHaveLength(0);
    });
  });

  test("without the flag nothing changes: OpenRouter rows only and the bare tag", async () => {
    const { stdout, toVercel } = await run([SLUG, "--pick"]);
    expect(stdout).toBe("alpha/fp8");
    expect(toVercel).toHaveLength(0);
    const text = await run([SLUG]);
    expect(text.stdout).toContain("# OpenRouter endpoint ranking");
    expect(text.stdout).toContain("# eligible: native tools");
    expect(text.stdout).not.toContain("gateway");
    expect(text.stdout).not.toContain("# fees");
  });

  test("--gateway vercel ranks only Vercel rows, borrowing OpenRouter's tool_choice verdicts", async () => {
    const model = await jsonModel(["--gateway", "vercel"]);
    expect(ids(model.ranked)).toEqual(["vercel:quebec", "vercel:alpha", "vercel:oscar"]);
    expect(model.ineligible).toContainEqual(
      expect.objectContaining({
        gateway: "vercel",
        endpoint: "mike",
        reasons: ["tool_choice lacks required/function (from openrouter mike)"],
        toolChoiceVerified: true,
      }),
    );
    expect(model.ineligible).toContainEqual(
      expect.objectContaining({ endpoint: "papa", reasons: ["tool_choice lacks none/auto/required/function"] }),
    );
    const { stdout, calls } = await run([SLUG, "--gateway", "vercel"]);
    expect(calls.map(({ url }) => url)).toContain(`${VERCEL}/models/zai/glm-5.3/endpoints`);
    expect(stdout).toContain("# Endpoint ranking");
    expect(stdout).toContain("# eligible (vercel): native tools");
    expect(stdout).toContain("(skipped 1 malformed endpoint)");
    expect(stdout).toMatch(/vercel:mike +zdr - +tool_choice lacks required\/function \(from openrouter mike\)/);
  });

  test("with both gateways, one table: unverified rows rank after the verified rows of their tier", async () => {
    const model = await jsonModel(["--gateway", "openrouter,vercel"]);
    expect(ids(model.ranked)).toEqual([
      "vercel:quebec",
      "vercel:alpha",
      "openrouter:alpha/fp8",
      "vercel:oscar", // fastest of all, but tc?
      "openrouter:lima", // a lower uptime tier
    ]);
    const oscar = model.ranked.find(({ endpoint }: Row) => endpoint === "oscar");
    expect(oscar.toolChoiceVerified).toBe(false);
    expect(oscar.toolChoiceSource.required).toBe("unverified");
    const alpha = model.ranked.find(({ gateway }: Row) => gateway === "vercel");
    expect(alpha).toMatchObject({ toolChoiceVerified: true });
    expect(model.ranked[1].toolChoiceSource).toEqual({
      none: "openrouter",
      auto: "openrouter",
      required: "openrouter",
      function: "openrouter",
    });
    expect(ids(model.ineligible).sort()).toEqual([
      "openrouter:mike/fp8",
      "openrouter:quebec",
      "vercel:mike",
      "vercel:papa",
    ]);

    const { stdout } = await run([SLUG, "--gateway", "openrouter,vercel"]);
    expect(stdout).toContain("# eligible (openrouter, vercel): native tools");
    expect(stdout).toContain("> verified tool_choice >");
    expect(stdout).toContain("# vercel rows: up30m = uptime 1h, up5m = uptime 15m, ttfb and tok/s = 1h p50");
    expect(stdout).toMatch(/^ +# +gateway +endpoint +quant/m);
    expect(stdout).toMatch(/▶ +1 +vercel +quebec /);
    expect(stdout).toMatch(/ 3 +openrouter +alpha\/fp8 /);
    expect(stdout).toMatch(/ 4 +vercel +oscar .* tc\?$/m);
    expect(stdout.trimEnd()).toEndWith(
      "# fees: OpenRouter adds 5.5% (min $0.80) to card credit purchases; Vercel AI Gateway adds no markup. " +
        "$run includes neither.",
    );
  });

  test("a Vercel row prices at its listed rate: the discount and region prices don't change $run", async () => {
    const model = await jsonModel(["--gateway", "vercel"]);
    const quebec = model.ranked.find(({ endpoint }: Row) => endpoint === "quebec");
    expect(quebec.referenceRunUsd).toBeCloseTo(3.18);
    expect(quebec.usdPerMillion).toEqual({ input: 1.5, cacheRead: 0.15, output: 6 });
  });

  test("--zdr uses Vercel's has_zdr, and needs no OpenRouter ZDR list for Vercel rows", async () => {
    const { code, stdout, calls } = await run([SLUG, "--gateway", "vercel", "--zdr", "--json"], { zdrList: null });
    expect(code).toBe(0);
    expect(calls.some(({ url }) => url.endsWith("/endpoints/zdr"))).toBe(false);
    const model = JSON.parse(stdout).models[0];
    expect(ids(model.ranked)).toEqual(["vercel:quebec", "vercel:alpha"]);
    expect(model.ineligible).toContainEqual(
      expect.objectContaining({ endpoint: "oscar", zdr: null, reasons: ["ZDR unknown"] }),
    );
    expect(model.ineligible).toContainEqual(
      expect.objectContaining({ endpoint: "mike", reasons: expect.arrayContaining(["not ZDR"]) }),
    );
  });

  test("with another gateway listed, --zdr without OpenRouter's ZDR list excludes only OpenRouter's rows", async () => {
    const { code, stdout, stderr } = await run([SLUG, "--gateway", "openrouter,vercel", "--zdr", "--json"], {
      zdrList: null,
    });
    expect(code).toBe(0);
    expect(stderr).toContain("opp: the ZDR endpoint list unavailable");
    const model = JSON.parse(stdout).models[0];
    expect(ids(model.ranked)).toEqual(["vercel:quebec", "vercel:alpha"]);
    expect(model.ineligible).toContainEqual(
      expect.objectContaining({ gateway: "openrouter", endpoint: "alpha/fp8", reasons: ["ZDR unknown"] }),
    );
  });

  test("--json lists the gateways used and the pick in its gateway's syntax", async () => {
    const { stdout } = await run([SLUG, "--json", "--gateway", "vercel,openrouter"]);
    const json = JSON.parse(stdout);
    expect(json.gateways).toEqual(["openrouter", "vercel"]);
    expect(json.models[0].pick).toEqual({
      pin: "zai/glm-5.3 vercel:quebec",
      gateway: "vercel",
      model: "zai/glm-5.3",
      endpoint: "quebec",
      provider: "quebec",
      routing: { gateway: { only: ["quebec"] } },
      verified: false,
      quantizationReported: true,
    });
    const plain = JSON.parse((await run([SLUG, "--json"])).stdout);
    expect(plain.gateways).toEqual(["openrouter"]);
    expect(plain.models[0].pick).toMatchObject({
      pin: `${SLUG}:alpha/fp8`,
      gateway: "openrouter",
      model: SLUG,
      routing: { only: ["alpha/fp8"], allow_fallbacks: false },
    });
  });

  test("a Vercel pick prints vercel:<slug> under --pick, and the pin line ends the same, then providerOptions", async () => {
    const picked = await run([SLUG, "--pick", "--gateway", "openrouter,vercel"]);
    expect(picked.stdout).toBe("vercel:quebec");
    expect(picked.stderr).not.toContain("pin needs ignore");
    const { stdout } = await run([SLUG, "--gateway", "vercel"]);
    const lines = stdout.split("\n");
    const pin = lines.findIndex((line) => line.startsWith("  pin: "));
    expect(lines[pin]).toBe("  pin: zai/glm-5.3 vercel:quebec");
    expect(lines[pin + 1]).toBe(`  routing: "providerOptions": {"gateway":{"only":["quebec"]}}`);
  });

  test("-p and -e match a Vercel row by its OpenRouter alias; -x looks it up under that slug", async () => {
    const bedrock = { ...(vercelFixture.data.endpoints[0] as object), provider_name: "bedrock" };
    const vercel = { data: { endpoints: [bedrock] } };
    const kept = await jsonModel(["--gateway", "vercel", "-p", "amazon-bedrock"], { vercel });
    expect(ids(kept.ranked)).toEqual(["vercel:bedrock"]);
    // Part of the alias matches too, as a provider filter matches part of a name.
    const partial = await jsonModel(["--gateway", "vercel", "-p", "amazon"], { vercel });
    expect(ids(partial.ranked)).toEqual(["vercel:bedrock"]);
    const excluded = await jsonModel(["--gateway", "vercel", "-e", "amazon-bedrock"], { vercel });
    expect(excluded.ranked).toEqual([]);
    const providers = [{ slug: "amazon-bedrock", headquarters: "US", datacenters: ["US", "RU"] }];
    const located = await jsonModel(["--gateway", "vercel", "-x", "RU"], { vercel, providers });
    expect(located.ineligible[0]).toMatchObject({ endpoint: "bedrock", reasons: ["datacenter in RU"] });
  });

  test("-p and -e take either gateway's spelling, and apply it to both gateways' rows", async () => {
    const togetherai = { ...(vercelFixture.data.endpoints[0] as object), provider_name: "togetherai" };
    const options = { vercel: { data: { endpoints: [togetherai] } }, list: [ep("together"), ep("other")] };
    const excluded = await jsonModel(["--gateway", "all", "-e", "togetherai"], options);
    expect(ids(excluded.ranked)).toEqual(["openrouter:other"]);
    const kept = await jsonModel(["--gateway", "all", "-p", "togetherai"], options);
    expect(ids(kept.ranked)).toEqual(["vercel:togetherai", "openrouter:together"]);
  });

  test("with --gateway vercel, an OpenRouter outage leaves the Vercel rows unverified but ranked", async () => {
    const { code, stdout } = await run([SLUG, "--gateway", "vercel"], { list: null });
    expect(code).toBe(0);
    expect(stdout).toContain("  openrouter: HTTP 503");
    // No verdict to borrow, so every row that lists tool_choice is tc? and speed decides.
    expect(stdout.split("\n").filter((line) => line.endsWith("tc?"))).toHaveLength(4);
    expect(stdout).toContain("pin: zai/glm-5.3 vercel:oscar");
  });

  test("a failed Vercel fetch is noted under the model and OpenRouter's rows rank alone", async () => {
    const down = () => new Response(JSON.stringify({ error: { message: "Model not found" } }), { status: 404 });
    const { code, stdout } = await run([SLUG, "--gateway", "openrouter,vercel"], { vercel: down });
    expect(code).toBe(0);
    expect(stdout).toContain("  vercel: HTTP 404: Model not found");
    expect(stdout).toContain(`pin: ${SLUG}:alpha/fp8`);
    const alone = await run([SLUG, "--gateway", "vercel"], { vercel: down });
    expect(alone.code).toBe(1);
    expect(alone.stdout).toContain("fetch failed: vercel: HTTP 404: Model not found");
    const picked = await run([SLUG, "--gateway", "openrouter,vercel", "--pick"], { vercel: down });
    expect(picked.stdout).toBe("alpha/fp8");
    expect(picked.stderr).toBe(`opp: ${SLUG}: vercel: HTTP 404: Model not found`);
  });

  describe("credentials", () => {
    test("--gateway vercel --verify without AI_GATEWAY_API_KEY exits 2 and sends no request", async () => {
      const { code, calls, stderr } = await run([SLUG, "--gateway", "vercel", "--verify"], { aiKey: null });
      expect(code).toBe(2);
      expect(calls).toHaveLength(0);
      expect(stderr).toContain("set AI_GATEWAY_API_KEY");
    });

    test("--gateway vercel --verify needs no OpenRouter key", async () => {
      const { code, stdout } = await run([SLUG, "--gateway", "vercel", "--verify"], { orKey: null });
      expect(code).toBe(0);
      expect(stdout).toContain("verified pin: zai/glm-5.3 vercel:quebec");
    });

    test("--gateway all --verify without AI_GATEWAY_API_KEY ranks OpenRouter only and skips Vercel on one line", async () => {
      const { code, stdout, stderr, toVercel } = await run([SLUG, "--gateway", "all", "--verify", "--json"], {
        aiKey: null,
      });
      expect(code).toBe(0);
      expect(toVercel).toHaveLength(0);
      expect(stderr.split("\n").filter((line) => line.includes("vercel"))).toEqual([
        "opp: --gateway all: skipping vercel (no AI_GATEWAY_API_KEY), opencode-go (no OPENCODE_GO_KEY)",
      ]);
      const json = JSON.parse(stdout);
      expect(json.gateways).toEqual(["openrouter"]);
      expect(json.models[0].ranked.every(({ gateway }: Row) => gateway === "openrouter")).toBe(true);
    });

    test("--gateway all lists every gateway when the run needs no key", async () => {
      const { stdout } = await run([SLUG, "--gateway", "all", "--json"], { aiKey: null, orKey: null });
      expect(JSON.parse(stdout).gateways).toEqual(["openrouter", "vercel"]);
    });

    test("--verify walks both gateways, each probe with its own gateway's key; only OpenRouter probes are stored", async () => {
      const cache = freshCache();
      process.env.XDG_CACHE_HOME = cache;
      // Vercel's quebec and alpha are answered by another provider, so the walk reaches OpenRouter's alpha/fp8.
      const { code, stdout, calls, probes } = await run([SLUG, "--gateway", "openrouter,vercel", "--verify"], {
        serve: (gateway, provider) => (gateway === "vercel" ? "elsewhere" : provider),
      });
      expect(code).toBe(0);
      expect(probes.map(({ url, body }) => [url, body.model, body.provider ?? body.providerOptions])).toEqual([
        [`${VERCEL}/chat/completions`, "zai/glm-5.3", { gateway: { only: ["quebec"] } }],
        [`${VERCEL}/chat/completions`, "zai/glm-5.3", { gateway: { only: ["alpha"] } }],
        ["https://openrouter.ai/api/v1/chat/completions", SLUG, { only: ["alpha/fp8"], allow_fallbacks: false }],
      ]);
      expect(stdout).toContain("probe vercel:quebec: FAILED (served by elsewhere)");
      expect(stdout).toContain(`verified pin: ${SLUG}:alpha/fp8`);
      const auth = (call: Call) => (call.init.headers as Record<string, string> | undefined)?.Authorization;
      for (const call of calls) {
        const sent = JSON.stringify(call.init.headers ?? {});
        if (call.url.startsWith(VERCEL)) expect(sent).not.toContain(OR_KEY);
        else expect(sent).not.toContain(AI_KEY);
      }
      expect(calls.filter(({ url }) => url === `${VERCEL}/chat/completions`).map(auth)).toEqual([
        `Bearer ${AI_KEY}`,
        `Bearer ${AI_KEY}`,
      ]);
      expect(stdout).not.toContain(AI_KEY);
      expect(readProbes(cache)).toEqual({
        [SLUG]: { "alpha/fp8": { required: { result: "pass", at: expect.any(String) } } },
      });
    });

    test("a Vercel probe with no finalProvider fails", async () => {
      const { stdout } = await run([SLUG, "--gateway", "vercel", "--verify"], {
        serve: () => undefined,
      });
      expect(stdout).toContain("probe vercel:quebec: FAILED (served by an unknown provider)");
    });

    describe("a gateway that refuses the account", () => {
      const refusal = (status: number, message: string) => () =>
        new Response(JSON.stringify({ error: { message, type: "forbidden" } }), { status });
      const FREE = "Free tier users do not have access to this model";
      const count = (text: string, part: string) => text.split(part).length - 1;

      test.each([
        [401, "Invalid API key"],
        [403, "AI Gateway requires a valid credit card on file"],
        [403, FREE],
      ])("HTTP %d stops Vercel probes after the first, says why once, and exits 1", async (status, message) => {
        const { code, output, stdout, probes } = await run([SLUG, "--gateway", "vercel", "--verify"], {
          vercelReply: refusal(status, message),
        });
        expect(code).toBe(1);
        expect(probes).toHaveLength(1);
        expect(stdout).toContain(`probe vercel:quebec: FAILED (HTTP ${status} ${message})`);
        expect(count(output, message)).toBe(1);
        expect(stdout).toContain(
          `no candidate served after 1 probe(s) (vercel refused the account (HTTP ${status}), 2 not probed)`,
        );
      });

      test("under --pick the message goes to stderr once and stdout stays empty", async () => {
        const { code, stdout, stderr, probes } = await run([SLUG, "--gateway", "vercel", "--verify", "--pick"], {
          vercelReply: refusal(403, FREE),
        });
        expect(code).toBe(1);
        expect(probes).toHaveLength(1);
        expect(stdout).toBe("");
        expect(count(stderr, FREE)).toBe(1);
        expect(stderr).toContain("vercel refused the account (HTTP 403), 2 not probed");
      });

      test("the walk goes on through OpenRouter's candidates", async () => {
        const { code, stdout, probes } = await run([SLUG, "--gateway", "openrouter,vercel", "--verify", "--json"], {
          vercelReply: refusal(403, FREE),
        });
        expect(code).toBe(0);
        expect(probes.map(({ url }) => new URL(url).host)).toEqual(["ai-gateway.vercel.sh", "openrouter.ai"]);
        const model = JSON.parse(stdout).models[0];
        expect(model.pick.endpoint).toBe("alpha/fp8");
        // Vercel's alpha ranked between quebec and alpha/fp8, so it was skipped; oscar ranks after the pick.
        expect(model.halted).toEqual([{ gateway: "vercel", status: 403, skipped: 1 }]);
      });
    });
  });

  describe("opencode-go", () => {
    const withKey = { goKey: GO_KEY };
    const GO_ROW = "opencode-go:glm-5.3";
    const GO_LINE = "opp: --gateway opencode-go needs OPENCODE_GO_KEY to list Go's models";
    const refusal = (status: number, message: string) => () =>
      new Response(JSON.stringify({ error: { message } }), { status });
    const GATED = 'Set the workspace privacy setting to "Global regions"';

    /** The whitespace-separated cells of the table row for `endpoint`, under the header's column names. */
    function cells(stdout: string, endpoint: string): Record<string, string> {
      const lines = stdout.split("\n");
      const header = lines
        .find((line) => line.includes("endpoint") && line.includes("ttfb"))!
        .trim()
        .split(/\s+/);
      const row = lines.find((line) => new RegExp(`\\s${endpoint.replace(".", "\\.")}\\s`).test(line))!;
      const values = row.trim().split(/\s+/);
      return Object.fromEntries(header.map((name, i) => [name, values[i]!]));
    }

    test("--help names the gateway, its key and what a Go row lacks", async () => {
      const { stdout } = await run(["--help"]);
      expect(stdout).toContain("vercel, opencode-go, cloudflare, or all");
      expect(stdout).toContain("OPENCODE_GO_KEY for OpenCode Go");
      expect(stdout).toContain("can't be pinned");
    });

    describe("the key", () => {
      test.each([[["--gateway", "opencode-go"]], [["--gateway", "openrouter,opencode-go", "--verify"]]])(
        "%j without OPENCODE_GO_KEY exits 2 before any request",
        async (flags) => {
          const { code, calls, stdout, stderr } = await run([SLUG, ...flags]);
          expect(code).toBe(2);
          expect(calls).toHaveLength(0);
          expect(stdout).toBe("");
          expect(stderr).toBe(GO_LINE);
        },
      );

      test("--gateway all skips Go on one stderr line and lists the rest", async () => {
        const { code, stdout, stderr, toGo } = await run([SLUG, "--gateway", "all", "--json"]);
        expect(code).toBe(0);
        expect(toGo).toHaveLength(0);
        expect(stderr.split("\n").filter((line) => line.includes("opencode-go"))).toEqual([
          "opp: --gateway all: skipping opencode-go (no OPENCODE_GO_KEY)",
        ]);
        expect(JSON.parse(stdout).gateways).toEqual(["openrouter", "vercel"]);
      });

      test("--gateway all with the key lists Go too, and says nothing", async () => {
        const { stdout, stderr, toGo } = await run([SLUG, "--gateway", "all", "--json"], withKey);
        expect(JSON.parse(stdout).gateways).toEqual(["openrouter", "vercel", "opencode-go"]);
        expect(stderr).toBe("");
        expect(toGo).toHaveLength(1);
      });

      test("the key goes to Go alone, and never into the output, even when Go echoes it", async () => {
        const echo = refusal(401, `Invalid key ${GO_KEY}`);
        const { stdout, stderr, calls } = await run([SLUG, "--gateway", "openrouter,vercel,opencode-go"], {
          ...withKey,
          go: echo,
        });
        expect(stdout).toContain("  opencode-go: HTTP 401: Invalid key [redacted]");
        expect(stdout + stderr).not.toContain(GO_KEY);
        for (const { url, init } of calls) {
          expect(JSON.stringify(init.headers ?? {}).includes(GO_KEY)).toBe(url.startsWith(GO));
        }
      });
    });

    describe("listing", () => {
      test("a Go model is one unnamed row with every stat unknown, and no OpenRouter request is made for it", async () => {
        const { stdout, calls } = await run([SLUG, "--gateway", "opencode-go", "--json"], withKey);
        const [model] = JSON.parse(stdout).models;
        expect(model.ranked).toEqual([
          expect.objectContaining({
            rank: 1,
            gateway: "opencode-go",
            endpoint: "glm-5.3",
            provider: "glm-5.3",
            quantization: null,
            headquarters: null,
            zdr: null,
            uptime: { last1d: null, last30m: null, last5m: null },
            turnMs: null,
            ttfbMsP50: null,
            tokensPerSecondP50: null,
            maxCompletionTokens: null,
            usdPerMillion: { input: null, cacheRead: null, output: null },
            referenceRunUsd: null,
            priceEliminated: false,
            pinnable: false,
            toolChoiceVerified: false,
            toolChoiceSource: {
              none: "unverified",
              auto: "unverified",
              required: "unverified",
              function: "unverified",
            },
          }),
        ]);
        expect(calls.some(({ url }) => url.endsWith("/endpoints"))).toBe(false);
        const [list] = calls.filter(({ url }) => url.startsWith(GO));
        expect(list!.url).toBe(`${GO}/models`);
        expect((list!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${GO_KEY}`);
      });

      test("every ranked row says whether it can be pinned", async () => {
        const model = await jsonModel(["--gateway", "all"], withKey);
        const pinnable = Object.fromEntries(
          model.ranked.map((row: Row & { pinnable: boolean }) => [row.gateway, row.pinnable]),
        );
        expect(pinnable).toEqual({ openrouter: true, vercel: true, "opencode-go": false });
      });

      test("the id match ignores case and takes the model part alone", async () => {
        const mixed = await run(["example/EXAMPLE-mixed", "--gateway", "opencode-go", "--pick"], withKey);
        expect(mixed.stdout).toBe("opencode-go:Example-Mixed");
        const other = await run(["example/glm-5", "--gateway", "opencode-go", "--pick"], withKey);
        expect(other.code).toBe(1);
        expect(other.stderr).toBe("opp: example/glm-5: fetch failed: opencode-go: not listed");
      });

      test("a model Go doesn't list is a note under the model, on --pick's stderr and in --json", async () => {
        const slug = "z-ai/not-on-go";
        const text = await run([slug, "--gateway", "openrouter,opencode-go"], withKey);
        expect(text.code).toBe(0);
        expect(text.stdout).toContain("  opencode-go: not listed");
        expect(text.stdout).toContain(`pin: ${slug}:alpha/fp8`);
        const picked = await run([slug, "--gateway", "openrouter,opencode-go", "--pick"], withKey);
        expect(picked.stdout).toBe("alpha/fp8");
        expect(picked.stderr).toBe(`opp: ${slug}: opencode-go: not listed`);
        const json = JSON.parse((await run([slug, "--gateway", "openrouter,opencode-go", "--json"], withKey)).stdout);
        expect(json.models[0].gatewayErrors).toEqual([{ gateway: "opencode-go", error: "not listed" }]);
      });

      test("with Go alone that is a fetch failure and exit 1", async () => {
        const { code, stdout } = await run(["z-ai/not-on-go", "--gateway", "opencode-go"], withKey);
        expect(code).toBe(1);
        expect(stdout).toContain("fetch failed: opencode-go: not listed");
      });

      test("a failed Go fetch leaves OpenRouter's rows ranked alone", async () => {
        const { code, stdout } = await run([SLUG, "--gateway", "openrouter,opencode-go"], {
          ...withKey,
          go: refusal(503, "down"),
        });
        expect(code).toBe(0);
        expect(stdout).toContain("  opencode-go: HTTP 503: down");
      });

      test("the text output flags the row tc?, says it isn't pinnable and prints no routing", async () => {
        const { stdout } = await run([SLUG, "--gateway", "opencode-go"], withKey);
        expect(stdout).toContain("# eligible (opencode-go): native tools");
        expect(stdout).toContain(
          "# opencode-go rows: no listed stats; --verify fills ttfb, and its allowance is the cost",
        );
        expect(stdout).toContain("# tc?: tool_choice listed without per-mode support or an OpenRouter verdict");
        expect(stdout).toContain(
          "# fees: OpenRouter adds 5.5% (min $0.80) to card credit purchases; OpenCode Go is a flat-rate subscription. $run includes neither.",
        );
        expect(stdout).toMatch(/▶ +1 +glm-5\.3 .* tc\?$/m);
        expect(stdout).toContain("  pin: glm-5.3 opencode-go:glm-5.3 (not pinnable: Go names no provider)");
        expect(stdout).not.toContain("routing:");
        expect(cells(stdout, "glm-5.3")).toMatchObject({ ttfb: "-", turn_s: "-", $run: "-", $in: "-" });
      });

      test("with all three gateways the fees note names each", async () => {
        const { stdout } = await run([SLUG, "--gateway", "all"], withKey);
        expect(stdout).toContain(
          "# fees: OpenRouter adds 5.5% (min $0.80) to card credit purchases; Vercel AI Gateway adds no markup; " +
            "OpenCode Go is a flat-rate subscription. $run includes none of them.",
        );
      });
    });

    describe("picking", () => {
      test("without --verify a Go row ranks after every row with figures, so OpenRouter's is picked", async () => {
        expect((await run([SLUG, "--gateway", "openrouter,opencode-go", "--pick"], withKey)).stdout).toBe("alpha/fp8");
        const model = await jsonModel(["--gateway", "openrouter,opencode-go"], withKey);
        expect(ids(model.ranked)).toEqual(["openrouter:alpha/fp8", "openrouter:lima", GO_ROW]);
      });

      test("Go is picked when no other listed gateway has an eligible row", async () => {
        const down = [ep("quebec", { provider_name: "Quebec", status: -1 })];
        const both = await run([SLUG, "--gateway", "openrouter,opencode-go", "--pick"], { ...withKey, list: down });
        expect(both.stdout).toBe(GO_ROW);
        const alone = await run([SLUG, "--gateway", "opencode-go", "--pick"], withKey);
        expect(alone).toMatchObject({ code: 0, stdout: GO_ROW });
      });

      test("a Go row above a price-eliminated row still isn't picked while another row is ranked", async () => {
        // -p hides the cheap row after ranking, so the price-eliminated one is all that is left beside Go's.
        const pricey = { prompt: "0.00001", input_cache_read: "0.000001", completion: "0.00004" };
        const list = [ep("cheap"), ep("costly", { pricing: pricey })];
        const flags = ["--gateway", "openrouter,opencode-go", "-p", "costly,glm-5.3"];
        const model = await jsonModel(flags, { ...withKey, list });
        expect(ids(model.ranked)).toEqual([GO_ROW, "openrouter:costly"]);
        expect(model.ranked[1].priceEliminated).toBe(true);
        expect(model.pick.endpoint).toBe("costly");
        expect((await run([SLUG, ...flags, "--pick"], { ...withKey, list })).stdout).toBe("costly");
      });

      test("a Go pick has no routing in --json, and its pin is the Go id", async () => {
        const model = await jsonModel(["--gateway", "opencode-go"], withKey);
        expect(model.pick).toEqual({
          pin: "glm-5.3 opencode-go:glm-5.3",
          gateway: "opencode-go",
          model: "glm-5.3",
          endpoint: "glm-5.3",
          provider: "glm-5.3",
          routing: null,
          verified: false,
          quantizationReported: false,
        });
      });
    });

    describe("--verify", () => {
      test("probes every Go row once even when the walk stopped earlier; the first to serve is still the pick", async () => {
        const cache = freshCache();
        process.env.XDG_CACHE_HOME = cache;
        const { code, stdout, probes, toGo } = await run(
          [SLUG, "--gateway", "openrouter,opencode-go", "--verify", "--json"],
          withKey,
        );
        expect(code).toBe(0);
        expect(probes.map(({ url }) => new URL(url).host)).toEqual(["openrouter.ai", "opencode.ai"]);
        const model = JSON.parse(stdout).models[0];
        expect(model.pick).toMatchObject({ endpoint: "alpha/fp8", verified: true });
        expect(model.probes).toEqual([
          expect.objectContaining({ gateway: "openrouter", endpoint: "alpha/fp8", ok: true, ttfbMs: null, cost: null }),
          expect.objectContaining({ gateway: "opencode-go", endpoint: "glm-5.3", ok: true, cost: 0.0012 }),
        ]);
        expect(Number.isInteger(model.probes[1].ttfbMs)).toBe(true);
        expect(model.notProbed).toBe(0);
        // The ranking keeps no latency for Go; only the probe has one.
        const row = model.ranked.find(({ gateway }: Row) => gateway === "opencode-go");
        expect(row.ttfbMsP50).toBeNull();
        // Go probes are never stored, and the request names Go's id with no routing.
        expect(readProbes(cache)).toEqual({
          [SLUG]: { "alpha/fp8": { required: { result: "pass", at: expect.any(String) } } },
        });
        const request = toGo.find(({ url }) => url.endsWith("/chat/completions"))!;
        const sent = JSON.parse(String(request.init.body));
        expect(sent).toMatchObject({ model: "glm-5.3", tool_choice: "required" });
        expect(sent).not.toHaveProperty("provider");
        expect(sent).not.toHaveProperty("providerOptions");
        const headers = request.init.headers as Record<string, string>;
        expect(headers["User-Agent"]).toMatch(/^opp\/\d+\.\d+\.\d+/);
        expect(headers["x-opencode-session"]).toMatch(/^[0-9a-f-]{36}$/);
      });

      test("the Go row's ttfb cell shows the probe's, and the probe line reads its allowance", async () => {
        const { stdout } = await run([SLUG, "--gateway", "openrouter,opencode-go", "--verify"], withKey);
        const line = stdout.match(
          /probe opencode-go:glm-5\.3: ok \(ttfb (\d+) ms, allowance \$0\.0012, finish=tool_calls\)/,
        );
        expect(line).not.toBeNull();
        expect(cells(stdout, "glm-5.3")).toMatchObject({ ttfb: line![1], "tok/s": "-", turn_s: "-", $run: "-" });
        expect(stdout).toContain(`verified pin: ${SLUG}:alpha/fp8`);
      });

      test("a Go pick is verified through its own probe, printing no routing", async () => {
        const { code, stdout, probes } = await run([SLUG, "--gateway", "opencode-go", "--verify"], withKey);
        expect(code).toBe(0);
        expect(probes).toHaveLength(1);
        expect(stdout).toContain("verified pin: glm-5.3 opencode-go:glm-5.3 (not pinnable: Go names no provider)");
        expect(stdout).not.toContain("routing:");
      });

      test("a region-gated model shows Go's HTTP 400 in the probe line, stays listed, and crashes nothing", async () => {
        const goReply = refusal(400, GATED);
        const alone = await run([SLUG, "--gateway", "opencode-go", "--verify"], { ...withKey, goReply });
        expect(alone.code).toBe(1);
        expect(alone.stdout).toContain(`probe opencode-go:glm-5.3: FAILED (HTTP 400 ${GATED})`);
        expect(alone.stdout).toContain("no candidate served after 1 probe(s)");
        expect(alone.stdout).toMatch(/ 1 +glm-5\.3 /);
        const both = await run([SLUG, "--gateway", "openrouter,opencode-go", "--verify"], { ...withKey, goReply });
        expect(both.code).toBe(0);
        expect(both.stdout).toContain(`probe opencode-go:glm-5.3: FAILED (HTTP 400 ${GATED})`);
        expect(both.stdout).toContain(`verified pin: ${SLUG}:alpha/fp8`);
        expect(cells(both.stdout, "glm-5.3")).toMatchObject({ ttfb: "-" });
      });

      test("under --pick a failed Go probe is told once on stderr", async () => {
        const goReply = refusal(400, GATED);
        const { code, stdout, stderr } = await run([SLUG, "--gateway", "opencode-go", "--verify", "--pick"], {
          ...withKey,
          goReply,
        });
        expect(code).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toBe(`opp: ${SLUG}: no candidate served after 1 probe(s)`);
      });
    });

    describe("--probe", () => {
      test("sends all four modes to the Go model, prints a line each, and stores nothing", async () => {
        const cache = freshCache();
        process.env.XDG_CACHE_HOME = cache;
        // A model told tool_choice none answers in text; the others call the tool.
        const plain = { choices: [{ finish_reason: "stop", message: { content: "Done." } }], usage: GO_CALL.usage };
        const goReply = ({ tool_choice }: Record<string, unknown>) =>
          new Response(JSON.stringify(tool_choice === "none" ? plain : GO_CALL));
        const { code, stdout, probes, calls } = await run([SLUG, "--probe", "glm-5.3", "--gateway", "opencode-go"], {
          ...withKey,
          goReply,
          orKey: null,
        });
        expect(code).toBe(0);
        expect(probes.map(({ body }) => body.tool_choice)).toEqual([
          "none",
          "auto",
          "required",
          { type: "function", function: { name: "ok" } },
        ]);
        expect(calls.every(({ url }) => url.startsWith(GO) || url.startsWith("https://opencode.ai"))).toBe(true);
        expect(stdout.split("\n")).toEqual([
          expect.stringMatching(
            /^glm-5\.3 {2}none {2}ok {2}listed: \? {2}ttfb \d+ ms, allowance \$0\.0012, no tool call, finish=stop$/,
          ),
          expect.stringMatching(
            /^glm-5\.3 {2}auto {2}ok {2}listed: \? {2}ttfb \d+ ms, allowance \$0\.0012, finish=tool_calls$/,
          ),
          expect.stringMatching(/^glm-5\.3 {2}required {2}ok /),
          expect.stringMatching(/^glm-5\.3 {2}function {2}ok /),
        ]);
        expect(existsSync(join(cache, "opp", "probes.json"))).toBe(false);
      });

      test("an unknown tag, an unlisted model and a missing key fail without a probe", async () => {
        const unknown = await run([SLUG, "--probe", "nope", "--gateway", "opencode-go"], withKey);
        expect(unknown).toMatchObject({ code: 1, stdout: `nope: no such endpoint for ${SLUG}`, probes: [] });
        const unlisted = await run(["z-ai/not-on-go", "--probe", "x", "--gateway", "opencode-go"], withKey);
        expect(unlisted).toMatchObject({
          code: 1,
          stderr: "opp: z-ai/not-on-go: fetch failed: not listed",
          probes: [],
        });
        const keyless = await run([SLUG, "--probe", "glm-5.3", "--gateway", "opencode-go"]);
        expect(keyless).toMatchObject({ code: 2, stderr: GO_LINE });
        expect(keyless.calls).toHaveLength(0);
      });
    });
  });
});
