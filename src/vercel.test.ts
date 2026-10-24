import { describe, expect, spyOn, test } from "bun:test";
import { ep, vercelFixture, vercelFixtureRows } from "./fixtures.ts";
import { referenceRunCost } from "./policy.ts";
import { probeBody } from "./probe.ts";
import {
  borrowToolChoice,
  fetchVercelEndpoints,
  normalise,
  servedProvider,
  toOpenRouterSlug,
  toVercelSlug,
  vercelModel,
  vercelRouting,
} from "./vercel.ts";

const row = (provider: string) =>
  vercelFixtureRows.find((r) => (r as { provider_name?: unknown }).provider_name === provider)!;

describe("aliases", () => {
  test("the map covers model creators and providers, both ways, and leaves other slugs unchanged", () => {
    expect(vercelModel("z-ai/glm-5.3")).toBe("zai/glm-5.3");
    expect(vercelModel("example/agent-1")).toBe("example/agent-1");
    expect(toVercelSlug("together")).toBe("togetherai");
    expect(toVercelSlug("amazon-bedrock")).toBe("bedrock");
    expect(toOpenRouterSlug("bedrock")).toBe("amazon-bedrock");
    expect(toOpenRouterSlug("togetherai")).toBe("together");
    expect(toVercelSlug("google-vertex")).toBe("vertex");
    expect(toOpenRouterSlug("vertex")).toBe("google-vertex");
    expect(toOpenRouterSlug("fireworks")).toBe("fireworks");
    expect(toOpenRouterSlug("constructor")).toBe("constructor");
  });
});

describe("normalise", () => {
  test("maps Vercel's windows onto the slots ranking reads, keyed by the provider slug", () => {
    expect(normalise(row("alpha"))).toEqual({
      gateway: "vercel",
      provider_name: "alpha",
      tag: "alpha",
      status: 0,
      quantization: "fp8",
      max_completion_tokens: 100000,
      supported_parameters: ["max_tokens", "temperature", "tools", "tool_choice", "reasoning"],
      has_zdr: true,
      uptime_last_5m: 100,
      uptime_last_30m: 100,
      uptime_last_1d: 100,
      latency_last_30m: { p50: 400 },
      throughput_last_30m: { p50: 100 },
      pricing: {
        prompt: "0.000001",
        completion: "0.000004",
        input_cache_read: "0.0000001",
        internal_reasoning: "0",
        request: "0",
      },
    });
  });

  test("the 1h uptime ranks and the 15m uptime is shown; a missing ZDR flag is unknown", () => {
    const quebec = normalise(row("quebec"))!;
    expect([quebec.uptime_last_1d, quebec.uptime_last_30m, quebec.uptime_last_5m]).toEqual([99.5, 100, 100]);
    expect(normalise(row("oscar"))!.has_zdr).toBeNull();
  });

  test("the discount and region prices don't change the price", () => {
    const quebec = normalise(row("quebec"))!;
    expect(quebec.pricing).not.toHaveProperty("discount");
    // $1.5/M in, $0.15/M cache read, $6/M out: 0.75 + 2.25 + 0.18.
    expect(referenceRunCost(quebec)).toBeCloseTo(3.18);
  });

  test("rows that fail the OpenRouter checks are malformed", () => {
    expect(normalise(row("sierra"))).toBeUndefined();
    expect(normalise(null)).toBeUndefined();
    expect(normalise({ ...(row("alpha") as object), provider_name: "bad\u001b[2J" })).toBeUndefined();
    expect(normalise({ ...(row("alpha") as object), quantization: "fp8\n" })).toBeUndefined();
  });
});

