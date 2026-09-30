/**
 * The interactive Métro map. MapLibre draws the basemap and the network; trains are painted on a
 * canvas above it, and station labels and line badges are DOM markers placed to avoid overlaps.
 * Hovering or tapping a line highlights it.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { NetworkManifest } from "@paris-transit/contracts";
import type { DisplayTrain, PatternNetwork } from "@paris-transit/transit-core/display";
import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import {
  addProtocol,
  type GeoJSONSource,
  Map as MapLibreMap,
  type MapLayerMouseEvent,
  type MapMouseEvent,
  Marker,
  setWorkerUrl
} from "maplibre-gl";
import mapLibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { Protocol } from "pmtiles";
import { Link } from "react-router-dom";
import { useReducedMotion } from "../hooks/useReducedMotion.js";
import {
  createMotionState,
  hubStopIds,
  trainFrame,
  type TrainFrame,
  type TrainMark
} from "../map/train-motion.js";
import {
  updateAnnotationVisibility,
  type BadgeMarker,
  type LabelMarker
} from "../map/annotations.js";
import { coordinateAtDistance, routeLength, type Coordinate } from "../map/geo.js";
import {
  canvasColor,
  inkColor,
  installTransitLayers,
  localMapStyle,
  setLineHighlight,
  type HubProperties,
  type RouteProperties,
  type StationProperties
} from "../map/map-style.js";
import {
  buildDisplayLayout,
  renderedLinePaths,
  type DisplayLayout
} from "../map/route-geometry.js";

const parisIntraMurosBounds: [[number, number], [number, number]] = [
  [2.2241, 48.8156],
  [2.4699, 48.9022]
];
const overviewLabels = new Map([
  ["la defense", "La Défense"],
  ["charles de gaulle etoile", "Charles de Gaulle–Étoile"],
  ["gare saint lazare", "Saint-Lazare"],
  ["saint lazare", "Saint-Lazare"],
  ["gare montparnasse", "Montparnasse–Bienvenüe"],
  ["montparnasse bienvenue", "Montparnasse–Bienvenüe"],
  ["gare du nord", "Gare du Nord"],
  ["gare de l est", "Gare de l’Est"],
  ["chatelet", "Châtelet"],
  ["republique", "République"],
  ["bastille", "Bastille"],
  ["gare de lyon", "Gare de Lyon"],
  ["nation", "Nation"]
]);
const smoothMotionFrameMs = 1000 / 30;
const reducedMotionUpdateMs = 15_000;
const frozenTrainOpacity = 0.45;
const trainArrowPath = "M9 2.5 13 12 9 10 5 12Z";
const standardTrainSize: TrainSize = { diameter: 16, border: 1.5, arrow: 11 };
const smallestTrainZoom = 10;
// Below this zoom the map is an overview: trains and line badges are drawn smaller.
const overviewCutoffZoom = 12.75;

const protocol = new Protocol();
let protocolRegistered = false;
setWorkerUrl(mapLibreWorkerUrl);

type TransitMapProps = {
  manifest: NetworkManifest;
  network: PatternNetwork;
  trains: DisplayTrain[];
};

type TrainSize = { diameter: number; border: number; arrow: number };

export function TransitMap({ manifest, network, trains }: TransitMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const labelMarkersRef = useRef<LabelMarker[]>([]);
  const badgeMarkersRef = useRef<BadgeMarker[]>([]);
  const trainsRef = useRef(trains);
  const refreshTrainsRef = useRef<(() => void) | undefined>(undefined);
  const reducedMotion = useReducedMotion();
  const [mapReady, setMapReady] = useState(false);
  const [zoom, setZoom] = useState(10);

  const displayLayout = useMemo(() => buildDisplayLayout(manifest), [manifest]);
  const stationCoordinates = displayLayout.stationCoordinates;
  const routeData = useMemo(
    () => routeFeatures(manifest, displayLayout),
    [displayLayout, manifest]
  );
  const stationData = useMemo<FeatureCollection<Point, StationProperties>>(
    () => ({
      type: "FeatureCollection",
      features: manifest.stops.flatMap((stop) => {
        const coordinates = stationCoordinates.get(stop.id);
        if (!coordinates) return [];
        const feature: Feature<Point, StationProperties> = {
          type: "Feature",
          properties: {
            id: stop.id,
            interchange: stop.lineIds.length > 1,
            lineCount: stop.lineIds.length
          },
          geometry: { type: "Point", coordinates }
        };
        return [feature];
      })
    }),
    [manifest.stops, stationCoordinates]
  );
  const hubPointData = useMemo(() => hubPointFeatures(displayLayout), [displayLayout]);
  const badgeCandidates = useMemo(
    () => lineBadgeCandidates(manifest, displayLayout),
    [displayLayout, manifest]
  );
  const trainScene = useMemo(
    () => ({ network, layout: displayLayout, hubStopIds: hubStopIds(manifest) }),
    [displayLayout, manifest, network]
  );

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    if (!protocolRegistered) {
      addProtocol("pmtiles", protocol.tile);
      protocolRegistered = true;
    }
    const isMobile = window.matchMedia("(max-width: 599px)").matches;
    const map = new MapLibreMap({
      container: containerRef.current,
      style: localMapStyle(isMobile),
      center: [2.347, 48.859],
      zoom: 10,
      minZoom: 9,
      maxZoom: 17,
      bearing: 0,
      pitch: 0,
      maxPitch: 0,
      dragRotate: false,
      attributionControl: false,
      fadeDuration: reducedMotion ? 0 : 200
    });
    map.touchZoomRotate.disableRotation();
    map.doubleClickZoom.disable();
    mapRef.current = map;
    let hoveredLineId: string | undefined;
    let lockedLineId: string | undefined;
    let interactionsInstalled = false;

    const applyLineHighlight = () => {
      const activeLineId = lockedLineId ?? hoveredLineId;
      setLineHighlight(map, activeLineId);
      if (containerRef.current) {
        containerRef.current.dataset.activeLineId = activeLineId ?? "";
      }
    };
    const onRouteMove = (event: MapLayerMouseEvent) => {
      const lineId = featureLineId(event.features?.[0]?.properties);
      if (hoveredLineId === lineId) return;
      hoveredLineId = lineId;
      map.getCanvas().style.cursor = lineId ? "pointer" : "";
      applyLineHighlight();
    };
    const onRouteLeave = () => {
      hoveredLineId = undefined;
      map.getCanvas().style.cursor = "";
      applyLineHighlight();
    };
    const onMapClick = (event: MapMouseEvent) => {
      const feature = map.queryRenderedFeatures(event.point, {
        layers: ["metro-route-hit-area"]
      })[0];
      const lineId = featureLineId(feature?.properties);
      lockedLineId = lineId === lockedLineId ? undefined : lineId;
      applyLineHighlight();
    };

    const onLoad = () => {
      installTransitLayers(map, routeData, stationData, hubPointData);
      if (!interactionsInstalled) {
        map.on("mousemove", "metro-route-hit-area", onRouteMove);
        map.on("mouseleave", "metro-route-hit-area", onRouteLeave);
        map.on("click", onMapClick);
        interactionsInstalled = true;
      }
      applyLineHighlight();
      map.fitBounds(parisIntraMurosBounds, { padding: isMobile ? 24 : 64, duration: 0 });
      setZoom(map.getZoom());
      setMapReady(true);
    };
    const onZoom = () => setZoom(map.getZoom());
    map.on("style.load", onLoad);
    map.on("zoom", onZoom);
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      if (interactionsInstalled) {
        map.off("mousemove", "metro-route-hit-area", onRouteMove);
        map.off("mouseleave", "metro-route-hit-area", onRouteLeave);
        map.off("click", onMapClick);
      }
      setMapReady(false);
      map.remove();
      mapRef.current = null;
    };
  }, [displayLayout.stationCoordinates, hubPointData, reducedMotion, routeData, stationData]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    void map.getSource<GeoJSONSource>("metro-routes")?.setData(routeData);
    void map.getSource<GeoJSONSource>("metro-stations")?.setData(stationData);
    void map.getSource<GeoJSONSource>("metro-hub-points")?.setData(hubPointData);
  }, [hubPointData, mapReady, routeData, stationData]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const isMobile = window.matchMedia("(max-width: 599px)").matches;
    for (const badge of badgeMarkersRef.current) badge.marker.remove();
    badgeMarkersRef.current = manifest.lines.flatMap((line) => {
      const candidates = badgeCandidates.get(line.id);
      if (!candidates?.[0]) return [];
      const element = document.createElement("div");
      element.className = "line-badge";
      element.textContent = line.code;
      element.dataset.testid = "line-badge";
      element.dataset.lineCode = line.code;
      element.setAttribute("aria-hidden", "true");
      element.style.backgroundColor = line.color;
      element.style.color = line.textColor;
      const marker = new Marker({ element, anchor: "center" }).setLngLat(candidates[0]).addTo(map);
      return [{ candidates, element, marker }];
    });

    for (const label of labelMarkersRef.current) label.marker.remove();
    labelMarkersRef.current = manifest.stops.flatMap((stop) => {
      const coordinate = stationCoordinates.get(stop.id);
      if (!coordinate) return [];
      const overviewName = overviewLabels.get(normalizedName(stop.name));
      const tier = overviewName ? "overview" : stop.lineIds.length > 1 ? "medium" : "close";
      const element = document.createElement("div");
      element.className = `station-label station-label--${tier}`;
      element.textContent = overviewName ?? stop.name;
      element.dataset.stopId = stop.id;
      element.dataset.testid = "station-label";
      element.setAttribute("aria-hidden", "true");
      const marker = new Marker({ element, anchor: "center" }).setLngLat(coordinate).addTo(map);
      const hub = displayLayout.hubs.find((candidate) => candidate.stopId === stop.id);
      const avoidCoordinates = hub ? [hub.center] : [coordinate];
      return [{ coordinate, avoidCoordinates, element, marker, tier }];
    });

    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        updateAnnotationVisibility(map, badgeMarkersRef.current, labelMarkersRef.current, isMobile)
      );
    };
    map.on("move", update);
    map.on("resize", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      map.off("move", update);
      map.off("resize", update);
      for (const item of badgeMarkersRef.current) item.marker.remove();
      for (const item of labelMarkersRef.current) item.marker.remove();
      badgeMarkersRef.current = [];
      labelMarkersRef.current = [];
    };
  }, [
    badgeCandidates,
    displayLayout.hubs,
    manifest.lines,
    manifest.stops,
    mapReady,
    stationCoordinates
  ]);

  useEffect(() => {
    trainsRef.current = trains;
    refreshTrainsRef.current?.();
  }, [trains]);

  // Trains are drawn on one canvas above the routes and below the DOM labels, advanced at 30 frames
  // per second (every 15 s in reduced motion) and repainted whenever the map renders.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const canvas = document.createElement("canvas");
    canvas.className = "train-layer";
    canvas.dataset.testid = "train-layer";
    canvas.setAttribute("aria-hidden", "true");
    map.getCanvas().after(canvas);
    const context = canvas.getContext("2d");
    const state = createMotionState();
    let frame: TrainFrame = { trains: [], ghosts: [] };
    let attributesAt = -Infinity;

    const paint = () => {
      if (!context) return;
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (
        canvas.width !== Math.round(width * ratio) ||
        canvas.height !== Math.round(height * ratio)
      ) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const size = trainSize(map.getZoom());
      for (const mark of frame.ghosts) drawTrain(context, map, mark, size);
      for (const mark of frame.trains) drawTrain(context, map, mark, size);
    };
    const update = () => {
      const now = Date.now();
      frame = trainFrame(trainsRef.current, trainScene, state, now, reducedMotion);
      paint();
      if (!reducedMotion && now - attributesAt < 1000) return;
      attributesAt = now;
      const drawn = frame.trains.filter((mark) => mark.alpha > 0);
      canvas.dataset.trainCount = String(drawn.length);
      canvas.dataset.frozenCount = String(drawn.filter((mark) => mark.frozen).length);
      canvas.dataset.lineIds = [...new Set(drawn.map((mark) => mark.lineId))].sort().join(" ");
    };

    refreshTrainsRef.current = update;
    map.on("render", paint);
    update();
    let animationFrame = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    if (reducedMotion) {
      interval = setInterval(update, reducedMotionUpdateMs);
    } else {
      let lastUpdate = 0;
      const tick = (time: number) => {
        if (time - lastUpdate >= smoothMotionFrameMs) {
          lastUpdate = time;
          update();
        }
        animationFrame = requestAnimationFrame(tick);
      };
      animationFrame = requestAnimationFrame(tick);
    }
    return () => {
      cancelAnimationFrame(animationFrame);
      clearInterval(interval);
      map.off("render", paint);
      refreshTrainsRef.current = undefined;
      canvas.remove();
    };
  }, [mapReady, reducedMotion, trainScene]);

  const changeZoom = (amount: number) => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ zoom: map.getZoom() + amount, duration: reducedMotion ? 0 : 180 });
  };

  return (
    <section
      className={`map-shell${zoom < overviewCutoffZoom ? " map-shell--overview" : ""}`}
      data-testid="transit-map"
    >
      <div
        id="metro-map"
        ref={containerRef}
        className="transit-map"
        role="region"
        aria-label="Geographic map of Paris showing the complete Métro network and eligible estimated train movement"
      />
      <div className="zoom-controls" aria-label="Map zoom controls">
        <button
          type="button"
          aria-label="Zoom in"
          aria-controls="metro-map"
          disabled={zoom >= 17}
          onClick={() => changeZoom(1)}
        >
          +
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          aria-controls="metro-map"
          disabled={zoom <= 9}
          onClick={() => changeZoom(-1)}
        >
          −
        </button>
      </div>
      <div className="map-attribution">
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          © OpenStreetMap contributors
        </a>
        <span aria-hidden="true"> · </span>
        <Link to="/credits">Data credits</Link>
      </div>
    </section>
  );
}

function routeFeatures(
  manifest: NetworkManifest,
  layout: DisplayLayout
): FeatureCollection<LineString, RouteProperties> {
  const renderedFallbacks = new Set<string>();
  const features: Feature<LineString, RouteProperties>[] = [];
  const colorByLineId = new Map(manifest.lines.map((line) => [line.id, line.color]));
  for (const path of renderedLinePaths(layout)) {
    features.push({
      type: "Feature",
      properties: { lineId: path.lineId, color: colorByLineId.get(path.lineId) ?? "#000000" },
      geometry: { type: "LineString", coordinates: path.coordinates }
    });
  }
  for (const display of layout.directions.values()) {
    if (display.segments.length > 0 || display.coordinates.length < 2) continue;
    const forward = JSON.stringify(display.coordinates);
    const reverse = JSON.stringify([...display.coordinates].reverse());
    const fallbackKey = `${display.lineId}|${forward < reverse ? forward : reverse}`;
    if (renderedFallbacks.has(fallbackKey)) continue;
    renderedFallbacks.add(fallbackKey);
    features.push({
      type: "Feature",
      properties: {
        lineId: display.lineId,
        color: colorByLineId.get(display.lineId) ?? "#000000"
      },
      geometry: { type: "LineString", coordinates: display.coordinates }
    });
  }
  return { type: "FeatureCollection", features };
}

function hubPointFeatures(layout: DisplayLayout): FeatureCollection<Point, HubProperties> {
  return {
    type: "FeatureCollection",
    features: layout.hubs.map((hub) => ({
      type: "Feature",
      properties: { stopId: hub.stopId, lineCount: hub.lineCount },
      geometry: { type: "Point", coordinates: hub.center }
    }))
  };
}

function lineBadgeCandidates(
  manifest: NetworkManifest,
  layout: DisplayLayout
): Map<string, Coordinate[]> {
  return new Map(
    manifest.lines.map((line) => {
      const paths = line.directions.flatMap((direction) => {
        const display = layout.directions.get(direction.id);
        return display ? [display.coordinates] : [];
      });
      const longest = paths.sort((left, right) => routeLength(right) - routeLength(left))[0] ?? [];
      const length = routeLength(longest);
      return [
        line.id,
        [0.5, 0.35, 0.65].flatMap((fraction) => {
          const point = coordinateAtDistance(longest, length * fraction);
          return point ? [[point.longitude, point.latitude] as Coordinate] : [];
        })
      ];
    })
  );
}

function normalizedName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function featureLineId(properties: unknown): string | undefined {
  if (!properties || typeof properties !== "object" || !("lineId" in properties)) return undefined;
  const lineId = (properties as { lineId?: unknown }).lineId;
  return typeof lineId === "string" ? lineId : undefined;
}

/** Full size from the overview cutoff up; below it, trains shrink from 11 px to 7 px at zoom 10. */
function trainSize(zoom: number): TrainSize {
  if (zoom >= overviewCutoffZoom) return standardTrainSize;
  const fraction = Math.max(
    0,
    Math.min(1, (zoom - smallestTrainZoom) / (overviewCutoffZoom - smallestTrainZoom))
  );
  const diameter = 7 + fraction * 4;
  return { diameter, border: diameter < 9 ? 1 : 1.5, arrow: diameter * 0.7 };
}

let trainArrow: Path2D | undefined;

function drawTrain(
  context: CanvasRenderingContext2D,
  map: MapLibreMap,
  mark: TrainMark,
  size: TrainSize
) {
  if (mark.alpha <= 0) return;
  const point = map.project([mark.longitude, mark.latitude]);
  context.globalAlpha = mark.alpha * (mark.frozen ? frozenTrainOpacity : 1);
  context.beginPath();
  context.arc(point.x, point.y, (size.diameter - size.border) / 2, 0, Math.PI * 2);
  context.fillStyle = inkColor;
  context.fill();
  context.lineWidth = size.border;
  context.strokeStyle = canvasColor;
  context.stroke();
  if (mark.bearing !== undefined) {
    trainArrow ??= new Path2D(trainArrowPath);
    const scale = size.arrow / 18;
    context.save();
    context.translate(point.x, point.y);
    context.rotate((mark.bearing * Math.PI) / 180);
    context.scale(scale, scale);
    context.translate(-9, -9);
    context.fillStyle = canvasColor;
    context.fill(trainArrow);
    context.restore();
  }
  context.globalAlpha = 1;
}
