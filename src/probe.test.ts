import { describe, expect, spyOn, test } from "bun:test";
import { ep } from "./fixtures.ts";
import type { ToolChoiceMode } from "./policy.ts";
import { normalise } from "./opencode-go.ts";
import { probe, probeBody, retryDelay, servedQuantization, toolCallProblem, verify } from "./probe.ts";

describe("retry", () => {
  test("Retry-After sets the retry wait, capped, with a default when absent or a date", () => {
    expect(retryDelay("0")).toBe(0);
    expect(retryDelay("3")).toBe(3_000);
    expect(retryDelay("120")).toBe(10_000);
    expect(retryDelay(null)).toBe(2_000);
    expect(retryDelay("")).toBe(2_000);
    expect(retryDelay("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(2_000);
  });
});

describe("unpinned requests", () => {
  test("the body without an endpoint carries no routing preferences", () => {
    const pinned = probeBody("m/x", ep("a"), [ep("a")], "required");
    const unpinned = probeBody("m/x", null, [ep("a")], "required");
    expect(unpinned).not.toHaveProperty("provider");
    const { provider: _, ...rest } = pinned;
    expect(unpinned).toEqual(rest);
  });

  test("a required tool call is judged the same way for every caller", () => {
    const reply = (finish: string, args: string) => ({
      choices: [{ finish_reason: finish, message: { tool_calls: [{ function: { name: "ok", arguments: args } }] } }],
    });
    expect(toolCallProblem(reply("tool_calls", "{}"))).toBeUndefined();
    expect(toolCallProblem(reply("tool_calls", ""))).toBeUndefined();
    expect(toolCallProblem(reply("length", "{}"))).toBe("unusable ok tool call, finish=length");
    expect(toolCallProblem(reply("tool_calls", "[]"))).toBe("unusable ok tool call, finish=tool_calls");
    expect(toolCallProblem(null)).toBe("no finished completion, finish=none");
  });

  test("quantization comes from the served provider's endpoints at the served tier, when they agree", () => {
    const list = [
      ep("a/fp8", { provider_name: "A", quantization: "fp8" }),
      ep("b/fp8", { provider_name: "B", quantization: "fp8" }),
      ep("b/bf16", { provider_name: "B", quantization: "bf16" }),
      ep("b/flex", { provider_name: "B", quantization: "fp4", service_tier: "flex" }),
    ];
    expect(servedQuantization("a", null, list)).toBe("fp8");
    expect(servedQuantization("A", "default", list)).toBe("fp8");
    expect(servedQuantization("B", null, list)).toBeNull();
    expect(servedQuantization("B", "default", list)).toBeNull();
    expect(servedQuantization("B", "flex", list)).toBe("fp4");
    expect(servedQuantization("C", null, list)).toBeNull();
  });
});

describe("inconclusive probes", () => {
  const auth = { key: "sk-or-v1-test", source: "test" };
  const timeout = () => new DOMException("The operation timed out.", "TimeoutError");

  async function probeWith(reply: () => Response | Promise<Response>, mode: ToolChoiceMode = "required") {
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async () => reply()) as unknown as typeof fetch);
    try {
      return { outcome: await probe("m/x", ep("a"), [], auth, mode), calls: fetchMock.mock.calls.length };
    } finally {
      fetchMock.mockRestore();
    }
  }

  test("a timeout is busy and inconclusive, without a retry", async () => {
    const { outcome, calls } = await probeWith(() => {
      throw timeout();
    });
    expect(outcome).toMatchObject({ ok: false, busy: true, conclusive: false });
    expect(calls).toBe(1);
  });

  test("a timeout while reading the body is a timeout too", async () => {
    const stalled = new ReadableStream({ pull: (controller) => controller.error(timeout()) });
    const { outcome } = await probeWith(() => new Response(stalled));
    expect(outcome).toMatchObject({ ok: false, busy: true, conclusive: false });
  });

  test.each([400, 401, 402, 403, 404, 501])("an HTTP %d error is inconclusive but not busy", async (status) => {
    const { outcome } = await probeWith(
      () => new Response(JSON.stringify({ error: { message: "account", code: status } }), { status }),
    );
    expect(outcome).toMatchObject({ ok: false, busy: false, conclusive: false });
    expect(outcome).not.toHaveProperty("refused");
  });

  test.each([401, 403])("Vercel's HTTP %d refuses the account; other statuses don't", async (status) => {
    const vercel = ep("a", { gateway: "vercel" });
    const reply = (code: number) => () => new Response(JSON.stringify({ error: "no access" }), { status: code });
    const refuse = spyOn(globalThis, "fetch").mockImplementation((async () =>
      reply(status)()) as unknown as typeof fetch);
    try {
      const outcome = await probe("m/x", vercel, [], auth);
      expect(outcome).toMatchObject({ ok: false, busy: false, conclusive: false, refused: status });
      expect(outcome.detail).toBe(`HTTP ${status} no access`);
    } finally {
      refuse.mockRestore();
    }
    const other = spyOn(globalThis, "fetch").mockImplementation((async () => reply(404)()) as unknown as typeof fetch);
    try {
      expect(await probe("m/x", vercel, [], auth)).not.toHaveProperty("refused");
    } finally {
      other.mockRestore();
    }
  });

  test("a reset while reading the body is inconclusive", async () => {
    const reset = new ReadableStream({ pull: (controller) => controller.error(new TypeError("socket closed")) });
    const { outcome } = await probeWith(() => new Response(reset));
    expect(outcome).toMatchObject({ ok: false, busy: false, conclusive: false });
  });

  test("a connection failure is inconclusive but not busy", async () => {
    const { outcome, calls } = await probeWith(() => {
      throw new TypeError("fetch failed");
    });
    expect(outcome).toMatchObject({ ok: false, busy: false, conclusive: false });
    expect(calls).toBe(1);
  });

  test.each([
    { finish_reason: "length", message: { content: null } },
    { finish_reason: "error", message: { content: null } },
    { finish_reason: "content_filter", message: { content: "" } },
    { finish_reason: "stop" },
  ])("an unfinished reply, %j, is inconclusive", async (choice) => {
    const { outcome } = await probeWith(() => new Response(JSON.stringify({ provider: "a", choices: [choice] })));
    expect(outcome).toMatchObject({ ok: false, busy: false, conclusive: false });
  });

  const call = { function: { name: "ok", arguments: "{}" } };
  test.each([
    [
      "a tool call cut off by the token budget",
      { provider: "a", choices: [{ finish_reason: "length", message: { tool_calls: [call] } }] },
    ],
    [
      "a reply from another provider",
      { provider: "b", choices: [{ finish_reason: "tool_calls", message: { tool_calls: [call] } }] },
    ],
    ["a reply that is not JSON", "<html>"],
    [
      "text cut off by the token budget",
      { provider: "a", choices: [{ finish_reason: "length", message: { content: "Sure" } }] },
    ],
    ["an error with no status", { error: { message: "Internal error" } }],
    ["a server error", { error: { message: "Not implemented", code: 501 } }],
  ])("%s is inconclusive", async (_, body) => {
    const { outcome } = await probeWith(() => new Response(typeof body === "string" ? body : JSON.stringify(body)));
    expect(outcome).toMatchObject({ ok: false, busy: false, conclusive: false });
  });

  test("a wrong reply or a pass is conclusive, and so is a call under none", async () => {
    const text = { finish_reason: "stop", message: { content: "no" } };
    const plain = await probeWith(() => new Response(JSON.stringify({ provider: "a", choices: [text] })));
    expect(plain.outcome).toMatchObject({ ok: false, busy: false, conclusive: true });
    const called = { finish_reason: "tool_calls", message: { tool_calls: [call] } };
    const pass = await probeWith(() => new Response(JSON.stringify({ provider: "a", choices: [called] })));
    expect(pass.outcome).toMatchObject({ ok: true, busy: false, conclusive: true });
    const cutCall = { finish_reason: "length", message: { tool_calls: [call] } };
    const none = await probeWith(() => new Response(JSON.stringify({ provider: "a", choices: [cutCall] })), "none");
    expect(none.outcome).toMatchObject({ ok: false, busy: false, conclusive: true });
  });

  test.each(["none", "auto"] as const)(
    "a plain reply cut off by the token budget passes %s, inconclusively",
    async (mode) => {
      const cut = { finish_reason: "length", message: { content: "Sure" } };
      const { outcome } = await probeWith(() => new Response(JSON.stringify({ provider: "a", choices: [cut] })), mode);
      expect(outcome).toMatchObject({ ok: true, busy: false, conclusive: false });
    },
  );
});

