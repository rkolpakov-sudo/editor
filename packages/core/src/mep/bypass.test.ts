import { describe, expect, test } from 'bun:test'
import type { AnyNode, AnyNodeId } from '../schema'
import { DuctSegmentNode } from '../schema'
import { elbowZeta } from './aerodynamics'
import {
  buildBypassMutations,
  buildBypassRunMutations,
  computeBypassGeometry,
  detectBypassCrossings,
  planAllBypasses,
  planAllBypassRuns,
  planBypass,
} from './bypass'
import { BYPASS_MIN_GAP_MM } from './constants'
import { buildDuctNetworks, validateDuctNetwork } from './duct-network'
import {
  registerDuctNetworkStubs,
  ductSegment as stubDuctSegment,
  ductTee as stubDuctTee,
  ductTerminal as stubDuctTerminal,
  sceneOf as stubSceneOf,
} from './duct-network-stubs'

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

// ── Этап 9: утка v2 ────────────────────────────────────────────────────────

describe('Этап 9: вертикальный зазор корпусов', () => {
  test('не конфликт, когда корпуса уже разнесены по вертикали на ≥ 50 мм', () => {
    // Приток Ø400 на y=3.1, вытяжка Ø200 на y=2.6:
    // зазор корпусов = 0.5 − (0.2 + 0.1) = 0.2 м = 200 мм ≥ 50 мм.
    const { scene } = crossingScene({
      supplySize: 400,
      supplyY: 3.1,
      exhaustSize: 200,
      exhaustY: 2.6,
    })
    expect(detectBypassCrossings(scene)).toHaveLength(0)
  })

  test('конфликт, когда корпуса перекрываются ближе минимального зазора', () => {
    // Приток Ø400 на y=2.9, вытяжка Ø200 на y=2.6:
    // зазор корпусов = 0.3 − 0.3 = 0 мм < 50 мм → пересечение требует утки.
    const { scene } = crossingScene({
      supplySize: 400,
      supplyY: 2.9,
      exhaustSize: 200,
      exhaustY: 2.6,
    })
    const crossings = detectBypassCrossings(scene)
    expect(crossings).toHaveLength(1)
    expect(crossings[0]!.verticalGapMm).toBeLessThan(BYPASS_MIN_GAP_MM)
  })

  test('прямоугольный корпус учитывает вертикальную сторону (height)', () => {
    // Прямоугольный приток 500×200 на y=3.0 (высота 200 → половина 100 мм),
    // вытяжка Ø200 на y=2.6: зазор = 0.4 − (0.1 + 0.1) = 0.2 м ≥ 50 мм → нет конфликта.
    const { scene } = crossingScene({
      supplyShape: 'rect',
      supplySize: 500,
      supplyY: 3.0,
      exhaustSize: 200,
      exhaustY: 2.6,
    })
    expect(detectBypassCrossings(scene)).toHaveLength(0)
  })
})

describe('Этап 9: автовыбор стороны и продольный сдвиг', () => {
  test('косое пересечение: утка открывается в сторону от длинного плеча притока', () => {
    // Вытяжка вдоль +Z, приток по диагонали с большей частью на левой полуплоскости.
    const supply = ductSegment(
      [
        [-6, 2.6, 3],
        [2, 2.6, -1],
      ],
      {
        id: 'duct-segment_supply',
        system: 'supply',
        shape: 'round',
        diameter: 300,
      },
    )
    const exhaust = ductSegment(
      [
        [0, 2.6, -5],
        [0, 2.6, 5],
      ],
      {
        id: 'duct-segment_exhaust',
        system: 'exhaust',
        shape: 'round',
        diameter: 160,
      },
    )
    const [crossing] = detectBypassCrossings(sceneOf(supply, exhaust))
    expect(crossing).toBeDefined()
    const result = planBypass(exhaust, crossing!, {})
    if (result.status !== 'planned') throw new Error('expected planned')
    expect(result.plan.side).toBe('right')
  })

  test('центрированная утка при равных прямых, сдвиг 0', () => {
    const { exhaust, scene } = crossingScene({ supplySize: 400, exhaustSize: 200 })
    const [crossing] = detectBypassCrossings(scene)
    const result = planBypass(exhaust, crossing!)
    if (result.status !== 'planned') throw new Error('expected planned')
    expect(result.plan.shiftM).toBeCloseTo(0, 9)
    // Коллары симметричны относительно точки пересечения.
    expect(result.plan.inletPoint[2]).toBeCloseTo(-result.plan.halfSpanM, 5)
    expect(result.plan.outletPoint[2]).toBeCloseTo(result.plan.halfSpanM, 5)
  })

  test('указывает options.side — явный выбор перекрывает авто', () => {
    const { exhaust, scene } = crossingScene({ supplySize: 400, exhaustSize: 200 })
    const [crossing] = detectBypassCrossings(scene)
    const result = planBypass(exhaust, crossing!, { side: 'left' })
    if (result.status !== 'planned') throw new Error('expected planned')
    expect(result.plan.side).toBe('left')
  })

  test('сдвигает S к более длинной прямой (взято «где больше runIn/runOut»)', () => {
    // Пересечение близко к началу вытяжки: runIn 0.6 м, runOut 2.6 м —
    // центр S смещается к выходу, чтобы утка поместилась.
    const supply = ductSegment(
      [
        [-2, 2.6, 0.6],
        [2, 2.6, 0.6],
      ],
      {
        id: 'duct-segment_supply',
        system: 'supply',
        shape: 'round',
        diameter: 250,
      },
    )
    const exhaust = ductSegment(
      [
        [0, 2.6, 0],
        [0, 2.6, 3.2],
      ],
      {
        id: 'duct-segment_exhaust',
        system: 'exhaust',
        shape: 'round',
        diameter: 160,
      },
    )
    const [crossing] = detectBypassCrossings(sceneOf(supply, exhaust))
    expect(crossing).toBeDefined()
    expect(crossing!.runInM).toBeCloseTo(0.6, 5)
    expect(crossing!.runOutM).toBeCloseTo(2.6, 5)
    const result = planBypass(exhaust, crossing!, {})
    if (result.status !== 'planned') throw new Error('expected planned')
    expect(result.plan.shiftM).toBeGreaterThan(0)
    // Коллар «до» не вылезает за начало участка.
    expect(result.plan.beforePath[0]).toEqual([0, 2.6, 0])
  })
})

