/**
 * The public API contract shared by the server and the browser: zod schemas and their inferred
 * types. Changing a schema is an API change and needs an ADR.
 */

import { z } from "zod";

export const schemaVersion = 1 as const;
const isoDateTimeSchema = z.iso.datetime();

export const modeSchema = z.enum(["metro", "rer", "transilien", "tram", "bus", "noctilien"]);
export type TransitMode = z.infer<typeof modeSchema>;

/** How much realtime detail a line has. */
export const capabilitySchema = z.enum([
  "estimated_segment",
  "arrival_only",
  "scheduled_only",
  "unavailable"
]);
export type LineCapability = z.infer<typeof capabilitySchema>;

export const trainSnapshotSchemaVersion = 2 as const;

/** See `TrainState` in transit-core for what each state means. */
export const trainStateSchema = z.enum(["live", "coasting", "frozen"]);
export type TrainState = z.infer<typeof trainStateSchema>;

/**
 * A train is one number on one pattern: its virtual origin departure time. Its estimated position
 * at any wall time is derived from the pattern timeline; the server sends no coordinates.
 */
export const trainSchema = z.object({
  id: z.string().min(1),
  lineId: z.string().min(1),
  patternId: z.string().min(1),
  destinationName: z.string().min(1),
  virtualStartAt: isoDateTimeSchema,
  holdStopIndex: z.number().int().nonnegative().optional(),
  lastEvidenceAt: isoDateTimeSchema,
  state: trainStateSchema,
  stateSince: isoDateTimeSchema
});
export type Train = z.infer<typeof trainSchema>;

export const lineStateSchema = z.object({
  lineId: z.string().min(1),
  state: z.enum(["live", "frozen"]),
  since: isoDateTimeSchema.optional()
});
export type LineState = z.infer<typeof lineStateSchema>;

/** Every train on the network at one instant, as streamed to the browser. */
export const trainSnapshotSchema = z.object({
  schemaVersion: z.literal(trainSnapshotSchemaVersion),
  sequence: z.number().int().nonnegative(),
  topologyVersion: z.string().min(1),
  feedAt: isoDateTimeSchema.nullable(),
  generatedAt: isoDateTimeSchema,
  lines: z.array(lineStateSchema),
  trains: z.array(trainSchema)
});
export type TrainSnapshot = z.infer<typeof trainSnapshotSchema>;

export const stopSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  longitude: z.number(),
  latitude: z.number(),
  lineIds: z.array(z.string()),
  accessible: z.boolean().optional()
});
export type TransitStop = z.infer<typeof stopSchema>;

export const routeGeometrySchema = z.object({
  type: z.literal("LineString"),
  coordinates: z.array(z.tuple([z.number(), z.number()])).min(2),
  geometrySource: z.enum(["gtfs_shape", "idfm_line_trace", "fixture"]).optional()
});

export const directionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  stopIds: z.array(z.string()).min(2),
  geometry: routeGeometrySchema
});
export type TransitDirection = z.infer<typeof directionSchema>;

export const lineSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  mode: modeSchema,
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  textColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  operator: z.string().min(1),
  directions: z.array(directionSchema).min(1),
  capability: capabilitySchema
});
export type TransitLine = z.infer<typeof lineSchema>;

/** The static network: lines, their directions and traces, and stops. */
export const networkManifestSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  topologyVersion: z.string().min(1),
  generatedAt: isoDateTimeSchema,
  source: z.string().min(1),
  attribution: z.string().min(1),
  lines: z.array(lineSchema),
  stops: z.array(stopSchema)
});
export type NetworkManifest = z.infer<typeof networkManifestSchema>;

/** App health and how fresh the provider data is. */
export const serviceStatusSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  status: z.enum(["healthy", "degraded", "unavailable", "no_service"]),
  source: z.enum(["fixture", "prim"]),
  generatedAt: isoDateTimeSchema,
  sourceObservedAt: isoDateTimeSchema.nullable(),
  sourceAgeSeconds: z.number().nonnegative().nullable(),
  pollIntervalSeconds: z.number().positive(),
  supportedLines: z.number().int().nonnegative(),
  message: z.string()
});
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

export const segmentTimeSchema = z.object({
  fromStopId: z.string().min(1),
  toStopId: z.string().min(1),
  runSeconds: z.number().positive(),
  dwellSeconds: z.number().nonnegative()
});
export type SegmentTime = z.infer<typeof segmentTimeSchema>;

/**
 * Per-segment median run and dwell times, keyed by internal direction id. Each direction lists its
 * segments in stop order (from-stop → next stop), and `dwellSeconds` is the from-stop's dwell. Built
 * offline from GTFS `stop_times`; server and browser build the same pattern timelines from it.
 */
export const segmentTimesSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  topologyVersion: z.string().min(1),
  segments: z.record(z.string(), z.array(segmentTimeSchema))
});
export type SegmentTimes = z.infer<typeof segmentTimesSchema>;
