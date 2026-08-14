import type { AnyNode, AnyNodeId } from '../schema'
import { DuctFittingNode, DuctSegmentNode } from '../schema'
import {
  type DuctSectionProfile,
  ductSectionAreaM2,
  ductSectionHydraulicDiameterM,
  elbowZeta,
  pressureDropPa,
  profileBodyWidthM,
  velocityMps,
} from './aerodynamics'
import { BYPASS_MIN_GAP_MM, ELBOW_RADIUS_FACTOR } from './constants'
import {
  buildDuctNetworkGraphs,
  type DuctJointMember,
  type DuctNetworkGraph,
} from './network-flows'
import type { SystemType } from './norms-types'
import { type PlanPoint, segmentSegmentIntersection } from './routing-rules'
import { type SizingResult, sizeDuctSection } from './sizing'

/**
 * Auto-bypass (утка) service for crossing П/В duct runs — pure planar
 * geometry + aerodynamics, no store, no Three.js (rules source:
 * `docs/mep/04-routing-bypass-practice.md`).
 *
 * Model (user decisions): both runs hang at the same level, supply (П)
 * stays straight, exhaust (В) detours around it with a horizontal offset
 * (утка) that returns to the original axis. The lateral shift is
 * perpendicular to the exhaust run (= perpendicular to the supply for the
 * perpendicular crossing this targets) and equals the supply body width
 * plus a 50 mm gap on both sides. Bends are 45° (R = 1.5D) by default,
 * falling back to 90° when the straight run either side of the crossing
 * cannot fit the shallower S.
 *
 * Этап 9 (утка v2) extends the stage-4 service:
 *  - the vertical-conflict band is replaced by a body-aware check (the runs
 *    only conflict when the bodies overlap closer than `BYPASS_MIN_GAP_MM`);
 *  - `runInM` / `runOutM` walk the collinear straight run through the
 *    segment's own legs AND the port-connected network (`buildDuctNetworkGraphs`),
 *    so the S fits a coupling that runs straight through a joint;
 *  - the S center may shift longitudinally toward the side with the longer
 *    straight run (the «возьми ту сторону, где больше runIn/runOut» rule)
 *    and the lateral `side` is auto-picked to open away from the supply;
 *  - `planBypassRun` plans EVERY crossing of one exhaust segment at once as
 *    a non-overlapping sequence of утки (previously only the first was
 *    applied — `touchedExhaustIds` skipped the rest).
 */

/** A level-local 3D point [x, y, z]. */
export type Point3 = readonly [number, number, number]

/** A single straight leg of a duct path in 3D (level-local meters). */
export type DuctLeg3 = {
  from: Point3
  to: Point3
  profile: DuctSectionProfile
  /** Body dimension across the run, mm — diameter for round, larger side for rect/oval. */
  sizeMm: number
  system: SystemType
}

/** Two runs on the same level count as conflicting within this vertical gap, m.
 *  Kept for API compatibility — stage 9 replaces the flat band with a
 *  body-aware clearance check (`verticalGapMm`). */
export const VERTICAL_CONFLICT_TOL_M = 0.1
/** Crossings landing within this parameter distance of a leg end are joints, not conflicts. */
export const CROSSING_END_EPS = 1e-6
/** Local-resistance model of the утка: two отвода per `docs/mep/04`. */
export const BYPASS_ZETA_ELBOW_COUNT = 2

/** Collinearity threshold for extending the straight run through a joint —
 *  the shared direction unit-vector dot product must exceed this. */
const COLLINEAR_DOT = 0.9995

function profileOf(segment: DuctSegmentNode): DuctSectionProfile {
  return segment.shape === 'round'
    ? { shape: 'round', diameterMm: segment.diameter }
    : { shape: segment.shape, widthMm: segment.width, heightMm: segment.height }
}

/** Vertical body half-extent of a profile, mm — diameter/2 for round,
 *  height/2 (half the vertical side) for rect/oval. Used by the body-aware
 *  vertical clearance check. */
function profileVerticalHalfMm(profile: DuctSectionProfile): number {
  return profile.shape === 'round' ? profile.diameterMm / 2 : profile.heightMm / 2
}

/** The area-equivalent round size a duct presents at its collars (mm). */
export function ductPortDiameterMmCore(segment: DuctSegmentNode): number {
  if (segment.shape === 'rect' || segment.shape === 'oval') {
    const w = segment.width
    const h = segment.height
    if (segment.shape === 'oval') {
      const minor = Math.min(w, h)
      const major = Math.max(w, h)
      const area = (major - minor) * minor + Math.PI * (minor / 2) ** 2
      return 2 * Math.sqrt(area / Math.PI)
    }
    return 2 * Math.sqrt((w * h) / Math.PI)
  }
  return segment.diameter
}

/** Decompose a duct segment's path into its straight 3D legs. */
export function ductLegs3(segment: DuctSegmentNode): DuctLeg3[] {
  const profile = profileOf(segment)
  const sizeMm = Math.round(profileBodyWidthM(profile) * 1000)
  const legs: DuctLeg3[] = []
  for (let i = 0; i < segment.path.length - 1; i += 1) {
    legs.push({
      from: segment.path[i]!,
      to: segment.path[i + 1]!,
      profile,
      sizeMm,
      system: segment.system,
    })
  }
  return legs
}

function legYAtT(leg: DuctLeg3, t: number): number {
  return leg.from[1] + (leg.to[1] - leg.from[1]) * t
}

// ── Path helpers ───────────────────────────────────────────────────────────

function legLengthM(a: Point3, b: Point3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
}

function segmentLengthM(segment: DuctSegmentNode): number {
  let total = 0
  for (let i = 0; i < segment.path.length - 1; i += 1) {
    total += legLengthM(segment.path[i]!, segment.path[i + 1]!)
  }
  return total
}