describe('Этап 9: несколько пересечений одной вытяжки', () => {
  test('планирует все пересечения участка последовательностью уток', () => {
    const supply1 = ductSegment(
      [
        [-4, 2.6, -2],
        [4, 2.6, -2],
      ],
      { id: 'duct-segment_s1', system: 'supply', shape: 'round', diameter: 300 },
    )
    const supply2 = ductSegment(
      [
        [-4, 2.6, 2],
        [4, 2.6, 2],
      ],
      { id: 'duct-segment_s2', system: 'supply', shape: 'round', diameter: 300 },
    )
    const exhaust = ductSegment(
      [
        [0, 2.6, -6],
        [0, 2.6, 6],
      ],
      { id: 'duct-segment_exhaust', system: 'exhaust', shape: 'round', diameter: 160 },
    )
    const scene = sceneOf(supply1, supply2, exhaust)

    const crossings = detectBypassCrossings(scene)
    expect(crossings).toHaveLength(2)

    const runs = planAllBypassRuns(scene)
    expect(runs).toHaveLength(1)
    const run = runs[0]!
    expect(run.bypasses).toHaveLength(2)
    expect(run.skipped).toHaveLength(0)
    // Прямые звенья: до первой утки, между утками, после второй.
    expect(run.pieces).toHaveLength(3)
    // Не перекрываются: выход первой ≤ вход второй.
    expect(run.bypasses[0]!.outletCumulativeM).toBeLessThanOrEqual(
      run.bypasses[1]!.inletCumulativeM,
    )

    const mutations = buildBypassRunMutations(run, exhaust)
    expect(mutations.fittings).toHaveLength(2)
    expect(mutations.intermediateSegments).toHaveLength(1)
    expect(mutations.intermediateSegments[0]!.system).toBe('exhaust')

    // Применить к сцене — оба пересечения решены.
    const next: Record<AnyNodeId, AnyNode> = { ...scene }
    next[exhaust.id] = { ...exhaust, path: mutations.beforePath } as DuctSegmentNode
    for (const segment of [...mutations.intermediateSegments, mutations.afterSegment]) {
      next[segment.id] = segment
    }
    for (const fitting of mutations.fittings) next[fitting.id] = fitting
    expect(detectBypassCrossings(next)).toHaveLength(0)
  })

  test('flat planAllBypasses отражает run-планирование (один план на утку)', () => {
    const supply1 = ductSegment(
      [
        [-4, 2.6, -2],
        [4, 2.6, -2],
      ],
      { id: 'duct-segment_s1', system: 'supply', shape: 'round', diameter: 300 },
    )
    const supply2 = ductSegment(
      [
        [-4, 2.6, 2],
        [4, 2.6, 2],
      ],
      { id: 'duct-segment_s2', system: 'supply', shape: 'round', diameter: 300 },
    )
    const exhaust = ductSegment(
      [
        [0, 2.6, -6],
        [0, 2.6, 6],
      ],
      { id: 'duct-segment_exhaust', system: 'exhaust', shape: 'round', diameter: 160 },
    )
    const scene = sceneOf(supply1, supply2, exhaust)
    const { plans, skipped } = planAllBypasses(scene)
    expect(plans).toHaveLength(2)
    expect(skipped).toHaveLength(0)
    const run = planAllBypassRuns(scene)[0]!
    expect(plans[0]!.beforePath).toEqual(run.pieces[0])
    expect(plans[0]!.afterPath).toEqual(run.pieces[1])
  })

  test('пересечение, слишком близкое к соседней утке, пропускается (остальные планируются)', () => {
    // Первое пересечение в центре, второе — на расстоянии меньше двух полу-пролётов.
    const supply1 = ductSegment(
      [
        [-4, 2.6, 0],
        [4, 2.6, 0],
      ],
      { id: 'duct-segment_s1', system: 'supply', shape: 'round', diameter: 300 },
    )
    const supply2 = ductSegment(
      [
        [-4, 2.6, 0.8],
        [4, 2.6, 0.8],
      ],
      { id: 'duct-segment_s2', system: 'supply', shape: 'round', diameter: 300 },
    )
    const exhaust = ductSegment(
      [
        [0, 2.6, -6],
        [0, 2.6, 6],
      ],
      { id: 'duct-segment_exhaust', system: 'exhaust', shape: 'round', diameter: 160 },
    )
    const scene = sceneOf(supply1, supply2, exhaust)
    const crossings = detectBypassCrossings(scene)
    expect(crossings).toHaveLength(2)
    const run = planAllBypassRuns(scene)[0]!
    expect(run.bypasses.length).toBeGreaterThanOrEqual(1)
    expect(run.skipped.length).toBeGreaterThanOrEqual(1)
    // Пропущенное пересечение помечено как no-room, а не потеряно.
    expect(run.skipped[0]!.reason).toBe('no-room')
  })
})

