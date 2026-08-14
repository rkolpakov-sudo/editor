import type { AnyNodeDefinition, DistributionRole, NodePort } from '../registry'
import { nodeRegistry, registerNode } from '../registry'
import type { AnyNode, AnyNodeId } from '../schema'
import { computeBypassGeometry } from './bypass'

/**
 * Тест-стабы duct-видов для Этапа 8 — зеркалят конвенции портов настоящих
 * видов (segments по path, tee с inlet/outlet/branch, терминал одним collar,
 * оборудование двумя портами) без импорта packages/nodes (core не должен
 * зависеть от nodes). Регистрация идемпотентна: повторный вызов не бросает.
 */

type Point = [number, number, number]

const FITTING_LEG = 1

function stubDef(
  kind: string,
  distributionRole: DistributionRole,
  ports: (node: AnyNode) => NodePort[],
): void {
  // Идемпотентность по фактическому реестру, а не по глобальному маркеру:
  // в параллельном прогоне в одном воркере могут делить реестр несколько
  // файлов (direct registerNode в duct-network.test.ts / gost-segmentation.test.ts),
  // и повторная регистрация в production-режиме бросает duplicate-kind.
  if (nodeRegistry.has(kind)) return
  registerNode({
    kind,
    schemaVersion: 1,
    schema: {},
    category: 'utility',
    distributionRole,
    defaults: () => ({}),
    capabilities: {},
    ports,
  } as unknown as AnyNodeDefinition)
}

function offset(base: Point, dx: number, dz: number, yaw: number): [number, number, number] {
  const cx = dx * Math.cos(yaw) + dz * Math.sin(yaw)
  const cz = -dx * Math.sin(yaw) + dz * Math.cos(yaw)
  return [base[0] + cx, base[1], base[2] + cz]
}

/** Регистрировать стабы один раз на процесс (bun изолирует файлы тестов). */
export function registerDuctNetworkStubs(): void {
  stubDef('duct-segment', 'run', (node) => {
    const path = (node as unknown as { path: Point[] }).path
    const system = (node as unknown as { system: string }).system
    return [
      { id: 'start', position: path[0]!, direction: [-1, 0, 0], diameter: 6, system },
      {
        id: 'end',
        position: path[path.length - 1]!,
        direction: [1, 0, 0],
        diameter: 6,
        system,
      },
    ]
  })

  stubDef('duct-fitting', 'fitting', (node) => {
    const position = (node as unknown as { position: Point }).position
    const rotation = (node as unknown as { rotation: number[] }).rotation ?? [0, 0, 0]
    const yaw = rotation[1] ?? 0
    const fittingType = (node as unknown as { fittingType: string }).fittingType
    const system = (node as unknown as { system: string }).system ?? 'supply'
    const leg = FITTING_LEG
    if (fittingType === 'tee') {
      return [
        {
          id: 'inlet',
          position: offset(position, -leg, 0, yaw),
          direction: [-1, 0, 0],
          diameter: 6,
          system,
        },
        {
          id: 'outlet',
          position: offset(position, leg, 0, yaw),
          direction: [1, 0, 0],
          diameter: 6,
          system,
        },
        {
          id: 'branch',
          position: offset(position, 0, leg, yaw),
          direction: [0, 0, 1],
          diameter: 6,
          system,
        },
      ]
    }
    if (fittingType === 'cross') {
      return [
        {
          id: 'inlet',
          position: offset(position, -leg, 0, yaw),
          direction: [-1, 0, 0],
          diameter: 6,
          system,
        },
        {
          id: 'outlet',
          position: offset(position, leg, 0, yaw),
          direction: [1, 0, 0],
          diameter: 6,
          system,
        },
        {
          id: 'branch',
          position: offset(position, 0, leg, yaw),
          direction: [0, 0, 1],
          diameter: 6,
          system,
        },
        {
          id: 'branch2',
          position: offset(position, 0, -leg, yaw),
          direction: [0, 0, -1],
          diameter: 6,
          system,
        },
      ]
    }
    if (fittingType === 'elbow') {
      return [
        {
          id: 'inlet',
          position: offset(position, -leg, 0, yaw),
          direction: [-1, 0, 0],
          diameter: 6,
          system,
        },
        {
          id: 'outlet',
          position: offset(position, 0, leg, yaw),
          direction: [0, 0, 1],
          diameter: 6,
          system,
        },
      ]
    }
    if (fittingType === 'offset') {
      // Утка (S) — коллары на оси в ±полу-пролёте от центра, зеркалит
      // настоящий def.ports (`computeBypassGeometry` из bypass).
      const offsetMm = (node as unknown as { offset: number }).offset ?? 100
      const angle = (node as unknown as { angle: number }).angle ?? 45
      const radiusFactor =
        (node as unknown as { offsetRadiusFactor: number }).offsetRadiusFactor ?? 1.5
      const diameter = (node as unknown as { diameter: number }).diameter ?? 160
      const geometry = computeBypassGeometry(offsetMm, angle, radiusFactor, diameter)
      const half = geometry ? geometry.halfSpanM : leg
      return [
        {
          id: 'inlet',
          position: offset(position, -half, 0, yaw),
          direction: [-1, 0, 0],
          diameter: 6,
          system,
        },
        {
          id: 'outlet',
          position: offset(position, half, 0, yaw),
          direction: [1, 0, 0],
          diameter: 6,
          system,
        },
      ]
    }
    return [
      {
        id: 'inlet',
        position: offset(position, -leg, 0, yaw),
        direction: [-1, 0, 0],
        diameter: 6,
        system,
      },
      {
        id: 'outlet',
        position: offset(position, leg, 0, yaw),
        direction: [1, 0, 0],
        diameter: 6,
        system,
      },
    ]
  })

  stubDef('duct-terminal', 'terminal', (node) => {
    const position = (node as unknown as { position: Point }).position
    const terminalType = (node as unknown as { terminalType: string }).terminalType
    return [
      {
        id: 'collar',
        position,
        direction: [0, -1, 0],
        diameter: 6,
        system: terminalType === 'return-grille' ? 'return' : 'supply',
      },
    ]
  })

  stubDef('hvac-equipment', 'equipment', (node) => {
    const position = (node as unknown as { position: Point }).position
    return [
      { id: 'supply', position, direction: [0, 1, 0], diameter: 12, system: 'supply' },
      {
        id: 'return',
        position: offset(position, 0.5, 0, 0),
        direction: [0, -1, 0],
        diameter: 12,
        system: 'return',
      },
    ]
  })
}

