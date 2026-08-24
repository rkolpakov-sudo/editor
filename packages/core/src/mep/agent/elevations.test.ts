import { describe, expect, test } from 'bun:test'
import type { DuctSketchElevation, DuctSketchRun } from '../../schema'
import { hvacUnit, sceneOf } from '../duct-network-stubs'
import { resolvePathElevations } from './elevations'
import { recognizeTopology } from './recognize-topology'

type Vertex = { x: number; z: number; elev: DuctSketchElevation }

const auto = (x: number, z: number): Vertex => ({ x, z, elev: 'auto' })
const fixed = (x: number, z: number, axisM: number): Vertex => ({
  x,
  z,
  elev: { axisM },
})

function topologyOf(points: Vertex[]) {
  const runs: DuctSketchRun[] = [{ system: 'supply', points }]
  return recognizeTopology(runs, sceneOf(hvacUnit([100, 0, 100])))
}

const ROUND_250 = { shape: 'round', diameterMm: 250 } as const

describe('resolvePathElevations — оси «как в Revit» (PLAN-AGENT §2.5)', () => {
  test("'auto' держит ось под потолком: потолок − зазор − H/2", () => {
    const topology = topologyOf([auto(10, 0), auto(14, 0)])
    const result = resolvePathElevations(topology, { 0: ROUND_250 })

    expect(result.issues).toEqual([])
    const elevation = result.elevations[0]!
    expect(elevation.axisM[0]).toBeCloseTo(2.525, 9)
    expect(elevation.axisM[1]).toBeCloseTo(2.525, 9)
    expect(elevation.verticals).toEqual([])
  })

  test("изоляция учитывается в 'auto' (верх с изоляцией ≤ потолок − зазор)", () => {
    const topology = topologyOf([auto(10, 0), auto(14, 0)])
    const result = resolvePathElevations(topology, { 0: ROUND_250 }, { insulationMm: 50 })

    expect(result.issues.filter((i) => i.severity === 'blocker')).toEqual([])
    expect(result.elevations[0]!.axisM[0]).toBeCloseTo(2.475, 9)
  })

  test('разные фиксированные оси соседних вершин дают вертикальный участок', () => {
    const topology = topologyOf([fixed(10, 0, 2.4), fixed(14, 0, 2.0)])
    const result = resolvePathElevations(topology, { 0: ROUND_250 })

    expect(result.issues.filter((i) => i.severity === 'blocker')).toEqual([])
    const elevation = result.elevations[0]!
    expect(elevation.axisM[0]).toBeCloseTo(2.4, 9)
    expect(elevation.axisM[1]).toBeCloseTo(2.0, 9)
    expect(elevation.verticals).toHaveLength(1)
    expect(elevation.verticals[0]!.afterVertexIndex).toBe(0)
    expect(elevation.verticals[0]!.riseM).toBeCloseTo(-0.4, 9)
  })

  test('фиксированная ось выше потолка с зазором — блокер duct-above-ceiling', () => {
    const topology = topologyOf([fixed(10, 0, 2.9), fixed(14, 0, 2.9)])
    const result = resolvePathElevations(topology, { 0: ROUND_250 })

    const issue = result.issues.find((i) => i.code === 'duct-above-ceiling')!
    expect(issue.severity).toBe('blocker')
    expect(issue.vertexIndex).toBe(0)
    expect(issue.message).toContain('опустите фиксированную ось')
  })

  test('изоляция может поднять верх выше допустимого и при разумной оси', () => {
    const topology = topologyOf([fixed(10, 0, 2.52), fixed(14, 0, 2.52)])
    const without = resolvePathElevations(topology, { 0: ROUND_250 })
    expect(without.issues.filter((i) => i.code === 'duct-above-ceiling')).toEqual([])

    const withInsulation = resolvePathElevations(topology, { 0: ROUND_250 }, { insulationMm: 50 })
    expect(withInsulation.issues.some((i) => i.code === 'duct-above-ceiling')).toBe(true)
  })

  test('низ ниже пола — блокер duct-below-floor', () => {
    const topology = topologyOf([fixed(10, 0, 0.1), fixed(14, 0, 0.1)])
    const result = resolvePathElevations(topology, { 0: ROUND_250 })

    const issue = result.issues.find((i) => i.code === 'duct-below-floor')!
    expect(issue.severity).toBe('blocker')
    expect(issue.message).toContain('ниже пола')
  })

  test('оси без профиля считаются для принятого тела Ø250 + предупреждение', () => {
    const topology = topologyOf([auto(10, 0), auto(14, 0)])
    const result = resolvePathElevations(topology, { 0: null })

    const warning = result.issues.find((i) => i.code === 'auto-without-profile')!
    expect(warning.severity).toBe('warning')
    expect(result.elevations[0]!.axisM[0]).toBeCloseTo(2.525, 9)
  })

  test('потолок можно переопределить по пути', () => {
    const topology = topologyOf([auto(10, 0), auto(14, 0)])
    const result = resolvePathElevations(
      topology,
      { 0: ROUND_250 },
      {
        ceilingHeightMByPath: { 0: 3.3 },
      },
    )

    expect(result.elevations[0]!.axisM[0]).toBeCloseTo(3.125, 9)
  })
})
