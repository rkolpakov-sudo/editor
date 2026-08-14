import { nodeRegistry } from '../registry'
import type { AnyNode, AnyNodeId } from '../schema'
import {
  buildPortComponents,
  type SystemSummary,
  summarizeSystemFor,
} from '../services/system-graph'

/**
 * Duct-network analysis — the MEP side of the system graph: groups the
 * port-connected components into П/В/return networks, reports their runs,
 * and validates the connectivity rules a drawing tool invites mistakes in
 * (free run ends, terminals that never got mated, orphaned paths, mixed
 * loops welded into one component).
 *
 * Pure logic over `def.ports` + node fields — no rendering. It reuses the
 * scene-wide `buildPortComponents` / `summarizeSystemFor` primitives from
 * `services/system-graph` and adds MEP-specific classification.
 */

/** Same joint tolerance as `system-graph`'s port coincidence. */
export const JOINT_EPS_M = 0.05

export type MepNodeRole = 'equipment' | 'segment' | 'fitting' | 'terminal'

export function mepRoleOf(node: AnyNode): MepNodeRole | null {
  switch (node.type) {
    case 'duct-segment':
      return 'segment'
    case 'duct-fitting':
      return 'fitting'
    case 'duct-terminal':
      return 'terminal'
    case 'hvac-equipment':
      return 'equipment'
    default:
      return null
  }
}

export type PortRecord = {
  nodeId: AnyNodeId
  portId: string
  nodeType: AnyNode['type']
  x: number
  y: number
  z: number
}

export function collectPortRecords(nodes: Readonly<Record<AnyNodeId, AnyNode>>): PortRecord[] {
  const records: PortRecord[] = []
  for (const node of Object.values(nodes)) {
    if (!node) continue
    const ports = nodeRegistry.get(node.type)?.ports?.(node)
    if (!ports) continue
    for (const port of ports) {
      records.push({
        nodeId: node.id,
        portId: port.id,
        nodeType: node.type,
        x: port.position[0],
        y: port.position[1],
        z: port.position[2],
      })
    }
  }
  return records
}

/** recordIndex → indices of coincident ports on OTHER nodes. */
export function matedPortGroups(records: readonly PortRecord[]): Map<number, number[]> {
  const groups = new Map<number, number[]>()
  const epsSq = JOINT_EPS_M * JOINT_EPS_M
  for (let i = 0; i < records.length; i += 1) {
    const a = records[i]!
    const mates: number[] = []
    for (let j = 0; j < records.length; j += 1) {
      if (i === j) continue
      const b = records[j]!
      if (a.nodeId === b.nodeId) continue
      const dx = a.x - b.x
      const dy = a.y - b.y
      const dz = a.z - b.z
      if (dx * dx + dy * dy + dz * dz <= epsSq) mates.push(j)
    }
    groups.set(i, mates)
  }
  return groups
}

function pathLengthM(path: ReadonlyArray<readonly [number, number, number]>): number {
  let total = 0
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i]!
    const b = path[i + 1]!
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  }
  return total
}

function emptySummary(nodeIds: AnyNodeId[], systems: string[]): SystemSummary {
  return {
    nodeIds,
    systems,
    runCount: 0,
    runLengthM: 0,
    fittingCount: 0,
    terminalCount: 0,
    equipmentCount: 0,
    connectedToEquipment: false,
  }
}

export type DuctNetwork = {
  nodeIds: AnyNodeId[]
  summary: SystemSummary
  /** Unique air-loop systems present, sorted (e.g. ['exhaust', 'supply']). */
  systems: string[]
  /** Total duct-run length in the network, m. */
  lengthM: number
  /** Run endpoints that mate with nothing (free open ends). */
  openEndCount: number
  connectedToEquipment: boolean
}

/** Classify every port-connected component that contains MEP duct nodes
 *  into a network. Non-MEP components (plumbing, refrigerant) are skipped. */
