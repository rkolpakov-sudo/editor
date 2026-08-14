import { describe, expect, test } from 'bun:test'
import type { AnyNodeDefinition, DistributionRole, NodePort } from '../registry'
import { nodeRegistry, registerNode } from '../registry'
import type { AnyNode } from '../schema'
import { DuctSegmentNode } from '../schema'
import {
  ductSegmentLengthM,
  planGostSegmentation,
  planGostSplit,
  planSystemMarkings,
  systemMarkingLabel,
  systemMarkingLetter,
} from './gost-segmentation'

type Point = [number, number, number]

// Stub registrations mirror the real duct kinds' port conventions so
// `planSystemMarkings` (which routes through `buildDuctNetworks`) runs
// without importing the nodes package. Idempotent on the actual registry —
// parallel workers may share it with `registerDuctNetworkStubs`.
function stubDef(
  kind: string,
  distributionRole: DistributionRole,
  ports: (node: AnyNode) => NodePort[],
): void {
  if (nodeRegistry.has(kind)) return
  registerNode({
    kind,
    schemaVersion: 1,
    schema: {},
    category: 'utility',
    distributionRole,
    defaults: () => ({}),
    capabilities: {},
    ports,
  } as unknown as AnyNodeDefinition)
}

stubDef('duct-segment', 'run', (node) => {
  const path = (node as unknown as { path: Point[] }).path
  const system = (node as unknown as { system: string }).system
  return [
    { id: 'start', position: path[0]!, direction: [-1, 0, 0], diameter: 6, system },
    { id: 'end', position: path[path.length - 1]!, direction: [1, 0, 0], diameter: 6, system },
  ]
})

describe('systemMarkingLetter', () => {
  test('П / В / Р per ГОСТ 21.602', () => {
    expect(systemMarkingLetter('supply')).toBe('П')
    expect(systemMarkingLetter('exhaust')).toBe('В')
    expect(systemMarkingLetter('return')).toBe('Р')
  })

  test('numbered marking П1 / В2 / Р1', () => {
    expect(systemMarkingLabel('supply', 1)).toBe('П1')
    expect(systemMarkingLabel('exhaust', 2)).toBe('В2')
    expect(systemMarkingLabel('return', 1)).toBe('Р1')
  })
})

describe('ductSegmentLengthM', () => {
  test('sums straight and bent legs', () => {
    const segment = DuctSegmentNode.parse({
      path: [
        [0, 2, 0],
        [3, 2, 0],
        [3, 2, 4],
      ],
    })
    expect(ductSegmentLengthM(segment)).toBeCloseTo(7, 9)
  })
})

describe('planGostSegmentation', () => {
  test('exact standard lengths return as-is', () => {
    expect(planGostSegmentation(0.5)).toEqual([0.5])
    expect(planGostSegmentation(1.25)).toEqual([1.25])
    expect(planGostSegmentation(2.5)).toEqual([2.5])
  })

  test('prefers the longest pieces first', () => {
    expect(planGostSegmentation(3.5)).toEqual([2.5, 1.0])
    expect(planGostSegmentation(4.0)).toEqual([2.0, 2.0])
    expect(planGostSegmentation(3.0)).toEqual([2.5, 0.5])
  })

  test('long runs decompose greedily with a standard remainder', () => {
    expect(planGostSegmentation(6.0)).toEqual([2.5, 2.5, 1.0])
  })

  test('a standard remainder completes the greedy decomposition', () => {
    // 2.5 + remainder 2.0 → both standard pieces.
    expect(planGostSegmentation(4.5)).toEqual([2.5, 2.0])
  })

  test('returns null below the smallest ГОСТ length', () => {
    expect(planGostSegmentation(0.4)).toBeNull()
  })

  test('returns null when no standard combination fits', () => {
    expect(planGostSegmentation(3.7)).toBeNull()
    expect(planGostSegmentation(Number.NaN)).toBeNull()
  })
})

describe('planGostSplit', () => {
  test('splits a straight segment into ГОСТ sub-segments', () => {
    const segment = DuctSegmentNode.parse({
      path: [
        [0, 2, 0],
        [3.5, 2, 0],
      ],
    })
    const plan = planGostSplit(segment)
    expect(plan).not.toBeNull()
    expect(plan!.lengthsM).toEqual([2.5, 1.0])
    expect(plan!.splitPoints).toHaveLength(3)
    expect(plan!.splitPoints[0]).toEqual([0, 2, 0])
    expect(plan!.splitPoints[2]).toEqual([3.5, 2, 0])
    // The intermediate node sits at 2.5 m along the run.
    expect(plan!.splitPoints[1]![0]).toBeCloseTo(2.5, 9)
  })

  test('rejects polyline (multi-leg) runs', () => {
    const bent = DuctSegmentNode.parse({
      path: [
        [0, 2, 0],
        [2, 2, 0],
        [2, 2, 2],
      ],
    })
    expect(planGostSplit(bent)).toBeNull()
  })

  test('returns null for runs the ГОСТ row cannot cover', () => {
    const tooShort = DuctSegmentNode.parse({
      path: [
        [0, 2, 0],
        [0.3, 2, 0],
      ],
    })
    expect(planGostSplit(tooShort)).toBeNull()
  })
})

describe('planSystemMarkings', () => {
  test('numbers each network within its own system', () => {
    const supply1 = DuctSegmentNode.parse({
      path: [
        [0, 0, 0],
        [3, 0, 0],
      ],
      system: 'supply',
    })
    const supply2 = DuctSegmentNode.parse({
      path: [
        [0, 0, 5],
        [3, 0, 5],
      ],
      system: 'supply',
    })
    const exhaust1 = DuctSegmentNode.parse({
      path: [
        [0, 0, 10],
        [3, 0, 10],
      ],
      system: 'exhaust',
    })
    const nodes = {
      [supply1.id]: supply1,
      [supply2.id]: supply2,
      [exhaust1.id]: exhaust1,
    }
    const markings = planSystemMarkings(nodes)
    expect(markings[supply1.id]).toBe('П1')
    expect(markings[supply2.id]).toBe('П2')
    expect(markings[exhaust1.id]).toBe('В1')
  })
})
