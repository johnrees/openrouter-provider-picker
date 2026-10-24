import { describe, expect, test } from "bun:test";
import { ep } from "./fixtures.ts";
import { probeBody, retryDelay, servedQuantization, toolCallProblem } from "./probe.ts";

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
