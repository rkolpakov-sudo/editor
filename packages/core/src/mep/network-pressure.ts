import type { AnyNode, AnyNodeId, DuctFittingNode, DuctSegmentNode } from '../schema'
import {
  type DuctSectionProfile,
  ductSectionAreaM2,
  ductSectionHydraulicDiameterM,
  elbowZeta,
  localPressureDropPa,
  pressureDropPa,
  teeZeta,
  transitionZeta,
  velocityMps,
} from './aerodynamics'
import { BYPASS_ZETA_ELBOW_COUNT } from './bypass'
import { BRANCH_BALANCE_TOLERANCE_PCT } from './constants'
import { ductSegmentLengthM } from './gost-segmentation'
import {
  buildDuctNetworkGraphs,
  computeNetworkFlows,
  type DuctNetworkGraph,
  type NetworkFlowResult,
} from './network-flows'
import type { SystemType } from './norms-types'

/**
 * Этап 8 — сетевые потери и балансировка: для каждой сети П/В проходит пути
 * от оборудования до каждого терминала, суммирует ΔP по пути (трение R·l по
 * участкам + ξ фитингов: отводы, утки, тройники, переходы), находит
 * критический путь (max ΔP) и проверяет балансировку ответвлений на узлах
 * ветвления (расхождение ≤ `BRANCH_BALANCE_TOLERANCE_PCT`, рабочее значение
 * до верификации по СП 60). Чистая логика над графом из `network-flows`.
 */

function segmentProfile(node: DuctSegmentNode): DuctSectionProfile {
  return node.shape === 'round'
    ? { shape: 'round', diameterMm: node.diameter }
    : { shape: node.shape, widthMm: node.width, heightMm: node.height }
}

function fittingRunProfile(node: DuctFittingNode): DuctSectionProfile {
  return node.shape === 'round'
    ? { shape: 'round', diameterMm: node.diameter }
    : { shape: node.shape, widthMm: node.width, heightMm: node.height }
}

function fittingSecondaryProfile(node: DuctFittingNode): DuctSectionProfile {
  return node.shape2 === 'round'
    ? { shape: 'round', diameterMm: node.diameter2 }
    : { shape: node.shape2, widthMm: node.width2, heightMm: node.height2 }
}

/** Порт фиттинга, которым он соединяется с соседом по пути (или null). */
function fittingPortToward(
  graph: DuctNetworkGraph,
  fittingId: AnyNodeId,
  neighborId: AnyNodeId,
): string | null {
  for (const jointId of graph.nodeJoints.get(fittingId) ?? []) {
    const members = graph.joints[jointId]!
    let hasNeighbor = false
    let port = ''
    for (const member of members) {
      if (member.nodeId === neighborId) hasNeighbor = true
      if (member.nodeId === fittingId) port = member.portId
    }
    if (hasNeighbor) return port
  }
  return null
}

function isBranchPort(port: string | null): boolean {
  return port === 'branch' || port === 'branch2'
}

/** ξ фиттинга на пути: отвод/утка по углу, тройник/крестовина по ветке,
 *  переход по соотношению площадей. */
function fittingZetaAlong(
  node: DuctFittingNode,
  graph: DuctNetworkGraph,
  path: AnyNodeId[],
  index: number,
): number {
  switch (node.fittingType) {
    case 'elbow':
      return elbowZeta(node.angle, node.offsetRadiusFactor)
    case 'offset':
      return BYPASS_ZETA_ELBOW_COUNT * elbowZeta(node.angle, node.offsetRadiusFactor)
    case 'tee':
    case 'cross': {
      const next = path[index + 1]
      const port = next !== undefined ? fittingPortToward(graph, node.id, next) : null
      return teeZeta(isBranchPort(port))
    }
    case 'reducer':
    case 'transition': {
      const a = ductSectionAreaM2(fittingRunProfile(node))
      const b = ductSectionAreaM2(fittingSecondaryProfile(node))
      return transitionZeta(Math.max(a, b), Math.min(a, b))
    }
    default:
      return 0
  }
}

/** Профиль фиттинга для скорости: у перехода — меньшее сечение (большая
 *  скорость), у тройника по ветке — профиль ответвления. */
