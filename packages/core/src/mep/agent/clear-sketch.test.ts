import { describe, expect, test } from 'bun:test'
import type { AnyNode, AnyNodeId } from '../../schema'
import { DuctSegmentNode, DuctSketchNode } from '../../schema'
import { planSketchClear } from './clear-sketch'

function sceneOf(...nodes: AnyNode[]): Record<AnyNodeId, AnyNode> {
  return Object.fromEntries(nodes.map((node) => [node.id, node])) as Record<AnyNodeId, AnyNode>
}

describe('planSketchClear — «Очистить эскиз» (PLAN-AGENT §2.1)', () => {
  test('удаляет узлы эскиза и считает полилинии', () => {
    const sketch = DuctSketchNode.parse({
      runs: [
        {
          system: 'supply',
          points: [
            { x: 0, z: 0 },
            { x: 4, z: 0 },
          ],
        },
        {
          system: 'exhaust',
          points: [
            { x: 0, z: 0 },
            { x: 0, z: 3 },
          ],
        },
      ],
    })
    const segment = DuctSegmentNode.parse({
      id: 'duct-segment_s1' as AnyNodeId,
      path: [
        [0, 2, 0],
        [4, 2, 0],
      ],
    })
    const plan = planSketchClear(sceneOf(sketch, segment))
    expect(plan.delete).toEqual([sketch.id])
    expect(plan.runCount).toBe(2)
  })

  test('без эскиза — пустой план без удалений', () => {
    const segment = DuctSegmentNode.parse({
      id: 'duct-segment_s1' as AnyNodeId,
      path: [
        [0, 2, 0],
        [4, 2, 0],
      ],
    })
    const plan = planSketchClear(sceneOf(segment))
    expect(plan.delete).toEqual([])
    expect(plan.runCount).toBe(0)
  })
})
