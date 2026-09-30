/**
 * Places line badges and station labels without overlaps. Each badge takes the first candidate
 * point that is on screen and free, or else the first on screen. Labels follow by tier (overview,
 * then interchanges, then other stations, each tier from a set zoom), and take the first free
 * position around their station dot; a label that doesn't fit is hidden.
 */

import type { Map as MapLibreMap, Marker } from "maplibre-gl";

import type { Coordinate } from "./geo.js";

const labelZoomThresholds = { medium: 12.75, close: 13.25 } as const;

export type LabelMarker = {
  coordinate: Coordinate;
  avoidCoordinates: Coordinate[];
  element: HTMLDivElement;
  marker: Marker;
  tier: "overview" | "medium" | "close";
};

export type BadgeMarker = {
  candidates: Coordinate[];
  element: HTMLDivElement;
  marker: Marker;
};

type ScreenRect = { left: number; right: number; top: number; bottom: number };

function overlaps(left: ScreenRect, right: ScreenRect, padding = 3): boolean {
  return !(
    left.right + padding < right.left ||
    left.left - padding > right.right ||
    left.bottom + padding < right.top ||
    left.top - padding > right.bottom
  );
}

function markerRect(
  map: MapLibreMap,
  coordinate: [number, number],
  element: HTMLElement,
  offset: [number, number] = [0, 0]
): ScreenRect {
  const point = map.project(coordinate);
  const width = element.offsetWidth || 32;
  const height = element.offsetHeight || 18;
  const centerX = point.x + offset[0];
  const centerY = point.y + offset[1];
  return {
    left: centerX - width / 2,
    right: centerX + width / 2,
    top: centerY - height / 2,
    bottom: centerY + height / 2
  };
}

function insideViewport(rect: ScreenRect, map: MapLibreMap): boolean {
  const container = map.getContainer();
  return (
    rect.left >= 4 &&
    rect.top >= 4 &&
    rect.right <= container.clientWidth - 4 &&
    rect.bottom <= container.clientHeight - 4
  );
}

function labelOffsets(map: MapLibreMap, label: LabelMarker, isMobile: boolean): Coordinate[] {
  const center = map.project(label.coordinate);
  const points = label.avoidCoordinates.map((coordinate) => map.project(coordinate));
  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));
  const width = label.element.offsetWidth || 32;
  const height = label.element.offsetHeight || 18;
  const gap = isMobile ? 6 : 8;
  const middleX = (left + right) / 2 - center.x;
  const middleY = (top + bottom) / 2 - center.y;
  const verticalTop = top - center.y - gap - height / 2;
  const verticalBottom = bottom - center.y + gap + height / 2;
  const horizontalLeft = left - center.x - gap - width / 2;
  const horizontalRight = right - center.x + gap + width / 2;
  return [
    [middleX, verticalTop],
    [middleX, verticalBottom],
    [horizontalRight, middleY],
    [horizontalLeft, middleY],
    [horizontalRight, verticalTop],
    [horizontalLeft, verticalTop],
    [horizontalRight, verticalBottom],
    [horizontalLeft, verticalBottom]
  ];
}

export function updateAnnotationVisibility(
  map: MapLibreMap,
  badges: BadgeMarker[],
  labels: LabelMarker[],
  isMobile: boolean
) {
  const occupied: ScreenRect[] = [];
  for (const badge of badges) {
    badge.element.style.visibility = "hidden";
    const options = badge.candidates.map((coordinate) => ({
      coordinate,
      rect: markerRect(map, coordinate, badge.element)
    }));
    const selected =
      options.find(
        (option) =>
          insideViewport(option.rect, map) &&
          !occupied.some((rect) => overlaps(option.rect, rect, 5))
      ) ?? options.find((option) => insideViewport(option.rect, map));
    if (!selected) continue;
    badge.marker.setLngLat(selected.coordinate);
    badge.element.style.visibility = "visible";
    occupied.push(selected.rect);
  }

  const zoom = map.getZoom();
  const priorities = { overview: 0, medium: 1, close: 2 } as const;
  const orderedLabels = [...labels].sort(
    (left, right) => priorities[left.tier] - priorities[right.tier]
  );
  for (const label of orderedLabels) {
    const atTier =
      label.tier === "overview" ||
      (label.tier === "medium" && zoom >= labelZoomThresholds.medium) ||
      (label.tier === "close" && zoom >= labelZoomThresholds.close);
    label.element.classList.toggle("is-hidden", !atTier);
    label.element.style.visibility = "hidden";
    if (!atTier) continue;
    const options = labelOffsets(map, label, isMobile).map((offset) => ({
      offset,
      rect: markerRect(map, label.coordinate, label.element, offset)
    }));
    const selected = options.find(
      (option) =>
        insideViewport(option.rect, map) && !occupied.some((item) => overlaps(option.rect, item))
    );
    if (!selected) continue;
    label.marker.setOffset(selected.offset);
    label.element.style.visibility = "visible";
    occupied.push(selected.rect);
  }
}
