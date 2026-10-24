import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ep } from "./fixtures.ts";
import type { Probe } from "./policy.ts";
import { loadProbes, probeStorePath, recordProbes, withLock } from "./probe-store.ts";

const path = () => join(mkdtempSync(join(tmpdir(), "opp-store-")), "opp", "probes.json");
/** A probe outcome; an inconclusive one (busy, or an account failure) is never stored. */
const outcome = (tag: string, ok: boolean, inconclusive = false, at = "2026-10-02T00:00:00.000Z"): Probe => ({
  endpoint: ep(tag),
  ok,
  busy: inconclusive,
  conclusive: !inconclusive,
  detail: "",
  at,
});

describe("probe store", () => {
  test("lives under XDG_CACHE_HOME, else ~/.cache", () => {
    expect(probeStorePath({ XDG_CACHE_HOME: "/c", HOME: "/h" })).toBe("/c/opp/probes.json");
    expect(probeStorePath({ HOME: "/h" })).toBe("/h/.cache/opp/probes.json");
    expect(probeStorePath({})).toBeUndefined();
  });

  test("keeps only the latest result per model, tag and mode, and skips inconclusive probes", () => {
    const file = path();
    const earlier = "2026-10-01T00:00:00.000Z";
    recordProbes(file, "m/x", [{ probe: outcome("cf", false, false, earlier), mode: "required" }]);
    recordProbes(file, "m/x", [
      { probe: outcome("cf", true), mode: "required" },
      { probe: outcome("cf", false, true), mode: "none" },
      { probe: outcome("cf/fp8", true), mode: "auto" },
    ]);
    recordProbes(file, "n/y", [{ probe: outcome("cf", false, true), mode: "required" }]);
    // A run that finishes later with an older answer doesn't replace a newer one.
    recordProbes(file, "m/x", [{ probe: outcome("cf", false, false, earlier), mode: "required" }]);
    expect(loadProbes(file)).toEqual({
      "m/x": {
        cf: { required: { result: "pass", at: "2026-10-02T00:00:00.000Z" } },
        "cf/fp8": { auto: { result: "pass", at: "2026-10-02T00:00:00.000Z" } },
      },
    });
  });

  test("updates under a lock, and gives up on one another run holds without breaking it", () => {
    const dir = mkdtempSync(join(tmpdir(), "opp-store-"));
    const lock = join(dir, "probes.json.lock");
    let held = false;
    withLock(lock, () => {
      held = existsSync(lock);
    });
    expect(held).toBe(true);
    expect(existsSync(lock)).toBe(false);
    const file = join(dir, "probes.json");
    writeFileSync(lock, "");
    expect(recordProbes(file, "m/x", [{ probe: outcome("cf", true), mode: "auto" }])).toContain("held by another run");
    expect(existsSync(file)).toBe(false);
    expect(existsSync(lock)).toBe(true);
  });

  test("a missing or malformed file reads as empty, and bad entries are dropped", () => {
    expect(loadProbes(path())).toEqual({});
    expect(loadProbes(undefined)).toEqual({});
    const dir = mkdtempSync(join(tmpdir(), "opp-store-"));
    const file = join(dir, "probes.json");
    writeFileSync(file, "not json");
    expect(loadProbes(file)).toEqual({});
    writeFileSync(
      file,
      JSON.stringify({
        "m/x": {
          cf: {
            required: { result: "pass", at: "2026-10-02T00:00:00Z" },
            none: { result: "maybe", at: "2026-10-02T00:00:00Z" },
            auto: { result: "pass" },
            bogus: { result: "pass", at: "2026-10-02T00:00:00Z" },
          },
          other: [],
        },
      }),
    );
    expect(loadProbes(file)).toEqual({
      "m/x": { cf: { required: { result: "pass", at: "2026-10-02T00:00:00Z" } }, other: {} },
    });
  });
});