function cumulativePositions(path: readonly Point3[]): number[] {
  const positions: number[] = [0]
  for (let i = 0; i < path.length - 1; i += 1) {
    positions.push(positions[i]! + legLengthM(path[i]!, path[i + 1]!))
  }
  return positions
}

/** Point on a polyline at a given cumulative distance from its start, m. */
function pointAtCumulative(path: readonly Point3[], cumulativeM: number): Point3 {
  if (cumulativeM <= 0) return [...path[0]!] as Point3
  const positions = cumulativePositions(path)
  const total = positions[positions.length - 1]!
  if (cumulativeM >= total) return [...path[path.length - 1]!] as Point3
  for (let i = 0; i < path.length - 1; i += 1) {
    const start = positions[i]!
    const end = positions[i + 1]!
    if (cumulativeM >= start && cumulativeM <= end) {
      const a = path[i]!
      const b = path[i + 1]!
      const length = end - start
      const t = length > 0 ? (cumulativeM - start) / length : 0
      return [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
      ] as Point3
    }
  }
  return [...path[path.length - 1]!] as Point3
}

/** Cut a polyline at cumulative distances (ascending, strictly inside).
 *  Returns the straight pieces; zero-length pieces (adjacent cuts that
 *  coincide) are dropped. */
function splitPathAtCuts(path: readonly Point3[], cuts: readonly number[]): Point3[][] {
  const sorted = [...cuts].sort((a, b) => a - b)
  const positions = cumulativePositions(path)
  const pieces: Point3[][] = []
  let piece: Point3[] = [[...path[0]!] as Point3]
  let cutIndex = 0
  let current = 0
  for (let i = 0; i < path.length - 1; i += 1) {
    const segmentLength = positions[i + 1]! - positions[i]!
    const segmentEnd = current + segmentLength
    while (cutIndex < sorted.length && sorted[cutIndex]! <= segmentEnd + 1e-9) {
      const cutCumulative = sorted[cutIndex]!
      const t = segmentLength > 0 ? (cutCumulative - current) / segmentLength : 0
      const a = path[i]!
      const b = path[i + 1]!
      const cutPoint: Point3 = [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
      ]
      const last = piece[piece.length - 1]
      if (!last || last[0] !== cutPoint[0] || last[1] !== cutPoint[1] || last[2] !== cutPoint[2]) {
        piece.push(cutPoint)
      }
      if (piece.length > 1) pieces.push(piece)
      piece = [cutPoint]
      cutIndex += 1
    }
    if (i < path.length - 2) {
      const vertex = [...path[i + 1]!] as Point3
      const last = piece[piece.length - 1]
      if (!last || last[0] !== vertex[0] || last[1] !== vertex[1] || last[2] !== vertex[2]) {
        piece.push(vertex)
      }
    }
    current = segmentEnd
  }
  const lastVertex = [...path[path.length - 1]!] as Point3
  const last = piece[piece.length - 1]
  if (
    !last ||
    last[0] !== lastVertex[0] ||
    last[1] !== lastVertex[1] ||
    last[2] !== lastVertex[2]
  ) {
    piece.push(lastVertex)
  }
  if (piece.length > 1) pieces.push(piece)
  return pieces.filter((candidate) =>
    candidate.some((point, index) => index > 0 && legLengthM(candidate[index - 1]!, point) > 1e-9),
  )
}

// ── Collinear straight-run walk (own legs + network joints) ───────────────

function planDirOf(a: Point3, b: Point3): PlanPoint | null {
  const dx = b[0] - a[0]
  const dz = b[2] - a[2]
  const length = Math.hypot(dx, dz)
  return length > 1e-12 ? [dx / length, dz / length] : null
}

/** Same-direction collinearity of two plan unit vectors. */
function collinearDir(a: PlanPoint | null, b: PlanPoint | null): boolean {
  return a !== null && b !== null && a[0] * b[0] + a[1] * b[1] > COLLINEAR_DOT
}

function findJoint(
  graph: DuctNetworkGraph,
  nodeId: AnyNodeId,
  portId: string,
): DuctJointMember[] | null {
  for (const jointId of graph.nodeJoints.get(nodeId) ?? []) {
    const members = graph.joints[jointId]!
    if (members.some((member) => member.nodeId === nodeId && member.portId === portId)) {
      return members
    }
  }
  return null
}

/** Walk a straight run through the network beyond a segment's own path:
 *  at each joint the neighbor must mate via its opposite end collar and its
 *  adjacent leg must continue in the same plan direction. Returns the added
 *  straight-run length, m. */
function extendRunThroughJoints(
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
  graph: DuctNetworkGraph,
  startNodeId: AnyNodeId,
  dir: PlanPoint,
  direction: 'backward' | 'forward',
): number {
  let total = 0
  const visited = new Set<AnyNodeId>([startNodeId])
  let cursor: AnyNodeId | null = startNodeId
  while (cursor) {
    const fromPort = direction === 'backward' ? 'start' : 'end'
    const joint = findJoint(graph, cursor, fromPort)
    if (!joint) break
    const wantPort = direction === 'backward' ? 'end' : 'start'
    const neighbor = joint.find(
      (member) =>
        member.nodeId !== cursor &&
        member.portId === wantPort &&
        nodes[member.nodeId]?.type === 'duct-segment',
    )
    if (!neighbor || visited.has(neighbor.nodeId)) break
    const next = nodes[neighbor.nodeId] as DuctSegmentNode
    const path = next.path
    const lastIndex = path.length - 1
    const nextDir =
      direction === 'backward'
        ? planDirOf(path[lastIndex - 1]!, path[lastIndex]!)
        : planDirOf(path[0]!, path[1]!)
    if (!collinearDir(dir, nextDir)) break
    let allCollinear = true
    if (direction === 'backward') {
      for (let j = lastIndex - 1; j >= 0; j -= 1) {
        if (!collinearDir(dir, planDirOf(path[j]!, path[j + 1]!))) {
          allCollinear = false
          break
        }
        total += legLengthM(path[j]!, path[j + 1]!)
      }
    } else {
      for (let j = 0; j < lastIndex; j += 1) {
        if (!collinearDir(dir, planDirOf(path[j]!, path[j + 1]!))) {
          allCollinear = false
          break
        }
        total += legLengthM(path[j]!, path[j + 1]!)
      }
    }
    visited.add(neighbor.nodeId)
    cursor = allCollinear ? neighbor.nodeId : null
  }
  return total
}