describe("OpenCode Go probes", () => {
  const auth = { key: "test-go-secret-key", source: "test" };
  const go = normalise({ id: "glm-5.3" })!;
  const call = { type: "function", function: { name: "ok", arguments: "{}" } };
  const served = (allowance?: unknown, extra: object = {}) => ({
    choices: [{ finish_reason: "tool_calls", message: { tool_calls: [call] } }],
    usage: { opencode: { billing_source: "go", list_cost: 0.5, ...(allowance !== undefined && { allowance }) } },
    ...extra,
  });

  async function probeGo(replies: (() => Response)[], mode: ToolChoiceMode = "required") {
    let next = 0;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async () =>
      replies[next++]!()) as unknown as typeof fetch);
    try {
      const outcome = await probe("z-ai/glm-5.3", go, [go], auth, mode);
      return { outcome, calls: [...fetchMock.mock.calls] as [string, RequestInit][] };
    } finally {
      fetchMock.mockRestore();
    }
  }
  const reply = (body: unknown, init?: ResponseInit) => () => new Response(JSON.stringify(body), init);

  test("the body names Go's model id and carries no routing", () => {
    const body = probeBody("z-ai/glm-5.3", go, [go], "required");
    expect(body.model).toBe("glm-5.3");
    expect(body).not.toHaveProperty("provider");
    expect(body).not.toHaveProperty("providerOptions");
    expect(body.tool_choice).toBe("required");
  });

  test("goes to Go with its key, a user agent and one session id, and reads ttfb and the allowance", async () => {
    const { outcome, calls } = await probeGo([reply(served(0.0012))]);
    const [url, init] = calls[0]!;
    expect(url).toBe("https://opencode.ai/inference/go/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${auth.key}`);
    expect(headers["User-Agent"]).toMatch(/^opp\/\d+\.\d+\.\d+/);
    expect(headers["x-opencode-session"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(init.redirect).toBe("error");
    expect(outcome).toMatchObject({ ok: true, busy: false, conclusive: true, cost: 0.0012 });
    expect(Number.isInteger(outcome.ttfbMs)).toBe(true);
    expect(outcome.detail).toBe(`ttfb ${outcome.ttfbMs} ms, allowance $0.0012, finish=tool_calls`);
  });

  test("the session id is the same for every request of a run", async () => {
    const first = await probeGo([reply(served(0.001))]);
    const second = await probeGo([reply(served(0.001))], "auto");
    const session = (calls: [string, RequestInit][]) =>
      (calls[0]![1].headers as Record<string, string>)["x-opencode-session"];
    expect(session(first.calls)).toBe(session(second.calls));
  });

  test("nothing is checked about who served it: the reply names no provider and a stray one is no failure", async () => {
    const { outcome } = await probeGo([reply(served(0.001, { provider: "someone-else", service_tier: "flex" }))]);
    expect(outcome.ok).toBe(true);
  });

  test("a reply with no allowance still passes, with the cost unknown", async () => {
    const { outcome } = await probeGo([reply(served())]);
    expect(outcome).toMatchObject({ ok: true });
    expect(outcome).not.toHaveProperty("cost");
    expect(outcome.detail).toBe(`ttfb ${outcome.ttfbMs} ms, finish=tool_calls`);
  });

  test("a region-gated request is an HTTP 400 with Go's message: inconclusive, not busy, no figures", async () => {
    const { outcome, calls } = await probeGo([
      reply({ error: { message: 'Set the workspace privacy setting to "Global regions"' } }, { status: 400 }),
    ]);
    expect(calls).toHaveLength(1);
    expect(outcome).toMatchObject({
      ok: false,
      busy: false,
      conclusive: false,
      detail: 'HTTP 400 Set the workspace privacy setting to "Global regions"',
    });
    expect(outcome).not.toHaveProperty("ttfbMs");
    expect(outcome).not.toHaveProperty("cost");
    expect(outcome).not.toHaveProperty("refused");
  });

  test("a rate-window error is retried like any gateway's 429, and the retry's figures are kept", async () => {
    const limited = reply({ error: { message: "rate window used" } }, { status: 429, headers: { "retry-after": "0" } });
    const { outcome, calls } = await probeGo([limited, reply(served(0.002))]);
    expect(calls).toHaveLength(2);
    expect(outcome).toMatchObject({ ok: true, cost: 0.002 });
    expect(outcome.detail).toEndWith(", after a retry");
    const again = await probeGo([limited, limited]);
    expect(again.outcome).toMatchObject({ ok: false, busy: true });
    expect(again.outcome.detail).toBe("HTTP 429 rate window used, retried");
  });

  test("a tool-call failure is judged as for any gateway, and the key never reaches the detail", async () => {
    const text = { choices: [{ finish_reason: "stop", message: { content: `no ${auth.key}` } }] };
    const { outcome } = await probeGo([reply(text)]);
    expect(outcome).toMatchObject({ ok: false, conclusive: true });
    expect(outcome.detail).toBe("no ok tool call despite tool_choice required, finish=stop");
    const leaked = await probeGo([reply({ error: { message: `bad key ${auth.key}` } }, { status: 401 })]);
    expect(leaked.outcome.detail).toBe("HTTP 401 bad key [redacted]");
  });
});

describe("verify and Go rows", () => {
  const keys = { openrouter: { key: "or", source: "t" }, "opencode-go": { key: "go", source: "t" } };
  const go = normalise({ id: "glm-5.3" })!;
  const rows = [ep("a"), ep("b"), go].map((endpoint) => ({ endpoint, cost: undefined, priceEliminated: false }));
  const call = { type: "function", function: { name: "ok", arguments: "{}" } };

  async function walk(deadline?: number, reply: () => Response = () => new Response(JSON.stringify(served))) {
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async () => reply()) as unknown as typeof fetch);
    try {
      const verification = await verify(
        "z-ai/glm-5.3",
        rows,
        rows.map((r) => r.endpoint),
        keys,
        deadline,
      );
      return { verification, urls: fetchMock.mock.calls.map(([url]) => String(url)) };
    } finally {
      fetchMock.mockRestore();
    }
  }
  const served = {
    provider: "a",
    choices: [{ finish_reason: "tool_calls", message: { tool_calls: [call] } }],
    usage: { opencode: { allowance: 0.001 } },
  };

  test("a Go row the walk didn't reach is probed after it, and the first to serve is still the pick", async () => {
    const { verification, urls } = await walk();
    expect(verification.verified).toBe(rows[0]!.endpoint);
    expect(verification.probes.map(({ endpoint }) => endpoint.tag)).toEqual(["a", "glm-5.3"]);
    expect(urls).toEqual([
      "https://openrouter.ai/api/v1/chat/completions",
      "https://opencode.ai/inference/go/v1/chat/completions",
    ]);
    expect(verification.probes[1]).toMatchObject({ ok: true, cost: 0.001 });
    expect(verification).not.toHaveProperty("unprobed");
  });

  test("a Go row the walk reached is probed once, not again", async () => {
    const wrong = () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: {} }] }));
    const { verification, urls } = await walk(undefined, wrong);
    expect(verification.verified).toBeUndefined();
    expect(verification.probes.map(({ endpoint }) => endpoint.tag)).toEqual(["a", "b", "glm-5.3"]);
    expect(urls.filter((url) => url.includes("opencode.ai"))).toHaveLength(1);
  });

  test("a Go row left when the budget runs out is counted as not probed", async () => {
    const now = spyOn(Date, "now");
    now.mockReturnValueOnce(0).mockReturnValue(10_000);
    try {
      const { verification, urls } = await walk(1_000);
      expect(verification.verified).toBe(rows[0]!.endpoint);
      expect(verification.unprobed).toBe(1);
      expect(urls).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });
});
