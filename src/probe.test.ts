import { describe, expect, spyOn, test } from "bun:test";
import { ep } from "./fixtures.ts";
import type { ToolChoiceMode } from "./policy.ts";
import { probe, probeBody, retryDelay, servedQuantization, toolCallProblem } from "./probe.ts";

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