/** Available straight run on each side of the crossing along the exhaust:
 *  the segment's own collinear legs, extended through the port-connected
 *  network when the duct kinds expose ports (falls back to the leg-only run
 *  when no graph is present, e.g. unit tests without registered stubs). */
function collinearRunAt(
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
  graphs: readonly DuctNetworkGraph[],
  networkIndexBySegment: ReadonlyMap<AnyNodeId, number>,
  exhaust: DuctSegmentNode,
  legIndex: number,
  u: number,
): { runInM: number; runOutM: number } {
  const path = exhaust.path
  const n = path.length
  const crossingLegLength = legLengthM(path[legIndex]!, path[legIndex + 1]!)
  const dir = planDirOf(path[legIndex]!, path[legIndex + 1]!)
  let runIn = u * crossingLegLength
  let runOut = (1 - u) * crossingLegLength
  if (!dir) return { runInM: runIn, runOutM: runOut }

  for (let j = legIndex - 1; j >= 0; j -= 1) {
    if (!collinearDir(dir, planDirOf(path[j]!, path[j + 1]!))) break
    runIn += legLengthM(path[j]!, path[j + 1]!)
  }
  for (let j = legIndex + 1; j < n - 1; j += 1) {
    if (!collinearDir(dir, planDirOf(path[j]!, path[j + 1]!))) break
    runOut += legLengthM(path[j]!, path[j + 1]!)
  }

  const graphIndex = networkIndexBySegment.get(exhaust.id)
  if (graphIndex === undefined) return { runInM: runIn, runOutM: runOut }
  const graph = graphs[graphIndex]!
  runIn += extendRunThroughJoints(nodes, graph, exhaust.id, dir, 'backward')
  runOut += extendRunThroughJoints(nodes, graph, exhaust.id, dir, 'forward')
  return { runInM: runIn, runOutM: runOut }
}

export type BypassCrossing = {
  supplyNodeId: AnyNodeId
  exhaustNodeId: AnyNodeId
  supplyLegIndex: number
  exhaustLegIndex: number
  /** Plan crossing point [x, z], level-local meters. */
  point: PlanPoint
  /** Parameter of the crossing along the exhaust leg (0..1). */
  tExhaust: number
  /** Parameter along the supply leg (0..1). */
  tSupply: number
  /** Normalized exhaust run direction on the plan (leg start → end). */
  exhaustDirection: PlanPoint
  supplySizeMm: number
  exhaustSizeMm: number
  /** Vertical gap between the duct bodies at the crossing, mm (negative =
   *  the bodies overlap). A conflict only exists when this is below the
   *  `BYPASS_MIN_GAP_MM` clearance. */
  verticalGapMm: number
  /** The height the bypass runs at (the exhaust height at the crossing), m. */
  elevationM: number
  /** Available straight run each side of the crossing along the exhaust
   *  (collinear through the segment and the network), m. */
  runInM: number
  runOutM: number
  /** Supply leg plan segment — for the auto side / oblique crossing rule. */
  supplyFrom: PlanPoint
  supplyTo: PlanPoint
}

/**
 * Find every plan crossing between a `supply` segment and an `exhaust`
 * segment on the same level. Supply stays straight; the returned crossing
 * names the exhaust run as the bypass candidate. The runs only conflict
 * when their bodies come closer than `BYPASS_MIN_GAP_MM` vertically; a
 * crossing at a leg end (a joint) is not a conflict.
 */
