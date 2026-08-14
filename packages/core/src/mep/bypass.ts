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

/** Two runs on the same level count as conflicting within this vertical gap, m. */
export const VERTICAL_CONFLICT_TOL_M = 0.1
/** Crossings landing within this parameter distance of a leg end are joints, not conflicts. */
export const CROSSING_END_EPS = 1e-6
/** Local-resistance model of the утка: two отвода per `docs/mep/04`. */
export const BYPASS_ZETA_ELBOW_COUNT = 2

function profileOf(segment: DuctSegmentNode): DuctSectionProfile {
  return segment.shape === 'round'
    ? { shape: 'round', diameterMm: segment.diameter }
    : { shape: segment.shape, widthMm: segment.width, heightMm: segment.height }
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
  /** The height the bypass runs at (the exhaust height at the crossing), m. */
  elevationM: number
  /** Available straight run length each side of the crossing along the exhaust, m. */
  runInM: number
  runOutM: number
}

/**
 * Find every plan crossing between a `supply` segment and an `exhaust`
 * segment on the same level. Supply stays straight; the returned crossing
 * names the exhaust run as the bypass candidate.
 */
export function detectBypassCrossings(
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
): BypassCrossing[] {
  const segments = Object.values(nodes).filter(
    (n): n is DuctSegmentNode => n.type === 'duct-segment',
  )
  const crossings: BypassCrossing[] = []
  for (const supply of segments) {
    if (supply.system !== 'supply') continue
    for (const exhaust of segments) {
      if (exhaust.id === supply.id || exhaust.system !== 'exhaust') continue
      const supplyLegs = ductLegs3(supply)
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
          if (Math.abs(legYAtT(sLeg, hit.t) - legYAtT(eLeg, u)) > VERTICAL_CONFLICT_TOL_M) {
            continue
          }
          const legLen = Math.hypot(edx, edz)
          const direction: PlanPoint = [edx / legLen, edz / legLen]
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
            elevationM: legYAtT(eLeg, u),
            runInM: u * legLen,
            runOutM: (1 - u) * legLen,
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
  /** Which perpendicular side the S opens toward. 'left' default. */
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
 * detected crossing. The S is centered on the crossing and must fit inside
 * the straight run available on both sides; when the 45° S cannot fit, the
 * 90° S (shorter footprint) is used and `autoSwitchedTo90` is set.
 */
export function planBypass(
  exhaust: DuctSegmentNode,
  crossing: BypassCrossing,
  options: BypassOptions = {},
): BypassResult {
  const minGapMm = options.minGapMm ?? BYPASS_MIN_GAP_MM
  const radiusFactor = options.radiusFactor ?? ELBOW_RADIUS_FACTOR
  const offsetMm = crossing.supplySizeMm + 2 * minGapMm
  const preferred = options.angleDeg ?? 45
  const fallback = preferred === 90 ? 45 : 90
  const availableM = Math.min(crossing.runInM, crossing.runOutM)

  let chosenAngle = 0
  let geometry: BypassGeometry | null = null
  for (const angleDeg of [preferred, fallback]) {
    const g = computeBypassGeometry(offsetMm, angleDeg, radiusFactor, crossing.exhaustSizeMm)
    if (g && g.halfSpanM <= availableM) {
      chosenAngle = angleDeg
      geometry = g
      break
    }
  }
  if (!geometry) return { status: 'infeasible', reason: 'no-room' }
  const autoSwitchedTo90 = chosenAngle !== preferred
  const side = options.side ?? 'left'

  const [px, pz] = crossing.point
  const elevation = crossing.elevationM
  const [dx, dz] = crossing.exhaustDirection
  const dHalf = geometry.halfSpanM
  const inletPoint: Point3 = [px - dx * dHalf, elevation, pz - dz * dHalf]
  const outletPoint: Point3 = [px + dx * dHalf, elevation, pz + dz * dHalf]

  const i = crossing.exhaustLegIndex
  const path = exhaust.path
  const beforePath: Point3[] = [...path.slice(0, i + 1).map((p) => [...p] as Point3), inletPoint]
  const afterPath: Point3[] = [outletPoint, ...path.slice(i + 1).map((p) => [...p] as Point3)]

  const yaw = Math.atan2(-dz, dx) + (side === 'right' ? Math.PI : 0)
  const centerline = geometry.keyPointsLocal.map(([lx, lz]) => {
    const wx = Math.cos(yaw) * lx + Math.sin(yaw) * lz
    const wz = -Math.sin(yaw) * lx + Math.cos(yaw) * lz
    return [px + wx, elevation, pz + wz] as Point3
  })

  const fitting = DuctFittingNode.parse({
    name: 'Утка',
    parentId: exhaust.parentId,
    fittingType: 'offset',
    shape: exhaust.shape,
    width: exhaust.width,
    height: exhaust.height,
    angle: chosenAngle,
    offset: offsetMm,
    offsetRadiusFactor: radiusFactor,
    diameter: ductPortDiameterMmCore(exhaust),
    diameter2: ductPortDiameterMmCore(exhaust),
    ductMaterial: exhaust.ductMaterial === 'spiral' ? 'sheet-metal' : exhaust.ductMaterial,
    system: exhaust.system,
    position: [px, elevation, pz],
    rotation: [0, yaw, 0],
  })

  let aero: BypassAero | undefined
  if (options.flowM3h !== undefined) {
    const profile = profileOf(exhaust)
    const areaM2 = ductSectionAreaM2(profile)
    const v = velocityMps(options.flowM3h, areaM2)
    const dH = ductSectionHydraulicDiameterM(profile)
    const zeta = BYPASS_ZETA_ELBOW_COUNT * elbowZeta(chosenAngle, radiusFactor)
    const pressurePa = pressureDropPa({
      lengthM: geometry.lengthM,
      hydraulicDiameterM: dH,
      velocityMps: v,
      zeta,
    })
    const resize = sizeDuctSection({
      flowM3h: options.flowM3h,
      system: 'exhaust',
      shape: exhaust.shape === 'round' ? 'round' : 'rect',
    })
    aero = {
      velocityMps: v,
      zeta,
      pressureDropPa: pressurePa,
      resize,
      needsResize: resize !== null && v > resize.recommendedVelocity.max + 1e-9,
    }
  }

  return {
    status: 'planned',
    plan: {
      crossing,
      angleDeg: chosenAngle,
      radiusFactor,
      offsetMm,
      offsetM: geometry.offsetM,
      middleM: geometry.middleM,
      radiusM: geometry.radiusM,
      halfSpanM: geometry.halfSpanM,
      xTotalM: geometry.xTotalM,
      bypassLengthM: geometry.lengthM,
      netLengthDeltaM: geometry.lengthM - 2 * geometry.halfSpanM,
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
 * Turn a plan into concrete node mutations: the existing exhaust segment
 * keeps its id but is trimmed to the before part; a new tail segment and
 * the offset fitting are created. Apply via the command layer (checkpoint
 * before mutating) so the whole bypass is one undo step.
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

/**
 * Convenience — detect every crossing and plan each bypass. Crossings on
 * segments with insufficient run on either side are reported as skipped.
 */
export function planAllBypasses(
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
  options: BypassOptions = {},
): { plans: BypassPlan[]; skipped: Array<{ crossing: BypassCrossing; reason: string }> } {
  const plans: BypassPlan[] = []
  const skipped: Array<{ crossing: BypassCrossing; reason: string }> = []
  for (const crossing of detectBypassCrossings(nodes)) {
    const exhaust = nodes[crossing.exhaustNodeId]
    if (exhaust?.type !== 'duct-segment') continue
    const result = planBypass(exhaust, crossing, options)
    if (result.status === 'planned') {
      plans.push(result.plan)
    } else {
      skipped.push({ crossing, reason: result.reason })
    }
  }
  return { plans, skipped }
}
