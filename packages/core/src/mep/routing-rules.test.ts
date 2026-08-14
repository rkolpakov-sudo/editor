import { describe, expect, test } from 'bun:test'
import {
  checkFireBarrierCrossing,
  checkWallPenetration,
  mountingSpacingM,
  planRunMounting,
  segmentPolygonCrossing,
  segmentSegmentIntersection,
  supportCountForRun,
  wallBarrierRect,
} from './routing-rules'

describe('mounting rules (СП 73.13330.2016 п. 6.5.5)', () => {
  test('spacing: size < 400 мм → 4 м, 400 мм и более → 3 м, любой формы', () => {
    expect(mountingSpacingM('round', 200)).toBe(4)
    expect(mountingSpacingM('round', 399)).toBe(4)
    expect(mountingSpacingM('round', 400)).toBe(3)
    expect(mountingSpacingM('round', 500)).toBe(3)
    // the norm applies the same threshold to the larger side of rect/oval
    expect(mountingSpacingM('rect', 300)).toBe(4)
    expect(mountingSpacingM('rect', 400)).toBe(3)
    expect(mountingSpacingM('oval', 300)).toBe(4)
  })

  test('support count = floor(L/spacing) + 1', () => {
    expect(supportCountForRun(10, 'round', 200)).toBe(3)
    expect(supportCountForRun(8, 'round', 500)).toBe(3)
    expect(supportCountForRun(0, 'round', 200)).toBe(0)
  })

  test('planRunMounting computes both', () => {
    const plan = planRunMounting({
      from: [0, 0],
      to: [0, 6],
      shape: 'round',
      sizeMm: 200,
    })
    expect(plan.spacingM).toBe(4)
    expect(plan.supportCount).toBe(2)
  })
})

describe('planar geometry primitives', () => {
  test('segmentSegmentIntersection returns the crossing point', () => {
    const hit = segmentSegmentIntersection([0, 0], [2, 2], [0, 2], [2, 0])
    expect(hit).not.toBeNull()
    expect(hit!.point[0]).toBeCloseTo(1, 5)
    expect(hit!.point[1]).toBeCloseTo(1, 5)
    expect(hit!.t).toBeCloseTo(0.5, 5)
  })

  test('parallel segments do not intersect', () => {
    expect(segmentSegmentIntersection([0, 0], [2, 0], [0, 1], [2, 1])).toBeNull()
  })

  test('wallBarrierRect builds the plan footprint rectangle', () => {
    const polygon = wallBarrierRect({
      start: [0, 0],
      end: [4, 0],
      thickness: 0.2,
    })
    expect(polygon).toEqual([
      [0, 0.1],
      [0, -0.1],
      [4, -0.1],
      [4, 0.1],
    ])
  })

  test('segmentPolygonCrossing detects a pass through the wall', () => {
    const wall = wallBarrierRect({ start: [0, 0], end: [4, 0], thickness: 0.2 })
    const crossing = segmentPolygonCrossing([2, -0.5], [2, 0.5], wall)
    expect(crossing.crosses).toBe(true)
    // the run enters the wall rectangle at its bottom edge (first polygon
    // edge crossed), at x=2
    expect(crossing.at![0]).toBeCloseTo(2, 5)
    expect(crossing.at![1]).toBeCloseTo(-0.1, 5)
    expect(crossing.t).toBeCloseTo(0.4, 5)

    const clear = segmentPolygonCrossing([5, -0.5], [5, 0.5], wall)
    expect(clear.crosses).toBe(false)
  })
})

describe('penetration rules', () => {
  const leg = { from: [2, -0.5], to: [2, 0.5], shape: 'round', sizeMm: 200 } as const
  const wall = wallBarrierRect({ start: [0, 0], end: [4, 0], thickness: 0.2 })

  test('checkWallPenetration demands a sleeve with non-combustible seal', () => {
    const requirement = checkWallPenetration(leg, wall)
    expect(requirement).not.toBeNull()
    expect(requirement!.kind).toBe('wall-sleeve')
    expect(requirement!.seal).toBe('non-combustible')
    expect(requirement!.at[0]).toBeCloseTo(2, 5)
  })

  test('checkFireBarrierCrossing demands a fire damper', () => {
    const requirement = checkFireBarrierCrossing(leg, wall)
    expect(requirement).not.toBeNull()
    expect(requirement!.kind).toBe('fire-damper')
    expect(requirement!.standard).toBe('sp-7.13130')
    expect(requirement!.at[0]).toBeCloseTo(2, 5)
  })

  test('a run clear of the wall passes both checks', () => {
    const clearLeg = { from: [6, -0.5], to: [6, 0.5], shape: 'rect', sizeMm: 300 } as const
    expect(checkWallPenetration(clearLeg, wall)).toBeNull()
    expect(checkFireBarrierCrossing(clearLeg, wall)).toBeNull()
  })
})
