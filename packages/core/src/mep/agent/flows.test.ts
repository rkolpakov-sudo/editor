import { describe, expect, test } from 'bun:test'
import type { AnyNodeId, DuctSketchRun } from '../../schema'
import { ductTerminal, hvacUnit, sceneOf } from '../duct-network-stubs'
import { computeAgentFlows, SUPPLY_EXHAUST_BALANCE_TOL_PCT } from './flows'
import { type RecognizedTopology, recognizeTopology } from './recognize-topology'

function run(system: DuctSketchRun['system'], coords: [number, number][]): DuctSketchRun {
  return { system, points: coords.map(([x, z]) => ({ x, z, elev: 'auto' })) }
}

function topologyOf(
  runs: DuctSketchRun[],
  ...nodes: Parameters<typeof sceneOf>
): RecognizedTopology {
  return recognizeTopology(runs, sceneOf(...nodes))
}

describe('computeAgentFlows — пропагация по дереву от установки', () => {
  test('магистраль несёт сумму ответвлений (врезка в тело)', () => {
    const equipment = hvacUnit([0, 0, 0])
    const trunkTerm = ductTerminal([6, 0, 0], 'diffuser')
    const branchTerm = ductTerminal([3, 0, 3], 'diffuser')
    const topology = topologyOf(
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
      equipment,
      trunkTerm,
      branchTerm,
    )
    const result = computeAgentFlows(topology, {
      terminalFlows: { [trunkTerm.id]: 60, [branchTerm.id]: 30 },
    })

    expect(result.issues).toEqual([])
    const trunk = result.paths.find((p) => p.pathIndex === 0)!
    const branch = result.paths.find((p) => p.pathIndex === 1)!
    expect(trunk.flowM3h).toBeCloseTo(90, 9)
    expect(branch.flowM3h).toBeCloseTo(30, 9)
    expect(result.supplyTotalM3h).toBeCloseTo(90, 9)
    expect(result.exhaustTotalM3h).toBe(0)
    expect(result.imbalancePercent).toBeNull()
  })

  test('стык из двух кусков: расход одинаков по магистрали', () => {
    const equipment = hvacUnit([0, 0, 0])
    const terminal = ductTerminal([6, 0, 0], 'diffuser')
    const topology = topologyOf(
      [
        run('supply', [
          [0, 0],
          [3, 0],
        ]),
        run('supply', [
          [3, 0],
          [6, 0],
        ]),
      ],
      equipment,
      terminal,
    )
    const result = computeAgentFlows(topology, { terminalFlows: { [terminal.id]: 60 } })

    expect(result.issues).toEqual([])
    expect(result.paths.map((p) => p.flowM3h)).toEqual([60, 60])
    expect(result.supplyTotalM3h).toBeCloseTo(60, 9)
  })

  test('вытяжка суммируется к установке независимо от направления рисунка', () => {
    const equipment = hvacUnit([6, 0, 0])
    const grille = ductTerminal([0, 0, 0], 'return-grille')
    const topology = topologyOf(
      [
        run('exhaust', [
          [0, 0],
          [6, 0],
        ]),
      ],
      equipment,
      grille,
    )
    const result = computeAgentFlows(topology, { terminalFlows: { [grille.id]: 80 } })

    expect(result.issues).toEqual([])
    expect(result.paths[0]!.flowM3h).toBeCloseTo(80, 9)
    expect(result.exhaustTotalM3h).toBeCloseTo(80, 9)
    expect(result.supplyTotalM3h).toBe(0)
  })
})

