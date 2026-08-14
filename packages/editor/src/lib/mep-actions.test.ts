import { beforeEach, describe, expect, test } from 'bun:test'
import {
  type AnyNodeDefinition,
  type AnyNodeId,
  DuctSegmentNode,
  type NodePort,
  nodeRegistry,
  registerNode,
  useScene,
} from '@pascal-app/core'
import { applyAllBypasses, applyGostSegmentation } from './mep-actions'

type RafFn = (cb: (time: number) => void) => number
;(globalThis as { requestAnimationFrame?: RafFn }).requestAnimationFrame ??= ((
  cb: (time: number) => void,
) => {
  cb(0)
  return 0
}) as RafFn
;(globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame ??= () => {}

type Point = [number, number, number]

// Stub the duct kinds' port convention so `buildDuctNetworks` and the bypass
// planner can route through the real store singleton.
function stubDuctDef(kind: string): void {
  if (nodeRegistry.has(kind)) return
  registerNode({
    kind,
    schemaVersion: 1,
    schema: {},
    category: 'utility',
    distributionRole: 'run',
    defaults: () => ({}),
    capabilities: {},
    ports: (node: unknown) => {
      const path = (node as { path: Point[] }).path
      const system = (node as { system: string }).system
      return [
        { id: 'start', position: path[0]!, direction: [-1, 0, 0], diameter: 6, system },
        {
          id: 'end',
          position: path[path.length - 1]!,
          direction: [1, 0, 0],
          diameter: 6,
          system,
        },
      ] satisfies NodePort[]
    },
  } as unknown as AnyNodeDefinition)
}

stubDuctDef('duct-segment')

function addSegment(fields: Record<string, unknown>): AnyNodeId {
  const segment = DuctSegmentNode.parse(fields)
  useScene.getState().createNode(segment)
  return segment.id
}

function pathLength(path: Point[]): number {
  let total = 0
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i]!
    const b = path[i + 1]!
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  }
  return total
}

beforeEach(() => {
  useScene.getState().unloadScene()
})

describe('applyGostSegmentation', () => {
  test('splits a straight run into ГОСТ sub-segments, one undo step', () => {
    const id = addSegment({
      path: [
        [0, 2, 0],
        [3.5, 2, 0],
      ],
      shape: 'round',
      diameter: 250,
      system: 'supply',
    })
    const outcome = applyGostSegmentation(id)
    expect(outcome).toEqual({ kind: 'applied', pieces: 2 })

    const nodes = useScene.getState().nodes
    expect(nodes[id]).toBeUndefined()

    const subs = Object.values(nodes).filter(
      (node): node is DuctSegmentNode => node.type === 'duct-segment',
    )
    expect(subs).toHaveLength(2)
    expect(subs.map((sub) => sub.id)).not.toContain(id)
    const total = subs.reduce((sum, sub) => sum + pathLength(sub.path), 0)
    expect(total).toBeCloseTo(3.5, 6)
    // Sub-segments inherit the profile and the system.
    for (const sub of subs) {
      expect(sub.system).toBe('supply')
      expect(sub.shape).toBe('round')
      expect(sub.diameter).toBe(250)
    }
    // Undo restores the single original segment.
    useScene.temporal.getState().undo()
    expect(useScene.getState().nodes[id]).toBeDefined()
  })

  test('no-ops on already-standard and non-straight runs', () => {
    const standard = addSegment({
      path: [
        [0, 2, 0],
        [1.25, 2, 0],
      ],
    })
    expect(applyGostSegmentation(standard)).toEqual({ kind: 'already-standard' })

    const bent = addSegment({
      path: [
        [0, 2, 0],
        [2, 2, 0],
        [2, 2, 2],
      ],
    })
    expect(applyGostSegmentation(bent)).toEqual({ kind: 'not-straight' })
  })
})

describe('applyAllBypasses', () => {
  test('builds утка for a crossing П/В as one command', () => {
    addSegment({
      path: [
        [0, 2, 0],
        [6, 2, 0],
      ],
      shape: 'round',
      diameter: 250,
      system: 'supply',
    })
    const exhaustId = addSegment({
      path: [
        [3, 2, -2],
        [3, 2, 2],
      ],
      shape: 'round',
      diameter: 160,
      system: 'exhaust',
    })

    const report = applyAllBypasses()
    expect(report.applied).toBe(1)
    expect(report.switchedTo90).toBe(0)
    expect(report.skipped).toBe(0)

    const nodes = useScene.getState().nodes
    const exhaust = nodes[exhaustId]
    expect(exhaust).toBeDefined()
    // Trimmed before-part: original 4 m run is now shorter than the crossing
    // span each side.
    expect(pathLength((exhaust as DuctSegmentNode).path)).toBeLessThan(2)

    const segments = Object.values(nodes).filter(
      (node): node is DuctSegmentNode => node.type === 'duct-segment',
    )
    expect(segments).toHaveLength(3)
    const fittings = Object.values(nodes).filter((node) => node.type === 'duct-fitting')
    expect(fittings).toHaveLength(1)
    expect((fittings[0] as { fittingType: string }).fittingType).toBe('offset')
    expect((fittings[0] as { system: string }).system).toBe('exhaust')

    // Single undo returns to the two original runs.
    useScene.temporal.getState().undo()
    const undone = useScene.getState().nodes
    expect(Object.values(undone).filter((node) => node.type === 'duct-segment')).toHaveLength(2)
    expect(undone[exhaustId]).toBeDefined()
  })

  test('skips a run too short to fit the S', () => {
    addSegment({
      path: [
        [0, 2, 0],
        [6, 2, 0],
      ],
      shape: 'round',
      diameter: 250,
      system: 'supply',
    })
    // Exhaust legs are only 0.4 m each side of the crossing — no room.
    addSegment({
      path: [
        [3, 2, -0.4],
        [3, 2, 0.4],
      ],
      shape: 'round',
      diameter: 160,
      system: 'exhaust',
    })
    const report = applyAllBypasses()
    expect(report.applied).toBe(0)
    expect(report.skipped).toBe(1)
    expect(report.skippedReasons).toEqual(['no-room'])
  })
})