export function detectBypassCrossings(
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
): BypassCrossing[] {
  const segments = Object.values(nodes).filter(
    (n): n is DuctSegmentNode => n.type === 'duct-segment',
  )
  const graphs = buildDuctNetworkGraphs(nodes)
  const networkIndexBySegment = new Map<AnyNodeId, number>()
  for (let graphIndex = 0; graphIndex < graphs.length; graphIndex += 1) {
    for (const id of graphs[graphIndex]!.nodeIds) {
      const node = nodes[id]
      if (node && node.type === 'duct-segment') networkIndexBySegment.set(id, graphIndex)
    }
  }
  const crossings: BypassCrossing[] = []
  for (const supply of segments) {
    if (supply.system !== 'supply') continue
    const supplyLegs = ductLegs3(supply)
    for (const exhaust of segments) {
      if (exhaust.id === supply.id || exhaust.system !== 'exhaust') continue
      const exhaustLegs = ductLegs3(exhaust)
      for (let si = 0; si < supplyLegs.length; si += 1) {
        const sLeg = supplyLegs[si]!
        for (let ei = 0; ei < exhaustLegs.length; ei += 1) {
          const eLeg = exhaustLegs[ei]!
          const hit = segmentSegmentIntersection(
            [sLeg.from[0], sLeg.from[2]],
            [sLeg.to[0], sLeg.to[2]],
            [eLeg.from[0], eLeg.from[2]],
            [eLeg.to[0], eLeg.to[2]],
          )
          if (!hit) continue
          // `segmentSegmentIntersection` returns only the param along the
          // FIRST segment (the supply); recover the exhaust param by
          // projecting the hit point onto the exhaust leg.
          const e0x = eLeg.from[0]
          const e0z = eLeg.from[2]
          const edx = eLeg.to[0] - e0x
          const edz = eLeg.to[2] - e0z
          const lenSq = edx * edx + edz * edz
          const u = ((hit.point[0] - e0x) * edx + (hit.point[1] - e0z) * edz) / lenSq
          // A crossing at a leg end is a joint, not a conflict.
          if (
            hit.t < CROSSING_END_EPS ||
            hit.t > 1 - CROSSING_END_EPS ||
            u < CROSSING_END_EPS ||
            u > 1 - CROSSING_END_EPS
          )
            continue
          // Body-aware vertical clearance: the runs only conflict when the
          // bodies overlap closer than the minimum gap. This replaces the
          // stage-4 flat `VERTICAL_CONFLICT_TOL_M` band.
          const supplyHalfMm = profileVerticalHalfMm(sLeg.profile)
          const exhaustHalfMm = profileVerticalHalfMm(eLeg.profile)
          const verticalGapMm =
            Math.abs(legYAtT(sLeg, hit.t) - legYAtT(eLeg, u)) * 1000 -
            (supplyHalfMm + exhaustHalfMm)
          if (verticalGapMm >= BYPASS_MIN_GAP_MM) continue
          const legLength = Math.hypot(edx, edz)
          const direction: PlanPoint = [edx / legLength, edz / legLength]
          const { runInM, runOutM } = collinearRunAt(
            nodes,
            graphs,
            networkIndexBySegment,
            exhaust,
            ei,
            u,
          )
          crossings.push({
            supplyNodeId: supply.id,
            exhaustNodeId: exhaust.id,
            supplyLegIndex: si,
            exhaustLegIndex: ei,
            point: hit.point,
            tExhaust: u,
            tSupply: hit.t,
            exhaustDirection: direction,
            supplySizeMm: sLeg.sizeMm,
            exhaustSizeMm: eLeg.sizeMm,
            verticalGapMm,
            elevationM: legYAtT(eLeg, u),
            runInM,
            runOutM,
            supplyFrom: [sLeg.from[0], sLeg.from[2]],
            supplyTo: [sLeg.to[0], sLeg.to[2]],
          })
        }
      }
    }
  }
  return crossings
}

/**
 * The S (утка) centerline geometry in the fitting's LOCAL frame: run along
 * +X, lateral shift along +Z, symmetric about x = 0. Bends are arcs of
 * radius `radiusFactor × ductSizeMm`, `angleDeg` each; the middle section
 * (parallel to the run) is `middleMm` long. Null when the two arcs alone
 * overshoot the offset (the inclined section would be negative).
 */
export type BypassGeometry = {
  offsetM: number
  middleM: number
  radiusM: number
  /** Longitudinal extent of each inclined straight, m. */
  inclinedLongitudinalM: number
  /** Half of the total longitudinal span — ports sit at ±halfSpan on the axis. */
  halfSpanM: number
  xTotalM: number
  /** Exact centerline length of the S (four arcs + two inclined + middle), m. */
  lengthM: number
  /** Local-frame S polyline [x, z] — arcs approximated by chords, 8 points. */
  keyPointsLocal: ReadonlyArray<PlanPoint>
}

export function computeBypassGeometry(
  offsetMm: number,
  angleDeg: number,
  radiusFactor: number,
  ductSizeMm: number,
  middleMm = offsetMm,
): BypassGeometry | null {
  const theta = (angleDeg * Math.PI) / 180
  const offsetM = offsetMm / 1000
  const middleM = middleMm / 1000
  const radiusM = (radiusFactor * ductSizeMm) / 1000
  const lateralPerArcM = radiusM * (1 - Math.cos(theta))
  const inclinedLateralM = offsetM - 2 * lateralPerArcM
  if (inclinedLateralM < 0) return null
  const inclinedLongitudinalM = inclinedLateralM / Math.tan(theta)
  const halfSpanM = 2 * radiusM * Math.sin(theta) + inclinedLongitudinalM + middleM / 2
  const xTotalM = halfSpanM * 2
  const arcLenM = radiusM * theta
  const inclinedLenM = inclinedLateralM / Math.sin(theta)
  const lengthM = 4 * arcLenM + 2 * inclinedLenM + middleM

  const s = Math.sin(theta)
  const radLat = lateralPerArcM
  const half = halfSpanM
  const mid = middleM
  const rS = radiusM * s
  const keyPointsLocal: Array<PlanPoint> = [
    [-half, 0],
    [-half + rS, radLat],
    [-mid / 2 - rS, offsetM - radLat],
    [-mid / 2, offsetM],
    [mid / 2, offsetM],
    [mid / 2 + rS, offsetM - radLat],
    [half - rS, radLat],
    [half, 0],
  ]
  return {
    offsetM,
    middleM,
    radiusM,
    inclinedLongitudinalM,
    halfSpanM,
    xTotalM,
    lengthM,
    keyPointsLocal,
  }
}

export type BypassOptions = {
  /** Preferred bend angle, degrees. 45 by default; auto-falls back to 90. */
  angleDeg?: number
  radiusFactor?: number
  minGapMm?: number
  /** Which perpendicular side the S opens toward. Auto-picked when unset. */
  side?: 'left' | 'right'
  /** Design flow, m³/h — enables the aerodynamics / resize report. */
  flowM3h?: number
}

export type BypassAero = {
  velocityMps: number
  /** Σξ of the утка — 2 отвода per `docs/mep/04`. */
  zeta: number
  /** ΔP across the bypass section (friction + local), Pa. */
  pressureDropPa: number
  /** The ГОСТ-ideal section for the flow, if it fits the row. */
  resize: SizingResult | null
  /** True when the current velocity exceeds the norm band and a resize helps. */
  needsResize: boolean
}

