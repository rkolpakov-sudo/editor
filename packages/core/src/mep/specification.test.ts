import { describe, expect, test } from 'bun:test'
import type { AnyNode, AnyNodeId } from '../schema'
import { DuctFittingNode, DuctSegmentNode, DuctTerminalNode, WallNode } from '../schema'
import { buildDuctSpecification, specificationToCsv, specificationToText } from './specification'

type Point = [number, number, number]

function segment(
  path: Point[],
  opts: {
    id: string
    system?: 'supply' | 'exhaust' | 'return'
    shape?: 'round' | 'rect' | 'oval'
    diameter?: number
    width?: number
    height?: number
  },
): DuctSegmentNode {
  return DuctSegmentNode.parse({
    id: opts.id as AnyNodeId,
    path,
    system: opts.system ?? 'supply',
    shape: opts.shape ?? 'round',
    diameter: opts.diameter ?? 160,
    width: opts.width ?? 400,
    height: opts.height ?? 200,
  })
}

function fitting(opts: {
  id: string
  fittingType: DuctFittingNode['fittingType']
  system?: 'supply' | 'exhaust' | 'return'
  shape?: 'round' | 'rect' | 'oval'
  shape2?: 'round' | 'rect' | 'oval'
  diameter?: number
  diameter2?: number
  width?: number
  height?: number
  angle?: number
  offset?: number
  offsetRadiusFactor?: number
}): DuctFittingNode {
  return DuctFittingNode.parse({
    id: opts.id as AnyNodeId,
    position: [1, 2, 0],
    fittingType: opts.fittingType,
    system: opts.system ?? 'supply',
    shape: opts.shape ?? 'round',
    shape2: opts.shape2 ?? 'rect',
    diameter: opts.diameter ?? 200,
    diameter2: opts.diameter2 ?? 160,
    width: opts.width ?? 400,
    height: opts.height ?? 200,
    angle: opts.angle ?? 90,
    offset: opts.offset ?? 100,
    offsetRadiusFactor: opts.offsetRadiusFactor ?? 1.5,
  })
}

function terminal(id: string, terminalType: DuctTerminalNode['terminalType']): DuctTerminalNode {
  return DuctTerminalNode.parse({ id: id as AnyNodeId, terminalType })
}

function sceneOf(...nodes: AnyNode[]): Record<AnyNodeId, AnyNode> {
  return Object.fromEntries(nodes.map((n) => [n.id, n])) as Record<AnyNodeId, AnyNode>
}