export function buildDuctNetworks(nodes: Readonly<Record<AnyNodeId, AnyNode>>): DuctNetwork[] {
  const records = collectPortRecords(nodes)
  const groups = matedPortGroups(records)
  const networks: DuctNetwork[] = []

  for (const component of buildPortComponents(nodes)) {
    if (!component.some((id) => nodes[id] && mepRoleOf(nodes[id]!) !== null)) continue

    const systems = new Set<string>()
    let lengthM = 0
    for (const id of component) {
      const node = nodes[id]
      if (!node) continue
      if (node.type === 'duct-segment' || node.type === 'duct-fitting') {
        if (node.system) systems.add(node.system)
      } else if (node.type === 'duct-terminal') {
        systems.add(node.terminalType === 'return-grille' ? 'return' : 'supply')
      }
      if (node.type === 'duct-segment' && node.path) {
        lengthM += pathLengthM(node.path)
      }
    }

    const componentSet = new Set(component)
    let openEndCount = 0
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i]!
      if (record.nodeType !== 'duct-segment') continue
      if (!componentSet.has(record.nodeId)) continue
      const mates = groups.get(i) ?? []
      if (mates.length === 0) openEndCount += 1
    }

    const systemsArray = [...systems].sort()
    const summary =
      summarizeSystemFor(component[0]!, nodes) ?? emptySummary(component, systemsArray)
    networks.push({
      nodeIds: component,
      summary,
      systems: systemsArray,
      lengthM,
      openEndCount,
      connectedToEquipment: summary.connectedToEquipment,
    })
  }

  return networks
}

/** The network the given node belongs to, or null when it is not in any
 *  MEP network. */
export function ductNetworkFor(
  nodeId: AnyNodeId,
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
): DuctNetwork | null {
  for (const network of buildDuctNetworks(nodes)) {
    if (network.nodeIds.includes(nodeId)) return network
  }
  return null
}

export type DuctNetworkSeverity = 'error' | 'warning'

export type DuctNetworkFinding = {
  severity: DuctNetworkSeverity
  /** Stable rule id, e.g. 'mixed-systems'. */
  code: string
  message: string
  nodeIds: AnyNodeId[]
}

/** Run the duct-network connectivity rules. Empty array = nothing to flag. */
export function validateDuctNetwork(
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
): DuctNetworkFinding[] {
  const findings: DuctNetworkFinding[] = []
  const records = collectPortRecords(nodes)
  const groups = matedPortGroups(records)

  for (const network of buildDuctNetworks(nodes)) {
    const componentSet = new Set(network.nodeIds)

    if (network.systems.length > 1) {
      findings.push({
        severity: 'error',
        code: 'mixed-systems',
        message: `One connected network carries both ${network.systems.join(
          ' and ',
        )} air loops — П and В must stay on separate runs.`,
        nodeIds: network.nodeIds,
      })
    }

    const hasAirPath = network.nodeIds.some((id) => {
      const node = nodes[id]
      return node !== undefined && (node.type === 'duct-segment' || node.type === 'duct-fitting')
    })
    if (hasAirPath && !network.connectedToEquipment) {
      findings.push({
        severity: 'warning',
        code: 'orphaned-network',
        message: 'Duct runs go nowhere — the network has no furnace / air handler.',
        nodeIds: network.nodeIds,
      })
    }

    for (let i = 0; i < records.length; i += 1) {
      const record = records[i]!
      if (!componentSet.has(record.nodeId)) continue
      const mates = groups.get(i) ?? []

      if (record.nodeType === 'duct-segment' && mates.length === 0) {
        findings.push({
          severity: 'warning',
          code: 'open-run-end',
          message:
            'A duct run end is free — air escapes unless it terminates at a register or grille.',
          nodeIds: [record.nodeId],
        })
      }

      if (record.nodeType === 'duct-terminal' && mates.length === 0) {
        findings.push({
          severity: 'warning',
          code: 'unconnected-terminal',
          message: 'A register / grille is not connected to any duct run.',
          nodeIds: [record.nodeId],
        })
      }
    }
  }

  return findings
}
