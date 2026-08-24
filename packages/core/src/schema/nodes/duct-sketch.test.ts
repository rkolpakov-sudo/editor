import { describe, expect, test } from 'bun:test'
import { DuctSketchNode } from './duct-sketch'

describe('DuctSketchNode', () => {
  test('fills defaults on a minimal parse', () => {
    const node = DuctSketchNode.parse({
      runs: [
        {
          system: 'exhaust',
          points: [
            { x: 0, z: 0 },
            { x: 3, z: 0 },
          ],
        },
      ],
    })
    expect(node.id.startsWith('duct-sketch_')).toBe(true)
    expect(node.type).toBe('duct-sketch')
    expect(node.object).toBe('node')
    expect(node.parentId).toBeNull()
    expect(node.visible).toBe(true)
    expect(node.runs).toHaveLength(1)
    expect(node.runs[0]!.system).toBe('exhaust')
    // Elevation defaults to the agent-controlled ceiling plane.
    expect(node.runs[0]!.points[0]!.elev).toBe('auto')
  })

  test('empty sketch parses with an empty run list (one node per level)', () => {
    const node = DuctSketchNode.parse({})
    expect(node.runs).toEqual([])
  })

  test('accepts fixed axis elevation and defaults the run system to supply', () => {
    const node = DuctSketchNode.parse({
      runs: [
        {
          points: [
            { x: 1, z: 2, elev: { axisM: 2.35 } },
            { x: 4, z: 2 },
          ],
        },
      ],
    })
    expect(node.runs[0]!.system).toBe('supply')
    expect(node.runs[0]!.points[0]!.elev).toEqual({ axisM: 2.35 })
    expect(node.runs[0]!.points[1]!.elev).toBe('auto')
  })

  test('rejects a run with fewer than two points', () => {
    const result = DuctSketchNode.safeParse({
      runs: [{ system: 'supply', points: [{ x: 0, z: 0 }] }],
    })
    expect(result.success).toBe(false)
  })

  test('rejects an unknown system and a malformed elevation', () => {
    expect(
      DuctSketchNode.safeParse({
        runs: [
          {
            system: 'drain',
            points: [
              { x: 0, z: 0 },
              { x: 1, z: 0 },
            ],
          },
        ],
      }).success,
    ).toBe(false)
    expect(
      DuctSketchNode.safeParse({
        runs: [
          {
            system: 'supply',
            points: [
              { x: 0, z: 0, elev: { heightM: 2 } },
              { x: 1, z: 0 },
            ],
          },
        ],
      }).success,
    ).toBe(false)
  })
})
