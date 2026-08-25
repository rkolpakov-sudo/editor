import {
  type FloorplanGeometry,
  type FloorplanPoint,
  type GeometryContext,
  resolveAutoZonePolygon,
  type ZoneNode,
} from '@pascal-app/core'
import { formatAreaLabel } from '@pascal-app/editor'

export function buildZoneContextualDimensions(
  node: ZoneNode,
  ctx: GeometryContext,
): FloorplanGeometry | null {
  const polygon = resolveAutoZonePolygon(node, ctx.resolve)
  if (polygon.length < 3) return null
  const { area, centroid } = polygonAreaAndCentroid(polygon)
  if (area <= 1e-6) return null

  return {
    kind: 'dimension-label',
    appearance: 'outlined',
    cx: centroid[0],
    cy: centroid[1],
    text: formatAreaLabelRu(area, ctx.viewState?.unit ?? 'metric', 1),
    angle: 0,
  }
}

/** Площадь по-русски: 12 → «12,0 м²» (имперская остаётся на общем форматтере). */
function formatAreaLabelRu(
  squareMeters: number,
  unit: 'metric' | 'imperial',
  fractionDigits = 1,
): string {
  if (unit !== 'metric') return formatAreaLabel(squareMeters, unit, fractionDigits)
  if (!Number.isFinite(squareMeters)) return '--'
  const value = squareMeters.toFixed(fractionDigits).replace('.', ',')
  return `${value} м²`
}

function polygonAreaAndCentroid(points: readonly FloorplanPoint[]): {
  area: number
  centroid: FloorplanPoint
} {
  let twiceSignedArea = 0
  let weightedX = 0
  let weightedY = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!
    const next = points[(index + 1) % points.length]!
    const cross = current[0] * next[1] - next[0] * current[1]
    twiceSignedArea += cross
    weightedX += (current[0] + next[0]) * cross
    weightedY += (current[1] + next[1]) * cross
  }
  const area = Math.abs(twiceSignedArea) / 2
  if (Math.abs(twiceSignedArea) <= 1e-9) {
    const sum = points.reduce(
      (acc, point) => [acc[0] + point[0], acc[1] + point[1]] as FloorplanPoint,
      [0, 0] as FloorplanPoint,
    )
    return {
      area,
      centroid: [sum[0] / points.length, sum[1] / points.length],
    }
  }
  return {
    area,
    centroid: [weightedX / (3 * twiceSignedArea), weightedY / (3 * twiceSignedArea)],
  }
}