let nextId = 0

export function makeNode(type: string, fields: Record<string, unknown>): AnyNode {
  nextId += 1
  return { id: `${type}_${nextId}`, type, object: 'node', parentId: null, ...fields } as AnyNode
}

export function ductSegment(
  path: Point[],
  system: 'supply' | 'exhaust' | 'return',
  fields: Record<string, unknown> = {},
): AnyNode {
  return makeNode('duct-segment', { path, system, shape: 'round', diameter: 160, ...fields })
}

export function ductTee(position: Point, fields: Record<string, unknown> = {}): AnyNode {
  return makeNode('duct-fitting', {
    position,
    rotation: [0, 0, 0],
    fittingType: 'tee',
    shape: 'round',
    diameter: 160,
    shape2: 'round',
    diameter2: 100,
    angle: 90,
    system: 'supply',
    ...fields,
  })
}

export function ductElbow(position: Point, fields: Record<string, unknown> = {}): AnyNode {
  return makeNode('duct-fitting', {
    position,
    rotation: [0, 0, 0],
    fittingType: 'elbow',
    shape: 'round',
    diameter: 160,
    angle: 90,
    offsetRadiusFactor: 1.5,
    system: 'supply',
    ...fields,
  })
}

export function ductTerminal(
  position: Point,
  terminalType: 'supply-register' | 'diffuser' | 'return-grille' = 'supply-register',
): AnyNode {
  return makeNode('duct-terminal', { position, terminalType, mount: 'floor' })
}

export function hvacUnit(position: Point): AnyNode {
  return makeNode('hvac-equipment', { position, equipmentType: 'furnace' })
}

export function sceneOf(...nodes: AnyNode[]): Record<AnyNodeId, AnyNode> {
  return Object.fromEntries(nodes.map((node) => [node.id, node])) as Record<AnyNodeId, AnyNode>
}

/**
 * Сцена Этапа 8: установка → магистраль → тройник1 → магистраль → тройник2 →
 * тупик, и два ответвления к терминалам:
 *   equip(0,0,0) → seg1[0→2] → tee1(3,0,0) → seg2[4→6] → tee2(7,0,0) → seg3[8→9]
 *                     └─ branch1[3,1→3,2] → term1(3,0,2)
 *                                            └─ branch2[7,1→7,2] → term2(7,0,2)
 * Расходы: term1 = 30, term2 = 60 → seg1 = 90, seg2 = 60, branch1 = 30,
 * branch2 = 60, seg3 = 0.
 */
export function twoBranchSupplyScene(): {
  nodes: Record<AnyNodeId, AnyNode>
  equipment: AnyNode
  seg1: AnyNode
  seg2: AnyNode
  seg3: AnyNode
  branch1: AnyNode
  branch2: AnyNode
  term1: AnyNode
  term2: AnyNode
} {
  const equipment = hvacUnit([0, 0, 0])
  const seg1 = ductSegment(
    [
      [0, 0, 0],
      [2, 0, 0],
    ],
    'supply',
  )
  const tee1 = ductTee([3, 0, 0])
  const seg2 = ductSegment(
    [
      [4, 0, 0],
      [6, 0, 0],
    ],
    'supply',
  )
  const tee2 = ductTee([7, 0, 0])
  const seg3 = ductSegment(
    [
      [8, 0, 0],
      [9, 0, 0],
    ],
    'supply',
  )
  const branch1 = ductSegment(
    [
      [3, 0, 1],
      [3, 0, 2],
    ],
    'supply',
  )
  const branch2 = ductSegment(
    [
      [7, 0, 1],
      [7, 0, 2],
    ],
    'supply',
  )
  const term1 = ductTerminal([3, 0, 2], 'diffuser')
  const term2 = ductTerminal([7, 0, 2], 'diffuser')
  return {
    nodes: sceneOf(equipment, seg1, tee1, seg2, tee2, seg3, branch1, branch2, term1, term2),
    equipment,
    seg1,
    seg2,
    seg3,
    branch1,
    branch2,
    term1,
    term2,
  }
}
