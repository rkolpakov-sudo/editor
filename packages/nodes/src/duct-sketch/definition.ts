import { DuctSketchNode as DuctSketchNodeSchema, type NodeDefinition } from '@pascal-app/core'
import { buildDuctSketchFloorplan } from './floorplan'
import { DuctSketchNode } from './schema'

/**
 * Duct sketch — agent-routing input (docs/mep/PLAN-AGENT.md §2.1, Этап A1).
 *
 * Composition: `floorplan` only. The sketch is a 2D-plan annotation —
 * dashed polylines tinted by system — with no 3D mesh, no per-frame work
 * and no palette tool of its own (the duct tool's "Sketch" mode writes
 * into it in Этап A2). `bake: 'strip'` keeps it out of GLB bakes; the MEP
 * specification / DXF builders filter node types explicitly, so the kind
 * never reaches exports (asserted in tests).
 */
export const ductSketchDefinition: NodeDefinition<typeof DuctSketchNode> = {
  kind: 'duct-sketch',
  bake: 'strip',
  schemaVersion: 1,
  schema: DuctSketchNode,
  category: 'utility',
  // No dirty consumer rebuilds this kind — see NodeDefinition.dirtyTracking.
  dirtyTracking: false,

  defaults: () => {
    const stub = DuctSketchNodeSchema.parse({
      id: 'duct-sketch_default' as never,
      type: 'duct-sketch',
    })
    const { id: _id, type: _type, ...rest } = stub
    return rest
  },

  capabilities: {
    selectable: { hitVolume: 'bbox' },
    duplicable: false,
    deletable: true,
    // A level's routing sketch is scene state — saving it as a reusable
    // catalog item has no meaning.
    presettable: false,
  },

  floorplan: buildDuctSketchFloorplan,

  presentation: {
    label: 'Duct Sketch',
    description: 'Agent-routing input — supply / exhaust / return sketch polylines for one level.',
    icon: { kind: 'url', src: '/icons/duct.webp' },
  },

  mcp: {
    description:
      'A level-scoped HVAC routing sketch: polylines per system (supply / exhaust / return) consumed by the duct-routing agent. Excluded from exports.',
  },
}