describe("fetchVercelEndpoints", () => {
  test("asks for the aliased model with no key and counts malformed rows", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response(JSON.stringify(vercelFixture))) as unknown as typeof fetch,
    );
    try {
      const { endpoints, malformed } = await fetchVercelEndpoints("z-ai/glm-5.3");
      expect(endpoints.map(({ tag }) => tag)).toEqual(["alpha", "mike", "oscar", "papa", "quebec"]);
      expect(malformed).toBe(1);
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe("https://ai-gateway.vercel.sh/v1/models/zai/glm-5.3/endpoints");
      expect(init.headers).toBeUndefined();
      expect(init.redirect).toBe("error");
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("an HTTP error names its status and message", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(JSON.stringify({ error: { message: "Model not found" } }), {
          status: 404,
        })) as unknown as typeof fetch,
    );
    try {
      await expect(fetchVercelEndpoints("m/x")).rejects.toThrow("HTTP 404: Model not found");
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe("tool_choice verdicts", () => {
  const vercel = (tag: string, parameters = ["tools", "tool_choice"]) =>
    ({ ...normalise(row("alpha"))!, provider_name: tag, tag, supported_parameters: parameters }) as const;

  test("a row borrows its provider's verdict through the alias map: a mode counts only if every endpoint lists it", () => {
    const openrouter = [
      ep("together", { provider_name: "Together" }),
      ep("together/fp8", {
        provider_name: "Together",
        supports_tool_choice: { none: true, auto: true, required: true, function: false },
      }),
      ep("other"),
    ];
    const [borrowed] = borrowToolChoice([vercel("togetherai")], openrouter);
    expect(borrowed).toMatchObject({
      tool_choice_from: "together",
      supports_tool_choice: { none: true, auto: true, required: true, function: false },
    });
    expect(borrowed).not.toHaveProperty("tool_choice_unverified");
  });

  test("a row with no OpenRouter counterpart, or no OpenRouter listing, is unverified", () => {
    expect(borrowToolChoice([vercel("oscar")], [ep("other")])[0]).toMatchObject({ tool_choice_unverified: true });
    expect(borrowToolChoice([vercel("oscar")], undefined)[0]).toMatchObject({ tool_choice_unverified: true });
  });

  test("a row that lists no tool_choice is left as it is, so it is ineligible", () => {
    const [papa] = borrowToolChoice([vercel("papa", ["tools"])], [ep("papa")]);
    expect(papa).not.toHaveProperty("tool_choice_unverified");
    expect(papa).not.toHaveProperty("tool_choice_from");
  });
});

describe("pins and probes", () => {
  test("a Vercel pin restricts routing to the provider slug", () => {
    expect(vercelRouting(normalise(row("quebec"))!)).toEqual({ gateway: { only: ["quebec"] } });
  });

  test("a Vercel probe asks for Vercel's model id with providerOptions, not OpenRouter's provider", () => {
    const body = probeBody("z-ai/glm-5.3", normalise(row("quebec"))!, [], "required");
    expect(body.model).toBe("zai/glm-5.3");
    expect(body.providerOptions).toEqual({ gateway: { only: ["quebec"] } });
    expect(body).not.toHaveProperty("provider");
  });

  test("the served provider is the message's routing.finalProvider, else its resolvedProvider", () => {
    const reply = (routing: unknown) => ({ choices: [{ message: { provider_metadata: { gateway: { routing } } } }] });
    expect(servedProvider(reply({ finalProvider: "quebec", resolvedProvider: "other" }))).toBe("quebec");
    expect(servedProvider(reply({ resolvedProvider: "quebec" }))).toBe("quebec");
    expect(servedProvider(reply({}))).toBeUndefined();
    // Only that path counts: not the top level, and not camelCase.
    const routing = { gateway: { routing: { finalProvider: "quebec" } } };
    expect(servedProvider({ provider_metadata: routing })).toBeUndefined();
    expect(servedProvider({ choices: [{ message: { providerMetadata: routing } }] })).toBeUndefined();
    expect(servedProvider({ provider: "quebec" })).toBeUndefined();
    expect(servedProvider(null)).toBeUndefined();
  });
});
