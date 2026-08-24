import { describe, expect, test } from 'bun:test'
import type { AnyNodeId, DuctSketchRun } from '../../schema'
import { ROUND_DUCT_SIZES_MM } from '../constants'
import { ductTerminal, hvacUnit, sceneOf } from '../duct-network-stubs'
import { EQUAL_FRICTION_DEFAULT_PA_PER_M, sizeDuctSection } from '../sizing'
import { computeAgentFlows } from './flows'
import { recognizeTopology } from './recognize-topology'
import { sizeAgentPaths } from './section-sizing'

function run(system: DuctSketchRun['system'], coords: [number, number][]): DuctSketchRun {
  return { system, points: coords.map(([x, z]) => ({ x, z, elev: 'auto' })) }
}

function tappedTrunkScene() {
  const equipment = hvacUnit([0, 0, 0])
  const trunkTerm = ductTerminal([6, 0, 0], 'diffuser')
  const branchTerm = ductTerminal([3, 0, 3], 'diffuser')
  const topology = recognizeTopology(
    [
      run('supply', [
        [0, 0],
        [6, 0],
      ]),
      run('supply', [
        [3, 3],
        [3, 0],
      ]),
    ],
    sceneOf(equipment, trunkTerm, branchTerm),
  )
  const flows = computeAgentFlows(topology, {
    terminalFlows: { [trunkTerm.id]: 60, [branchTerm.id]: 30 },
  })
  return { topology, flows }
}

describe('sizeAgentPaths — скоростной метод СП 60', () => {
  test('профиль и скорость совпадают с sizeDuctSection по расходу участка', () => {
    const { topology, flows } = tappedTrunkScene()
    const result = sizeAgentPaths(topology, flows)

    expect(result.paths).toHaveLength(2)
    const expected = sizeDuctSection({ flowM3h: 90, system: 'supply', shape: 'round' })!
    const trunk = result.paths[0]!
    expect(trunk.flowM3h).toBeCloseTo(90, 9)
    expect(trunk.profile).toEqual(expected.profile)
    expect(trunk.velocityMps).toBeCloseTo(expected.velocityMps, 9)
    // ГОСТ-подбор может выйти за норм-диапазон на малых расходах — флаг
    // должен честно повторять сравнение со спектром СП 60.
    const inBand =
      expected.velocityMps >= expected.recommendedVelocity.min &&
      expected.velocityMps <= expected.recommendedVelocity.max
    expect(trunk.inNormBand).toBe(inBand)
    expect(result.issues).toEqual([])
  })

  test('нулевая ветка не получает сечение и даёт предупреждение zero-flow-path', () => {
    const equipment = hvacUnit([0, 0, 0])
    const terminal = ductTerminal([6, 0, 0], 'diffuser')
    const topology = recognizeTopology(
      [
        run('supply', [
          [0, 0],
          [6, 0],
        ]),
        run('supply', [
          [9, 9],
          [12, 9],
        ]),
      ],
      sceneOf(equipment, terminal),
    )
    // Вторая полилиния — сирота без терминалов: расход 0.
    const flows = computeAgentFlows(topology, { terminalFlows: { [terminal.id]: 60 } })
    const result = sizeAgentPaths(topology, flows)

    expect(result.paths.find((p) => p.pathIndex === 1)!.profile).toBeNull()
    const warning = result.issues.find((i) => i.code === 'zero-flow-path')!
    expect(warning.severity).toBe('warning')
    expect(warning.message).toContain('нулевой расход')
  })

  test('отрицательный расход — unsizable-flow', () => {
    const equipment = hvacUnit([0, 0, 0])
    const trunkTerm = ductTerminal([6, 0, 0], 'diffuser')
    const branchTerm = ductTerminal([3, 0, 3], 'diffuser')
    const topology = recognizeTopology(
      [
        run('supply', [
          [0, 0],
          [6, 0],
        ]),
        run('supply', [
          [3, 3],
          [3, 0],
        ]),
      ],
      sceneOf(equipment, trunkTerm, branchTerm),
    )
    const flows = computeAgentFlows(topology, {
      terminalFlows: { [trunkTerm.id]: -100, [branchTerm.id]: 30 } as Record<AnyNodeId, number>,
    })
    const result = sizeAgentPaths(topology, flows)

    // Отрицательная сумма осела на магистрали (−70): ей сечение не назначено.
    const unsizable = result.issues.filter((i) => i.code === 'unsizable-flow')
    expect(unsizable).toHaveLength(1)
    expect(unsizable[0]!.pathIndex).toBe(0)
    expect(result.paths[0]!.profile).toBeNull()
    // Ветка с положительным расходом 30 подобрана как обычно.
    expect(result.paths[1]!.profile?.shape).toBe('round')
  })
})

describe('sizeAgentPaths — метод равных потерь', () => {
  test('сечение на ГОСТ-ряду и удельные потери не выше целевых', () => {
    const equipment = hvacUnit([0, 0, 0])
    const terminal = ductTerminal([6, 0, 0], 'diffuser')
    const topology = recognizeTopology(
      [
        run('supply', [
          [0, 0],
          [6, 0],
        ]),
      ],
      sceneOf(equipment, terminal),
    )
    const flows = computeAgentFlows(topology, { terminalFlows: { [terminal.id]: 300 } })
    const result = sizeAgentPaths(topology, flows, { method: 'equal-friction' })

    expect(result.issues).toEqual([])
    const sized = result.paths[0]!
    expect(sized.profile?.shape).toBe('round')
    if (sized.profile?.shape === 'round') {
      expect(ROUND_DUCT_SIZES_MM).toContain(sized.profile.diameterMm)
    }
    expect(sized.frictionPaPerM).toBeGreaterThan(0)
    expect(sized.frictionPaPerM).toBeLessThanOrEqual(EQUAL_FRICTION_DEFAULT_PA_PER_M + 1e-6)
    expect(sized.velocityMps).toBeGreaterThan(0)
  })

  test('большему расходу отвечает большее сечение при той же цели потерь', () => {
    const equipment = hvacUnit([0, 0, 0])
    // Две независимые магистрали от установки: восток 150 м³/ч, север 350.
    const small = ductTerminal([4, 0, 0], 'diffuser')
    const large = ductTerminal([0, 0, 8], 'diffuser')
    const topology = recognizeTopology(
      [
        run('supply', [
          [0, 0],
          [4, 0],
        ]),
        run('supply', [
          [0, 0],
          [0, 8],
        ]),
      ],
      sceneOf(equipment, small, large),
    )
    const flows = computeAgentFlows(topology, {
      terminalFlows: { [small.id]: 150, [large.id]: 350 },
    })
    const result = sizeAgentPaths(topology, flows, { method: 'equal-friction' })

    expect(result.issues).toEqual([])
    const diameter = (pathIndex: number): number => {
      const profile = result.paths[pathIndex]!.profile
      return profile?.shape === 'round' ? profile.diameterMm : 0
    }
    expect(diameter(1)).toBeGreaterThanOrEqual(diameter(0))
  })
})
