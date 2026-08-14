import { describe, expect, test } from 'bun:test'
import type { AnyNode, AnyNodeId } from '../schema'
import { DuctFittingNode, DuctSegmentNode, DuctTerminalNode } from '../schema'
import { ductsToDxf, dxfLayerForNode } from './dxf'

type Point = [number, number, number]

function segment(
  path: Point[],
  opts: {
    id: string
    system?: 'supply' | 'exhaust' | 'return'
    diameter?: number
  },
): DuctSegmentNode {
  return DuctSegmentNode.parse({
    id: opts.id as AnyNodeId,
    path,
    system: opts.system ?? 'supply',
    diameter: opts.diameter ?? 160,
  })
}

function fitting(id: string, system: 'supply' | 'exhaust' = 'supply'): DuctFittingNode {
  return DuctFittingNode.parse({
    id: id as AnyNodeId,
    position: [2, 2.6, 3],
    fittingType: 'elbow',
    angle: 90,
    system,
  })
}

function terminal(id: string): DuctTerminalNode {
  return DuctTerminalNode.parse({ id: id as AnyNodeId })
}

function sceneOf(...nodes: AnyNode[]): Record<AnyNodeId, AnyNode> {
  return Object.fromEntries(nodes.map((n) => [n.id, n])) as Record<AnyNodeId, AnyNode>
}

describe('ductsToDxf', () => {
  test('starts with a valid header and ends with EOF', () => {
    const dxf = ductsToDxf({})
    expect(dxf).toContain('SECTION')
    expect(dxf).toContain('$ACADVER')
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true)
  })

  test('declares all system layers with distinct colors', () => {
    const dxf = ductsToDxf(
      sceneOf(
        segment(
          [
            [0, 2, 0],
            [2.5, 2, 0],
          ],
          { id: 'duct-segment_s1' },
        ),
      ),
    )
    expect(dxf).toContain('MEP_SUPPLY')
    expect(dxf).toContain('MEP_EXHAUST')
    expect(dxf).toContain('MEP_RETURN')
    expect(dxf).toContain('MEP_FITTING')
    expect(dxf).toContain('MEP_TERMINAL')
    // LAYER entries: each has a color group code 62.
    expect(dxf.match(/\n62\n/g)).toHaveLength(6) // 0 + 5 MEP layers
  })

  test('projects segment path onto the plan as LINE entities on the system layer', () => {
    const scene = sceneOf(
      segment(
        [
          [0, 2.6, 0],
          [3, 2.6, 0],
        ],
        { id: 'duct-segment_s1', system: 'supply' },
      ),
      segment(
        [
          [5, 2.6, 0],
          [8, 2.6, 0],
        ],
        { id: 'duct-segment_e1', system: 'exhaust' },
      ),
    )
    const dxf = ductsToDxf(scene)
    // Plan uses (x, z): supply 0→3 on x, z = 0; exhaust 5→8 on x, z = 0.
    expect(dxf).toContain('MEP_SUPPLY\n10\n0\n20\n0\n30\n0\n11\n3\n21\n0')
    expect(dxf).toContain('MEP_EXHAUST')
    expect(dxf).toContain('11\n8\n21\n0')
  })

  test('places П1/В1 marking text at segment midpoints', () => {
    const scene = sceneOf(
      segment(
        [
          [0, 2.6, 0],
          [2.5, 2.6, 0],
        ],
        { id: 'duct-segment_s1', system: 'supply' },
      ),
      segment(
        [
          [0, 2.6, 5],
          [1, 2.6, 5],
        ],
        { id: 'duct-segment_e1', system: 'exhaust' },
      ),
    )
    const dxf = ductsToDxf(scene)
    expect(dxf).toContain('1\nП1')
    expect(dxf).toContain('1\nВ1')
    // Label on the supply layer, height default 0.35.
    expect(dxf).toContain('MEP_SUPPLY\n10\n1.25\n20\n0\n30\n0\n40\n0.35\n1\nП1')
  })

  test('draws fittings as circles and terminals as squares', () => {
    const scene = sceneOf(
      segment(
        [
          [0, 2.6, 0],
          [4, 2.6, 0],
        ],
        { id: 'duct-segment_s1' },
      ),
      fitting('duct-fitting_f1'),
      terminal('duct-terminal_t1'),
    )
    const dxf = ductsToDxf(scene)
    expect(dxf).toContain('CIRCLE')
    expect(dxf).toContain('MEP_FITTING')
    expect(dxf).toContain('LINE') // terminal square = 4 lines
  })

  test('honours drawFittings / drawTerminals flags', () => {
    const scene = sceneOf(fitting('duct-fitting_f1'), terminal('duct-terminal_t1'))
    const minimal = ductsToDxf(scene, { drawFittings: false, drawTerminals: false })
    expect(minimal).not.toContain('CIRCLE')
  })

  test('custom markings override the per-system fallback', () => {
    const scene = sceneOf(
      segment(
        [
          [0, 2.6, 0],
          [2.5, 2.6, 0],
        ],
        { id: 'duct-segment_s1', system: 'supply' },
      ),
    )
    const dxf = ductsToDxf(scene, { markings: { 'duct-segment_s1': 'П3' } })
    expect(dxf).toContain('1\nП3')
  })
})

describe('dxfLayerForNode', () => {
  test('maps duct nodes to their system layer', () => {
    const supply = segment(
      [
        [0, 2, 0],
        [1, 2, 0],
      ],
      { id: 'duct-segment_s1', system: 'supply' },
    )
    const exhaust = segment(
      [
        [0, 2, 0],
        [1, 2, 0],
      ],
      { id: 'duct-segment_e1', system: 'exhaust' },
    )
    expect(dxfLayerForNode(supply)).toBe('MEP_SUPPLY')
    expect(dxfLayerForNode(exhaust)).toBe('MEP_EXHAUST')
    expect(dxfLayerForNode(fitting('duct-fitting_f1'))).toBe('MEP_FITTING')
    expect(dxfLayerForNode(terminal('duct-terminal_t1'))).toBe('MEP_TERMINAL')
  })
})
