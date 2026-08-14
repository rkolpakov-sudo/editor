import type { DuctShape } from './norms-types'

/**
 * Routing and installation rules for duct runs (СП 73.13330, СП 60.13330,
 * СП 7.13130 — see `docs/mep/03`). Pure planar geometry + tables, no store
 * or Three.js. The crossing primitives here are also the base the stage-4
 * bypass detection builds on.
 *
 * Values marked `MOUNTING_SPACING_VERIFIED = false` in `constants.ts` are
 * typical spacing pending the full (paid) СП 73 text.
 */

/** A point on the level's XZ plan, meters. */
export type PlanPoint = readonly [number, number]

/** Minimal wall description the rules need — structurally satisfied by the
 *  real `WallNode` (start/end centerline points, optional thickness). */
export type WallLike = {
  start: readonly [number, number]
  end: readonly [number, number]
  thickness?: number
}

/** A single straight leg of a duct run on the plan. `sizeMm` is the body
 *  dimension across the run: diameter for round, the larger side for
 *  rect/oval (used for the fire-damper / clearance rules). */
export type DuctRunLeg = {
  from: PlanPoint
  to: PlanPoint
  shape: DuctShape
  sizeMm: number
}

export const DEFAULT_WALL_THICKNESS_M = 0.1
const INTERSECTION_EPS = 1e-9

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// ── Mounting (СП 73 typical spacing) ──────────────────────────────────────

/** Support spacing for a duct by shape and body size, meters. */
export function mountingSpacingM(shape: DuctShape, sizeMm: number): number {
  if (shape === 'rect' || shape === 'oval') return 3
  return sizeMm <= 400 ? 4 : 3
}

/** Number of supports on a straight run of the given length: floor(L/spacing)
 *  + 1, so every piece between two supports is within the spacing. */
export function supportCountForRun(lengthM: number, shape: DuctShape, sizeMm: number): number {
  if (lengthM <= 0) return 0
  const spacing = mountingSpacingM(shape, sizeMm)
  return Math.floor(lengthM / spacing) + 1
}

export type MountingPlan = {
  spacingM: number
  supportCount: number
}

/** Plan supports for a single straight leg. */
export function planRunMounting(leg: DuctRunLeg): MountingPlan {
  const lengthM = Math.hypot(leg.to[0] - leg.from[0], leg.to[1] - leg.from[1])
  return {
    spacingM: mountingSpacingM(leg.shape, leg.sizeMm),
    supportCount: supportCountForRun(lengthM, leg.shape, leg.sizeMm),
  }
}

// ── Planar geometry primitives ────────────────────────────────────────────

export type SegmentHit = {
  crosses: boolean
  /** Crossing point on the run leg, meters. */
  at?: PlanPoint
  /** Parameter along the run leg (0..1) of the crossing. */
  t?: number
}

/** Intersection of two plan segments, with the parameter along the FIRST
 *  segment. Null for parallel/coincident pairs. */
export function segmentSegmentIntersection(
  a: PlanPoint,
  b: PlanPoint,
  c: PlanPoint,
  d: PlanPoint,
): { point: PlanPoint; t: number } | null {
  const rx = b[0] - a[0]
  const ry = b[1] - a[1]
  const sx = d[0] - c[0]
  const sy = d[1] - c[1]
  const denom = rx * sy - ry * sx
  if (Math.abs(denom) < INTERSECTION_EPS) return null

  const cx = c[0] - a[0]
  const cy = c[1] - a[1]
  const t = (cx * sy - cy * sx) / denom
  const u = (cx * ry - cy * rx) / denom
  if (t < -INTERSECTION_EPS || t > 1 + INTERSECTION_EPS) return null
  if (u < -INTERSECTION_EPS || u > 1 + INTERSECTION_EPS) return null
  const tc = clamp(t, 0, 1)
  return { point: [a[0] + rx * tc, a[1] + ry * tc], t: tc }
}

/** First crossing of a run leg with a polygon barrier (wall footprint,
 *  fire-rated partition) on the plan. */
export function segmentPolygonCrossing(
  from: PlanPoint,
  to: PlanPoint,
  polygon: readonly PlanPoint[],
): SegmentHit {
  if (polygon.length < 3) return { crosses: false }
  for (let i = 0; i < polygon.length; i += 1) {
    const c = polygon[i]!
    const d = polygon[(i + 1) % polygon.length]!
    const hit = segmentSegmentIntersection(from, to, c, d)
    if (hit) return { crosses: true, at: hit.point, t: hit.t }
  }
  return { crosses: false }
}

/** Simple rectangular plan footprint of a wall from its centerline and
 *  thickness (ignores mitering — good enough for sleeve/damper rules). */
export function wallBarrierRect(wall: WallLike): PlanPoint[] {
  const thickness = wall.thickness ?? DEFAULT_WALL_THICKNESS_M
  const half = thickness / 2
  const dx = wall.end[0] - wall.start[0]
  const dy = wall.end[1] - wall.start[1]
  const length = Math.hypot(dx, dy)
  if (length < INTERSECTION_EPS) return []
  const nx = -dy / length
  const ny = dx / length
  return [
    [wall.start[0] + nx * half, wall.start[1] + ny * half],
    [wall.start[0] - nx * half, wall.start[1] - ny * half],
    [wall.end[0] - nx * half, wall.end[1] - ny * half],
    [wall.end[0] + nx * half, wall.end[1] + ny * half],
  ]
}

// ── Penetration rules ─────────────────────────────────────────────────────

export type WallSleeveRequirement = {
  kind: 'wall-sleeve'
  at: PlanPoint
  /** The sleeve must carry a non-combustible packing. */
  seal: 'non-combustible'
}

export type FireDamperRequirement = {
  kind: 'fire-damper'
  at: PlanPoint
  /** Огнезадерживающий клапан on a fire-rated barrier (СП 7.13130). */
  standard: 'sp-7.13130'
}

/** Where a run crosses a wall, it needs a sleeve (гильза) with a
 *  non-combustible seal. Returns the requirement, or null when the leg does
 *  not cross the barrier. */
export function checkWallPenetration(
  leg: DuctRunLeg,
  barrierPolygon: readonly PlanPoint[],
): WallSleeveRequirement | null {
  const hit = segmentPolygonCrossing(leg.from, leg.to, barrierPolygon)
  if (!hit.crosses || !hit.at) return null
  return { kind: 'wall-sleeve', at: hit.at, seal: 'non-combustible' }
}

/** Crossing a fire-rated barrier requires an огнезадерживающий (fire
 *  damper) valve at the penetration. */
export function checkFireBarrierCrossing(
  leg: DuctRunLeg,
  barrierPolygon: readonly PlanPoint[],
): FireDamperRequirement | null {
  const hit = segmentPolygonCrossing(leg.from, leg.to, barrierPolygon)
  if (!hit.crosses || !hit.at) return null
  return { kind: 'fire-damper', at: hit.at, standard: 'sp-7.13130' }
}
