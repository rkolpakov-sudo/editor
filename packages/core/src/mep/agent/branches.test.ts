import { describe, expect, test } from 'bun:test'
import type { AnyNodeId, DuctSketchRun } from '../../schema'
import { ductTerminal, hvacUnit, sceneOf } from '../duct-network-stubs'
import { DEFAULT_ROUTING_PREFERENCES } from '../routing-preferences'
import { planAutoBranches } from './branches'
import { buildDuctPlan } from './build-plan'
import { recognizeTopology } from './recognize-topology'

function run(system: DuctSketchRun['system'], coords: [number, number][]): DuctSketchRun {
  return { system, points: coords.map(([x, z]) => ({ x, z, elev: 'auto' })) }
}

describe('planAutoBranches — терминал → ближайшая магистраль (C3)', () => {
  test('терминал в пределах допуска подключается к ближайшей трассе своей системы', () => {
    const equipment = hvacUnit([0, 0, 0])
    const trunkTerm = ductTerminal([6, 0, 0], 'diffuser')
    const topology = recognizeTopology(
      [
        run('supply', [
          [0, 0],
          [6, 0],
        ]),
      ],
      sceneOf(equipment, trunkTerm),
    )
    const newTerminal = ductTerminal([3, 0, 0.4], 'diffuser')
    const result = planAutoBranches(
      topology,
      [{ id: newTerminal.id, position: newTerminal.position, terminalType: 'diffuser' }],
      DEFAULT_ROUTING_PREFERENCES,
    )

    expect(result.issues).toEqual([])
    expect(result.branches).toHaveLength(1)
    const branch = result.branches[0]!
    expect(branch.system).toBe('supply')
    expect(branch.hostPathIndex).toBe(0)
    // Ближайшая точка: (3, 0) — середина магистрали.
    expect(branch.tapPoint[0]).toBeCloseTo(3, 9)
    expect(branch.tapPoint[1]).toBeCloseTo(0, 9)
    expect(branch.hostT).toBeCloseTo(0.5, 9)
    expect(branch.terminalPoint).toEqual([3, 0.4])
  })

  test('терминал за допуском — предупреждение без ветки', () => {
    const equipment = hvacUnit([0, 0, 0])
    const trunkTerm = ductTerminal([6, 0, 0], 'diffuser')
    const topology = recognizeTopology(
      [
        run('supply', [
          [0, 0],
          [6, 0],
        ]),
      ],
      sceneOf(equipment, trunkTerm),
    )
    const far = ductTerminal([3, 0, 2], 'diffuser')
    const result = planAutoBranches(
      topology,
      [{ id: far.id, position: far.position, terminalType: 'diffuser' }],
      DEFAULT_ROUTING_PREFERENCES,
    )

    expect(result.branches).toEqual([])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]!.code).toBe('no-trunk-within-tolerance')
    expect(result.issues[0]!.message).toContain('≤ 1 м')
  })

  test('нет трассы системы терминала — предупреждение no-trunk-of-system', () => {
    const equipment = hvacUnit([0, 0, 0])
    const diffuser = ductTerminal([6, 0, 0], 'diffuser')
    const topology = recognizeTopology(
      [
        run('supply', [
          [0, 0],
          [6, 0],
        ]),
      ],
      sceneOf(equipment, diffuser),
    )
    const grille = ductTerminal([3, 0, 0.3], 'return-grille')
    const result = planAutoBranches(
      topology,
      [{ id: grille.id, position: grille.position, terminalType: 'return-grille' }],
      DEFAULT_ROUTING_PREFERENCES,
    )

    expect(result.branches).toEqual([])
    expect(result.issues[0]!.code).toBe('no-trunk-of-system')
  })

  test('допуск подключения настраивается предпочтением', () => {
    const equipment = hvacUnit([0, 0, 0])
    const diffuser = ductTerminal([6, 0, 0], 'diffuser')
    const topology = recognizeTopology(
      [
        run('supply', [
          [0, 0],
          [6, 0],
        ]),
      ],
      sceneOf(equipment, diffuser),
    )
    // 1.2 м: вне дефолтного допуска 1.0, внутри 1.5.
    const terminal = ductTerminal([3, 0, 1.2], 'diffuser')
    const inputs = [
      { id: terminal.id, position: terminal.position, terminalType: 'diffuser' as const },
    ]

    const strict = planAutoBranches(topology, inputs, DEFAULT_ROUTING_PREFERENCES)
    expect(strict.branches).toEqual([])
    expect(strict.issues).toHaveLength(1)

    const wide = planAutoBranches(topology, inputs, {
      ...DEFAULT_ROUTING_PREFERENCES,
      terminalConnectToleranceM: 1.5,
    })
    expect(wide.branches).toHaveLength(1)
  })
})

