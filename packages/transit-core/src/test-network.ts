import type { PatternTimeline } from "./timeline.js";

/** A pattern with 60 s runs and 20 s dwells: arr = [0, 60, 140, 220, 300, …]. */
export function testTimeline(id: string, lineId: string, stopIds: string[]): PatternTimeline {
  const arr = [0];
  const dep = [0];
  for (let index = 1; index < stopIds.length; index += 1) {
    const arrival = (dep[index - 1] ?? 0) + 60;
    arr.push(arrival);
    dep.push(index === stopIds.length - 1 ? arrival : arrival + 20);
  }
  return { id, lineId, name: stopIds.at(-1) ?? id, stopIds, arr, dep };
}

/** Line L runs a–e both ways. Line B has two branches (x, y) that converge at m toward t2. */
export const testTimelines = [
  testTimeline("east", "L", ["a", "b", "c", "d", "e"]),
  testTimeline("west", "L", ["e", "d", "c", "b", "a"]),
  testTimeline("b1", "B", ["x1", "x2", "m", "t1", "t2"]),
  testTimeline("b2", "B", ["y1", "y2", "m", "t1", "t2"]),
  testTimeline("r1", "B", ["t2", "t1", "m", "x2", "x1"]),
  testTimeline("r2", "B", ["t2", "t1", "m", "y2", "y1"])
];
