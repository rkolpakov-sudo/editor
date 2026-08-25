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
    shape: 'round',
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
    expect(dxf).toContain('MEP_SLEEVE')
    expect(dxf).toContain('MEP_FIRE_DAMPER')
    expect(dxf).toContain('MEP_ELEVATION')
    // LAYER entries: each has a color group code 62.
    expect(dxf.match(/\n62\n/g)).toHaveLength(9) // 0 + 8 MEP layers
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

  test('draws elbows as arcs and terminals as squares', () => {
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
    // Этап 10: отвод рисуется дугой, а не кругом.
    expect(dxf).toContain('ARC')
    expect(dxf).not.toContain('CIRCLE')
    expect(dxf).toContain('MEP_FITTING')
    expect(dxf).toContain('LINE') // terminal square = 4 lines
    // Размер в мм — текстом у знака фиттинга.
    expect(dxf).toContain('1\nОтвод 90° Ø315')
  })

  test('honours drawFittings / drawTerminals flags', () => {
    const scene = sceneOf(fitting('duct-fitting_f1'), terminal('duct-terminal_t1'))
    const minimal = ductsToDxf(scene, { drawFittings: false, drawTerminals: false })
    expect(minimal).not.toContain('CIRCLE')
    expect(minimal).not.toContain('ARC')
  })

  test('draws an offset (утка) as an S polyline with its geometry (Этап 10)', () => {
    const offsetFitting = DuctFittingNode.parse({
      id: 'duct-fitting_off1' as AnyNodeId,
      position: [2, 2.6, 3],
      fittingType: 'offset',
      angle: 45,
      offset: 100,
      offsetRadiusFactor: 1.5,
      diameter: 200,
      system: 'exhaust',
      shape: 'round',
    })
    const dxf = ductsToDxf(sceneOf(offsetFitting))
    // The S body is a polyline on the MEP_FITTING layer — not a circle.
    expect(dxf).not.toContain('CIRCLE')
    expect(dxf).toContain('MEP_FITTING')
    expect(dxf).toContain('1\nУтка 45° Ø200')
  })

  test('draws tee and reducer symbols as lines (Этап 10)', () => {
    const tee = DuctFittingNode.parse({
      id: 'duct-fitting_tee1' as AnyNodeId,
      position: [1, 2.6, 2],
      fittingType: 'tee',
      diameter: 315,
      diameter2: 160,
      shape2: 'round',
      shape: 'round',
      system: 'supply',
    })
    const reducer = DuctFittingNode.parse({
      id: 'duct-fitting_red1' as AnyNodeId,
      position: [5, 2.6, 2],
      fittingType: 'reducer',
      diameter: 250,
      diameter2: 160,
      shape2: 'round',
      shape: 'round',
      system: 'supply',
    })
    const dxf = ductsToDxf(sceneOf(tee, reducer))
    expect(dxf).not.toContain('CIRCLE')
    expect(dxf).toContain('MEP_FITTING')
    expect(dxf).toContain('1\nТройник Ø315/Ø160')
    expect(dxf).toContain('1\nПереход Ø250→Ø160')
  })

  test('marks wall sleeves and fire dampers at crossings (Этап 10)', () => {
    // Duct along X at z = 0 crossing a wall; the same wall is fire-rated.
    const scene = sceneOf(
      segment(
        [
          [-3, 2.6, 0],
          [3, 2.6, 0],
        ],
        { id: 'duct-segment_s1', diameter: 400 },
      ),
    )
    const wall = {
      start: [0, -1] as const,
      end: [0, 1] as const,
      thickness: 0.1,
    }
    const dxf = ductsToDxf(scene, { walls: [wall], fireRatedBarriers: [wall] })
    expect(dxf).toContain('MEP_SLEEVE')
    expect(dxf).toContain('MEP_FIRE_DAMPER')
    // Both markers are small circles at the crossing point on the wall face.
    expect(dxf.match(/\nCIRCLE\n/g)).toHaveLength(2)
    // A sleeve circle sits on the MEP_SLEEVE layer.
    expect(dxf).toContain('8\nMEP_SLEEVE')
    expect(dxf).toContain('8\nMEP_FIRE_DAMPER')
  })

  test('emits a system legend below the plan (Этап 10)', () => {
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
    expect(dxf).toContain('1\nСистемы')
    expect(dxf).toContain('П1 — Приток')
    expect(dxf).toContain('В1 — Вытяжка')
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

  test('emits axis and bottom elevation marks at the run start (C4, ГОСТ 21.602)', () => {
    const scene = sceneOf(
      segment(
        [
          [0, 2.6, 0],
          [2.5, 2.6, 0],
        ],
        { id: 'duct-segment_s1', system: 'supply', diameter: 160 },
      ),
    )
    const dxf = ductsToDxf(scene)
    // Ось = path y = 2,6; низ = ось − D/2 (Ø160 → 2,520).
    expect(dxf).toContain('1\n2,600')
    expect(dxf).toContain('1\nниз 2,520')
    // Отметки — на своём слое MEP_ELEVATION.
    expect(dxf).toContain('8\nMEP_ELEVATION')
  })

  test('marks only elevation-change vertices plus the run start', () => {
    const scene = sceneOf(
      segment(
        [
          [0, 2.6, 0],
          [4, 2.6, 0],
          [4, 3, 5],
        ],
        { id: 'duct-segment_s1', system: 'supply' },
      ),
    )
    const dxf = ductsToDxf(scene)
    // Старт (2,600) и изменение на вершине 2 (3,000); вершина 1 ось не меняла.
    expect(dxf.match(/\n1\n2,600\n/g)).toHaveLength(1)
    expect(dxf.match(/\n1\n3,000\n/g)).toHaveLength(1)
  })

  test('elevationReference axis/bottom and drawElevations=false', () => {
    const scene = sceneOf(
      segment(
        [
          [0, 2.6, 0],
          [2.5, 2.6, 0],
        ],
        { id: 'duct-segment_s1', system: 'supply' },
      ),
    )
    const axisOnly = ductsToDxf(scene, { elevationReference: 'axis' })
    expect(axisOnly).toContain('1\n2,600')
    expect(axisOnly).not.toContain('низ ')

    const bottomOnly = ductsToDxf(scene, { elevationReference: 'bottom' })
    expect(bottomOnly).toContain('1\nниз 2,520')
    expect(bottomOnly).not.toContain('1\n2,600')

    const none = ductsToDxf(scene, { drawElevations: false })
    expect(none).not.toContain('1\n2,600')
    expect(none).not.toContain('низ ')
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
