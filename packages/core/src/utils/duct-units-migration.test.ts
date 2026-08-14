import { describe, expect, test } from 'bun:test'
import { migrateDuctUnitsToMm } from './duct-units-migration'

function roundNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'duct-segment_round',
    object: 'node',
    parentId: null,
    visible: true,
    metadata: {},
    type: 'duct-segment',
    name: 'Round run',
    path: [
      [0, 0, 0],
      [3, 0, 0],
    ],
    shape: 'round',
    diameter: 6,
    ductMaterial: 'sheet-metal',
    insulationR: 0,
    system: 'supply',
    ...overrides,
  }
}

describe('migrateDuctUnitsToMm', () => {
  test('converts round/rect duct-segment dimensions with exact ×25.4', () => {
    const nodes = {
      seg_round: roundNode(),
      seg_rect: roundNode({
        id: 'duct-segment_rect',
        shape: 'rect',
        diameter: 11.94,
        width: 14,
        height: 8,
      }),
    }

    const result = migrateDuctUnitsToMm(nodes)

    expect(result.changed).toBe(true)
    const round = result.nodes.seg_round as Record<string, unknown>
    expect(round.diameter).toBe(152.4)
    const rect = result.nodes.seg_rect as Record<string, unknown>
    expect(rect.width).toBe(355.6)
    expect(rect.height).toBe(203.2)
    expect(rect.diameter).toBeCloseTo(11.94 * 25.4, 1)
  })

  test('converts duct-fitting dimensions including the reducer/tee second legs', () => {
    const fitting = {
      id: 'duct-fitting_tee',
      object: 'node',
      parentId: null,
      visible: true,
      metadata: {},
      type: 'duct-fitting',
      name: 'Tee',
      fittingType: 'tee',
      shape: 'rect',
      width: 12,
      height: 6,
      width2: 8,
      height2: 4,
      diameter: 9.55,
      diameter2: 6.37,
      ductMaterial: 'sheet-metal',
      system: 'supply',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      angle: 90,
    }

    const result = migrateDuctUnitsToMm({ fitting })

    const migrated = result.nodes.fitting as Record<string, unknown>
    expect(migrated.width).toBe(304.8)
    expect(migrated.height).toBe(152.4)
    expect(migrated.width2).toBe(203.2)
    expect(migrated.height2).toBe(101.6)
    expect(migrated.diameter).toBeCloseTo(9.55 * 25.4, 1)
    expect(migrated.diameter2).toBeCloseTo(6.37 * 25.4, 1)
    expect(migrated.metadata).toMatchObject({ migratedFromInches: true })
  })

  test('rounds to 0.1 mm (6" → 152.4, 14" → 355.6)', () => {
    const result = migrateDuctUnitsToMm({
      seg: roundNode({ diameter: 6 }),
      rect: roundNode({ id: 'rect', shape: 'rect', diameter: 11.94, width: 14, height: 8 }),
    })
    expect(result.nodes.seg.diameter).toBe(152.4)
    expect(result.nodes.rect.width).toBe(355.6)
  })

  test('idempotent: migrated nodes with the marker are never touched again', () => {
    // A migrated 2" round duct is 50.8mm — still < 100, so only the marker
    // prevents a second, destructive pass.
    const already = roundNode({
      diameter: 50.8,
      metadata: { migratedFromInches: true },
    })

    const result = migrateDuctUnitsToMm({ seg: already })

    expect(result.changed).toBe(false)
    expect(result.nodes.seg).toBe(already)
  })

  test('round trips exactly: running twice changes nothing', () => {
    const first = migrateDuctUnitsToMm({ seg: roundNode() })
    expect(first.changed).toBe(true)

    const second = migrateDuctUnitsToMm(first.nodes)
    expect(second.changed).toBe(false)
    expect(second.nodes.seg.diameter).toBe(152.4)
    expect(second.nodes.seg.metadata).toMatchObject({ migratedFromInches: true })
  })

  test('ignores non-duct nodes and already-mm nodes', () => {
    const nodes = {
      pipe: {
        id: 'pipe',
        object: 'node',
        parentId: null,
        visible: true,
        metadata: {},
        type: 'pipe-segment',
        name: 'Drain',
        path: [
          [0, 0, 0],
          [3, 0, 0],
        ],
        diameter: 2,
        system: 'waste',
      },
      seg_mm: roundNode({ diameter: 200 }),
    }

    const result = migrateDuctUnitsToMm(nodes)

    expect(result.changed).toBe(false)
    expect(result.nodes.pipe.diameter).toBe(2)
    expect(result.nodes.seg_mm.diameter).toBe(200)
  })
})