/** The S center's longitudinal shift from the crossing, m (positive = toward
 *  the outlet). Chosen so the crossing stays inside the parallel middle
 *  while the collars remain within the available straight run. */
export function chooseBypassShift(
  crossingCumulativeM: number,
  halfSpanM: number,
  middleM: number,
  runStartM: number,
  runEndM: number,
): number {
  const lo = Math.max(runStartM + halfSpanM, crossingCumulativeM - middleM / 2)
  const hi = Math.min(runEndM - halfSpanM, crossingCumulativeM + middleM / 2)
  if (lo > hi + 1e-9) return Number.NaN
  const centered = lo <= crossingCumulativeM + 1e-9 && crossingCumulativeM <= hi + 1e-9
  if (centered) return 0
  const runBefore = crossingCumulativeM - runStartM
  const runAfter = runEndM - crossingCumulativeM
  return runAfter >= runBefore ? hi - crossingCumulativeM : lo - crossingCumulativeM
}

/** Auto-pick the lateral side the S opens toward: the supply's plan segment
 *  is longer on one half-plane of the exhaust axis — open the S away from
 *  it (the «возьми ту сторону, где больше свободной прямой» rule). */
function autoBypassSide(crossing: BypassCrossing): 'left' | 'right' {
  const [ex, ez] = crossing.exhaustDirection
  // 'left' normal of the exhaust axis.
  const nx = -ez
  const nz = ex
  const signed = (point: PlanPoint): number =>
    (point[0] - crossing.point[0]) * nx + (point[1] - crossing.point[1]) * nz
  const a = signed(crossing.supplyFrom)
  const b = signed(crossing.supplyTo)
  return Math.abs(a) > Math.abs(b) ? 'right' : 'left'
}

/** Pick the bend angle (45 preferred, 90 fallback) and lateral side for a
 *  crossing, plus the longitudinal shift. The S is only feasible when its
 *  collars sit inside `[runStartM, runEndM]` and the crossing stays within
 *  the parallel middle. */
function planBypassGeometryForRun(
  crossing: BypassCrossing,
  options: BypassOptions,
  runStartM: number,
  runEndM: number,
  crossingCumulativeM: number,
): {
  angleDeg: number
  radiusFactor: number
  offsetMm: number
  geometry: BypassGeometry
  side: 'left' | 'right'
  shiftM: number
  autoSwitchedTo90: boolean
} | null {
  const minGapMm = options.minGapMm ?? BYPASS_MIN_GAP_MM
  const radiusFactor = options.radiusFactor ?? ELBOW_RADIUS_FACTOR
  const offsetMm = crossing.supplySizeMm + 2 * minGapMm
  const preferred = options.angleDeg ?? 45
  const fallback = preferred === 90 ? 45 : 90
  const side = options.side ?? autoBypassSide(crossing)
  for (const angleDeg of [preferred, fallback]) {
    const geometry = computeBypassGeometry(offsetMm, angleDeg, radiusFactor, crossing.exhaustSizeMm)
    if (!geometry) continue
    const shiftM = chooseBypassShift(
      crossingCumulativeM,
      geometry.halfSpanM,
      geometry.middleM,
      runStartM,
      runEndM,
    )
    if (Number.isNaN(shiftM)) continue
    return {
      angleDeg,
      radiusFactor,
      offsetMm,
      geometry,
      side,
      shiftM,
      autoSwitchedTo90: angleDeg !== preferred,
    }
  }
  return null
}

/** The world-space yaw (about Y) for the S, mapping local +X onto the run
 *  direction and local +Z onto the chosen lateral side. */
function bypassYaw(exhaustDirection: PlanPoint, side: 'left' | 'right'): number {
  const [dx, dz] = exhaustDirection
  return Math.atan2(-dz, dx) + (side === 'right' ? Math.PI : 0)
}

function buildOffsetFitting(
  exhaust: DuctSegmentNode,
  crossing: BypassCrossing,
  geometry: BypassGeometry,
  angleDeg: number,
  radiusFactor: number,
  offsetMm: number,
  centerWorld: Point3,
  side: 'left' | 'right',
): DuctFittingNode {
  const yaw = bypassYaw(crossing.exhaustDirection, side)
  return DuctFittingNode.parse({
    name: 'Утка',
    parentId: exhaust.parentId,
    fittingType: 'offset',
    shape: exhaust.shape,
    width: exhaust.width,
    height: exhaust.height,
    angle: angleDeg,
    offset: offsetMm,
    offsetRadiusFactor: radiusFactor,
    diameter: ductPortDiameterMmCore(exhaust),
    diameter2: ductPortDiameterMmCore(exhaust),
    ductMaterial: exhaust.ductMaterial === 'spiral' ? 'sheet-metal' : exhaust.ductMaterial,
    system: exhaust.system,
    position: [...centerWorld],
    rotation: [0, yaw, 0],
  })
}

function computeBypassAero(
  exhaust: DuctSegmentNode,
  geometry: BypassGeometry,
  angleDeg: number,
  radiusFactor: number,
  flowM3h: number,
): BypassAero {
  const profile = profileOf(exhaust)
  const areaM2 = ductSectionAreaM2(profile)
  const velocity = velocityMps(flowM3h, areaM2)
  const hydraulicDiameterM = ductSectionHydraulicDiameterM(profile)
  const zeta = BYPASS_ZETA_ELBOW_COUNT * elbowZeta(angleDeg, radiusFactor)
  const pressurePa = pressureDropPa({
    lengthM: geometry.lengthM,
    hydraulicDiameterM,
    velocityMps: velocity,
    zeta,
  })
  const resize = sizeDuctSection({
    flowM3h,
    system: 'exhaust',
    shape: exhaust.shape === 'round' ? 'round' : 'rect',
  })
  return {
    velocityMps: velocity,
    zeta,
    pressureDropPa: pressurePa,
    resize,
    needsResize: resize !== null && velocity > resize.recommendedVelocity.max + 1e-9,
  }
}

