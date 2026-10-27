import response from "./fixtures/endpoints.json";
import vercelResponse from "./fixtures/vercel-endpoints.json";
import type { Endpoint } from "./policy.ts";

/**
 * A hand-written GET /models/{creator}/{model}/endpoints response from Vercel AI Gateway, with invented
 * providers. alpha, mike and quebec share names with OpenRouter rows in the tests; oscar and papa don't.
 * papa lists no tool_choice, quebec has a discount, a region price and a turn fast enough to be worth 1.5× alpha's
 * price, and sierra is malformed.
 */
export const vercelFixture = vercelResponse;
export const vercelFixtureRows: unknown[] = vercelResponse.data.endpoints;

/**
 * Rows of a hand-written GET /models/{slug}/endpoints response for an anonymous
 * caller, with invented providers. Its cheapest reliable endpoint is fp4; fp8
 * rows cost a little more and unknown-quantization rows over 2× and $1 more.
 */
export const fixtureRows: unknown[] = response.data.endpoints;

/** An eligible, fully up endpoint: $1/M in, $0.1/M cache read, $4/M out ($2.12 per reference run). */
export function ep(tag: string, overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    provider_name: tag.split("/")[0]!,
    tag,
    status: 0,
    supported_parameters: ["tools", "tool_choice"],
    supports_tool_choice: { none: true, auto: true, required: true, function: true },
    uptime_last_1d: 100,
    uptime_last_30m: 100,
    latency_last_30m: { p50: 500 },
    throughput_last_30m: { p50: 100 },
    max_completion_tokens: 100_000,
    pricing: { prompt: "0.000001", input_cache_read: "0.0000001", completion: "0.000004" },
    ...overrides,
  };
}