function fittingVelocityProfile(
  node: DuctFittingNode,
  graph: DuctNetworkGraph,
  path: AnyNodeId[],
  index: number,
): DuctSectionProfile {
  switch (node.fittingType) {
    case 'reducer':
    case 'transition': {
      const run = fittingRunProfile(node)
      const secondary = fittingSecondaryProfile(node)
      return ductSectionAreaM2(secondary) < ductSectionAreaM2(run) ? secondary : run
    }
    case 'tee':
    case 'cross': {
      const next = path[index + 1]
      const port = next !== undefined ? fittingPortToward(graph, node.id, next) : null
      if (isBranchPort(port)) {
        return node.shape2 === 'round'
          ? { shape: 'round', diameterMm: node.diameter2 }
          : { shape: node.shape2, widthMm: node.width2, heightMm: node.height2 }
      }
      return fittingRunProfile(node)
    }
    default:
      return fittingRunProfile(node)
  }
}

/** Расход, который несёт путь в позиции фиттинга: расход ближайшего
 *  нижележащего участка (или расход терминала, если фиттинг стоит прямо
 *  перед ним). */
function carriedFlow(
  path: AnyNodeId[],
  index: number,
  segmentFlows: Readonly<Record<AnyNodeId, number>>,
  terminalFlowM3h: number,
): number {
  for (let j = index + 1; j < path.length; j += 1) {
    const id = path[j]!
    const flow = segmentFlows[id]
    if (flow !== undefined) return flow
  }
  return terminalFlowM3h
}

export type NetworkPressureOptions = {
  /** Готовые расходы (`computeNetworkFlows`); без них — дефолтный прогон с
   *  нулевыми расходами терминалов. */
  flows?: readonly NetworkFlowResult[]
  /** Переопределение профиля участка (например, подобранные Этапом 8
   *  сечения). Без него — текущий профиль узла. */
  profiles?: Readonly<Record<AnyNodeId, DuctSectionProfile>>
}

export type PressurePathLeg = {
  nodeId: AnyNodeId
  kind: 'segment' | 'fitting'
  flowM3h: number
  velocityMps: number
  zeta: number
  lengthM: number
  pressureDropPa: number
}

export type NetworkPressurePath = {
  terminalId: AnyNodeId
  flowM3h: number
  lengthM: number
  pressureDropPa: number
  /** Путь от корня (оборудования) до терминала. */
  nodeIds: AnyNodeId[]
  legs: PressurePathLeg[]
}

export type BranchBalanceCheck = {
  /** Узел ветвления (тройник/крестовина). */
  atNodeId: AnyNodeId
  branchPaths: Array<{ terminalId: AnyNodeId; pressureDropPa: number }>
  /** (max−min)/max · 100 по ответвлениям от узла. */
  deviationPct: number
  withinTolerance: boolean
}

export type NetworkPressureResult = {
  networkIndex: number
  systems: SystemType[]
  paths: NetworkPressurePath[]
  criticalPath: NetworkPressurePath | null
  totalPressurePa: number
  balances: BranchBalanceCheck[]
  warnings: string[]
}

type PathRecord = {
  nodes: AnyNodeId[]
  /** nodeId → leg (только участки/фиттинги; оборудование и терминалы без ног). */
  legByNode: Map<AnyNodeId, PressurePathLeg>
  total: number
  lengthM: number
}

/** Потери по путям оборудования → терминалы, критический путь и
 *  балансировка ответвлений для всех сетей. */