/** Cumulative distance from the segment start to the crossing, m. */
function crossingCumulativeM(exhaust: DuctSegmentNode, crossing: BypassCrossing): number {
  const path = exhaust.path
  let cumulative = 0
  for (let j = 0; j < crossing.exhaustLegIndex; j += 1) {
    cumulative += legLengthM(path[j]!, path[j + 1]!)
  }
  const legStart = path[crossing.exhaustLegIndex]!
  const legEnd = path[crossing.exhaustLegIndex + 1]!
  cumulative += crossing.tExhaust * legLengthM(legStart, legEnd)
  return cumulative
}

export type BypassPlan = {
  crossing: BypassCrossing
  angleDeg: number
  radiusFactor: number
  offsetMm: number
  offsetM: number
  middleM: number
  radiusM: number
  halfSpanM: number
  xTotalM: number
  bypassLengthM: number
  /** Added centerline vs the straight stretch the S replaces, m. */
  netLengthDeltaM: number
  /** Longitudinal shift of the S center from the crossing, m. */
  shiftM: number
  side: 'left' | 'right'
  autoSwitchedTo90: boolean
  /** Local-frame S polyline [x, z]. */
  keyPointsLocal: ReadonlyArray<PlanPoint>
  /** Level-local 3D centerline of the S (for plans / previews). */
  centerline: Point3[]
  /** Collar where the run leaves the axis, level-local 3D. */
  inletPoint: Point3
  /** Collar where the run returns to the axis, level-local 3D. */
  outletPoint: Point3
  /** Trimmed path for the existing exhaust segment (the before part). */
  beforePath: Point3[]
  /** Path for the new tail segment (the after part). */
  afterPath: Point3[]
  /** The offset (утка) fitting node to create. */
  fitting: DuctFittingNode
  /** Present only when `flowM3h` was provided. */
  aero?: BypassAero
}

export type BypassResult =
  | { status: 'planned'; plan: BypassPlan }
  | { status: 'infeasible'; reason: 'no-room' | 'no-geometry' }

/**
 * Plan the утка that detours the exhaust run around the supply at a
 * detected crossing. The S is kept centered on the crossing when the
 * straight run allows it, otherwise shifted toward the side with the longer
 * run. When the 45° S cannot fit, the 90° S (shorter footprint) is used and
 * `autoSwitchedTo90` is set.
 */
export function planBypass(
  exhaust: DuctSegmentNode,
  crossing: BypassCrossing,
  options: BypassOptions = {},
): BypassResult {
  const totalLengthM = segmentLengthM(exhaust)
  const crossingCumulative = crossingCumulativeM(exhaust, crossing)
  const runStartM = Math.max(0, crossingCumulative - crossing.runInM)
  const runEndM = Math.min(totalLengthM, crossingCumulative + crossing.runOutM)
  const fit = planBypassGeometryForRun(crossing, options, runStartM, runEndM, crossingCumulative)
  if (!fit) return { status: 'infeasible', reason: 'no-room' }
  const { geometry, angleDeg, radiusFactor, offsetMm, side, shiftM, autoSwitchedTo90 } = fit

  const [px, pz] = crossing.point
  const [dx, dz] = crossing.exhaustDirection
  const elevation = crossing.elevationM
  const centerWorld: Point3 = [px + dx * shiftM, elevation, pz + dz * shiftM]
  const inletCumulative = crossingCumulative + shiftM - geometry.halfSpanM
  const outletCumulative = crossingCumulative + shiftM + geometry.halfSpanM
  const inletPoint = pointAtCumulative(exhaust.path, inletCumulative)
  const outletPoint = pointAtCumulative(exhaust.path, outletCumulative)
  // The S replaces the middle straight stretch, so the after part is the
  // third piece (outlet → run end); the middle piece (inlet → outlet) is dropped.
  const pieces = splitPathAtCuts(exhaust.path, [inletCumulative, outletCumulative])
  const beforePath = pieces[0]
  const afterPath = pieces[2] ?? pieces[1]
  if (!beforePath || !afterPath) return { status: 'infeasible', reason: 'no-room' }

  const yaw = bypassYaw(crossing.exhaustDirection, side)
  const centerline = geometry.keyPointsLocal.map(([lx, lz]) => {
    const wx = Math.cos(yaw) * lx + Math.sin(yaw) * lz
    const wz = -Math.sin(yaw) * lx + Math.cos(yaw) * lz
    return [centerWorld[0] + wx, elevation, centerWorld[2] + wz] as Point3
  })

  const fitting = buildOffsetFitting(
    exhaust,
    crossing,
    geometry,
    angleDeg,
    radiusFactor,
    offsetMm,
    centerWorld,
    side,
  )

  let aero: BypassAero | undefined
  if (options.flowM3h !== undefined) {
    aero = computeBypassAero(exhaust, geometry, angleDeg, radiusFactor, options.flowM3h)
  }

  return {
    status: 'planned',
    plan: {
      crossing,
      angleDeg,
      radiusFactor,
      offsetMm,
      offsetM: geometry.offsetM,
      middleM: geometry.middleM,
      radiusM: geometry.radiusM,
      halfSpanM: geometry.halfSpanM,
      xTotalM: geometry.xTotalM,
      bypassLengthM: geometry.lengthM,
      netLengthDeltaM: geometry.lengthM - 2 * geometry.halfSpanM,
      shiftM,
      side,
      autoSwitchedTo90,
      keyPointsLocal: geometry.keyPointsLocal,
      centerline,
      inletPoint,
      outletPoint,
      beforePath,
      afterPath,
      fitting,
      aero,
    },
  }
}