describe('computeAgentFlows — баланс П/В и назначения (W2)', () => {
  function supplyExhaustScene() {
    const equipment = hvacUnit([0, 0, 0])
    const diffuser = ductTerminal([5, 0, 0], 'diffuser')
    const grille = ductTerminal([-4, 0, 0], 'return-grille')
    const topology = topologyOf(
      [
        run('supply', [
          [0, 0],
          [5, 0],
        ]),
        run('exhaust', [
          [-4, 0],
          [0, 0],
        ]),
      ],
      equipment,
      diffuser,
      grille,
    )
    return { topology, diffuser, grille }
  }

  test('баланс в допуске — без замечаний', () => {
    const { topology, diffuser, grille } = supplyExhaustScene()
    const result = computeAgentFlows(topology, {
      terminalFlows: { [diffuser.id]: 100, [grille.id]: 100 },
    })

    expect(result.supplyTotalM3h).toBeCloseTo(100, 9)
    expect(result.exhaustTotalM3h).toBeCloseTo(100, 9)
    expect(result.imbalancePercent).toBeCloseTo(0, 9)
    expect(result.issues).toEqual([])
  })

  test('дисбаланс сверх допуска — предупреждение; свой допуск учитывается', () => {
    const { topology, diffuser, grille } = supplyExhaustScene()
    const flows = { [diffuser.id]: 100, [grille.id]: 50 }

    const strict = computeAgentFlows(topology, { terminalFlows: flows })
    const issue = strict.issues.find((i) => i.code === 'supply-exhaust-imbalance')!
    expect(issue.severity).toBe('warning')
    expect(strict.imbalancePercent).toBeCloseTo(50, 9)
    expect(issue.message).toContain(`${SUPPLY_EXHAUST_BALANCE_TOL_PCT}%`)

    const lenient = computeAgentFlows(topology, {
      terminalFlows: flows,
      balanceTolerancePercent: 60,
    })
    expect(lenient.issues.find((i) => i.code === 'supply-exhaust-imbalance')).toBeUndefined()
  })

  test('неназначенный терминал — предупреждение unassigned-terminals', () => {
    const equipment = hvacUnit([0, 0, 0])
    const trunkTerm = ductTerminal([6, 0, 0], 'diffuser')
    const branchTerm = ductTerminal([3, 0, 3], 'diffuser')
    const topology = topologyOf(
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
      equipment,
      trunkTerm,
      branchTerm,
    )
    const result = computeAgentFlows(topology, { terminalFlows: { [trunkTerm.id]: 60 } })

    const warning = result.issues.find((i) => i.code === 'unassigned-terminals')!
    expect(warning.severity).toBe('warning')
    expect(warning.message).toContain('1 терминал')
    const row = result.terminals.find((t) => t.terminalId === branchTerm.id)!
    expect(row.assigned).toBe(false)
    expect(row.flowM3h).toBe(0)

    // Неназначенные ветки не участвуют в балансе: сирот нет, но расход нулевой.
    expect(result.paths.find((p) => p.pathIndex === 1)!.flowM3h).toBe(0)
  })

  test('таблица подтверждения содержит помещение и назначение (W2)', () => {
    const equipment = hvacUnit([0, 0, 0])
    const terminal = ductTerminal([5, 0, 0], 'diffuser')
    const topology = topologyOf(
      [
        run('supply', [
          [0, 0],
          [5, 0],
        ]),
      ],
      equipment,
      terminal,
    )
    const zones: Record<AnyNodeId, { zoneId: string; label: string }> = {
      [terminal.id]: { zoneId: 'zone_1', label: 'Спальня' },
    }
    const result = computeAgentFlows(topology, {
      terminalFlows: { [terminal.id]: 60 },
      terminalZones: zones,
    })

    expect(result.terminals).toHaveLength(1)
    const row = result.terminals[0]!
    expect(row.system).toBe('supply')
    expect(row.zoneId).toBe('zone_1')
    expect(row.label).toBe('Спальня')
    expect(row.flowM3h).toBe(60)
    expect(row.assigned).toBe(true)
  })
})

describe('computeAgentFlows — деградированные топологии (W9, блокеры)', () => {
  test('контур без маршрута до установки — блокер orphan-path, расход 0', () => {
    const equipment = hvacUnit([10, 10, 0])
    const termA = ductTerminal([0, 0, 0], 'diffuser')
    const termB = ductTerminal([3, 0, 0], 'diffuser')
    const topology = topologyOf(
      [
        run('supply', [
          [0, 0],
          [3, 0],
        ]),
      ],
      equipment,
      termA,
      termB,
    )
    const result = computeAgentFlows(topology, {
      terminalFlows: { [termA.id]: 60, [termB.id]: 60 },
    })

    const orphan = result.issues.find((i) => i.code === 'orphan-path')!
    expect(orphan.severity).toBe('blocker')
    expect(orphan.message).toContain('нет маршрута до установки')
    expect(result.paths[0]!.flowM3h).toBe(0)
    expect(result.supplyTotalM3h).toBe(0)
    // Терминалы видны в таблице подтверждения даже у сироты.
    expect(result.terminals).toHaveLength(2)
  })

  test('кольцо путей через врезку — блокер path-cycle', () => {
    const equipment = hvacUnit([0, 0, 0])
    const topology = topologyOf(
      [
        run('supply', [
          [0, 0],
          [8, 0],
        ]),
        run('supply', [
          [8, 0],
          [8, -4],
        ]),
        run('supply', [
          [8, -4],
          [4, 0],
        ]),
      ],
      equipment,
    )
    const result = computeAgentFlows(topology)

    const cycle = result.issues.filter((i) => i.code === 'path-cycle')
    expect(cycle).toHaveLength(1)
    expect(cycle[0]!.severity).toBe('blocker')
  })

  test('отрицательное назначение ломает монотонность — блокер flow-monotonicity (W9)', () => {
    const equipment = hvacUnit([0, 0, 0])
    const trunkTerm = ductTerminal([6, 0, 0], 'diffuser')
    const branchTerm = ductTerminal([3, 0, 3], 'diffuser')
    const topology = topologyOf(
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
      equipment,
      trunkTerm,
      branchTerm,
    )
    const result = computeAgentFlows(topology, {
      terminalFlows: { [trunkTerm.id]: -100, [branchTerm.id]: 30 },
    })

    const violation = result.issues.find((i) => i.code === 'flow-monotonicity')!
    expect(violation.severity).toBe('blocker')
    expect(violation.message).toContain('W9')
    expect(violation.pathIndex).toBe(1)
  })
})
