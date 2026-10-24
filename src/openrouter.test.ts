import { describe, expect, test } from "bun:test";
import { ep } from "./fixtures.ts";
import { isEndpoint, sanitize } from "./openrouter.ts";

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
});