describe('buildDuctPlan — интеграция автоответвлений', () => {
  test('непривязанный терминал становится веткой: расход, сечение, тройник', () => {
    const equipment = hvacUnit([0, 0, 0])
    const trunkTerm = ductTerminal([6, 0, 0], 'diffuser')
    const unboundTerm = ductTerminal([3, 0, 0.4], 'diffuser')
    const plan = buildDuctPlan({
      sketch: {
        runs: [
          run('supply', [
            [0, 0],
            [6, 0],
          ]),
        ],
      },
      nodes: sceneOf(equipment, trunkTerm, unboundTerm),
      terminalFlows: {
        [trunkTerm.id]: 900,
        [unboundTerm.id]: 60,
      } as Record<AnyNodeId, number>,
      autoBranchTerminalIds: [trunkTerm.id, unboundTerm.id],
    })

    expect(plan.canBuild).toBe(true)
    expect(plan.blockers).toEqual([])
    // Магистраль + автоответвление.
    expect(plan.runs).toHaveLength(2)
    const trunk = plan.runs.find((r) => r.points.length === 2 && r.sourceRunIndex === 0)!
    expect(trunk.flowM3h).toBeCloseTo(960, 9)
    const branch = plan.runs.find((r) => r.sourceRunIndex === -1)!
    expect(branch.flowM3h).toBeCloseTo(60, 9)
    expect(branch.profile?.shape).toBe('round')

    // Врезка ветки в магистраль → тройник/седелка по предпочтению.
    const tap = plan.fittings.find((f) => f.fittingType === 'tee' || f.fittingType === 'saddle')!
    expect(tap.fittingType).toBe('saddle')
    expect(tap.hostPathIndex).toBe(0)
    expect(tap.hostT).toBeCloseTo(0.5, 9)

    expect(plan.solutions.some((note) => note.includes('Автоответвление'))).toBe(true)
    // Таблица подтверждения W2 видит терминал ветки.
    expect(plan.terminals.some((row) => row.terminalId === unboundTerm.id && row.assigned)).toBe(
      true,
    )
  })

  test('терминал за допуском — предупреждение, построение без ветки', () => {
    const equipment = hvacUnit([0, 0, 0])
    const trunkTerm = ductTerminal([6, 0, 0], 'diffuser')
    const far = ductTerminal([3, 0, 2], 'diffuser')
    const plan = buildDuctPlan({
      sketch: {
        runs: [
          run('supply', [
            [0, 0],
            [6, 0],
          ]),
        ],
      },
      nodes: sceneOf(equipment, trunkTerm, far),
      terminalFlows: {
        [trunkTerm.id]: 900,
        [far.id]: 60,
      } as Record<AnyNodeId, number>,
      autoBranchTerminalIds: [far.id],
    })

    expect(plan.canBuild).toBe(true)
    expect(plan.runs).toHaveLength(1)
    expect(plan.violations.some((v) => v.code === 'no-trunk-within-tolerance')).toBe(true)
  })
})
