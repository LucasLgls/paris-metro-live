/**
 * The MapLibre style: a muted Protomaps basemap served from the bundled PMTiles file, plus the
 * Métro route, station and interchange layers drawn on top.
 */

import { layers, namedFlavor, type Flavor } from "@protomaps/basemaps";
import type { FeatureCollection, LineString, Point } from "geojson";
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";

export const canvasColor = "#fbfaf6";
export const inkColor = "#10243b";
const tileAsset = "/maps/paris-metro-20260909.pmtiles";

export type RouteProperties = {
  lineId: string;
  color: string;
};

export type StationProperties = {
  id: string;
  interchange: boolean;
  lineCount: number;
};

export type HubProperties = {
  stopId: string;
  lineCount: number;
};

export function localMapStyle(isMobile: boolean): StyleSpecification {
  const flavor: Flavor = {
    ...namedFlavor("white"),
    background: canvasColor,
    earth: canvasColor,
    park_a: "#e9efe6",
    park_b: "#edf2ea",
    wood_a: "#e5eee2",
    wood_b: "#ebf1e8",
    water: "#d7eaf6",
    buildings: "#ebe9e3",
    pedestrian: "#f4f1e9",
    minor_service: "#e6e2d9",
    minor_a: "#dfdbd2",
    minor_b: "#e8e4dc",
    major: "#d6d1c7",
    highway: "#cec8bd",
    railway: "#d3cec4",
    boundaries: "#d4cec3"
  };
  const baseLayers = layers("protomaps", flavor)
    .filter((layer) => layer.type !== "symbol")
    .map((layer) => tuneBasemapLayer(layer, isMobile));
  return {
    version: 8,
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${window.location.origin}${tileAsset}`,
        attribution: "© OpenStreetMap contributors"
      }
    },
    layers: baseLayers
  };
}

/** On phones, fades the basemap and hides minor detail below zoom 12.5 so the Métro stands out. */
function tuneBasemapLayer<T extends StyleSpecification["layers"][number]>(
  layer: T,
  isMobile: boolean
): T {
  if (!isMobile) return layer;
  let tuned = layer;
  if (layer.id === "buildings") {
    tuned = { ...layer, minzoom: 12.5, paint: { ...layer.paint, "fill-opacity": 0.42 } } as T;
  }
  if (layer.id === "roads_rail") {
    tuned = { ...layer, minzoom: 12.5, paint: { ...layer.paint, "line-opacity": 0.3 } } as T;
  }
  if (
    layer.id.startsWith("roads_") &&
    ["other", "minor", "service", "link"].some((kind) => layer.id.includes(kind))
  ) {
    tuned = { ...layer, minzoom: 12.5, paint: { ...layer.paint, "line-opacity": 0.5 } } as T;
  }
  if (
    layer.id.startsWith("landuse_") &&
    layer.id !== "landuse_park" &&
    layer.id !== "landuse_urban_green"
  ) {
    tuned = { ...layer, minzoom: 12.5, paint: { ...layer.paint, "fill-opacity": 0.4 } } as T;
  }
  if (
    layer.id.startsWith("roads_") &&
    (layer.id.includes("major") || layer.id.includes("highway"))
  ) {
    tuned = { ...layer, paint: { ...layer.paint, "line-opacity": 0.55 } } as T;
  }
  if (layer.id.startsWith("boundaries")) tuned = { ...layer, minzoom: 12.5 } as T;
  return tuned;
}

export function installTransitLayers(
  map: MapLibreMap,
  routes: FeatureCollection<LineString, RouteProperties>,
  stations: FeatureCollection<Point, StationProperties>,
  hubPoints: FeatureCollection<Point, HubProperties>
) {
  if (map.getSource("metro-routes")) return;
  map.addSource("metro-routes", { type: "geojson", data: routes });
  map.addSource("metro-stations", { type: "geojson", data: stations });
  map.addSource("metro-hub-points", { type: "geojson", data: hubPoints });
  map.addLayer({
    id: "metro-route-casing",
    type: "line",
    source: "metro-routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": canvasColor,
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 4, 12.75, 8, 14, 9]
    }
  });
  map.addLayer({
    id: "metro-route-lines",
    type: "line",
    source: "metro-routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 2, 12.75, 4.75, 14, 5.5]
    }
  });
  map.addLayer({
    id: "metro-route-highlight-casing",
    type: "line",
    source: "metro-routes",
    filter: ["==", ["get", "lineId"], ""],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": canvasColor,
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 6, 12.75, 10, 14, 11]
    }
  });
  map.addLayer({
    id: "metro-route-highlight",
    type: "line",
    source: "metro-routes",
    filter: ["==", ["get", "lineId"], ""],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 3, 12.75, 6.25, 14, 7]
    }
  });
  map.addLayer({
    id: "metro-route-hit-area",
    type: "line",
    source: "metro-routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "rgba(0, 0, 0, 0)",
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 12, 12.75, 18, 14, 20]
    }
  });
  map.addLayer({
    id: "ordinary-stations",
    type: "circle",
    source: "metro-stations",
    filter: ["==", ["get", "interchange"], false],
    paint: {
      "circle-color": canvasColor,
      "circle-stroke-color": inkColor,
      "circle-stroke-width": 1.75,
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.5, 12.75, 3.5, 14, 4.5]
    }
  });
  map.addLayer({
    id: "interchange-hub-outer-points",
    type: "circle",
    source: "metro-hub-points",
    paint: {
      "circle-color": inkColor,
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        9,
        ["case", [">=", ["get", "lineCount"], 3], 5.5, 3.5],
        12.75,
        ["case", [">=", ["get", "lineCount"], 3], 10.5, 7],
        14,
        ["case", [">=", ["get", "lineCount"], 3], 12, 8]
      ]
    }
  });
  map.addLayer({
    id: "interchange-hub-inner-points",
    type: "circle",
    source: "metro-hub-points",
    paint: {
      "circle-color": canvasColor,
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        9,
        ["case", [">=", ["get", "lineCount"], 3], 3.5, 2],
        12.75,
        ["case", [">=", ["get", "lineCount"], 3], 7.5, 5],
        14,
        ["case", [">=", ["get", "lineCount"], 3], 9, 6]
      ]
    }
  });
}

export function setLineHighlight(map: MapLibreMap, lineId: string | undefined) {
  map.setFilter("metro-route-highlight-casing", ["==", ["get", "lineId"], lineId ?? ""]);
  map.setFilter("metro-route-highlight", ["==", ["get", "lineId"], lineId ?? ""]);
}
