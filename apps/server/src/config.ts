export type TransitSourceName = "fixture" | "prim";

export type RuntimeConfig = {
  source: TransitSourceName;
  host: string;
  port: number;
  primApiKey: string;
  primApiBaseUrl: string;
  primRequestTimeoutMs: number;
  primMaxCompressedResponseBytes: number;
  primMaxDecodedResponseBytes: number;
  primIdMapPath?: string;
  networkManifestPath?: string;
  segmentTimesPath?: string;
  rateLimitPerMinute: number;
};

function enumValue<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  name: string
): T {
  if (value === undefined || value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

/** Reads and validates configuration from environment variables; see `.env.example`. */
export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const config: RuntimeConfig = {
    source: enumValue(environment.TRANSIT_SOURCE, ["fixture", "prim"], "fixture", "TRANSIT_SOURCE"),
    host: environment.HOST ?? "127.0.0.1",
    port: positiveInteger(environment.PORT, 3001, "PORT"),
    primApiKey: environment.PRIM_API_KEY ?? "",
    primApiBaseUrl:
      environment.PRIM_API_BASE_URL ?? "https://prim.iledefrance-mobilites.fr/marketplace",
    primRequestTimeoutMs: positiveInteger(
      environment.PRIM_REQUEST_TIMEOUT_MS,
      30_000,
      "PRIM_REQUEST_TIMEOUT_MS"
    ),
    primMaxCompressedResponseBytes: positiveInteger(
      environment.PRIM_MAX_COMPRESSED_RESPONSE_BYTES,
      32 * 1024 * 1024,
      "PRIM_MAX_COMPRESSED_RESPONSE_BYTES"
    ),
    primMaxDecodedResponseBytes: positiveInteger(
      environment.PRIM_MAX_DECODED_RESPONSE_BYTES,
      128 * 1024 * 1024,
      "PRIM_MAX_DECODED_RESPONSE_BYTES"
    ),
    rateLimitPerMinute: positiveInteger(
      environment.API_RATE_LIMIT_PER_MINUTE,
      240,
      "API_RATE_LIMIT_PER_MINUTE"
    )
  };
  if (environment.NETWORK_MANIFEST_PATH) {
    config.networkManifestPath = environment.NETWORK_MANIFEST_PATH;
  }
  if (environment.SEGMENT_TIMES_PATH) {
    config.segmentTimesPath = environment.SEGMENT_TIMES_PATH;
  }
  if (environment.PRIM_ID_MAP_PATH) {
    config.primIdMapPath = environment.PRIM_ID_MAP_PATH;
  }
  return config;
}
