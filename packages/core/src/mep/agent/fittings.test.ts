import { describe, expect, test } from 'bun:test'
import type { DuctSketchRun } from '../../schema'
import { ductTerminal, hvacUnit, sceneOf } from '../duct-network-stubs'
import { DEFAULT_ROUTING_PREFERENCES, normalizeRoutingPreferences } from '../routing-preferences'
import { resolvePathElevations } from './elevations'
import { chooseBranchFittingKind, planAgentFittings, snapTurnAngleDeg } from './fittings'
import { computeAgentFlows } from './flows'
import { recognizeTopology } from './recognize-topology'
import { sizeAgentPaths } from './section-sizing'

function run(system: DuctSketchRun['system'], coords: [number, number][]): DuctSketchRun {
  return { system, points: coords.map(([x, z]) => ({ x, z, elev: 'auto' })) }
}

function pipeline(runs: DuctSketchRun[], terminals: Parameters<typeof sceneOf>, flowM3h = 150) {
  const equipment = hvacUnit([0, 0, 0])
  const topology = recognizeTopology(runs, sceneOf(equipment, ...terminals))
  const terminalFlows = Object.fromEntries(terminals.map((terminal) => [terminal.id, flowM3h]))
  const flows = computeAgentFlows(topology, { terminalFlows })
  const sized = sizeAgentPaths(topology, flows)
  return { topology, sized }
}

describe('chooseBranchFittingKind — тройник или седелка', () => {
  test('auto: малое ответвление — седелка, крупное — тройник', () => {
    const prefs = DEFAULT_ROUTING_PREFERENCES
    expect(chooseBranchFittingKind(315, 100, prefs)).toBe('saddle')
    expect(chooseBranchFittingKind(315, 200, prefs)).toBe('tee')
    // Граница включена: ровно половина магистрали ещё седелка.
    expect(chooseBranchFittingKind(400, 200, prefs)).toBe('saddle')
  })

  test('явное предпочтение и порог перекрывают auto', () => {
    const forced = normalizeRoutingPreferences({ branchFitting: 'tee' })
    expect(chooseBranchFittingKind(315, 100, forced)).toBe('tee')
    const wideSaddle = normalizeRoutingPreferences({ saddleMaxDiameterRatio: 0.7 })
    expect(chooseBranchFittingKind(315, 200, wideSaddle)).toBe('saddle')
  })
})

describe('snapTurnAngleDeg — снап угла отклонения', () => {
  test('перпендикуляр — 90°, диагональ — 45°', () => {
    expect(snapTurnAngleDeg([-1, 0], [0, 1], [15, 30, 45, 90], 90)).toBe(90)
    expect(snapTurnAngleDeg([-1, 0], [1, 1], [15, 30, 45, 90], 90)).toBe(45)
  })

  test('равенство расстояний разрешается в fallback предпочтения', () => {
    // Отклонение ровно 60° посередине допусков 30 и 90.
    expect(snapTurnAngleDeg([-1, 0], [0.5, 0.8660254037844387], [30, 90], 90)).toBe(90)
    expect(snapTurnAngleDeg([-1, 0], [0.5, 0.8660254037844387], [30, 90], 30)).toBe(30)
  })
})

