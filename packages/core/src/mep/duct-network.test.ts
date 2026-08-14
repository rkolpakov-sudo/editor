import { describe, expect, test } from 'bun:test'
import type { AnyNodeDefinition, DistributionRole, NodePort } from '../registry'
import { nodeRegistry, registerNode } from '../registry'
import type { AnyNode, AnyNodeId } from '../schema'
import { buildDuctNetworks, ductNetworkFor, validateDuctNetwork } from './duct-network'

type Point = [number, number, number]

// Stub registrations mirror the real duct kinds' port conventions so the
// network analysis runs without importing the nodes package. Idempotent on
// the actual registry — parallel workers may share it with
// `registerDuctNetworkStubs` (see duct-network-stubs.ts).
function stubDef(
  kind: string,
  distributionRole: DistributionRole,
  ports: (node: AnyNode) => NodePort[],
): void {
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
  const system = (node as unknown as { system: string }).system
  return [
    { id: 'inlet', position, direction: [-1, 0, 0], diameter: 6, system },
    { id: 'outlet', position, direction: [1, 0, 0], diameter: 6, system },
  ]
})
stubDef('duct-terminal', 'terminal', (node) => {
  const position = (node as unknown as { position: Point }).position
  return [{ id: 'collar', position, direction: [0, -1, 0], diameter: 6, system: 'supply' }]
})
stubDef('hvac-equipment', 'equipment', (node) => {
  const position = (node as unknown as { position: Point }).position
  return [{ id: 'supply', position, direction: [0, 1, 0], diameter: 12, system: 'supply' }]
})

let nextId = 0
function makeNode(type: string, fields: Record<string, unknown>): AnyNode {
  nextId += 1
  return { id: `${type}_${nextId}`, type, object: 'node', parentId: null, ...fields } as AnyNode
}

function sceneOf(...nodes: AnyNode[]): Record<AnyNodeId, AnyNode> {
  return Object.fromEntries(nodes.map((n) => [n.id, n])) as Record<AnyNodeId, AnyNode>
}

function run(path: Point[], system = 'supply'): AnyNode {
  return makeNode('duct-segment', { path, system, diameter: 160 })
}

describe('buildDuctNetworks', () => {
  test('equipment → trunk → branch → terminal forms one network', () => {
    const furnace = makeNode('hvac-equipment', { position: [0, 0, 0] as Point })
    const trunk = run([
      [0, 0, 0],
      [4, 0, 0],
    ])
    const branch = run([
      [4, 0, 0],
      [4, 0, 3],
    ])
    const register = makeNode('duct-terminal', {
      position: [4, 0, 3] as Point,
      terminalType: 'supply-register',
    })
    const networks = buildDuctNetworks(sceneOf(furnace, trunk, branch, register))

    expect(networks.length).toBe(1)
    const network = networks[0]!
    expect(network.systems).toEqual(['supply'])
    expect(network.connectedToEquipment).toBe(true)
    expect(network.lengthM).toBeCloseTo(7, 6)
    expect(network.openEndCount).toBe(0)
    expect(network.nodeIds.length).toBe(4)
  })

  test('independent П and В runs are separate networks', () => {
    const supply = run(
      [
        [0, 0, 0],
        [3, 0, 0],
      ],
      'supply',
    )
    const exhaust = run(
      [
        [20, 0, 0],
        [23, 0, 0],
      ],
      'exhaust',
    )
    const networks = buildDuctNetworks(sceneOf(supply, exhaust))
    expect(networks.length).toBe(2)
    const systemSets = networks.map((n) => n.systems).sort((a, b) => a[0]!.localeCompare(b[0]!))
    expect(systemSets).toEqual([['exhaust'], ['supply']])
  })

  test('non-MEP components are skipped', () => {
    const wall = makeNode('wall', {})
    const supply = run([
      [0, 0, 0],
      [3, 0, 0],
    ])
    const networks = buildDuctNetworks(sceneOf(wall, supply))
    expect(networks.length).toBe(1)
    expect(networks[0]!.nodeIds).toEqual([supply.id])
  })
})

describe('ductNetworkFor', () => {
  test('finds the network a node belongs to', () => {
    const a = run([
      [0, 0, 0],
      [3, 0, 0],
    ])
    const b = run([
      [3, 0, 0],
      [6, 0, 0],
    ])
    const network = ductNetworkFor(b.id, sceneOf(a, b))
    expect(network).not.toBeNull()
    expect(network!.nodeIds).toContain(a.id)
  })

  test('returns null for a non-MEP node', () => {
    const wall = makeNode('wall', {})
    expect(ductNetworkFor(wall.id, sceneOf(wall))).toBeNull()
  })
})

describe('validateDuctNetwork', () => {
  test('a complete supply tree passes clean', () => {
    const furnace = makeNode('hvac-equipment', { position: [0, 0, 0] as Point })
    const trunk = run([
      [0, 0, 0],
      [4, 0, 0],
    ])
    const register = makeNode('duct-terminal', {
      position: [4, 0, 0] as Point,
      terminalType: 'supply-register',
    })
    const findings = validateDuctNetwork(sceneOf(furnace, trunk, register))
    expect(findings).toEqual([])
  })

  test('an orphaned run with free ends is flagged', () => {
    const lonely = run(
      [
        [10, 0, 10],
        [14, 0, 10],
      ],
      'exhaust',
    )
    const findings = validateDuctNetwork(sceneOf(lonely))
    const codes = findings.map((f) => f.code)
    expect(codes).toContain('orphaned-network')
    expect(codes.filter((c) => c === 'open-run-end').length).toBe(2)
    expect(findings.every((f) => f.severity === 'warning')).toBe(true)
  })

  test('П and В welded into one component is an error', () => {
    const supply = run(
      [
        [0, 0, 0],
        [3, 0, 0],
      ],
      'supply',
    )
    const exhaust = run(
      [
        [3, 0, 0],
        [6, 0, 0],
      ],
      'exhaust',
    )
    const findings = validateDuctNetwork(sceneOf(supply, exhaust))
    const mixed = findings.find((f) => f.code === 'mixed-systems')
    expect(mixed).toBeDefined()
    expect(mixed!.severity).toBe('error')
  })

  test('a lone register with no run is flagged as unconnected', () => {
    const register = makeNode('duct-terminal', {
      position: [40, 0, 0] as Point,
      terminalType: 'diffuser',
    })
    const findings = validateDuctNetwork(sceneOf(register))
    expect(findings.map((f) => f.code)).toContain('unconnected-terminal')
    // a lone terminal is not an air path, so no orphaned-network warning
    expect(findings.map((f) => f.code)).not.toContain('orphaned-network')
  })
})
