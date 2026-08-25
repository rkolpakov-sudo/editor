import { describe, expect, test } from 'bun:test'
import type { AnyNodeId, DuctSketchRun } from '../../schema'
import { ductTerminal, hvacUnit, sceneOf } from '../duct-network-stubs'
import { buildDuctPlan } from './build-plan'

function run(system: DuctSketchRun['system'], coords: [number, number][]): DuctSketchRun {
  return { system, points: coords.map(([x, z]) => ({ x, z, elev: 'auto' })) }
}

describe('buildDuctPlan — конвейер §2.2 «эскиз + сцена → план построения»', () => {
  test('счастливый путь: П с врезкой + В у одной установки строится без замечаний', () => {
    const equipment = hvacUnit([0, 0, 0])
    const trunkTerm = ductTerminal([6, 0, 0], 'diffuser')
    const branchTerm = ductTerminal([3, 0, 3], 'diffuser')
    const grille = ductTerminal([-4, 0, 0], 'return-grille')
    const plan = buildDuctPlan({
      sketch: {
        runs: [
          run('supply', [
            [0, 0],
            [6, 0],
          ]),
          run('supply', [
            [3, 3],
            [3, 0],
          ]),
          run('exhaust', [
            [-4, 0],
            [0, 0],
          ]),
        ],
      },
      nodes: sceneOf(equipment, trunkTerm, branchTerm, grille),
      terminalFlows: {
        [trunkTerm.id]: 900,
        [branchTerm.id]: 60,
        [grille.id]: 960,
      } as Record<AnyNodeId, number>,
      terminalZones: { [trunkTerm.id]: { zoneId: 'z1', label: 'Кухня' } },
    })

    expect(plan.canBuild).toBe(true)
    expect(plan.blockers).toEqual([])
    expect(plan.violations).toEqual([])

    // Три запланированные трассы: магистраль П, ветка П, вытяжка.
    expect(plan.runs).toHaveLength(3)
    const trunk = plan.runs.find((r) => r.system === 'supply' && r.points.length === 2)!
    expect(trunk.flowM3h).toBeCloseTo(960, 9)
    expect(trunk.profile?.shape).toBe('round')
    expect(trunk.axisM.every((axis) => Number.isFinite(axis))).toBe(true)

    // Фиттинги: седелка на врезке; решений и баланса — в панели.
    expect(plan.fittings.some((f) => f.fittingType === 'saddle')).toBe(true)
    expect(plan.solutions.some((note) => note.startsWith('Участок №1'))).toBe(true)
    expect(plan.solutions.some((note) => note.includes('Баланс П/В'))).toBe(true)
    expect(plan.solutions.some((note) => note.includes('дисбаланс') && note.includes('0%'))).toBe(
      true,
    )

    // Таблица подтверждения W2 доступна через решения? Нет — она в flows,
    // но зона терминала попадает в аннотации через расход: проверяем ключ.
    void trunk.key
  })

  test('пустой эскиз — блокер validate, построение запрещено', () => {
    const plan = buildDuctPlan({ sketch: { runs: [] }, nodes: sceneOf(hvacUnit([0, 0, 0])) })
    expect(plan.canBuild).toBe(false)
    const blocker = plan.blockers.find((i) => i.code === 'no-runs')!
    expect(blocker.source).toBe('validate')
    expect(blocker.severity).toBe('blocker')
  })

  test('несвязанный конец полилинии — блокер топологии', () => {
    const plan = buildDuctPlan({
      sketch: {
        runs: [
          run('supply', [
            [0, 0],
            [3, 0],
          ]),
        ],
      },
      nodes: sceneOf(hvacUnit([0, 0, 0])),
    })
    expect(plan.canBuild).toBe(false)
    const blocker = plan.blockers.find((i) => i.code === 'unbound-end')!
    expect(blocker.source).toBe('topology')
  })

  test('сирота без маршрута до установки — блокер потоков', () => {
    const equipment = hvacUnit([20, 0, 20])
    const termA = ductTerminal([0, 0, 0], 'diffuser')
    const plan = buildDuctPlan({
      sketch: {
        runs: [
          run('supply', [
            [0, 0],
            [4, 0],
          ]),
          run('supply', [
            [10, 10],
            [14, 10],
          ]),
        ],
      },
      nodes: sceneOf(equipment, termA, ductTerminal([14, 0, 10], 'diffuser')),
      terminalFlows: {
        [termA.id]: 120,
      } as Record<AnyNodeId, number>,
    })

    // Первая трасса привязана установкой и терминалом; вторая — сирота.
    const orphan = plan.blockers.find((i) => i.code === 'orphan-path')!
    expect(orphan.source).toBe('flows')
    expect(plan.canBuild).toBe(false)
  })

  test('фиксированная ось выше потолка — блокер высот', () => {
    const equipment = hvacUnit([0, 0, 0])
    const terminal = ductTerminal([5, 0, 5], 'diffuser')
    const plan = buildDuctPlan({
      sketch: {
        runs: [
          {
            system: 'supply',
            points: [
              { x: 0, z: 0, elev: 'auto' },
              { x: 5, z: 5, elev: { axisM: 2.9 } },
            ],
          },
        ],
      },
      nodes: sceneOf(equipment, terminal),
      terminalFlows: { [terminal.id]: 150 } as Record<AnyNodeId, number>,
    })

    const blocker = plan.blockers.find((i) => i.code === 'duct-above-ceiling')!
    expect(blocker.source).toBe('elevations')
    expect(plan.canBuild).toBe(false)
  })

  test('дисбаланс П/В сверх допуска — нарушение, но строить можно (W3)', () => {
    const equipment = hvacUnit([0, 0, 0])
    const diffuser = ductTerminal([5, 0, 0], 'diffuser')
    const grille = ductTerminal([-3, 0, 0], 'return-grille')
    const plan = buildDuctPlan({
      sketch: {
        runs: [
          run('supply', [
            [0, 0],
            [5, 0],
          ]),
          run('exhaust', [
            [-3, 0],
            [0, 0],
          ]),
        ],
      },
      nodes: sceneOf(equipment, diffuser, grille),
      terminalFlows: {
        [diffuser.id]: 300,
        [grille.id]: 100,
      } as Record<AnyNodeId, number>,
    })

    expect(plan.canBuild).toBe(true)
    const violation = plan.violations.find((i) => i.code === 'supply-exhaust-imbalance')!
    expect(violation.severity).toBe('warning')
    expect(violation.source).toBe('flows')
  })

  test('пересечение П и В даёт решение об утке', () => {
    const equipment = hvacUnit([0, 0, 0])
    const diffuser = ductTerminal([6, 0, 0], 'diffuser')
    const grilleIn = ductTerminal([3, 0, -4], 'return-grille')
    const grilleOut = ductTerminal([3, 0, 4], 'return-grille')
    const plan = buildDuctPlan({
      sketch: {
        runs: [
          run('supply', [
            [0, 0],
            [6, 0],
          ]),
          run('exhaust', [
            [3, -4],
            [3, 4],
          ]),
        ],
      },
      nodes: sceneOf(equipment, diffuser, grilleIn, grilleOut),
      terminalFlows: {
        [diffuser.id]: 200,
        [grilleIn.id]: 100,
        [grilleOut.id]: 100,
      } as Record<AnyNodeId, number>,
    })

    expect(plan.solutions.some((note) => note.includes('Утка:'))).toBe(true)
    // Вытяжка без привязки к установке остаётся сиротой — блокер никуда не пропал.
    expect(plan.blockers.some((i) => i.code === 'orphan-path')).toBe(true)
  })

  test('параллельные П/В в узком коридоре — предупреждение развести по высоте (§2.5)', () => {
    const equipment = hvacUnit([0, 0, 0])
    const diffuser = ductTerminal([8, 0, 0.1], 'diffuser')
    const grille = ductTerminal([8, 0, 0], 'return-grille')
    const plan = buildDuctPlan({
      sketch: {
        runs: [
          // Приток вдоль z = 0.1, вытяжка вдоль z = 0 — рядом, параллельно.
          run('supply', [
            [0, 0.1],
            [8, 0.1],
          ]),
          run('exhaust', [
            [0, 0],
            [8, 0],
          ]),
        ],
      },
      nodes: sceneOf(equipment, diffuser, grille),
      terminalFlows: {
        [diffuser.id]: 120,
        [grille.id]: 120,
      } as Record<AnyNodeId, number>,
    })

    const violation = plan.violations.find((i) => i.code === 'parallel-pv-clearance')
    expect(violation).toBeDefined()
    expect(violation!.severity).toBe('warning')
    expect(violation!.source).toBe('crossings')
    expect(violation!.message).toContain('разведите трассы по высоте')
  })

  test('детерминизм: одинаковый вход — идентичный план', () => {
    const makeScene = () => {
      const equipment = hvacUnit([0, 0, 0])
      const terminal = ductTerminal([5, 0, 0], 'diffuser')
      return {
        sketch: {
          runs: [
            run('supply', [
              [0, 0],
              [5, 0],
            ]),
          ],
        },
        nodes: sceneOf(equipment, terminal),
        terminalFlows: { [terminal.id]: 150 } as Record<AnyNodeId, number>,
      }
    }
    const input = makeScene()
    const a = buildDuctPlan(input)
    const b = buildDuctPlan(makeScene())
    expect(b.canBuild).toBe(a.canBuild)
    expect(b.runs).toEqual(a.runs)
    expect(b.fittings.map((f) => f.key)).toEqual(a.fittings.map((f) => f.key))
    expect(b.solutions).toEqual(a.solutions)
    expect(b.blockers).toEqual(a.blockers)
    expect(b.violations).toEqual(a.violations)
  })
})
