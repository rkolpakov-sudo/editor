import { describe, expect, test } from 'bun:test'
import type { AnyNode, AnyNodeId } from '../schema'
import { DuctSegmentNode } from '../schema'
import { elbowZeta } from './aerodynamics'
import {
  buildBypassMutations,
  computeBypassGeometry,
  detectBypassCrossings,
  planBypass,
} from './bypass'
import { BYPASS_MIN_GAP_MM } from './constants'

type Point = [number, number, number]

function ductSegment(
  path: Point[],
  opts: {
    id: string
    system?: 'supply' | 'exhaust' | 'return'
    shape?: 'round' | 'rect' | 'oval'
    diameter?: number
    width?: number
    height?: number
  },
): DuctSegmentNode {
  return DuctSegmentNode.parse({
    id: opts.id as AnyNodeId,
    path,
    system: opts.system ?? 'supply',
    shape: opts.shape ?? 'round',
    diameter: opts.diameter ?? 160,
    width: opts.width ?? 400,
    height: opts.height ?? 200,
  })
}

function sceneOf(...nodes: AnyNode[]): Record<AnyNodeId, AnyNode> {
  return Object.fromEntries(nodes.map((n) => [n.id, n])) as Record<AnyNodeId, AnyNode>
}

/** Perpendicular crossing: supply along X, exhaust along Z, both at y = 2.6. */
function crossingScene(opts: {
  supplySize?: number
  exhaustSize?: number
  supplyY?: number
  exhaustY?: number
  exhaustLengthM?: number
  supplyShape?: 'round' | 'rect'
}): { supply: DuctSegmentNode; exhaust: DuctSegmentNode; scene: Record<AnyNodeId, AnyNode> } {
  const supply = ductSegment(
    [
      [-3, opts.supplyY ?? 2.6, 0],
      [3, opts.supplyY ?? 2.6, 0],
    ],
    {
      id: 'duct-segment_supply',
      system: 'supply',
      shape: opts.supplyShape ?? 'round',
      diameter: opts.supplySize ?? 400,
      width: opts.supplySize ?? 500,
      height: 200,
    },
  )
  const half = (opts.exhaustLengthM ?? 3) / 2
  const exhaust = ductSegment(
    [
      [0, opts.exhaustY ?? 2.6, -half],
      [0, opts.exhaustY ?? 2.6, half],
    ],
    {
      id: 'duct-segment_exhaust',
      system: 'exhaust',
      diameter: opts.exhaustSize ?? 200,
    },
  )
  return { supply, exhaust, scene: sceneOf(supply, exhaust) }
}

describe('computeBypassGeometry', () => {
  test('45° S returns a symmetric centerline at the requested offset', () => {
    const g = computeBypassGeometry(500, 45, 1.5, 200)
    expect(g).not.toBeNull()
    // Middle section sits at z = offset, centered on x = 0.
    expect(g!.keyPointsLocal[3]![0]).toBeCloseTo(-g!.middleM / 2, 5)
    expect(g!.keyPointsLocal[3]![1]).toBeCloseTo(g!.offsetM, 5)
    expect(g!.keyPointsLocal[4]![0]).toBeCloseTo(g!.middleM / 2, 5)
    expect(g!.keyPointsLocal[4]![1]).toBeCloseTo(g!.offsetM, 5)
    // Start / end back on the axis.
    expect(g!.keyPointsLocal[0]![1]).toBe(0)
    expect(g!.keyPointsLocal[7]![1]).toBe(0)
    expect(g!.keyPointsLocal[0]![0]).toBeCloseTo(-g!.halfSpanM, 5)
    expect(g!.keyPointsLocal[7]![0]).toBeCloseTo(g!.halfSpanM, 5)
    expect(g!.xTotalM).toBeCloseTo(g!.halfSpanM * 2, 5)
  })

  test('90° S has no inclined straight (lateral reached by the arcs)', () => {
    // offset 600 = 2 × R (R = 1.5 × 200): the two arcs reach the offset exactly.
    const g = computeBypassGeometry(600, 90, 1.5, 200)
    expect(g).not.toBeNull()
    expect(g!.inclinedLongitudinalM).toBeCloseTo(0, 5)
  })

  test('null when the two arcs alone overshoot the offset', () => {
    // R = 1.5 × 200 = 300 mm; 2 × R × (1 − cos 45°) ≈ 175 mm > 50 mm offset.
    expect(computeBypassGeometry(50, 45, 1.5, 200)).toBeNull()
  })
})