describe('planAgentFittings — фиттинги сопряжений', () => {
  test('изгиб полилинии даёт отвод с углом и радиусом из предпочтений', () => {
    const terminal = ductTerminal([4, 0, 3], 'diffuser')
    const { topology, sized } = pipeline(
      [
        run('supply', [
          [0, 0],
          [4, 0],
          [4, 3],
        ]),
      ],
      [terminal],
    )
    const { fittings, issues } = planAgentFittings(topology, sized.paths)

    expect(issues).toEqual([])
    const elbows = fittings.filter((f) => f.fittingType === 'elbow')
    expect(elbows).toHaveLength(1)
    const elbow = elbows[0]!
    expect(elbow.at).toEqual([4, 0])
    expect(elbow.angleDeg).toBe(90)
    expect(elbow.radiusFactor).toBe(DEFAULT_ROUTING_PREFERENCES.elbowRadiusFactor)
    expect(elbow.note).toContain('Отвод 90°')
    expect(elbow.profile?.shape).toBe('round')
  })

  test('плавный изгиб 45° и прямая без изгибов', () => {
    const diagonal = pipeline(
      [
        run('supply', [
          [0, 0],
          [7, 0],
          [14, 7],
        ]),
      ],
      [ductTerminal([14, 0, 7], 'diffuser')],
    )
    const bends = planAgentFittings(diagonal.topology, diagonal.sized.paths)
    const bendElbows = bends.fittings.filter((f) => f.fittingType === 'elbow')
    expect(bendElbows).toHaveLength(1)
    expect(bendElbows[0]!.angleDeg).toBe(45)

    const straight = pipeline(
      [
        run('supply', [
          [0, 0],
          [8, 0],
        ]),
      ],
      [ductTerminal([8, 0, 0], 'diffuser')],
    )
    const noBends = planAgentFittings(straight.topology, straight.sized.paths)
    expect(noBends.fittings.filter((f) => f.fittingType === 'elbow')).toEqual([])
  })

  test('врезка ответвления: седелка по auto, угол 90°, аннотация решения', () => {
    const trunkTerm = ductTerminal([6, 0, 0], 'diffuser')
    const branchTerm = ductTerminal([3, 0, 3], 'diffuser')
    const { topology, sized } = pipeline(
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
      [trunkTerm, branchTerm],
    )
    // Осознанные расходы: магистраль (900 м³/ч) заметно толще ветки (60).
    const flows = computeAgentFlows(topology, {
      terminalFlows: { [trunkTerm.id]: 900, [branchTerm.id]: 60 },
    })
    const sizedExplicit = sizeAgentPaths(topology, flows)
    const { fittings } = planAgentFittings(topology, sizedExplicit.paths)

    const taps = fittings.filter((f) => f.fittingType === 'saddle' || f.fittingType === 'tee')
    expect(taps).toHaveLength(1)
    const tap = taps[0]!
    expect(tap.fittingType).toBe('saddle')
    expect(tap.angleDeg).toBe(90)
    expect(tap.note).toContain('Седелка')
    expect(tap.note).toContain('auto')

    const forcedTee = planAgentFittings(topology, sizedExplicit.paths, null, {
      branchFitting: 'tee',
    })
    const tee = forcedTee.fittings.find((f) => f.fittingType === 'tee')!
    expect(tee.note).toContain('по предпочтению')
  })

  test('вертикальный участок — пара отводов 90°', () => {
    const equipment = hvacUnit([0, 0, 0])
    const steppedRuns: DuctSketchRun[] = [
      {
        system: 'supply',
        points: [
          { x: 0, z: 0, elev: 'auto' },
          { x: 4, z: 0, elev: { axisM: 2.0 } },
          { x: 8, z: 0, elev: { axisM: 2.0 } },
        ],
      },
    ]
    const steppedTopology = recognizeTopology(steppedRuns, sceneOf(equipment))
    const steppedElevations = resolvePathElevations(steppedTopology, {
      0: { shape: 'round', diameterMm: 250 },
    })
    const { fittings } = planAgentFittings(
      steppedTopology,
      [
        {
          pathIndex: 0,
          sourceRunIndex: 0,
          system: 'supply',
          flowM3h: 150,
          profile: { shape: 'round', diameterMm: 250 },
          velocityMps: 4,
          inNormBand: true,
          noiseCheckRequired: false,
          frictionPaPerM: 0.9,
        },
      ],
      steppedElevations.elevations,
    )

    const risers = fittings.filter((f) => f.key.includes('-riser-'))
    expect(risers).toHaveLength(2)
    for (const riser of risers) {
      expect(riser.angleDeg).toBe(90)
      expect(riser.note).toContain('Вертикальный участок')
    }
    // Перепад осей между вершиной 0 (auto ≈2.525) и вершиной 1 (fixed 2.0).
    expect(fittings.find((f) => f.key.endsWith('-riser-a'))!.at).toEqual([0, 0])
    expect(fittings.find((f) => f.key.endsWith('-riser-b'))!.at).toEqual([4, 0])
  })

  test('врезка без подобранных сечений — предупреждение unsized-junction', () => {
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
    const unsized = topology.paths.map((path, pathIndex) => ({
      pathIndex,
      sourceRunIndex: path.sourceRunIndex,
      system: path.system,
      flowM3h: 0,
      profile: null,
      velocityMps: 0,
      inNormBand: true,
      noiseCheckRequired: false,
      frictionPaPerM: 0,
    }))
    const { fittings, issues } = planAgentFittings(topology, unsized)

    expect(issues.some((i) => i.code === 'unsized-junction')).toBe(true)
    // Врезки без сечений не порождают фиттинов (решение откладывается на B5).
    expect(fittings.filter((f) => f.fittingType !== 'elbow')).toEqual([])
  })
})
