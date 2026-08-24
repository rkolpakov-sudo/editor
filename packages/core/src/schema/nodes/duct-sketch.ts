import dedent from 'dedent'
import { z } from 'zod'
import { BaseNode, nodeType, objectId } from '../base'

/**
 * Duct sketch — the agent-routing input (docs/mep/PLAN-AGENT.md §2.1).
 *
 * One node per level holds every polyline the user drafts with the duct
 * tool's "Sketch" mode: supply / exhaust / return runs drawn on the floor
 * plan without choosing sections or fittings. The routing agent later
 * consumes these polylines ("Трассировка" button) and materialises real
 * duct-segment / duct-fitting nodes; the sketch itself is the source of
 * truth for regeneration and never reaches exports.
 *
 * Points are level-local plan meters. Elevation follows the Revit-style
 * model: `'auto'` lets the agent keep the axis flat under the ceiling
 * (ceiling − clearance − H/2), a fixed value pins the duct axis to an
 * absolute height in meters above the level floor — differing neighbouring
 * axes become a vertical drop with two elbows at build time.
 */
export const DuctSketchElevation = z
  .union([z.literal('auto'), z.object({ axisM: z.number() })])
  .default('auto')
export type DuctSketchElevation = z.infer<typeof DuctSketchElevation>

export const DuctSketchPoint = z.object({
  x: z.number(),
  z: z.number(),
  elev: DuctSketchElevation,
})
export type DuctSketchPoint = z.infer<typeof DuctSketchPoint>

export const DuctSketchRun = z.object({
  // П / В / рециркуляция per ГОСТ 21.602 — same vocabulary as duct-segment.
  system: z.enum(['supply', 'exhaust', 'return']).default('supply'),
  points: z.array(DuctSketchPoint).min(2),
})
export type DuctSketchRun = z.infer<typeof DuctSketchRun>

export const DuctSketchNode = BaseNode.extend({
  id: objectId('duct-sketch'),
  type: nodeType('duct-sketch'),
  runs: z.array(DuctSketchRun).default([]),
}).describe(
  dedent`
  Duct sketch - agent-routing input polylines for one level (PLAN-AGENT §2.1).
  - runs: list of { system, points }; system is supply | exhaust | return (П / В / Р)
  - points: level-local plan meters { x, z, elev }; elev is 'auto' (agent keeps the
    axis under the ceiling) or fixed { axisM } in meters above the level floor
  - consumed by the routing agent; excluded from specification / DXF / GLB exports
  `,
)
export type DuctSketchNode = z.infer<typeof DuctSketchNode>
export type DuctSketchNodeId = DuctSketchNode['id']
