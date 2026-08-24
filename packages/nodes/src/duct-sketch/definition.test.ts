import { describe, expect, test } from 'bun:test'
import {
  type AnyNode,
  type AnyNodeId,
  buildDuctSpecification,
  DuctSketchNode,
  ductsToDxf,
} from '@pascal-app/core'
import { ductSketchDefinition } from './definition'
import { buildDuctSketchFloorplan } from './floorplan'

function sketchScene(): Record<AnyNodeId, AnyNode> {
  const node = DuctSketchNode.parse({
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
          { x: 0, z: 2 },
          { x: 4, z: 2 },
        ],
      },
    ],
  })
  return { [node.id]: node }
}

describe('ductSketchDefinition', () => {
  test('registers a plan-only annotation contract', () => {
    expect(ductSketchDefinition.kind).toBe('duct-sketch')
    expect(ductSketchDefinition.category).toBe('utility')
    expect(ductSketchDefinition.bake).toBe('strip')
    expect(ductSketchDefinition.dirtyTracking).toBe(false)
    expect(ductSketchDefinition.schemaVersion).toBe(1)
    // Plan-only: no 3D geometry, renderer or per-frame system; no palette
    // tool (the duct tool's Sketch mode writes into it from Этап A2).
    expect(ductSketchDefinition.geometry).toBeUndefined()
    expect(ductSketchDefinition.renderer).toBeUndefined()
    expect(ductSketchDefinition.system).toBeUndefined()
    expect(ductSketchDefinition.tool).toBeUndefined()
    expect(ductSketchDefinition.presentation?.paletteSection).toBeUndefined()
    expect(typeof ductSketchDefinition.floorplan).toBe('function')
    expect(ductSketchDefinition.capabilities).toMatchObject({
      selectable: { hitVolume: 'bbox' },
      deletable: true,
      duplicable: false,
      presettable: false,
    })
  })

  test('produces schema-valid defaults', () => {
    const parsed = ductSketchDefinition.schema.safeParse({
      id: 'duct-sketch_default',
      type: 'duct-sketch',
      ...ductSketchDefinition.defaults(),
    })
    expect(parsed.success).toBe(true)
  })

  test('floorplan draws one dashed polyline per run, tinted by system', () => {
    const node = DuctSketchNode.parse({
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
            { x: 0, z: 2 },
            { x: 0, z: 5 },
          ],
        },
      ],
    })
    const plan = buildDuctSketchFloorplan(node)
    expect(plan?.kind).toBe('group')
    const children = plan && plan.kind === 'group' ? plan.children : []
    expect(children).toHaveLength(2)
    for (const child of children) {
      if (child.kind !== 'polyline') continue
      expect(child.strokeDasharray).toBeTruthy()
      expect(child.vectorEffect).toBe('non-scaling-stroke')
    }
    expect(children[0]?.kind === 'polyline' && children[0]!.points).toEqual([
      [0, 0],
      [4, 0],
    ])
  })

  test('empty sketch renders nothing in plan', () => {
    expect(buildDuctSketchFloorplan(DuctSketchNode.parse({}))).toBeNull()
  })

  test('sketch nodes never reach the MEP specification', () => {
    const specification = buildDuctSpecification(sketchScene())
    expect(specification.totals.lengthM).toBe(0)
    expect(specification.totals.fittings).toBe(0)
    expect(specification.totals.terminals).toBe(0)
    expect(specification.systems).toEqual([])
  })

  test('sketch nodes never reach the DXF export', () => {
    const dxf = ductsToDxf(sketchScene())
    // Layer table always declares the MEP layers — the assertion is an
    // empty ENTITIES section (no duct geometry drawn from the sketch).
    expect(dxf).toContain('SECTION\n2\nENTITIES\n\n0\nENDSEC')
    expect(dxf).not.toContain('\nLINE\n')
  })
})
