/** API client. Every response is checked against the shared contract schemas before use. */

import {
  networkManifestSchema,
  segmentTimesSchema,
  serviceStatusSchema,
  trainSnapshotSchema,
  type NetworkManifest,
  type SegmentTimes,
  type ServiceStatus,
  type TrainSnapshot
} from "@paris-transit/contracts";

type ResponseSchema<T> = {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false };
};

const API_ROOT = "/api/v1";

class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  schema: ResponseSchema<T>,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {})
  });
  if (!response.ok)
    throw new ApiError(`Request failed with ${String(response.status)}`, response.status);
  const parsed: unknown = await response.json();
  const result = schema.safeParse(parsed);
  if (!result.success) throw new ApiError("The server returned an invalid response");
  return result.data;
}

export function getNetworkManifest(signal?: AbortSignal): Promise<NetworkManifest> {
  return request("/network/manifest", networkManifestSchema, signal);
}

export function getSegmentTimes(signal?: AbortSignal): Promise<SegmentTimes> {
  return request("/network/segment-times", segmentTimesSchema, signal);
}

export function getServiceStatus(signal?: AbortSignal): Promise<ServiceStatus> {
  return request("/status", serviceStatusSchema, signal);
}

export function getTrains(signal?: AbortSignal): Promise<TrainSnapshot> {
  return request("/vehicles", trainSnapshotSchema, signal);
}

export function parseTrainEvent(data: string): TrainSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(data);
    const result = trainSnapshotSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export const trainStreamUrl = `${API_ROOT}/vehicles/stream`;
