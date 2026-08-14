import type { AnyNode, AnyNodeId } from '../schema'
import {
  buildDuctNetworks,
  collectPortRecords,
  type DuctNetwork,
  matedPortGroups,
} from './duct-network'
import type { SystemType } from './norms-types'

/**
 * Этап 8 — сетевые расходы: строит граф соединённых по портам узлов
 * каждой сети П/В (общий примитив для всех модулей Этапа 8) и прокачивает
 * расходы терминалов к магистрали. Чистая логика поверх `def.ports`
 * (`collectPortRecords` / `matedPortGroups` из `duct-network`) — без
 * Three.js и без хранилища.
 *
 * Модель: сеть — дерево, корень — оборудование (установка). Расход каждого
 * участка = сумма расходов терминалов в поддереве «в сторону от корня»:
 * магистраль у установки несёт весь расход сети, ответвление — расход своей
 * подветки. Направление потока (П от установки / В к установке) на
 * абсолютные значения не влияет — только на направление.
 */

export type DuctJointMember = {
  nodeId: AnyNodeId
  portId: string
}

/** Граф одной duct-сети: узлы, смежность через совпавшие порты, корень и
 *  остовное дерево от корня. Общий для Этапа 8 (расходы, потери, подбор). */
export type DuctNetworkGraph = {
  networkIndex: number
  nodeIds: AnyNodeId[]
  /** nodeId → соседние nodeId (соединённые общим узлом-портом). */
  adjacency: Map<AnyNodeId, AnyNodeId[]>
  /** Каждый узел-соединение: список портов, совпавших в одной точке. */
  joints: DuctJointMember[][]
  /** nodeId → индексы узлов-соединений, в которых участвует узел. */
  nodeJoints: Map<AnyNodeId, number[]>
  rootId: AnyNodeId | null
  /** True, когда корнем выбрано оборудование (установка). */
  rootedAtEquipment: boolean
  /** Остовное дерево от корня: parent[child] = родитель. */
  parent: Map<AnyNodeId, AnyNodeId | null>
  /** Остовное дерево от корня: children[node] = дети. */
  children: Map<AnyNodeId, AnyNodeId[]>
}

/** Корень без оборудования: узел с максимальной степенью (магистраль сети). */
function fallbackRoot(
  network: DuctNetwork,
  adjacency: Map<AnyNodeId, AnyNodeId[]>,
): AnyNodeId | null {
  let best: AnyNodeId | null = null
  let bestDegree = -1
  for (const id of network.nodeIds) {
    const degree = (adjacency.get(id) ?? []).length
    if (degree > bestDegree) {
      bestDegree = degree
      best = id
    }
  }
  return best ?? network.nodeIds[0] ?? null
}

/** Построить граф каждой duct-сети по совпавшим портам узлов сцены. */
export function buildDuctNetworkGraphs(
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
): DuctNetworkGraph[] {
  const networks = buildDuctNetworks(nodes)
  const records = collectPortRecords(nodes)
  const mates = matedPortGroups(records)

  // Union-find портов в узлы-соединения (кластеры совпавших портов).
  const parentOf = records.map((_, index) => index)
  const find = (index: number): number => {
    let root = parentOf[index]!
    while (root !== parentOf[root]) root = parentOf[root]!
    let cursor = index
    while (parentOf[cursor] !== root) {
      const next = parentOf[cursor]!
      parentOf[cursor] = root
      cursor = next
    }
    return root
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parentOf[rb] = ra
  }
  for (const [index, mated] of mates) {
    for (const other of mated) union(index, other)
  }

  const jointsByRoot = new Map<number, number[]>()
  records.forEach((_, index) => {
    const root = find(index)
    const list = jointsByRoot.get(root)
    if (list) list.push(index)
    else jointsByRoot.set(root, [index])
  })
  const sceneJoints: DuctJointMember[][] = [...jointsByRoot.values()].map((indices) =>
    indices.map((index) => ({
      nodeId: records[index]!.nodeId,
      portId: records[index]!.portId,
    })),
  )

  return networks.map((network, networkIndex) => {
    const memberSet = new Set(network.nodeIds)
    const joints: DuctJointMember[][] = []
    const nodeJoints = new Map<AnyNodeId, number[]>()
    for (const members of sceneJoints) {
      if (members.some((member) => !memberSet.has(member.nodeId))) continue
      const jointId = joints.length
      joints.push(members)
      for (const member of members) {
        const list = nodeJoints.get(member.nodeId) ?? []
        list.push(jointId)
        nodeJoints.set(member.nodeId, list)
      }
    }

    const adjacency = new Map<AnyNodeId, AnyNodeId[]>()
    for (const members of joints) {
      const nodeIds = [...new Set(members.map((member) => member.nodeId))]
      for (let i = 0; i < nodeIds.length; i += 1) {
        for (let j = i + 1; j < nodeIds.length; j += 1) {
          const a = nodeIds[i]!
          const b = nodeIds[j]!
          const aList = adjacency.get(a) ?? []
          if (!aList.includes(b)) aList.push(b)
          adjacency.set(a, aList)
          const bList = adjacency.get(b) ?? []
          if (!bList.includes(a)) bList.push(a)
          adjacency.set(b, bList)
        }
      }
    }

    const equipmentId = network.nodeIds.find((id) => nodes[id]?.type === 'hvac-equipment') ?? null
    const rootId = equipmentId ?? fallbackRoot(network, adjacency)
    const rootedAtEquipment = rootId === equipmentId

    const parent = new Map<AnyNodeId, AnyNodeId | null>()
    const children = new Map<AnyNodeId, AnyNodeId[]>()
    if (rootId) {
      parent.set(rootId, null)
      const queue = [rootId]
      const visited = new Set<AnyNodeId>([rootId])
      while (queue.length > 0) {
        const current = queue.shift()!
        for (const neighbor of adjacency.get(current) ?? []) {
          if (visited.has(neighbor)) continue
          visited.add(neighbor)
          parent.set(neighbor, current)
          const list = children.get(current) ?? []
          list.push(neighbor)
          children.set(current, list)
          queue.push(neighbor)
        }
      }
    }

    return {
      networkIndex,
      nodeIds: network.nodeIds,
      adjacency,
      joints,
      nodeJoints,
      rootId,
      rootedAtEquipment,
      parent,
      children,
    }
  })
}

