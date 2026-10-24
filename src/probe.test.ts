import { describe, expect, test } from "bun:test";
import { retryDelay } from "./probe.ts";

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
