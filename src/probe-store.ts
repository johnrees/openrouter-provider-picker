/**
 * The probe store: the latest result of each probe, kept in
 * `$XDG_CACHE_HOME/opp/probes.json` so later runs can let it override the
 * listing. Delete the file to clear it.
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Probe, type ProbeStore, TOOL_CHOICE_MODES, type ToolChoiceMode } from "./policy.ts";

/** Where the store lives, or undefined when neither XDG_CACHE_HOME nor HOME is set. */
export function probeStorePath(env: Record<string, string | undefined> = process.env): string | undefined {
  const cache = env.XDG_CACHE_HOME || (env.HOME && `${env.HOME}/.cache`);
  return cache ? `${cache}/opp/probes.json` : undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads the store, keeping only well-formed entries. A missing or unreadable file is an empty store. */
export function loadProbes(path: string | undefined): ProbeStore {
  let raw: unknown;
  try {
    raw = path === undefined ? undefined : JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  if (!isObject(raw)) return {};
  const entries = (value: unknown) => (isObject(value) ? Object.entries(value) : []);
  return Object.fromEntries(
    entries(raw).map(([slug, tags]) => [
      slug,
      Object.fromEntries(
        entries(tags).map(([tag, modes]) => [
          tag,
          Object.fromEntries(
            entries(modes).filter(
              ([mode, entry]) =>
                TOOL_CHOICE_MODES.includes(mode as ToolChoiceMode) &&
                isObject(entry) &&
                (entry.result === "pass" || entry.result === "fail") &&
                typeof entry.at === "string",
            ),
          ),
        ]),
      ),
    ]),
  ) as ProbeStore;
}

/**
 * Records each probe's result for its model, endpoint and mode, unless the
 * store already holds a newer one, say from a run that finished first.
 * Inconclusive probes are skipped: a rate limit, timeout or misrouted reply
 * says nothing about capability. Returns an error message when the store
 * can't be written.
 */
export function recordProbes(
  path: string | undefined,
  slug: string,
  results: readonly { probe: Probe; mode: ToolChoiceMode }[],
): string | undefined {
  const conclusive = results.filter(({ probe }) => probe.conclusive);
  if (path === undefined || !conclusive.length) return undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    withLock(`${path}.lock`, () => {
      let store = loadProbes(path);
      for (const { probe, mode } of conclusive) {
        const tags = Object.hasOwn(store, slug) ? store[slug]! : {};
        const modes = Object.hasOwn(tags, probe.endpoint.tag) ? tags[probe.endpoint.tag]! : {};
        const stored = Object.hasOwn(modes, mode) ? Date.parse(modes[mode]!.at) : NaN;
        if (stored > Date.parse(probe.at)) continue;
        const entry = { result: probe.ok ? "pass" : "fail", at: probe.at } as const;
        // Computed keys define own properties, so no model or tag can reach a prototype.
        store = { ...store, [slug]: { ...tags, [probe.endpoint.tag]: { ...modes, [mode]: entry } } };
      }
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`);
      renameSync(temp, path);
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Give up on a held lock after this long. An update holds it for milliseconds. */
const LOCK_WAIT_MS = 2_000;

/**
 * Runs `update` holding an exclusive lock file, so concurrent runs don't
 * overwrite each other's results. A lock left by a crashed run is never
 * broken automatically, since no run can tell it from a live one safely; the
 * error names it so it can be removed.
 */
export function withLock(lock: string, update: () => void): void {
  const started = performance.now();
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      if (performance.now() - started > LOCK_WAIT_MS) {
        throw new Error(`${lock} is held by another run; remove it if no opp is running`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    update();
  } finally {
    rmSync(lock, { force: true });
  }
}