describe('buildDuctSpecification', () => {
  test('groups round segments by system and size, sums lengths', () => {
    const scene = sceneOf(
      segment(
        [
          [0, 2, 0],
          [2.5, 2, 0],
        ],
        { id: 'duct-segment_s1', system: 'supply' },
      ),
      segment(
        [
          [0, 2, 5],
          [4, 2, 5],
        ],
        { id: 'duct-segment_s2', system: 'supply', diameter: 200 },
      ),
      segment(
        [
          [0, 2, 10],
          [1.0, 2, 10],
        ],
        { id: 'duct-segment_e1', system: 'exhaust' },
      ),
    )
    const spec = buildDuctSpecification(scene)

    const ductRows = spec.sections.ducts
    // 3 segment groups (без строк креплений): П Ø160 (2.5 м), П Ø200 (4 м), В Ø160 (1 м).
    const airRows = ductRows.filter((r) => r.unit === 'м')
    expect(airRows).toHaveLength(3)
    const supply160 = airRows.find(
      (r) => r.name === 'Воздуховод круглый Ø160' && r.system === 'supply',
    )
    expect(supply160).not.toBeUndefined()
    expect(supply160!.quantity).toBeCloseTo(2.5, 5)
    expect(supply160!.note).toContain('2,5 м × 1')
    expect(supply160!.lengthM).toBeCloseTo(2.5, 5)

    const exhaust160 = airRows.find((r) => r.system === 'exhaust')
    expect(exhaust160!.quantity).toBeCloseTo(1.0, 5)

    expect(spec.totals.lengthM).toBeCloseTo(7.5, 5)
  })

  test('decomposes a long run into ГОСТ pieces and flags custom lengths', () => {
    const scene = sceneOf(
      segment(
        [
          [0, 2, 0],
          [3.5, 2, 0],
        ],
        { id: 'duct-segment_s1' },
      ), // 2.5 + 1.0
      segment(
        [
          [0, 2, 5],
          [3.7, 2, 5],
        ],
        { id: 'duct-segment_s2' },
      ), // нестандарт
    )
    const spec = buildDuctSpecification(scene)
    const supply160 = spec.sections.ducts[0]!
    expect(supply160.note).toContain('2,5 м × 1')
    expect(supply160.note).toContain('1,0 м × 1')
    expect(spec.warnings.some((w) => w.includes('нестандартной длины'))).toBe(true)
  })

  test('rect segments carry W×H labels and supports', () => {
    const scene = sceneOf(
      segment(
        [
          [0, 2, 0],
          [6, 2, 0],
        ],
        {
          id: 'duct-segment_r1',
          shape: 'rect',
          width: 400,
          height: 200,
        },
      ),
    )
    const spec = buildDuctSpecification(scene)
    const rect = spec.sections.ducts.find((r) => r.name.includes('400×200'))
    expect(rect).not.toBeUndefined()
    // Supports on a 6 m rect run: spacing 3 м → floor(6/3) + 1 = 3.
    const bracket = spec.sections.ducts.find((r) => r.name.includes('Кронштейн'))
    expect(bracket!.quantity).toBe(3)
    expect(bracket!.note).toContain('3 м')
  })

  test('counts fittings by type, angle and size', () => {
    const scene = sceneOf(
      fitting({ id: 'duct-fitting_f1', fittingType: 'elbow', angle: 90, diameter: 200 }),
      fitting({ id: 'duct-fitting_f2', fittingType: 'elbow', angle: 90, diameter: 200 }),
      fitting({ id: 'duct-fitting_f3', fittingType: 'elbow', angle: 45, diameter: 200 }),
      fitting({
        id: 'duct-fitting_f4',
        fittingType: 'offset',
        angle: 45,
        diameter: 200,
        offset: 100,
      }),
      fitting({
        id: 'duct-fitting_f5',
        fittingType: 'tee',
        diameter: 315,
        diameter2: 160,
        shape2: 'round',
      }),
      fitting({
        id: 'duct-fitting_f6',
        fittingType: 'reducer',
        diameter: 250,
        diameter2: 160,
        shape2: 'round',
      }),
    )
    const spec = buildDuctSpecification(scene)
    const elbows90 = spec.sections.fittings.find((r) => r.name === 'Отвод 90° Ø200 R=1.5D')
    expect(elbows90!.quantity).toBe(2)
    const elbows45 = spec.sections.fittings.find((r) => r.name === 'Отвод 45° Ø200 R=1.5D')
    expect(elbows45!.quantity).toBe(1)
    const offset = spec.sections.fittings.find((r) => r.name.includes('Утка 45°'))
    expect(offset!.quantity).toBe(1)
    const tee = spec.sections.fittings.find((r) => r.name.includes('Тройник Ø315'))
    expect(tee!.name).toContain('ответвление Ø160')
    const reducer = spec.sections.fittings.find((r) => r.name.includes('Переход'))
    expect(reducer!.name).toBe('Переход Ø250 → Ø160')
    expect(spec.totals.fittings).toBe(6)
  })

  test('counts terminals', () => {
    const scene = sceneOf(
      terminal('duct-terminal_t1', 'supply-register'),
      terminal('duct-terminal_t2', 'diffuser'),
      terminal('duct-terminal_t3', 'return-grille'),
    )
    const spec = buildDuctSpecification(scene)
    const names = spec.sections.terminals.map((r) => r.name)
    expect(names).toContain('Решётка приточная')
    expect(names).toContain('Диффузор потолочный')
    expect(names).toContain('Решётка вытяжная')
    expect(spec.totals.terminals).toBe(3)
  })

  test('counts wall sleeves and fire dampers from walls', () => {
    // Supply duct along X at z = 0 crossing two walls; one wall is fire-rated.
    const scene = sceneOf(
      segment(
        [
          [-3, 2.6, 0],
          [3, 2.6, 0],
        ],
        { id: 'duct-segment_s1', diameter: 400 },
      ),
    )
    const wallA = WallNode.parse({
      id: 'wall_a' as AnyNodeId,
      start: [0, -1],
      end: [0, 1],
      thickness: 0.1,
    })
    const wallB = WallNode.parse({
      id: 'wall_b' as AnyNodeId,
      start: [1.5, -1],
      end: [1.5, 1],
      thickness: 0.1,
    })
    const spec = buildDuctSpecification(scene, {
      walls: [wallA, wallB],
      fireRatedBarriers: [wallA],
    })
    expect(spec.totals.sleeves).toBe(2)
    expect(spec.totals.fireDampers).toBe(1)
    const hardwareNames = spec.sections.hardware.map((r) => r.name)
    expect(hardwareNames).toContain('Гильза (проход через стену)')
    expect(hardwareNames).toContain('Клапан противопожарный')
  })

  test('per-system summary rows with ГОСТ markings', () => {
    const scene = sceneOf(
      segment(
        [
          [0, 2, 0],
          [2.5, 2, 0],
        ],
        { id: 'duct-segment_s1', system: 'supply' },
      ),
      segment(
        [
          [0, 2, 5],
          [1, 2, 5],
        ],
        { id: 'duct-segment_e1', system: 'exhaust' },
      ),
    )
    const spec = buildDuctSpecification(scene)
    expect(spec.systems).toHaveLength(2)
    const supply = spec.systems.find((row) => row.system === 'supply')!
    expect(supply.marking).toBe('П1')
    expect(supply.lengthM).toBeCloseTo(2.5, 5)
    const exhaust = spec.systems.find((row) => row.system === 'exhaust')!
    expect(exhaust.marking).toBe('В1')
    expect(spec.totals.massKg).toBeGreaterThan(0)
  })

  test('empty scene yields empty spec without warnings', () => {
    const spec = buildDuctSpecification({})
    expect(spec.sections.ducts).toHaveLength(0)
    expect(spec.sections.fittings).toHaveLength(0)
    expect(spec.systems).toHaveLength(0)
    expect(spec.totals.lengthM).toBe(0)
    expect(spec.warnings).toHaveLength(0)
  })
})

