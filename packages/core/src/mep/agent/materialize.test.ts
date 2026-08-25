import { describe, expect, test } from 'bun:test'
import type { AnyNode } from '../../schema'
import type { DuctBuildPlan } from './build-plan'
import { planBuildMutations } from './materialize'

const ROUND = (diameterMm: number) => ({ shape: 'round' as const, diameterMm })
const PROFILE_200 = ROUND(200)
const PROFILE_100 = ROUND(100)

function planWith(
  runs: DuctBuildPlan['runs'],
  fittings: DuctBuildPlan['fittings'] = [],
): DuctBuildPlan {
  return {
    canBuild: true,
    runs,
    fittings,
    solutions: [],
    violations: [],
    blockers: [],
  }
}

describe('planBuildMutations — материализация плана в узлы', () => {
  test('прямая магистраль даёт один участок на высоте оси с меткой агента', () => {
    const plan = planWith([
      {
        key: 'run0path0',
        system: 'supply',
        sourceRunIndex: 0,
        points: [
          [0, 0],
          [6, 0],
        ],
        axisM: [2.5, 2.5],
        profile: PROFILE_200,
        flowM3h: 300,
        velocityMps: 4.2,
      },
    ])
    const mutations = planBuildMutations(plan, { parentId: 'level_1' })

    expect(mutations.notes).toEqual([])
    expect(mutations.create).toHaveLength(1)
    expect(mutations.delete).toEqual([])
    const segment = mutations.create[0]!.node as AnyNode & {
      path: [number, number, number][]
      metadata: { agentRouting: boolean }
    }
    expect(segment.type).toBe('duct-segment')
    expect(segment.system).toBe('supply')
    expect(segment.diameter).toBe(200)
    expect(segment.path).toEqual([
      [0, 2.5, 0],
      [6, 2.5, 0],
    ])
    expect(segment.metadata.agentRouting).toBe(true)
    expect(mutations.create[0]!.parentId).toBe('level_1')
  })

  test('изгиб 90°: два звена подрезаны на плечо отвода, отвод в углу', () => {
    const leg = 0.25 // fittingLegLengthM(200) = max(0.14, 0.2/2*2.5)
    const plan = planWith(
      [
        {
          key: 'run0path0',
          system: 'supply',
          sourceRunIndex: 0,
          points: [
            [0, 0],
            [4, 0],
            [4, 3],
          ],
          axisM: [2.5, 2.5, 2.5],
          profile: PROFILE_200,
          flowM3h: 300,
          velocityMps: 4.2,
        },
      ],
      [
        {
          key: 'p0v1-elbow',
          fittingType: 'elbow',
          system: 'supply',
          at: [4, 0],
          angleDeg: 90,
          radiusFactor: 1.5,
          profile: PROFILE_200,
          pathIndex: 0,
          note: 'Отвод 90°',
        },
      ],
    )
    const mutations = planBuildMutations(plan)

    const segments = mutations.create.filter((c) => c.node.type === 'duct-segment')
    const elbows = mutations.create.filter((c) => c.node.type === 'duct-fitting')
    expect(segments).toHaveLength(2)
    expect(elbows).toHaveLength(1)

    const first = segments[0]!.node.path as [number, number, number][]
    const second = segments[1]!.node.path as [number, number, number][]
    // Первое звено: (0,0)→(4,0), обрезано до 4−leg.
    expect(first[first.length - 1]![0]).toBeCloseTo(4 - leg, 9)
    // Второе звено: идёт по +Z от (4,0) → начинается после зазора отвода.
    expect(second[0]![0]).toBeCloseTo(4, 9)
    expect(second[0]![2]).toBeCloseTo(leg, 9)

    const elbow = elbows[0]!.node as AnyNode & { angle: number; position: number[] }
    expect(elbow.fittingType).toBe('elbow')
    expect(elbow.angle).toBe(90)
    expect(elbow.position[0]).toBeCloseTo(4, 9)
    expect(elbow.position[2]).toBeCloseTo(0, 9)
    // Yaw: +X направлен по входящему (−X), т.е. ψ = atan2(−(−0), 1) = 0.
    expect(elbow.rotation[1]).toBeCloseTo(0, 6)
  })

  test('врезка ветки: тройник в точке, магистраль разрезана с зазором, ветка удлинена до патрубка', () => {
    const hostLeg = 0.25 // fittingLegLengthM(200)
    const branchLeg = 0.14 // fittingLegLengthM(100) → max(0.14, 0.05*2.5)
    const plan = planWith(
      [
        {
          key: 'run0path0',
          system: 'supply',
          sourceRunIndex: 0,
          points: [
            [0, 0],
            [6, 0],
          ],
          axisM: [2.5, 2.5],
          profile: PROFILE_200,
          flowM3h: 360,
          velocityMps: 4.5,
        },
        {
          key: 'run1path1',
          system: 'supply',
          sourceRunIndex: 1,
          points: [
            [3, 3],
            [3, 0],
          ],
          axisM: [2.5, 2.5],
          profile: PROFILE_100,
          flowM3h: 60,
          velocityMps: 3,
        },
      ],
      [
        {
          key: 'p1-tap-0-0.500',
          fittingType: 'tee',
          system: 'supply',
          at: [3, 0],
          angleDeg: 90,
          radiusFactor: 1.5,
          profile: PROFILE_200,
          branchProfile: PROFILE_100,
          pathIndex: 1,
          hostPathIndex: 0,
          hostT: 0.5,
          note: 'Тройник',
        },
      ],
    )
    const mutations = planBuildMutations(plan)

    expect(mutations.notes).toEqual([])
    const segments = mutations.create.filter((c) => c.node.type === 'duct-segment')
    const fittings = mutations.create.filter((c) => c.node.type === 'duct-fitting')
    expect(fittings).toHaveLength(1)
    expect(segments).toHaveLength(3) // магистраль на 2 части + ветка

    const tee = fittings[0]!.node as AnyNode & {
      angle: number
      diameter: number
      diameter2: number
      position: number[]
    }
    expect(tee.fittingType).toBe('tee')
    expect(tee.diameter).toBe(200)
    expect(tee.diameter2).toBe(100)
    expect(tee.angle).toBe(90)
    expect(tee.position[0]).toBeCloseTo(3, 9)
    expect(tee.position[1]).toBeCloseTo(2.5, 9)

    // Магистраль разорвана: конец первого куска на 3−hostLeg, начало второго на 3+hostLeg.
    const trunk1 = segments[0]!.node.path as [number, number, number][]
    const trunk2 = segments[1]!.node.path as [number, number, number][]
    expect(trunk1[trunk1.length - 1]![0]).toBeCloseTo(3 - hostLeg, 9)
    expect(trunk2[0]![0]).toBeCloseTo(3 + hostLeg, 9)

    // Ветка: конец вынесен на патрубок (3 + branchLeg по +Z? нет — по отводу от оси).
    const branch = segments[2]!.node.path as [number, number, number][]
    const branchTip = branch[branch.length - 1]!
    // Отвод 90° от магистрали (ось +X) → +Z: патрубок на (3, 2.5, branchLeg).
    expect(branchTip[0]).toBeCloseTo(3, 6)
    expect(branchTip[2]).toBeCloseTo(branchLeg, 6)
    // Начало ветки не тронуто.
    expect(branch[0]![2]).toBeCloseTo(3, 6)
  })

  test('существующие узлы агента попадают в delete (регенерация W5)', () => {
    const plan = planWith([
      {
        key: 'run0path0',
        system: 'exhaust',
        sourceRunIndex: 0,
        points: [
          [0, 0],
          [3, 0],
        ],
        axisM: [2.6, 2.6],
        profile: PROFILE_100,
        flowM3h: 100,
        velocityMps: 3.5,
      },
    ])
    const mutations = planBuildMutations(plan, {
      existingAgentNodeIds: ['duct-segment_9', 'duct-fitting_10'],
    })

    expect(mutations.delete.sort()).toEqual(['duct-fitting_10', 'duct-segment_9'])
    expect(mutations.create).toHaveLength(1)
  })

  test('трасса без сечения не материализуется с пометкой', () => {
    const plan = planWith([
      {
        key: 'run0path0',
        system: 'supply',
        sourceRunIndex: 0,
        points: [
          [0, 0],
          [3, 0],
        ],
        axisM: [2.5, 2.5],
        profile: null,
        flowM3h: 0,
        velocityMps: 0,
      },
    ])
    const mutations = planBuildMutations(plan)

    expect(mutations.create).toEqual([])
    expect(mutations.notes.some((note) => note.includes('без подобранного сечения'))).toBe(true)
  })
})
