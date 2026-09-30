/** The OpenAPI 3.1 description of the HTTP API, generated from the zod schemas. */

import { z } from "zod";

import {
  networkManifestSchema,
  segmentTimesSchema,
  serviceStatusSchema,
  trainSnapshotSchema
} from "./index.js";

const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: "draft-7" });

const jsonResponse = (schemaName: string, description: string) => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: `#/components/schemas/${schemaName}` }
    }
  }
});

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Paris Transit Live API",
    version: "1.0.0",
    description: "Provider-neutral network data and clearly labelled estimated train positions."
  },
  servers: [{ url: "/" }],
  paths: {
    "/api/v1/network/manifest": {
      get: { responses: { "200": jsonResponse("NetworkManifest", "Static network topology.") } }
    },
    "/api/v1/network/segment-times": {
      get: {
        responses: {
          "200": jsonResponse("SegmentTimes", "Median run and dwell times for every pattern.")
        }
      }
    },
    "/api/v1/vehicles": {
      get: {
        responses: { "200": jsonResponse("TrainSnapshot", "Current estimated trains by line.") }
      }
    },
    "/api/v1/vehicles/stream": {
      get: {
        responses: {
          "200": {
            description: "Server-sent complete train snapshots.",
            content: { "text/event-stream": { schema: { type: "string" } } }
          }
        }
      }
    },
    "/api/v1/status": {
      get: { responses: { "200": jsonResponse("ServiceStatus", "App and provider freshness.") } }
    }
  },
  components: {
    schemas: {
      NetworkManifest: schema(networkManifestSchema),
      SegmentTimes: schema(segmentTimesSchema),
      TrainSnapshot: schema(trainSnapshotSchema),
      ServiceStatus: schema(serviceStatusSchema)
    }
  }
} as const;