describe('Этап 9: утка на сети с тройником', () => {
  function exhaustTeeScene(): {
    nodes: Record<AnyNodeId, AnyNode>
    segE1: AnyNode
    segE2: AnyNode
    supply: AnyNode
  } {
    registerDuctNetworkStubs()
    const segE1 = stubDuctSegment(
      [
        [0, 2.6, -4],
        [0, 2.6, 0],
      ],
      'exhaust',
    )
    const segE2 = stubDuctSegment(
      [
        [0, 2.6, 0],
        [0, 2.6, 4],
      ],
      'exhaust',
    )
    const tee = stubDuctTee([0, 2.6, 5], { system: 'exhaust' })
    const branch = stubDuctSegment(
      [
        [1, 2.6, 5],
        [2, 2.6, 5],
      ],
      'exhaust',
    )
    const terminal = stubDuctTerminal([2, 2.6, 5], 'return-grille')
    const supply = stubDuctSegment(
      [
        [-2, 2.6, -2],
        [2, 2.6, -2],
      ],
      'supply',
      { diameter: 300 },
    )
    return {
      nodes: stubSceneOf(segE1, segE2, tee, branch, terminal, supply),
      segE1,
      segE2,
      supply,
    }
  }

  test('runIn/runOut продлеваются через коллинеарный joint сети', () => {
    const { nodes, segE1 } = exhaustTeeScene()
    const [crossing] = detectBypassCrossings(nodes)
    expect(crossing).toBeDefined()
    // Собственная нога 2 м + коллинеарное продолжение segE2 (4 м) через joint в (0,2.6,0).
    expect(crossing!.runInM).toBeCloseTo(2, 3)
    expect(crossing!.runOutM).toBeCloseTo(6, 3)
    void segE1
  })

  test('обвод на звене сети не рвёт связность (тройник и терминал остаются в сети)', () => {
    const { nodes, segE1, segE2 } = exhaustTeeScene()
    const run = planAllBypassRuns(nodes)[0]!
    expect(run.bypasses).toHaveLength(1)
    const exhaust = nodes[segE1.id] as DuctSegmentNode
    const mutations = buildBypassRunMutations(run, exhaust)

    const next: Record<AnyNodeId, AnyNode> = { ...nodes }
    next[segE1.id] = { ...exhaust, path: mutations.beforePath } as DuctSegmentNode
    next[mutations.afterSegment.id] = mutations.afterSegment
    next[mutations.fittings[0]!.id] = mutations.fittings[0]!
    expect(detectBypassCrossings(next)).toHaveLength(0)

    // Сеть вытяжки остаётся одной связной компонентой: тройник, терминал,
    // хвостовой участок и фиттинг-утка вместе с segE2.
    const networks = buildDuctNetworks(next)
    const exhaustNetwork = networks.find((network) => network.nodeIds.includes(segE2.id))
    expect(exhaustNetwork).toBeDefined()
    for (const id of [mutations.afterSegment.id, mutations.fittings[0]!.id, segE2.id]) {
      expect(exhaustNetwork!.nodeIds).toContain(id)
    }
    expect(exhaustNetwork!.systems).toEqual(['exhaust'])

    // Обвод не создал свободных концов на новых звеньях: хвостовой участок
    // и утка соединены с двух сторон (исходный свободный старт segE1 не в счёт).
    const findings = validateDuctNetwork(next)
    const bypassNodeIds = new Set([mutations.afterSegment.id, mutations.fittings[0]!.id])
    const openRunEnds = findings.filter(
      (finding) =>
        finding.code === 'open-run-end' && finding.nodeIds.some((id) => bypassNodeIds.has(id)),
    )
    expect(openRunEnds).toHaveLength(0)
  })
})
