import { describe, expect, test } from 'bun:test'
import type { AnyNodeId } from '../schema'
import { DuctTerminalNode, ZoneNode } from '../schema'
import {
  assignZoneAirflowsToTerminals,
  computeZoneAirflows,
  polygonAreaM2,
  terminalDirection,
  terminalFlowMap,
  zoneCentroid,
} from './air-exchange'

function zone(
  id: string,
  name: string,
  polygon: Array<[number, number]>,
  category: string = 'public',
  role: 'room' | 'generic' = 'room',
) {
  return ZoneNode.parse({
    id: id as AnyNodeId,
    name,
    polygon,
    spaceRole: role,
    spaceCategory: category,
  })
}

function terminalNode(
  id: string,
  position: [number, number, number],
  terminalType: 'supply-register' | 'diffuser' | 'return-grille',
): DuctTerminalNode {
  return DuctTerminalNode.parse({
    id: id as AnyNodeId,
    position,
    terminalType,
    mount: 'floor',
  })
}

describe('polygonAreaM2 / zoneCentroid', () => {
  test('площадь прямоугольника 6×4 = 24 м²', () => {
    expect(
      polygonAreaM2([
        [0, 0],
        [6, 0],
        [6, 4],
        [0, 4],
      ]),
    ).toBe(24)
  })

  test('центроид прямоугольника — его середина', () => {
    const [x, z] = zoneCentroid([
      [0, 0],
      [6, 0],
      [6, 4],
      [0, 4],
    ])
    expect(x).toBe(3)
    expect(z).toBe(2)
  })
})

describe('computeZoneAirflows — нормы СП 54', () => {
  test('кухня с газом: 90 м³/ч вытяжки', () => {
    const kitchen = zone(
      'zone_kitchen',
      'Кухня',
      [
        [0, 0],
        [6, 0],
        [6, 4],
        [0, 4],
      ],
      'kitchen_gas',
    )
    const [airflow] = computeZoneAirflows([kitchen])
    expect(airflow!.requiredFlowM3h).toBe(90)
    expect(airflow!.direction).toBe('exhaust')
    expect(airflow!.areaM2).toBe(24)
  })

  test('жилая комната: 3 м³/ч·м² притока', () => {
    const living = zone(
      'zone_living',
      'Гостиная',
      [
        [0, 0],
        [10, 0],
        [10, 5],
        [0, 5],
      ],
      'living',
    )
    const [airflow] = computeZoneAirflows([living])
    expect(airflow!.direction).toBe('supply')
    expect(airflow!.requiredFlowM3h).toBe(150)
  })

  test('public/industrial (по заданию) — расход не вычисляется', () => {
    const publicZone = zone(
      'zone_pub',
      'Зал',
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
      'public',
    )
    const [airflow] = computeZoneAirflows([publicZone])
    expect(airflow!.requiredFlowM3h).toBeNull()
  })

  test('generic-зоны не участвуют в вентиляции', () => {
    const genericZone = zone(
      'zone_lawn',
      'Газон',
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
      'living',
      'generic',
    )
    expect(computeZoneAirflows([genericZone])).toHaveLength(0)
  })
})

describe('assignZoneAirflowsToTerminals — ближайший совместимый терминал', () => {
  test('кухня назначается в ближайшую вытяжную решётку, а не в приточный диффузор', () => {
    const kitchen = zone(
      'zone_kitchen',
      'Кухня',
      [
        [0, 0],
        [6, 0],
        [6, 4],
        [0, 4],
      ],
      'kitchen_gas',
    )
    const diffuser = terminalNode('duct-terminal_diffuser', [10, 0, 10], 'diffuser')
    const grille = terminalNode('duct-terminal_grille', [1, 0, 1], 'return-grille')
    const nodes = { [diffuser.id]: diffuser, [grille.id]: grille }

    const assignments = assignZoneAirflowsToTerminals(nodes, [kitchen])
    expect(assignments).toHaveLength(1)
    const assignment = assignments[0]!
    expect(assignment.terminalId).toBe('duct-terminal_grille')
    expect(assignment.flowM3h).toBe(90)
    // Расстояние от центроида (3, 2) до (1, 1).
    expect(assignment.distanceM).toBeCloseTo(Math.hypot(2, 1), 9)
  })

  test('несколько зон на один терминал складываются в terminalFlowMap', () => {
    const bath = zone(
      'zone_bath',
      'Ванная',
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
      ],
      'bath',
    )
    const toilet = zone(
      'zone_toilet',
      'Туалет',
      [
        [2, 0],
        [4, 0],
        [4, 2],
        [2, 2],
      ],
      'toilet',
    )
    const grille = terminalNode('duct-terminal_shared', [2, 0, 1], 'return-grille')
    const assignments = assignZoneAirflowsToTerminals({ [grille.id]: grille }, [bath, toilet])
    expect(assignments).toHaveLength(2)
    const map = terminalFlowMap(assignments)
    expect(map['duct-terminal_shared']).toBe(25 + 25)
  })

  test('нет совместимого терминала — зона не назначена', () => {
    const kitchen = zone(
      'zone_kitchen',
      'Кухня',
      [
        [0, 0],
        [6, 0],
        [6, 4],
        [0, 4],
      ],
      'kitchen_gas',
    )
    const diffuser = terminalNode('duct-terminal_diffuser', [1, 0, 1], 'diffuser')
    expect(assignZoneAirflowsToTerminals({ [diffuser.id]: diffuser }, [kitchen])).toHaveLength(0)
  })

  test('terminalDirection различает приток и вытяжку', () => {
    expect(terminalDirection(terminalNode('duct-terminal_a', [0, 0, 0], 'diffuser'))).toBe('supply')
    expect(terminalDirection(terminalNode('duct-terminal_b', [0, 0, 0], 'return-grille'))).toBe(
      'return',
    )
  })
})
