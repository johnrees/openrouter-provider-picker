import type { Endpoint } from "./policy.ts";

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
