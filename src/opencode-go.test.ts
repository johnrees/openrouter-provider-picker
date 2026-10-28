import { describe, expect, spyOn, test } from "bun:test";
import { opencodeGoFixture } from "./fixtures.ts";
import {
  allowanceOf,
  fetchOpenCodeGoEndpoints,
  fmtAllowance,
  normalise,
  OPENCODE_GO_SESSION,
  OPENCODE_GO_USER_AGENT,
  opencodeGoModel,
  resolveOpenCodeGoAuth,
} from "./opencode-go.ts";
import { pinnable, rank } from "./policy.ts";
import { ep } from "./fixtures.ts";

const KEY = "test-go-secret-key";

async function listWith(reply: () => Response, slug = "z-ai/glm-5.3") {
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async () => reply()) as unknown as typeof fetch);
  try {
    const result = await fetchOpenCodeGoEndpoints(slug, KEY).catch((error: Error) => error);
    return { result, calls: [...fetchMock.mock.calls] as [string, RequestInit][] };
  } finally {
    fetchMock.mockRestore();
  }
}
const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status });

describe("the model id", () => {
  test("is the slug's model part, lowercase", () => {
    expect(opencodeGoModel("z-ai/glm-5.3")).toBe("glm-5.3");
    expect(opencodeGoModel("Example/Agent-1")).toBe("agent-1");
  });
});

describe("normalise", () => {
  test("a model is one unnamed row with no stats, eligible but unverified", () => {
    expect(normalise({ id: "glm-5.3", object: "model", created: 1, owned_by: "opencode" })).toEqual({
      gateway: "opencode-go",
      provider_name: "glm-5.3",
      tag: "glm-5.3",
      status: 0,
      supported_parameters: ["tools", "tool_choice"],
      tool_choice_unverified: true,
      pricing: {},
    });
  });

  test("a row that fails the OpenRouter checks is malformed, and a Go row can't be pinned", () => {
    for (const row of [null, {}, { id: 3 }, { id: "" }, { id: "bad\u001b[2J" }]) expect(normalise(row)).toBeUndefined();
    expect(pinnable(normalise({ id: "glm-5.3" })!)).toBe(false);
    expect(pinnable(ep("a"))).toBe(true);
  });

  test("with every stat unknown, a Go row ranks after the rows with figures and before a price-eliminated one", () => {
    const go = normalise({ id: "glm-5.3" })!;
    const costly = ep("costly", {
      pricing: { prompt: "0.00004", input_cache_read: "0.000004", completion: "0.00016" },
    });
    const ranked = rank([costly, go, ep("a", { uptime_last_1d: 90, uptime_last_30m: 90 }), ep("b")]);
    expect(ranked.map(({ endpoint, priceEliminated }) => [endpoint.tag, priceEliminated])).toEqual([
      ["b", false],
      ["a", false],
      ["glm-5.3", false],
      ["costly", true],
    ]);
  });
});

describe("fetchOpenCodeGoEndpoints", () => {
  test("asks for the model list with the key, sent to Go alone, and returns the row whose id matches", async () => {
    const { result, calls } = await listWith(json(opencodeGoFixture));
    expect(result).toMatchObject({ endpoints: [{ tag: "glm-5.3" }], malformed: 0 });
    const [url, init] = calls[0]!;
    expect(url).toBe("https://opencode.ai/inference/go/v1/models");
    expect(init.headers).toEqual({ Authorization: `Bearer ${KEY}` });
    expect(init.redirect).toBe("error");
  });

  test("the id matches the model part exactly, ignoring case on either side", async () => {
    const { result } = await listWith(json(opencodeGoFixture), "example/EXAMPLE-mixed");
    expect(result).toMatchObject({ endpoints: [{ tag: "Example-Mixed" }] });
    const prefix = await listWith(json(opencodeGoFixture), "z-ai/glm");
    expect(String(prefix.result)).toContain("not listed");
  });

  test("a model Go doesn't list is an error", async () => {
    const { result } = await listWith(json(opencodeGoFixture), "z-ai/other-model");
    expect(result).toEqual(new Error("not listed"));
  });

  test("a matching row that is malformed is counted, not listed", async () => {
    const { result } = await listWith(json({ data: [{ id: "glm\u0007" }, { id: "glm-5.3" }] }), "z-ai/glm\u0007");
    expect(result).toEqual({ endpoints: [], malformed: 1 });
  });

  test("an HTTP error names its status and message; a body with no list is unexpected", async () => {
    const denied = await listWith(json({ error: { message: "Invalid key" } }, 401));
    expect(denied.result).toEqual(new Error("HTTP 401: Invalid key"));
    const plain = await listWith(json({ error: "Invalid key" }, 401));
    expect(plain.result).toEqual(new Error("HTTP 401: Invalid key"));
    const odd = await listWith(json({ models: [] }));
    expect(odd.result).toEqual(new Error("unexpected response: no data array"));
  });
});

describe("a reply's allowance", () => {
  test("is usage.opencode.allowance, when it is a finite non-negative number", () => {
    const reply = (allowance: unknown) => ({ usage: { opencode: { allowance, list_cost: 9 } } });
    expect(allowanceOf(reply(0.0012))).toBe(0.0012);
    expect(allowanceOf(reply(0))).toBe(0);
    for (const bad of [-1, "0.1", null, Number.NaN]) expect(allowanceOf(reply(bad))).toBeUndefined();
    expect(allowanceOf({ usage: { cost: 1 } })).toBeUndefined();
    expect(allowanceOf(null)).toBeUndefined();
  });

  test("shows to four decimals, and two significant figures below a hundredth of a cent", () => {
    expect(fmtAllowance(0.0012)).toBe("$0.0012");
    expect(fmtAllowance(0)).toBe("$0.0000");
    expect(fmtAllowance(0.0000312)).toBe("$0.000031");
    expect(fmtAllowance(0.00001)).toBe("$0.000010");
  });
});

describe("identity", () => {
  test("the user agent names opp and its version; the session is one UUID per run", () => {
    expect(OPENCODE_GO_USER_AGENT).toMatch(/^opp\/\d+\.\d+\.\d+/);
    expect(OPENCODE_GO_SESSION).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("the key comes from OPENCODE_GO_KEY, trimmed; a blank one is none", () => {
    expect(resolveOpenCodeGoAuth({ OPENCODE_GO_KEY: ` ${KEY} ` })).toEqual({ key: KEY, source: "OPENCODE_GO_KEY" });
    expect(resolveOpenCodeGoAuth({ OPENCODE_GO_KEY: "  " })).toBeUndefined();
    expect(resolveOpenCodeGoAuth({})).toBeUndefined();
  });
});
