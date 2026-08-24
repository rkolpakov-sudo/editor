import type { FloorplanGeometry, FloorplanPoint } from '@pascal-app/core'
import type { DuctSketchNode } from './schema'

const SUPPLY_COLOR = '#d4825a'
const EXHAUST_COLOR = '#5ab46a'
const RETURN_COLOR = '#5a8ad4'

function colorForSystem(system: 'supply' | 'exhaust' | 'return'): string {
  return system === 'supply' ? SUPPLY_COLOR : system === 'exhaust' ? EXHAUST_COLOR : RETURN_COLOR
}

/**
 * Floor-plan representation of the routing sketch: each run drawn as a
 * dashed polyline tinted by its system — visually distinct from committed
 * duct runs (solid body + dashed centerline) so the plan always reads
 * "intent, not built". Elevation is not drawn in plan.
 */
export function buildDuctSketchFloorplan(node: DuctSketchNode): FloorplanGeometry | null {
  const children: FloorplanGeometry[] = []
  for (const run of node.runs) {
    // Drop consecutive duplicate plan points so zero-length artifacts
    // never render (same guard as duct-segment risers).
    const points: FloorplanPoint[] = []
    for (const point of run.points) {
      const prev = points[points.length - 1]
      if (prev && Math.abs(prev[0] - point.x) < 1e-6 && Math.abs(prev[1] - point.z) < 1e-6) {
        continue
      }
      points.push([point.x, point.z])
    }
    if (points.length < 2) continue

    children.push({
      kind: 'polyline',
      points,
      stroke: colorForSystem(run.system),
      strokeWidth: 1.5,
      vectorEffect: 'non-scaling-stroke',
      strokeDasharray: '6 4',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      opacity: 0.9,
    })
  }
  if (children.length === 0) return null
  return { kind: 'group', children }
}