export type BypassMutations = {
  /** The after part of the split exhaust run (new node — fresh id). */
  afterSegment: DuctSegmentNode
  /** The offset fitting (new node). */
  fitting: DuctFittingNode
  /** Trimmed path for the existing exhaust segment (the before part). */
  beforePath: Point3[]
}

/**
 * Turn a single-crossing plan into concrete node mutations: the existing
 * exhaust segment keeps its id but is trimmed to the before part; a new
 * tail segment and the offset fitting are created. Apply via the command
 * layer (checkpoint before mutating) so the whole bypass is one undo step.
 */
export function buildBypassMutations(plan: BypassPlan, exhaust: DuctSegmentNode): BypassMutations {
  const { id: _oldId, ...rest } = exhaust
  const afterSegment = DuctSegmentNode.parse({ ...rest, path: plan.afterPath })
  return {
    afterSegment,
    fitting: plan.fitting,
    beforePath: plan.beforePath,
  }
}

// ── Run-level (multi-crossing) planning ────────────────────────────────────

export type BypassRunBypass = {
  crossing: BypassCrossing
  angleDeg: number
  radiusFactor: number
  offsetMm: number
  offsetM: number
  middleM: number
  radiusM: number
  halfSpanM: number
  xTotalM: number
  bypassLengthM: number
  netLengthDeltaM: number
  /** Longitudinal shift of the S center from the crossing, m. */
  shiftM: number
  side: 'left' | 'right'
  autoSwitchedTo90: boolean
  keyPointsLocal: ReadonlyArray<PlanPoint>
  centerline: Point3[]
  inletPoint: Point3
  outletPoint: Point3
  /** Distance along the run from the segment start, m. */
  inletCumulativeM: number
  outletCumulativeM: number
  /** Straight piece before the S (from the previous collar or segment start). */
  beforePath: Point3[]
  /** Straight piece after the S (to the next collar or segment end). */
  afterPath: Point3[]
  fitting: DuctFittingNode
  aero?: BypassAero
}

export type BypassRunPlan = {
  exhaustNodeId: AnyNodeId
  /** Straight pieces after cutting at every collar:
   *  [before, between₁, …, betweenₙ₋₁, after]. */
  pieces: Point3[][]
  /** S bypasses, sorted along the run, non-overlapping. */
  bypasses: BypassRunBypass[]
  /** Crossings that could not be planned. */
  skipped: Array<{ crossing: BypassCrossing; reason: string }>
}

export type BypassRunResult =
  | { status: 'planned'; plan: BypassRunPlan }
  | { status: 'no-crossings' }

/**
 * Plan every crossing of one exhaust segment at once: a non-overlapping
 * sequence of утки along the run, each centered when the run allows and
 * shifted toward the roomier side otherwise. A later crossing that cannot
 * fit after the previous S is reported as skipped — the rest are still
 * planned (previously `applyAllBypasses` skipped ALL repeats of a touched
 * exhaust segment).
 */
export function planBypassRun(
  exhaust: DuctSegmentNode,
  crossings: readonly BypassCrossing[],
  options: BypassOptions = {},
): BypassRunResult {
  const own = crossings.filter((crossing) => crossing.exhaustNodeId === exhaust.id)
  if (own.length === 0) return { status: 'no-crossings' }
  const totalLengthM = segmentLengthM(exhaust)
  const sorted = [...own].sort(
    (a, b) => crossingCumulativeM(exhaust, a) - crossingCumulativeM(exhaust, b),
  )

  const bypasses: BypassRunBypass[] = []
  const skipped: Array<{ crossing: BypassCrossing; reason: string }> = []
  let previousOutletCumulative = 0

  for (const crossing of sorted) {
    const crossingCumulative = crossingCumulativeM(exhaust, crossing)
    const straightStartM = Math.max(0, crossingCumulative - crossing.runInM)
    const straightEndM = Math.min(totalLengthM, crossingCumulative + crossing.runOutM)
    const runStartM = Math.max(straightStartM, previousOutletCumulative)
    const runEndM = straightEndM
    const fit = planBypassGeometryForRun(crossing, options, runStartM, runEndM, crossingCumulative)
    if (!fit) {
      skipped.push({ crossing, reason: 'no-room' })
      continue
    }
    const { geometry, angleDeg, radiusFactor, offsetMm, side, shiftM, autoSwitchedTo90 } = fit
    const [px, pz] = crossing.point
    const [dx, dz] = crossing.exhaustDirection
    const elevation = crossing.elevationM
    const centerWorld: Point3 = [px + dx * shiftM, elevation, pz + dz * shiftM]
    const inletCumulative = crossingCumulative + shiftM - geometry.halfSpanM
    const outletCumulative = crossingCumulative + shiftM + geometry.halfSpanM
    previousOutletCumulative = outletCumulative

    const yaw = bypassYaw(crossing.exhaustDirection, side)
    const centerline = geometry.keyPointsLocal.map(([lx, lz]) => {
      const wx = Math.cos(yaw) * lx + Math.sin(yaw) * lz
      const wz = -Math.sin(yaw) * lx + Math.cos(yaw) * lz
      return [centerWorld[0] + wx, elevation, centerWorld[2] + wz] as Point3
    })
    const fitting = buildOffsetFitting(
      exhaust,
      crossing,
      geometry,
      angleDeg,
      radiusFactor,
      offsetMm,
      centerWorld,
      side,
    )
    let aero: BypassAero | undefined
    if (options.flowM3h !== undefined) {
      aero = computeBypassAero(exhaust, geometry, angleDeg, radiusFactor, options.flowM3h)
    }
    bypasses.push({
      crossing,
      angleDeg,
      radiusFactor,
      offsetMm,
      offsetM: geometry.offsetM,
      middleM: geometry.middleM,
      radiusM: geometry.radiusM,
      halfSpanM: geometry.halfSpanM,
      xTotalM: geometry.xTotalM,
      bypassLengthM: geometry.lengthM,
      netLengthDeltaM: geometry.lengthM - 2 * geometry.halfSpanM,
      shiftM,
      side,
      autoSwitchedTo90,
      keyPointsLocal: geometry.keyPointsLocal,
      centerline,
      inletPoint: pointAtCumulative(exhaust.path, inletCumulative),
      outletPoint: pointAtCumulative(exhaust.path, outletCumulative),
      inletCumulativeM: inletCumulative,
      outletCumulativeM: outletCumulative,
      beforePath: [],
      afterPath: [],
      fitting,
      aero,
    })
  }

  const cuts = bypasses.flatMap((bypass) => [bypass.inletCumulativeM, bypass.outletCumulativeM])
  // Each утка replaces its inlet→outlet straight stretch, so the run keeps
  // only the even-indexed pieces (before, between утки, after).
  const pieces = splitPathAtCuts(exhaust.path, cuts).filter((_piece, index) => index % 2 === 0)
  bypasses.forEach((bypass, index) => {
    bypass.beforePath = pieces[index] ?? []
    bypass.afterPath = pieces[index + 1] ?? []
  })

  return { status: 'planned', plan: { exhaustNodeId: exhaust.id, pieces, bypasses, skipped } }
}

