import { describe, expect, test } from 'bun:test'
import { elbowZeta } from './aerodynamics'
import {
  ductElbow,
  ductSegment,
  ductTee,
  ductTerminal,
  hvacUnit,
  registerDuctNetworkStubs,
  sceneOf,
  twoBranchSupplyScene,
} from './duct-network-stubs'
import { computeNetworkFlows } from './network-flows'
import { computeNetworkPressure } from './network-pressure'

registerDuctNetworkStubs()

describe('computeNetworkPressure — потери по путям, критический путь, балансировка', () => {
  test('пути до каждого терминала и критический путь (длинная ветка с большим расходом)', () => {
    const { nodes, seg1, seg2, branch1, branch2, term1, term2 } = twoBranchSupplyScene()
    const flows = computeNetworkFlows(nodes, {
      terminalFlows: { [term1.id]: 30, [term2.id]: 60 },
    })
    const results = computeNetworkPressure(nodes, { flows })

    expect(results).toHaveLength(1)
    const result = results[0]!
    expect(result.paths).toHaveLength(2)

    const path1 = result.paths.find((path) => path.terminalId === term1.id)!
    const path2 = result.paths.find((path) => path.terminalId === term2.id)!
    expect(path1.flowM3h).toBe(30)
    expect(path2.flowM3h).toBe(60)
    expect(path1.pressureDropPa).toBeGreaterThan(0)
    expect(path2.pressureDropPa).toBeGreaterThan(path1.pressureDropPa)

    expect(result.criticalPath).not.toBeNull()
    expect(result.criticalPath!.terminalId).toBe(term2.id)
    expect(result.totalPressurePa).toBe(result.criticalPath!.pressureDropPa)

    // Расход по участкам соответствует пропагации.
    const seg1Leg = path2.legs.find((leg) => leg.nodeId === seg1.id)!
    expect(seg1Leg.kind).toBe('segment')
    expect(seg1Leg.flowM3h).toBeCloseTo(90, 9)
    const branch1Leg = path1.legs.find((leg) => leg.nodeId === branch1.id)!
    expect(branch1Leg.flowM3h).toBeCloseTo(30, 9)
    const seg2Leg = path2.legs.find((leg) => leg.nodeId === seg2.id)!
    expect(seg2Leg.flowM3h).toBeCloseTo(60, 9)
    const branch2Leg = path2.legs.find((leg) => leg.nodeId === branch2.id)!
    expect(branch2Leg.flowM3h).toBeCloseTo(60, 9)

    // В пути есть и участки, и фиттинги (тройники).
    expect(path2.legs.some((leg) => leg.kind === 'fitting')).toBe(true)
    expect(path2.legs.some((leg) => leg.kind === 'segment')).toBe(true)

    // Балансировка считается только на узлах ветвления с ≥ 2 ответвлениями.
    expect(result.balances).toHaveLength(1)
    const balance = result.balances[0]!
    expect(balance.branchPaths).toHaveLength(2)
    expect(balance.deviationPct).toBeGreaterThanOrEqual(0)
  })

  test('длинное ответвление против короткого → разбалансировка > 15%', () => {
    const equipment = hvacUnit([0, 0, 0])
    const segA = ductSegment(
      [
        [0, 0, 0],
        [4, 0, 0],
      ],
      'supply',
    )
    const tee = ductTee([5, 0, 0])
    const shortBranch = ductSegment(
      [
        [5, 0, 1],
        [5, 0, 2],
      ],
      'supply',
    )
    const longRun = ductSegment(
      [
        [6, 0, 0],
        [6, 0, 7],
      ],
      'supply',
    )
    const termA = ductTerminal([5, 0, 2], 'diffuser')
    const termB = ductTerminal([6, 0, 7], 'diffuser')
    const nodes = sceneOf(equipment, segA, tee, shortBranch, longRun, termA, termB)

    const flows = computeNetworkFlows(nodes, {
      terminalFlows: { [termA.id]: 50, [termB.id]: 50 },
    })
    const [result] = computeNetworkPressure(nodes, { flows })

    expect(result!.balances).toHaveLength(1)
    const balance = result!.balances[0]!
    expect(balance.withinTolerance).toBe(false)
    expect(balance.deviationPct).toBeGreaterThan(15)
    expect(result!.warnings.some((warning) => warning.includes('Разбалансировка'))).toBe(true)
  })

  test('короткие симметричные ответвления балансируются в пределах 15%', () => {
    const equipment = hvacUnit([0, 0, 0])
    const segA = ductSegment(
      [
        [0, 0, 0],
        [4, 0, 0],
      ],
      'supply',
    )
    // Крестовина: два ответвления ±Z дают симметричные ветки.
    const cross = ductTee([5, 0, 0], { fittingType: 'cross' })
    const branch1 = ductSegment(
      [
        [5, 0, 1],
        [5, 0, 2],
      ],
      'supply',
    )
    const branch2 = ductSegment(
      [
        [5, 0, -1],
        [5, 0, -2],
      ],
      'supply',
    )
    const term1 = ductTerminal([5, 0, 2], 'diffuser')
    const term2 = ductTerminal([5, 0, -2], 'diffuser')
    const nodes = sceneOf(equipment, segA, cross, branch1, branch2, term1, term2)

    const flows = computeNetworkFlows(nodes, {
      terminalFlows: { [term1.id]: 50, [term2.id]: 50 },
    })
    const [result] = computeNetworkPressure(nodes, { flows })

    expect(result!.balances).toHaveLength(1)
    expect(result!.balances[0]!.withinTolerance).toBe(true)
    expect(result!.warnings).toHaveLength(0)
  })

  test('отвод вносит локальные потери (ξ > 0) на пути', () => {
    const equipment = hvacUnit([0, 0, 0])
    const seg1 = ductSegment(
      [
        [0, 0, 0],
        [1, 0, 0],
      ],
      'exhaust',
    )
    const elbow = ductElbow([2, 0, 0], { system: 'exhaust' })
    const seg2 = ductSegment(
      [
        [2, 0, 1],
        [2, 0, 2],
      ],
      'exhaust',
    )
    const grille = ductTerminal([2, 0, 2], 'return-grille')
    const nodes = sceneOf(equipment, seg1, elbow, seg2, grille)

    const flows = computeNetworkFlows(nodes, { terminalFlows: { [grille.id]: 90 } })
    const [result] = computeNetworkPressure(nodes, { flows })

    expect(result!.paths).toHaveLength(1)
    const path = result!.paths[0]!
    const elbowLeg = path.legs.find((leg) => leg.nodeId === elbow.id)!
    expect(elbowLeg.kind).toBe('fitting')
    expect(elbowLeg.zeta).toBeGreaterThan(0)
    expect(elbowLeg.pressureDropPa).toBeGreaterThan(0)
    expect(path.pressureDropPa).toBeGreaterThan(0)
  })

  test('без расходов сети потери нулевые', () => {
    const { nodes } = twoBranchSupplyScene()
    const results = computeNetworkPressure(nodes)
    expect(results).toHaveLength(1)
    expect(results[0]!.totalPressurePa).toBe(0)
  })

  test('отвод R=1D (короткий) теряет больше, чем R=1.5D (стандарт) — радиус учитывается (fix #1)', () => {
    const build = (radiusFactor: number) => {
      const equipment = hvacUnit([0, 0, 0])
      const seg1 = ductSegment(
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        'exhaust',
      )
      const elbow = ductElbow([2, 0, 0], { system: 'exhaust', radiusFactor })
      const seg2 = ductSegment(
        [
          [2, 0, 1],
          [2, 0, 2],
        ],
        'exhaust',
      )
      const grille = ductTerminal([2, 0, 2], 'return-grille')
      return sceneOf(equipment, seg1, elbow, seg2, grille)
    }
    // Изолируем: считаем потери только от отвода через прямое сравнение сцен.
    const shortZeta = elbowZeta(90, 1)
    const standardZeta = elbowZeta(90, 1.5)
    expect(shortZeta).toBeGreaterThan(standardZeta)
    // Сцена с R=1D должна давать больший суммарный ΔP.
    const nodesShort = build(1)
    const nodesStandard = build(1.5)
    const shortGrille = Object.values(nodesShort).find((n) => n.type === 'duct-terminal')!
    const standardGrille = Object.values(nodesStandard).find((n) => n.type === 'duct-terminal')!
    const flowsShort = computeNetworkFlows(nodesShort, {
      terminalFlows: { [shortGrille.id]: 90 },
    })
    const flowsStandard = computeNetworkFlows(nodesStandard, {
      terminalFlows: { [standardGrille.id]: 90 },
    })
    const shortDrop = computeNetworkPressure(nodesShort, { flows: flowsShort })[0]!.totalPressurePa
    const standardDrop = computeNetworkPressure(nodesStandard, { flows: flowsStandard })[0]!
      .totalPressurePa
    expect(shortDrop).toBeGreaterThan(standardDrop)
  })
})