export type NetworkFlowsOptions = {
  /** Терминал → расход (м³/ч), обычно из `assignZoneAirflowsToTerminals` +
   *  `terminalFlowMap`. Терминалы вне карты несут 0. */
  terminalFlows?: Readonly<Record<AnyNodeId, number>>
}

export type NetworkTerminalFlow = {
  terminalId: AnyNodeId
  flowM3h: number
  /** True — расход назначен явно (зона/задание), а не дефолтный 0. */
  assigned: boolean
}

export type NetworkFlowResult = {
  networkIndex: number
  nodeIds: AnyNodeId[]
  systems: SystemType[]
  connectedToEquipment: boolean
  rootId: AnyNodeId | null
  rootedAtEquipment: boolean
  /** Суммарный расход сети (корень), м³/ч. */
  totalFlowM3h: number
  /** Участок → расход (м³/ч): сумма терминалов в поддереве от корня. */
  segmentFlows: Record<AnyNodeId, number>
  terminals: NetworkTerminalFlow[]
}

function networkSystems(
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
  ids: AnyNodeId[],
): SystemType[] {
  const systems = new Set<SystemType>()
  for (const id of ids) {
    const node = nodes[id]
    if (node && (node.type === 'duct-segment' || node.type === 'duct-fitting') && node.system) {
      systems.add(node.system as SystemType)
    }
  }
  return [...systems].sort()
}

/** Пропагация расходов по каждой сети от терминалов к магистрали. */
export function computeNetworkFlows(
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
  options: NetworkFlowsOptions = {},
): NetworkFlowResult[] {
  const terminalFlows = options.terminalFlows ?? {}
  return buildDuctNetworkGraphs(nodes).map((graph) => {
    const terminals: NetworkTerminalFlow[] = []
    const segmentFlows: Record<AnyNodeId, number> = {}
    const subtree = new Map<AnyNodeId, number>()

    const visit = (id: AnyNodeId): number => {
      const node = nodes[id]
      let sum = 0
      if (node?.type === 'duct-terminal') {
        const flow = terminalFlows[id] ?? 0
        sum = flow
        terminals.push({
          terminalId: id,
          flowM3h: flow,
          assigned: id in terminalFlows && flow > 0,
        })
      }
      for (const child of graph.children.get(id) ?? []) sum += visit(child)
      subtree.set(id, sum)
      if (node?.type === 'duct-segment') segmentFlows[id] = sum
      return sum
    }

    const totalFlowM3h = graph.rootId ? visit(graph.rootId) : 0
    const connectedToEquipment = graph.nodeIds.some((id) => nodes[id]?.type === 'hvac-equipment')

    return {
      networkIndex: graph.networkIndex,
      nodeIds: graph.nodeIds,
      systems: networkSystems(nodes, graph.nodeIds),
      connectedToEquipment,
      rootId: graph.rootId,
      rootedAtEquipment: graph.rootedAtEquipment,
      totalFlowM3h,
      segmentFlows,
      terminals,
    }
  })
}

/** Удобство — сеть, которой принадлежит участок (или null), с картой
 *  расходов по участкам сети. */
export function networkFlowsForSegment(
  segmentId: AnyNodeId,
  flows: readonly NetworkFlowResult[],
): NetworkFlowResult | null {
  for (const flow of flows) {
    if (flow.segmentFlows[segmentId] !== undefined) return flow
  }
  return null
}