describe('detectBypassCrossings', () => {
  test('finds a perpendicular П/В crossing at the same height', () => {
    const { scene } = crossingScene({ supplySize: 400, exhaustSize: 200 })
    const crossings = detectBypassCrossings(scene)
    expect(crossings).toHaveLength(1)
    const c = crossings[0]!
    expect(c.supplyNodeId).toBe('duct-segment_supply')
    expect(c.exhaustNodeId).toBe('duct-segment_exhaust')
    expect(c.point[0]).toBeCloseTo(0, 5)
    expect(c.point[1]).toBeCloseTo(0, 5)
    expect(c.tExhaust).toBeCloseTo(0.5, 5)
    expect(c.supplySizeMm).toBe(400)
    expect(c.exhaustSizeMm).toBe(200)
    expect(c.runInM).toBeCloseTo(1.5, 5)
    expect(c.runOutM).toBeCloseTo(1.5, 5)
  })

  test('rect supply reports its larger side as the body size', () => {
    const { scene } = crossingScene({ supplyShape: 'rect', supplySize: 500 })
    const [c] = detectBypassCrossings(scene)
    expect(c!.supplySizeMm).toBe(500)
  })

  test('skips runs on different levels', () => {
    const { scene } = crossingScene({ supplyY: 2.6, exhaustY: 3.2 })
    expect(detectBypassCrossings(scene)).toHaveLength(0)
  })

  test('skips same-system runs', () => {
    const supply = ductSegment(
      [
        [-3, 2.6, 0],
        [3, 2.6, 0],
      ],
      { id: 'duct-segment_s1', system: 'supply' },
    )
    const exhaust = ductSegment(
      [
        [0, 2.6, -3],
        [0, 2.6, 3],
      ],
      { id: 'duct-segment_s2', system: 'supply' },
    )
    expect(detectBypassCrossings(sceneOf(supply, exhaust))).toHaveLength(0)
  })

  test('skips a crossing that lands on a leg end (a joint, not a conflict)', () => {
    const supply = ductSegment(
      [
        [-3, 2.6, 0],
        [3, 2.6, 0],
      ],
      { id: 'duct-segment_supply', system: 'supply' },
    )
    const exhaust = ductSegment(
      [
        [0, 2.6, -3],
        [0, 2.6, 0],
      ],
      { id: 'duct-segment_exhaust', system: 'exhaust' },
    )
    expect(detectBypassCrossings(sceneOf(supply, exhaust))).toHaveLength(0)
  })
})