export type BypassRunMutations = {
  /** Trimmed path for the existing exhaust segment (the before part). */
  beforePath: Point3[]
  /** The tail segment after the last утка (new node — fresh id). */
  afterSegment: DuctSegmentNode
  /** Straight segments between consecutive утки (new nodes — fresh ids). */
  intermediateSegments: DuctSegmentNode[]
  /** The offset (утка) fittings (new nodes). */
  fittings: DuctFittingNode[]
}

/**
 * Turn a run plan into concrete node mutations: the existing exhaust
 * segment is trimmed to the first before piece; each straight piece between
 * the утки and the tail become fresh segments; the offset fittings are
 * created. Apply via the command layer so the whole run is one undo step.
 */
export function buildBypassRunMutations(
  plan: BypassRunPlan,
  exhaust: DuctSegmentNode,
): BypassRunMutations {
  const { id: _oldId, ...rest } = exhaust
  const pieces = plan.pieces
  const afterSegment = DuctSegmentNode.parse({ ...rest, path: pieces[pieces.length - 1]! })
  const intermediateSegments = pieces
    .slice(1, -1)
    .map((path) => DuctSegmentNode.parse({ ...rest, path }))
  return {
    beforePath: pieces[0]!,
    afterSegment,
    intermediateSegments,
    fittings: plan.bypasses.map((bypass) => bypass.fitting),
  }
}

/** Convenience — detect every crossing and plan each exhaust run's full
 *  sequence of утки. Crossings that cannot fit are reported as skipped. */
export function planAllBypassRuns(
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
  options: BypassOptions = {},
): BypassRunPlan[] {
  const crossingsByExhaust = new Map<AnyNodeId, BypassCrossing[]>()
  for (const crossing of detectBypassCrossings(nodes)) {
    const list = crossingsByExhaust.get(crossing.exhaustNodeId) ?? []
    list.push(crossing)
    crossingsByExhaust.set(crossing.exhaustNodeId, list)
  }
  const runs: BypassRunPlan[] = []
  for (const [exhaustId, crossings] of crossingsByExhaust) {
    const exhaust = nodes[exhaustId]
    if (exhaust?.type !== 'duct-segment') continue
    const result = planBypassRun(exhaust, crossings, options)
    if (result.status === 'planned') runs.push(result.plan)
  }
  return runs
}

/** Convenience — flatten every run plan into one plan per утка (the stage-5
 *  preview shape). Kept API-compatible: `plans[0]` + `buildBypassMutations`
 *  still apply a single-crossing run exactly as before. */
export function planAllBypasses(
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
  options: BypassOptions = {},
): { plans: BypassPlan[]; skipped: Array<{ crossing: BypassCrossing; reason: string }> } {
  const plans: BypassPlan[] = []
  const skipped: Array<{ crossing: BypassCrossing; reason: string }> = []
  for (const run of planAllBypassRuns(nodes, options)) {
    run.bypasses.forEach((bypass, index) => {
      plans.push({
        crossing: bypass.crossing,
        angleDeg: bypass.angleDeg,
        radiusFactor: bypass.radiusFactor,
        offsetMm: bypass.offsetMm,
        offsetM: bypass.offsetM,
        middleM: bypass.middleM,
        radiusM: bypass.radiusM,
        halfSpanM: bypass.halfSpanM,
        xTotalM: bypass.xTotalM,
        bypassLengthM: bypass.bypassLengthM,
        netLengthDeltaM: bypass.netLengthDeltaM,
        shiftM: bypass.shiftM,
        side: bypass.side,
        autoSwitchedTo90: bypass.autoSwitchedTo90,
        keyPointsLocal: bypass.keyPointsLocal,
        centerline: bypass.centerline,
        inletPoint: bypass.inletPoint,
        outletPoint: bypass.outletPoint,
        beforePath: bypass.beforePath,
        afterPath: bypass.afterPath,
        fitting: bypass.fitting,
        aero: bypass.aero,
      })
    })
    for (const entry of run.skipped) skipped.push(entry)
  }
  return { plans, skipped }
}
