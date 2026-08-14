import type { AnyNode, AnyNodeId, DuctSegmentNode } from '../schema'
import {
  type DuctSectionProfile,
  ductSectionAreaM2,
  ductSectionHydraulicDiameterM,
  pressureDropPa,
  velocityMps,
} from './aerodynamics'
import { ductSegmentLengthM } from './gost-segmentation'
import {
  buildDuctNetworkGraphs,
  computeNetworkFlows,
  type NetworkFlowResult,
} from './network-flows'
import type { AnnualHoursBand, BuildingClass, ResidentialSection, SystemType } from './norms-types'
import { type SizingResult, sizeDuctSection } from './sizing'

/**
 * Этап 8 — подбор сечений по сети: перебирает участки каждой сети в порядке
 * «магистраль → ответвления» (BFS от оборудования) и подбирает каждому сечение
 * по СП 60 прил. Л (`sizeDuctSection`) под его расход из Этапа 8. Результат —
 * единая таблица участков с расходом, ГОСТ-сечением, скоростью, ΔP по трению
 * и флагом шумовой проверки. Чистая логика, без Three.js.
 */

function segmentProfile(node: DuctSegmentNode): DuctSectionProfile {
  return node.shape === 'round'
    ? { shape: 'round', diameterMm: node.diameter }
    : { shape: node.shape, widthMm: node.width, heightMm: node.height }
}

export type NetworkSizingOptions = {
  /** Готовые расходы (`computeNetworkFlows`); без них — нулевые. */
  flows?: readonly NetworkFlowResult[]
  hoursBand?: AnnualHoursBand
  buildingClass?: BuildingClass
  residentialSection?: ResidentialSection
  /** Жёсткий предел скорости (акустика), перекрывающий норм-диапазон. */
  maxVelocityMps?: number
}

export type SizedDuctSection = {
  segmentId: AnyNodeId
  networkIndex: number
  system: SystemType
  flowM3h: number
  /** Профиль, который был у участка до подбора. */
  currentProfile: DuctSectionProfile
  /** Подобранный ГОСТ-профиль (при нулевом расходе — текущий). */
  profile: DuctSectionProfile
  /** Скорость при подобранном сечении, м/с. */
  velocityMps: number
  /** True — скорость внутри норм-диапазона СП 60 прил. Л. */
  inNormBand: boolean
  noiseCheckRequired: boolean
  /** Потери на трение по длине участка (подобранное сечение), Па. */
  frictionDropPa: number
  lengthM: number
}

export type NetworkSizingResult = {
  networkIndex: number
  systems: SystemType[]
  segments: SizedDuctSection[]
  totalFlowM3h: number
  warnings: string[]
}

/** BFS-порядок сети от корня: магистраль → ответвления. */
function breadthFirstOrder(rootId: AnyNodeId, adjacency: Map<AnyNodeId, AnyNodeId[]>): AnyNodeId[] {
  const order: AnyNodeId[] = []
  const queue = [rootId]
  const visited = new Set<AnyNodeId>([rootId])
  while (queue.length > 0) {
    const current = queue.shift()!
    order.push(current)
    for (const neighbor of adjacency.get(current) ?? []) {
      if (visited.has(neighbor)) continue
      visited.add(neighbor)
      queue.push(neighbor)
    }
  }
  return order
}

/** Подбор сечений всех сетей сцены в порядке «магистраль → ответвления». */
export function sizeDuctNetworks(
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
  options: NetworkSizingOptions = {},
): NetworkSizingResult[] {
  const flows = options.flows ?? computeNetworkFlows(nodes)
  const flowsByIndex = new Map(flows.map((flow) => [flow.networkIndex, flow]))
  const graphs = buildDuctNetworkGraphs(nodes)

  return graphs.map((graph) => {
    const flow = flowsByIndex.get(graph.networkIndex)
    const segmentFlows = flow?.segmentFlows ?? {}
    const warnings: string[] = []
    const segments: SizedDuctSection[] = []

    const order = graph.rootId ? breadthFirstOrder(graph.rootId, graph.adjacency) : graph.nodeIds

    for (const id of order) {
      const node = nodes[id]
      if (node?.type !== 'duct-segment') continue
      const currentProfile = segmentProfile(node)
      const segmentFlow = segmentFlows[id] ?? 0
      const lengthM = ductSegmentLengthM(node)

      let profile = currentProfile
      let velocity = 0
      let inNormBand = true
      let noiseCheckRequired = false
      let sizing: SizingResult | null = null

      if (segmentFlow > 0) {
        sizing = sizeDuctSection({
          flowM3h: segmentFlow,
          system: node.system,
          shape: node.shape === 'round' ? 'round' : 'rect',
          hoursBand: options.hoursBand,
          buildingClass: options.buildingClass,
          residentialSection: options.residentialSection,
          maxVelocityMps: options.maxVelocityMps,
        })
        if (sizing) {
          profile = sizing.profile
          velocity = sizing.velocityMps
          inNormBand =
            velocity >= sizing.recommendedVelocity.min && velocity <= sizing.recommendedVelocity.max
          noiseCheckRequired = sizing.noiseCheckRequired
        } else {
          warnings.push(
            `Участок ${id}: ГОСТ-ряд не покрывает требуемое сечение для расхода ${segmentFlow.toFixed(0)} м³/ч — оставлен текущий профиль.`,
          )
        }
      }

      const areaM2 = ductSectionAreaM2(profile)
      if (sizing === null && segmentFlow > 0) {
        velocity = velocityMps(segmentFlow, areaM2)
      }
      const frictionDropPa =
        velocity > 0
          ? pressureDropPa({
              lengthM,
              hydraulicDiameterM: ductSectionHydraulicDiameterM(profile),
              velocityMps: velocity,
            })
          : 0

      if (velocity > 0 && !inNormBand) {
        warnings.push(
          `Участок ${id}: скорость ${velocity.toFixed(1)} м/с вне норм-диапазона СП 60 прил. Л.`,
        )
      }
      if (noiseCheckRequired) {
        warnings.push(`Участок ${id}: скорость выше порога шума — требуется акустическая проверка.`)
      }

      segments.push({
        segmentId: id,
        networkIndex: graph.networkIndex,
        system: node.system,
        flowM3h: segmentFlow,
        currentProfile,
        profile,
        velocityMps: velocity,
        inNormBand,
        noiseCheckRequired,
        frictionDropPa,
        lengthM,
      })
    }

    return {
      networkIndex: graph.networkIndex,
      systems: flow?.systems ?? [],
      segments,
      totalFlowM3h: flow?.totalFlowM3h ?? 0,
      warnings,
    }
  })
}

/** Карта «участок → подобранный профиль» для `computeNetworkPressure` —
 *  чтобы критический путь считался по подобранным сечениям. */
export function sizedProfiles(
  results: readonly NetworkSizingResult[],
): Record<AnyNodeId, DuctSectionProfile> {
  const map: Record<AnyNodeId, DuctSectionProfile> = {}
  for (const result of results) {
    for (const segment of result.segments) map[segment.segmentId] = segment.profile
  }
  return map
}
