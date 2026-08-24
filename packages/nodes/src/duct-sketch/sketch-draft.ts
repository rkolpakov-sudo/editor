import {
  type AnyNode,
  type AnyNodeId,
  DuctSketchNode,
  type DuctSketchRun,
  type LevelNode,
} from '@pascal-app/core'

/** Consecutive points closer than this (meters) collapse into one vertex. */
export const SKETCH_POINT_MERGE_EPS = 0.05

/**
 * Append a plan point to an in-flight sketch polyline. Consecutive points
 * within `SKETCH_POINT_MERGE_EPS` collapse into one vertex so a shaky
 * double-click never produces zero-length segments.
 */
export function appendSketchPoint(
  points: readonly [number, number, number][],
  point: readonly [number, number, number],
): Array<[number, number, number]> {
  const last = points[points.length - 1]
  if (
    last &&
    Math.hypot(last[0] - point[0], last[1] - point[1], last[2] - point[2]) < SKETCH_POINT_MERGE_EPS
  ) {
    return [...points]
  }
  return [...points, [point[0], point[1], point[2]]]
}

/**
 * Materialize an in-flight polyline as a sketch run. Null when the draft
 * holds fewer than two distinct vertices (nothing to route through).
 */
export function finalizeSketchRun(
  system: 'supply' | 'exhaust' | 'return',
  points: readonly [number, number, number][],
): DuctSketchRun | null {
  if (points.length < 2) return null
  return {
    system,
    points: points.map((p) => ({ x: p[0], z: p[2], elev: 'auto' as const })),
  }
}

/**
 * Mutation plan that lands `run` into the level's sketch node: update the
 * existing `duct-sketch` under `levelId`, or mint one carrying the run.
 * Pure — the caller applies it via `applyNodeChanges` for a single undo
 * step per finished polyline.
 */
export function planSketchCommit(
  nodes: Readonly<Record<string, AnyNode>>,
  levelId: LevelNode['id'],
  run: DuctSketchRun,
):
  | { create: { node: DuctSketchNode; parentId: LevelNode['id'] }; update: null }
  | {
      create: null
      update: { id: AnyNodeId; data: { runs: DuctSketchRun[] } }
    } {
  const existing = Object.values(nodes).find(
    (node) => node?.type === 'duct-sketch' && node.parentId === levelId,
  )
  if (existing && existing.type === 'duct-sketch') {
    return { create: null, update: { id: existing.id, data: { runs: [...existing.runs, run] } } }
  }
  return {
    create: { node: DuctSketchNode.parse({ runs: [run] }), parentId: levelId },
    update: null,
  }
}
