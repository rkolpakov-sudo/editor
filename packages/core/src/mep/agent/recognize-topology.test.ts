import { describe, expect, test } from 'bun:test'
import type { DuctSketchRun } from '../../schema'
import { ductTerminal, hvacUnit, sceneOf } from '../duct-network-stubs'
import { DEFAULT_BIND_TOLERANCE_M, recognizeTopology } from './recognize-topology'

function run(system: DuctSketchRun['system'], coords: [number, number][]): DuctSketchRun {
  return { system, points: coords.map(([x, z]) => ({ x, z, elev: 'auto' })) }
}

describe('recognizeTopology — разрез у установки и привязка концов (W1)', () => {
  test('магистраль от установки к терминалу распознаётся целиком', () => {
    const equipment = hvacUnit([0, 0, 0])
    const terminal = ductTerminal([4, 0, 0], 'diffuser')
    const topology = recognizeTopology(
      [
        run('supply', [
          [0, 0],
          [4, 0],
        ]),
      ],
      sceneOf(equipment, terminal),
    )

    expect(topology.issues).toEqual([])
    expect(topology.paths).toHaveLength(1)
    const path = topology.paths[0]!
    expect(path.system).toBe('supply')
    expect(path.sourceRunIndex).toBe(0)
    expect(path.lengthM).toBeCloseTo(4, 9)
    expect(path.start).toEqual({ kind: 'equipment', nodeId: equipment.id, distanceM: 0 })
    expect(path.end.kind).toBe('terminal')
    if (path.end.kind === 'terminal') {
      expect(path.end.nodeId).toBe(terminal.id)
      expect(path.end.distanceM).toBeCloseTo(0, 9)
    }
  })

  test('полилиния сквозь установку режется на два пути', () => {
    const equipment = hvacUnit([0, 0, 0])
    const left = ductTerminal([-2, 0, 0], 'diffuser')
    const right = ductTerminal([2, 0, 0], 'diffuser')
    const topology = recognizeTopology(
      [
        run('supply', [
          [-2, 0],
          [2, 0],
        ]),
      ],
      sceneOf(equipment, left, right),
    )

    expect(topology.issues).toEqual([])
    expect(topology.paths).toHaveLength(2)
    const first = topology.paths[0]!
    const second = topology.paths[1]!
    expect(first.start.kind).toBe('terminal')
    expect(first.end.kind).toBe('equipment')
    expect(second.start.kind).toBe('equipment')
    expect(second.end.kind).toBe('terminal')
    if (first.end.kind === 'equipment' && second.start.kind === 'equipment') {
      expect(first.end.nodeId).toBe(equipment.id)
      expect(second.start.nodeId).toBe(equipment.id)
    }
    expect(first.sourceRunIndex).toBe(0)
    expect(second.sourceRunIndex).toBe(0)
  })

  test('вытяжка в обратном направлении: конец привязывается оборудованием', () => {
    const equipment = hvacUnit([6, 0, 0])
    const grille = ductTerminal([0, 0, 0], 'return-grille')
    const topology = recognizeTopology(
      [
        run('exhaust', [
          [0, 0],
          [6, 0],
        ]),
      ],
      sceneOf(equipment, grille),
    )

    expect(topology.issues).toEqual([])
    const path = topology.paths[0]!
    expect(path.system).toBe('exhaust')
    expect(path.start.kind).toBe('terminal')
    expect(path.end.kind).toBe('equipment')
    if (path.end.kind === 'equipment') expect(path.end.nodeId).toBe(equipment.id)
  })

  test('конец вне допуска — блокер unbound-end', () => {
    const equipment = hvacUnit([0, 0, 0])
    const terminal = ductTerminal([4, 0, 0], 'diffuser')
    const topology = recognizeTopology(
      [
        run('supply', [
          [0, 0],
          [3, 0],
        ]),
      ],
      sceneOf(equipment, terminal),
    )

    const path = topology.paths[0]!
    expect(path.start.kind).toBe('equipment')
    expect(path.end.kind).toBe('unbound')
    const issue = topology.issues.find((i) => i.code === 'unbound-end')!
    expect(issue.severity).toBe('blocker')
    expect(issue.runIndex).toBe(0)
    expect(issue.message).toContain(`${DEFAULT_BIND_TOLERANCE_M} м`)
  })

  test('допуск связи: на границе связывает, за границей — нет', () => {
    const terminal = ductTerminal([4, 0, 0], 'diffuser')

    const inside = recognizeTopology(
      [
        run('supply', [
          [0, 0],
          [3.6, 0],
        ]),
      ],
      sceneOf(terminal),
    )
    expect(inside.paths[0]!.end.kind).toBe('terminal')
    if (inside.paths[0]!.end.kind === 'terminal') {
      expect(inside.paths[0]!.end.distanceM).toBeCloseTo(0.4, 9)
    }

    const outside = recognizeTopology(
      [
        run('supply', [
          [0, 0],
          [3.6, 0],
        ]),
      ],
      sceneOf(terminal),
      { bindToleranceM: 0.3 },
    )
    expect(outside.paths[0]!.end.kind).toBe('unbound')
  })

  test('стык двух полилиний конец-в-конец сращивается без блокеров', () => {
    const equipment = hvacUnit([0, 0, 0])
    const terminal = ductTerminal([6, 0, 0], 'diffuser')
    const topology = recognizeTopology(
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
      sceneOf(equipment, terminal),
    )

    expect(topology.issues).toEqual([])
    expect(topology.paths).toHaveLength(2)
    const head = topology.paths[0]!
    const tail = topology.paths[1]!
    expect(head.start.kind).toBe('equipment')
    expect(head.end).toEqual({ kind: 'junction', peerPathIndex: 1, peerEnd: 'start' })
    expect(tail.start).toEqual({ kind: 'junction', peerPathIndex: 0, peerEnd: 'end' })
    expect(tail.end.kind).toBe('terminal')
  })

  test('врезка ответвления в тело магистрали — привязка tap с параметром', () => {
    const equipment = hvacUnit([0, 0, 0])
    const trunkTerminal = ductTerminal([6, 0, 0], 'diffuser')
    const branchTerminal = ductTerminal([3, 0, 3], 'diffuser')
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
      sceneOf(equipment, trunkTerminal, branchTerminal),
    )

    expect(topology.issues).toEqual([])
    const branch = topology.paths[1]!
    expect(branch.start.kind).toBe('terminal')
    expect(branch.end.kind).toBe('tap')
    if (branch.end.kind === 'tap') {
      expect(branch.end.hostPathIndex).toBe(0)
      expect(branch.end.hostT).toBeCloseTo(0.5, 9)
    }
    const trunk = topology.paths[0]!
    expect(trunk.start.kind).toBe('equipment')
    expect(trunk.end.kind).toBe('terminal')
  })

  test('системы независимы: пересечение П и В не создаёт связей и предупреждений', () => {
    const equipment = hvacUnit([0, 0, 0])
    const diffuser = ductTerminal([6, 0, 0], 'diffuser')
    const grilleIn = ductTerminal([3, 0, -3], 'return-grille')
    const grilleOut = ductTerminal([3, 0, 3], 'return-grille')
    const topology = recognizeTopology(
      [
        run('supply', [
          [0, 0],
          [6, 0],
        ]),
        run('exhaust', [
          [3, -3],
          [3, 3],
        ]),
      ],
      sceneOf(equipment, diffuser, grilleIn, grilleOut),
    )

    expect(topology.issues).toEqual([])
    const supply = topology.paths.find((p) => p.system === 'supply')!
    const exhaust = topology.paths.find((p) => p.system === 'exhaust')!
    expect(supply.start.kind).toBe('equipment')
    expect(supply.end.kind).toBe('terminal')
    expect(exhaust.start.kind).toBe('terminal')
    expect(exhaust.end.kind).toBe('terminal')
  })
})
