import { describe, expect, test } from 'bun:test'
import {
  ductSegment,
  ductTerminal,
  hvacUnit,
  registerDuctNetworkStubs,
  sceneOf,
  twoBranchSupplyScene,
} from './duct-network-stubs'
import { computeNetworkFlows } from './network-flows'
import { sizeDuctNetworks, sizedProfiles } from './network-sizing'

registerDuctNetworkStubs()

describe('sizeDuctNetworks — подбор сечений по сети «магистраль → ответвления»', () => {
  test('кухня 90 м³/ч вытяжки → ГОСТ Ø100, скорость в диапазоне Л.1', () => {
    const equipment = hvacUnit([0, 0, 0])
    const seg1 = ductSegment(
      [
        [0, 0, 0],
        [4, 0, 0],
      ],
      'exhaust',
    )
    const seg2 = ductSegment(
      [
        [4, 0, 0],
        [7, 0, 0],
      ],
      'exhaust',
    )
    const grille = ductTerminal([7, 0, 0], 'return-grille')
    const nodes = sceneOf(equipment, seg1, seg2, grille)

    const flows = computeNetworkFlows(nodes, { terminalFlows: { [grille.id]: 90 } })
    const results = sizeDuctNetworks(nodes, { flows })

    expect(results).toHaveLength(1)
    const result = results[0]!
    expect(result.segments).toHaveLength(2)

    const sized1 = result.segments.find((segment) => segment.segmentId === seg1.id)!
    const sized2 = result.segments.find((segment) => segment.segmentId === seg2.id)!
    expect(sized1.flowM3h).toBeCloseTo(90, 9)
    expect(sized2.flowM3h).toBeCloseTo(90, 9)
    expect(sized1.profile).toEqual({ shape: 'round', diameterMm: 100 })
    expect(sized1.velocityMps).toBeGreaterThanOrEqual(3.0)
    expect(sized1.velocityMps).toBeLessThanOrEqual(4.0)
    expect(sized1.inNormBand).toBe(true)
    expect(sized1.noiseCheckRequired).toBe(false)
    expect(sized1.frictionDropPa).toBeGreaterThan(0)

    // sizedProfiles → карта для сетевых потерь.
    const profiles = sizedProfiles(results)
    expect(profiles[seg1.id]).toEqual({ shape: 'round', diameterMm: 100 })
  })

  test('большой расход притока помечает участок шумовой проверкой', () => {
    const equipment = hvacUnit([0, 0, 0])
    const segment = ductSegment(
      [
        [0, 0, 0],
        [5, 0, 0],
      ],
      'supply',
    )
    const diffuser = ductTerminal([5, 0, 0], 'diffuser')
    const nodes = sceneOf(equipment, segment, diffuser)

    const flows = computeNetworkFlows(nodes, { terminalFlows: { [diffuser.id]: 4000 } })
    const [result] = sizeDuctNetworks(nodes, { flows, hoursBand: 'lt2000' })

    const sized = result!.segments[0]!
    expect(sized.profile).toEqual({ shape: 'round', diameterMm: 500 })
    expect(sized.velocityMps).toBeGreaterThan(5)
    expect(sized.inNormBand).toBe(true)
    expect(sized.noiseCheckRequired).toBe(true)
    expect(result!.warnings.some((warning) => warning.includes('акустическая'))).toBe(true)
  })

  test('нулевой расход оставляет текущий профиль без скорости', () => {
    const { nodes, seg3 } = twoBranchSupplyScene()
    const flows = computeNetworkFlows(nodes, {})
    const [result] = sizeDuctNetworks(nodes, { flows })

    const sized3 = result!.segments.find((segment) => segment.segmentId === seg3.id)!
    expect(sized3.flowM3h).toBe(0)
    expect(sized3.profile).toEqual(sized3.currentProfile)
    expect(sized3.velocityMps).toBe(0)
    expect(sized3.inNormBand).toBe(true)
    expect(sized3.frictionDropPa).toBe(0)
  })

  test('магистральные участки подбираются раньше ответвлений (BFS от корня)', () => {
    const { nodes, seg1, seg2, branch1 } = twoBranchSupplyScene()
    const flows = computeNetworkFlows(nodes, {})
    const [result] = sizeDuctNetworks(nodes, { flows })

    const order = result!.segments.map((segment) => segment.segmentId)
    const seg1Index = order.indexOf(seg1.id)
    const seg2Index = order.indexOf(seg2.id)
    const branchIndex = order.indexOf(branch1.id)
    expect(seg1Index).toBeGreaterThanOrEqual(0)
    expect(seg2Index).toBeGreaterThan(seg1Index)
    expect(branchIndex).toBeGreaterThan(seg1Index)
  })
})
