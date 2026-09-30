/** Checks the committed network data: schema, cross-references, timings and Métro coverage. */

import { resolve } from "node:path";

import { segmentTimesSchema, type NetworkManifest } from "@paris-transit/contracts";
import { ZodError } from "zod";

import { readJson } from "./json.ts";
import {
  parseNetwork,
  validateNetworkReferences,
  validateSegmentTimes,
  type ValidationIssue
} from "./validation.ts";

const expectedMetroCodes = [
  "1",
  "2",
  "3",
  "3bis",
  "4",
  "5",
  "6",
  "7",
  "7bis",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13",
  "14"
];
const tileBounds = [2.15, 48.65, 2.55, 49.08] as const;

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv.at(index + 1);
}

function fail(issues: ValidationIssue[]): never {
  for (const issue of issues) console.error(`${issue.path}: ${issue.message}`);
  process.exit(1);
}

function validateCompleteMetro(network: NetworkManifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const codes = network.lines.map((line) => line.code);
  if (codes.join("|") !== expectedMetroCodes.join("|")) {
    issues.push({
      path: "lines",
      message: "The network must contain the 16 expected Métro line codes"
    });
  }
  for (const line of network.lines) {
    if (line.mode !== "metro") {
      issues.push({
        path: `lines.${line.id}.mode`,
        message: "The network may contain only Métro lines"
      });
    }
    for (const direction of line.directions) {
      if (direction.geometry.geometrySource !== "idfm_line_trace") {
        issues.push({
          path: `lines.${line.id}.${direction.id}.geometry`,
          message: "Direction must use an official IDFM line trace"
        });
      }
      for (const [longitude, latitude] of direction.geometry.coordinates) {
        if (
          longitude < tileBounds[0] ||
          latitude < tileBounds[1] ||
          longitude > tileBounds[2] ||
          latitude > tileBounds[3]
        ) {
          issues.push({
            path: `lines.${line.id}.${direction.id}.geometry`,
            message: "Route falls outside local PMTiles bounds"
          });
          break;
        }
      }
    }
  }
  return issues;
}

const dataDirectory = resolve(import.meta.dirname, "../../../data/paris-metro");

function pathArgument(flag: string, fallback: string): string {
  const value = valueAfter(flag);
  return value === undefined ? resolve(dataDirectory, fallback) : resolve(process.cwd(), value);
}

try {
  const network = parseNetwork(await readJson(pathArgument("--network", "network.json")));
  const segmentTimes = segmentTimesSchema.parse(
    await readJson(pathArgument("--segment-times", "segment-times.json"))
  );
  const issues = [
    ...validateNetworkReferences(network),
    ...validateSegmentTimes(network, segmentTimes),
    ...validateCompleteMetro(network)
  ];
  if (issues.length > 0) fail(issues);
  console.log(
    `Valid network: ${String(network.lines.length)} lines, ${String(network.stops.length)} stops, ${String(Object.keys(segmentTimes.segments).length)} timed directions.`
  );
} catch (error) {
  if (error instanceof ZodError) {
    fail(error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })));
  }
  throw error;
}
