import { describe, expect, test } from 'bun:test'
import type { DuctSketchNode } from '@pascal-app/core'
import {
  appendSketchPoint,
  finalizeSketchRun,
  planSketchCommit,
  SKETCH_POINT_MERGE_EPS,
} from './sketch-draft'

const P = (x: number, z: number): [number, number, number] => [x, 0, z]

describe('appendSketchPoint', () => {
  test('appends points beyond the merge epsilon', () => {
    const points = appendSketchPoint([P(0, 0)], P(3, 0))
    expect(points).toEqual([P(0, 0), P(3, 0)])
  })

  test('collapses a consecutive point within the epsilon', () => {
    const near = SKETCH_POINT_MERGE_EPS / 2
    const points = appendSketchPoint([P(0, 0)], P(near, 0))
    expect(points).toEqual([P(0, 0)])
  })

  test('a duplicate click never grows the draft', () => {
    let points: Array<[number, number, number]> = [P(1, 1)]
    for (let i = 0; i < 5; i++) points = appendSketchPoint(points, P(1, 1))
    expect(points).toHaveLength(1)
  })
})

describe('finalizeSketchRun', () => {
  test('builds a run with auto elevation from plan points', () => {
    const run = finalizeSketchRun('exhaust', [P(0, 0), P(4, 0), P(4, 6)])
    expect(run).toEqual({
      system: 'exhaust',
      points: [
        { x: 0, z: 0, elev: 'auto' },
        { x: 4, z: 0, elev: 'auto' },
        { x: 4, z: 6, elev: 'auto' },
      ],
    })
  })

  test('null when fewer than two vertices (single anchor click)', () => {
    expect(finalizeSketchRun('supply', [])).toBeNull()
    expect(finalizeSketchRun('supply', [P(2, 2)])).toBeNull()
  })
})

describe('planSketchCommit', () => {
  const run = finalizeSketchRun('supply', [P(0, 0), P(3, 0)])!

  test('mints a sketch node under the level when none exists', () => {
    const plan = planSketchCommit({}, 'level_1', run)
    expect(plan.update).toBeNull()
    if (!plan.create) throw new Error('expected create')
    expect(plan.create.parentId).toBe('level_1')
    expect(plan.create.node.type).toBe('duct-sketch')
    expect(plan.create.node.id.startsWith('duct-sketch_')).toBe(true)
    expect(plan.create.node.runs).toEqual([run])
  })

  test('appends to the existing level sketch in one update', () => {
    const first = planSketchCommit({}, 'level_1', run)
    if (!first.create) throw new Error('expected create')
    const node = { ...first.create.node, parentId: 'level_1' }
    const nextRun = finalizeSketchRun('exhaust', [P(0, 2), P(3, 2)])!
    const plan = planSketchCommit({ [node.id]: node }, 'level_1', nextRun)
    expect(plan.create).toBeNull()
    expect(plan.update?.id).toBe(node.id)
    expect(plan.update?.data.runs).toEqual([run, nextRun])
  })

  test('sketch nodes of OTHER levels are left alone', () => {
    const otherLevel = { ...({ type: 'duct-sketch', parentId: 'level_2', runs: [] } as object) }
    const plan = planSketchCommit(
      { sk_other: otherLevel as unknown as DuctSketchNode },
      'level_1',
      run,
    )
    expect(plan.update).toBeNull()
    expect(plan.create?.parentId).toBe('level_1')
  })
})