export function computeNetworkPressure(
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
  options: NetworkPressureOptions = {},
): NetworkPressureResult[] {
  const flows = options.flows ?? computeNetworkFlows(nodes)
  const flowsByIndex = new Map(flows.map((flow) => [flow.networkIndex, flow]))
  const profiles = options.profiles ?? {}
  const graphs = buildDuctNetworkGraphs(nodes)

  return graphs.map((graph) => {
    const flow = flowsByIndex.get(graph.networkIndex)
    const segmentFlows = flow?.segmentFlows ?? {}
    const warnings: string[] = []
    const paths: NetworkPressurePath[] = []
    const pathByTerminal = new Map<AnyNodeId, PathRecord>()

    for (const id of graph.nodeIds) {
      const node = nodes[id]
      if (node?.type !== 'duct-terminal') continue

      const reversed: AnyNodeId[] = []
      let cursor: AnyNodeId | null = id
      while (cursor) {
        reversed.push(cursor)
        cursor = graph.parent.get(cursor) ?? null
      }
      const path = reversed.reverse()

      const terminalFlow =
        flow?.terminals.find((terminal) => terminal.terminalId === id)?.flowM3h ?? 0
      let total = 0
      let lengthM = 0
      const legs: PressurePathLeg[] = []
      const legByNode = new Map<AnyNodeId, PressurePathLeg>()

      for (let i = 0; i < path.length; i += 1) {
        const nodeId = path[i]!
        const pathNode = nodes[nodeId]
        if (pathNode?.type === 'duct-segment') {
          const profile = profiles[nodeId] ?? segmentProfile(pathNode)
          const segmentFlow = segmentFlows[nodeId] ?? 0
          const area = ductSectionAreaM2(profile)
          const velocity = segmentFlow > 0 ? velocityMps(segmentFlow, area) : 0
          const length = ductSegmentLengthM(pathNode)
          const drop =
            segmentFlow > 0
              ? pressureDropPa({
                  lengthM: length,
                  hydraulicDiameterM: ductSectionHydraulicDiameterM(profile),
                  velocityMps: velocity,
                })
              : 0
          total += drop
          lengthM += length
          const leg: PressurePathLeg = {
            nodeId,
            kind: 'segment',
            flowM3h: segmentFlow,
            velocityMps: velocity,
            zeta: 0,
            lengthM: length,
            pressureDropPa: drop,
          }
          legs.push(leg)
          legByNode.set(nodeId, leg)
        } else if (pathNode?.type === 'duct-fitting') {
          const fittingFlow = carriedFlow(path, i, segmentFlows, terminalFlow)
          const profile = fittingVelocityProfile(pathNode, graph, path, i)
          const area = ductSectionAreaM2(profile)
          const velocity = fittingFlow > 0 ? velocityMps(fittingFlow, area) : 0
          const zeta = fittingZetaAlong(pathNode, graph, path, i)
          const drop = localPressureDropPa(zeta, velocity)
          total += drop
          const leg: PressurePathLeg = {
            nodeId,
            kind: 'fitting',
            flowM3h: fittingFlow,
            velocityMps: velocity,
            zeta,
            lengthM: 0,
            pressureDropPa: drop,
          }
          legs.push(leg)
          legByNode.set(nodeId, leg)
        }
      }

      paths.push({
        terminalId: id,
        flowM3h: terminalFlow,
        lengthM,
        pressureDropPa: total,
        nodeIds: path,
        legs,
      })
      pathByTerminal.set(id, { nodes: path, legByNode, total, lengthM })
    }

    let criticalPath: NetworkPressurePath | null = null
    for (const path of paths) {
      if (!criticalPath || path.pressureDropPa > criticalPath.pressureDropPa) {
        criticalPath = path
      }
    }

    const balances: BranchBalanceCheck[] = []
    for (const id of graph.nodeIds) {
      const node = nodes[id]
      if (node?.type !== 'duct-fitting') continue
      if (node.fittingType !== 'tee' && node.fittingType !== 'cross') continue

      const downstream: Array<{ terminalId: AnyNodeId; fromFittingPa: number }> = []
      for (const [terminalId, record] of pathByTerminal) {
        const index = record.nodes.indexOf(id)
        if (index < 0) continue
        const fromFittingPa = record.nodes
          .slice(index + 1)
          .reduce((sum, nodeId) => sum + (record.legByNode.get(nodeId)?.pressureDropPa ?? 0), 0)
        downstream.push({ terminalId, fromFittingPa })
      }
      if (downstream.length < 2) continue

      const maxDrop = Math.max(...downstream.map((entry) => entry.fromFittingPa))
      const minDrop = Math.min(...downstream.map((entry) => entry.fromFittingPa))
      const deviationPct = maxDrop > 0 ? ((maxDrop - minDrop) / maxDrop) * 100 : 0
      const withinTolerance = deviationPct <= BRANCH_BALANCE_TOLERANCE_PCT
      if (!withinTolerance) {
        warnings.push(
          `Разбалансировка на тройнике ${id}: отклонение ${deviationPct.toFixed(0)}% > ${BRANCH_BALANCE_TOLERANCE_PCT}% (рабочий порог до верификации по СП 60).`,
        )
      }
      balances.push({
        atNodeId: id,
        branchPaths: downstream.map((entry) => ({
          terminalId: entry.terminalId,
          pressureDropPa: entry.fromFittingPa,
        })),
        deviationPct,
        withinTolerance,
      })
    }

    return {
      networkIndex: graph.networkIndex,
      systems: flow?.systems ?? [],
      paths,
      criticalPath,
      totalPressurePa: criticalPath?.pressureDropPa ?? 0,
      balances,
      warnings,
    }
  })
}