describe('specificationToCsv', () => {
  test('emits header, sections and totals with system column', () => {
    const scene = sceneOf(
      segment(
        [
          [0, 2, 0],
          [2.5, 2, 0],
        ],
        { id: 'duct-segment_s1', system: 'supply' },
      ),
      fitting({ id: 'duct-fitting_f1', fittingType: 'elbow', angle: 90, diameter: 200 }),
    )
    const csv = specificationToCsv(buildDuctSpecification(scene))
    const lines = csv.trim().split('\n')
    expect(lines[0]!).toContain('Позиция')
    expect(lines[0]!).toContain('Система')
    expect(csv).toContain('[Воздуховоды]')
    expect(csv).toContain('[Итого]')
    expect(csv).toContain('П1')
  })

  test('does not contain raw semicolons inside quoted cells', () => {
    const scene = sceneOf(
      segment(
        [
          [0, 2, 0],
          [3.5, 2, 0],
        ],
        { id: 'duct-segment_s1' },
      ),
    )
    const csv = specificationToCsv(buildDuctSpecification(scene))
    // Every line must have exactly 8 columns when split on top-level ';'.
    for (const line of csv.trim().split('\n')) {
      if (line.startsWith('[') || line.startsWith(';')) continue
      const outsideQuotes = line.split(';').filter((_, i, arr) => {
        // crude balance check: count quotes per cell
        const cell = line.split(';')[i]!
        return !cell.includes('"')
      })
      void outsideQuotes
      expect(line.split(';')).toHaveLength(8)
    }
  })
})

describe('specificationToText', () => {
  test('renders systems and section rows', () => {
    const scene = sceneOf(
      segment(
        [
          [0, 2, 0],
          [2.5, 2, 0],
        ],
        { id: 'duct-segment_s1', system: 'supply' },
      ),
    )
    const text = specificationToText(buildDuctSpecification(scene))
    expect(text).toContain('П1')
    expect(text).toContain('Воздуховод круглый Ø160')
  })
})