describe('planBypass', () => {
  test('plans a 45° утка with the supply-body + 2×50 mm offset', () => {
    const { exhaust, scene } = crossingScene({ supplySize: 400, exhaustSize: 200 })
    const [crossing] = detectBypassCrossings(scene)
    const result = planBypass(exhaust, crossing!)
    expect(result.status).toBe('planned')
    if (result.status !== 'planned') return
    const plan = result.plan
    expect(plan.angleDeg).toBe(45)
    expect(plan.autoSwitchedTo90).toBe(false)
    expect(plan.offsetMm).toBe(400 + 2 * BYPASS_MIN_GAP_MM)
    expect(plan.halfSpanM).toBeLessThanOrEqual(3)
    // The parallel section clears the supply body by ≥ 50 mm.
    const gapMm = plan.offsetM * 1000 - (crossing!.supplySizeMm + crossing!.exhaustSizeMm) / 2
    expect(gapMm).toBeGreaterThanOrEqual(BYPASS_MIN_GAP_MM)
  })

  test('splits the exhaust path at the collars on the original axis', () => {
    const { exhaust, scene } = crossingScene({ supplySize: 400, exhaustSize: 200 })
    const [crossing] = detectBypassCrossings(scene)
    const result = planBypass(exhaust, crossing!)
    if (result.status !== 'planned') throw new Error('expected planned')
    const plan = result.plan
    const dHalf = plan.halfSpanM
    // Exhaust runs along +Z, so the collars sit at z = ±dHalf on the axis.
    expect(plan.inletPoint[0]).toBeCloseTo(0, 5)
    expect(plan.inletPoint[2]).toBeCloseTo(-dHalf, 5)
    expect(plan.inletPoint[1]).toBeCloseTo(2.6, 5)
    expect(plan.outletPoint[0]).toBeCloseTo(0, 5)
    expect(plan.outletPoint[2]).toBeCloseTo(dHalf, 5)
    expect(plan.beforePath[plan.beforePath.length - 1]).toEqual(plan.inletPoint)
    expect(plan.afterPath[0]).toEqual(plan.outletPoint)
    // The two split segments reconnect the endpoints of the original leg.
    expect(plan.beforePath[0]).toEqual([0, 2.6, -1.5])
    expect(plan.afterPath[plan.afterPath.length - 1]).toEqual([0, 2.6, 1.5])
  })

  test('the fitting is an offset утка on the exhaust run', () => {
    const { exhaust, scene } = crossingScene({ supplySize: 400, exhaustSize: 200 })
    const [crossing] = detectBypassCrossings(scene)
    const result = planBypass(exhaust, crossing!)
    if (result.status !== 'planned') throw new Error('expected planned')
    const f = result.plan.fitting
    expect(f.fittingType).toBe('offset')
    expect(f.system).toBe('exhaust')
    expect(f.angle).toBe(45)
    expect(f.offset).toBe(500)
    expect(f.offsetRadiusFactor).toBe(1.5)
    expect(f.position).toEqual([0, 2.6, 0])
    // Run along +Z → yaw −π/2 (local +X maps onto +Z).
    expect(f.rotation[1]).toBeCloseTo(-Math.PI / 2, 5)
    // Ports sit on the run axis at ±half-span.
    expect(result.plan.inletPoint[2]).toBeCloseTo(-result.plan.halfSpanM, 5)
  })

  test('auto-switches 45° → 90° when the straight run is too short', () => {
    // offset = 800 + 100 = 900 mm; 45° S needs ~1.60 m half-span, 90° ~1.05 m.
    const { exhaust, scene } = crossingScene({
      supplySize: 800,
      exhaustSize: 200,
      exhaustLengthM: 2.6,
    })
    const [crossing] = detectBypassCrossings(scene)
    const result = planBypass(exhaust, crossing!)
    expect(result.status).toBe('planned')
    if (result.status !== 'planned') return
    // available = 1.3 m: the 45° S cannot fit, the 90° S can.
    expect(result.plan.angleDeg).toBe(90)
    expect(result.plan.autoSwitchedTo90).toBe(true)
  })

  test('reports infeasible when even the 90° S cannot fit', () => {
    const { exhaust, scene } = crossingScene({
      supplySize: 800,
      exhaustSize: 200,
      exhaustLengthM: 1.6,
    })
    const [crossing] = detectBypassCrossings(scene)
    const result = planBypass(exhaust, crossing!)
    expect(result.status).toBe('infeasible')
  })

  test('computes aerodynamics and a resize suggestion when flow is given', () => {
    const { exhaust, scene } = crossingScene({ supplySize: 400, exhaustSize: 200 })
    const [crossing] = detectBypassCrossings(scene)
    const result = planBypass(exhaust, crossing!, { flowM3h: 500 })
    if (result.status !== 'planned') throw new Error('expected planned')
    const aero = result.plan.aero
    expect(aero).toBeDefined()
    expect(aero!.zeta).toBeCloseTo(2 * elbowZeta(45, 1.5), 5)
    expect(aero!.pressureDropPa).toBeGreaterThan(0)
    expect(aero!.velocityMps).toBeCloseTo(500 / 3600 / (Math.PI * 0.1 ** 2), 5)
    expect(aero!.resize).not.toBeNull()
  })
})

describe('buildBypassMutations', () => {
  test('keeps the exhaust id for the before part, creates a fresh tail segment', () => {
    const { exhaust, scene } = crossingScene({ supplySize: 400, exhaustSize: 200 })
    const [crossing] = detectBypassCrossings(scene)
    const result = planBypass(exhaust, crossing!)
    if (result.status !== 'planned') throw new Error('expected planned')
    const mutations = buildBypassMutations(result.plan, exhaust)
    expect(mutations.beforePath).toEqual(result.plan.beforePath)
    expect(mutations.fitting.fittingType).toBe('offset')
    expect(mutations.afterSegment.id).not.toBe(exhaust.id)
    expect(mutations.afterSegment.path).toEqual(result.plan.afterPath)
    expect(mutations.afterSegment.system).toBe('exhaust')
  })
})
