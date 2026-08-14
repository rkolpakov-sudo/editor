import type { AnyNodeId, DuctTerminalNode, ZoneNode } from '../schema'
import { AIR_EXCHANGE_RATES, type AirExchangeRule, resolveRequiredAirflowM3h } from './constants'
import type { SpaceCategory, SystemType } from './norms-types'

/**
 * Этап 8 — воздухообмен помещений: связывает авто-зоны (`spaceCategory`,
 * `spaceRole: 'room'`) с терминалами трасс П/В. Для каждой комнаты считает
 * нормативный расход (СП 54 / универсальная база — `resolveRequiredAirflowM3h`,
 * площадь по полигону зоны, численность по опции) и назначает его в
 * ближайший совместимый терминал притока или вытяжки. Чистая логика, без
 * Three.js и без хранилища — работает на любом `Record<AnyNodeId, AnyNode>`.
 */

/** Площадь полигона зоны по формуле Гаусса, м². Полигон хранит [x, z]. */
export function polygonAreaM2(polygon: ZoneNode['polygon']): number {
  let area = 0
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!
    const b = polygon[(i + 1) % polygon.length]!
    area += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(area) / 2
}

/** Центроид полигона зоны как [x, z] (среднее вершин). */
export function zoneCentroid(polygon: ZoneNode['polygon']): [number, number] {
  if (polygon.length === 0) return [0, 0]
  let x = 0
  let z = 0
  for (const [px, pz] of polygon) {
    x += px
    z += pz
  }
  return [x / polygon.length, z / polygon.length]
}

export type ZoneAirflowOptions = {
  /** Площадь, подставляемая всем зонам (по умолчанию — shoelace по полигону). */
  areaM2?: number
  /** Численность для правил «м³/ч на человека». */
  occupants?: number
  /** Переопределение численности по конкретной зоне. */
  occupantsByZone?: Readonly<Record<AnyNodeId, number>>
}

export type ZoneAirflow = {
  zoneId: AnyNodeId
  name: string
  spaceCategory: SpaceCategory
  /** Площадь пола, м² (полигон зоны). */
  areaM2: number
  /** Каким контуром помещение обменивается воздухом: приток / вытяжка. */
  direction: SystemType
  /** Нормативный воздухообмен, м³/ч. Null — категория «по заданию»
   *  (public/industrial) или не хватает входных данных. */
  requiredFlowM3h: number | null
  occupants?: number
}

/** Воздухообмен всех зон-помещений по СП 54 (`spaceRole: 'room'`).
 *  Остальные зоны (generic) не участвуют в расчёте вентиляции. */
export function computeZoneAirflows(
  zones: readonly ZoneNode[],
  options: ZoneAirflowOptions = {},
): ZoneAirflow[] {
  const result: ZoneAirflow[] = []
  for (const zone of zones) {
    if (zone.spaceRole !== 'room') continue
    const areaM2 = options.areaM2 ?? polygonAreaM2(zone.polygon)
    const occupants = options.occupantsByZone?.[zone.id] ?? options.occupants
    const rule: AirExchangeRule = AIR_EXCHANGE_RATES[zone.spaceCategory]
    result.push({
      zoneId: zone.id,
      name: zone.name,
      spaceCategory: zone.spaceCategory,
      areaM2,
      direction: rule.flowDirection,
      requiredFlowM3h: resolveRequiredAirflowM3h(zone.spaceCategory, { areaM2, occupants }),
      occupants,
    })
  }
  return result
}

/** Направление терминала: приток для supply-register / diffuser, вытяжка /
 *  рециркуляция для return-grille (гриль исполняет роль вытяжной решётки). */
export function terminalDirection(terminal: DuctTerminalNode): SystemType {
  return terminal.terminalType === 'return-grille' ? 'return' : 'supply'
}

/** Совместим ли терминал с направлением помещения: приток → приточные
 *  решётки/диффузоры, вытяжка → вытяжные (return-grille). */
export function terminalMatchesDirection(
  terminal: DuctTerminalNode,
  direction: SystemType,
): boolean {
  if (direction === 'supply') {
    return terminal.terminalType === 'supply-register' || terminal.terminalType === 'diffuser'
  }
  return terminal.terminalType === 'return-grille'
}

export type TerminalAssignmentOptions = {
  /** Не назначать терминалы дальше этого расстояния, м (без ограничения по
   *  умолчанию). */
  maxDistanceM?: number
}

export type TerminalAssignment = {
  terminalId: AnyNodeId
  zoneId: AnyNodeId
  zoneName: string
  flowM3h: number
  direction: SystemType
  /** Расстояние от центроида зоны до терминала, м. */
  distanceM: number
}

/** Расстояние между двумя плановыми точками [x, z], м. */
function planDistanceM(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

/**
 * Назначить нормативные расходы зон в ближайшие совместимые терминалы.
 * Каждая зона с расходом находит ближайший подходящий терминал
 * (жадный запрос без переиспользования); один терминал может обслуживать
 * несколько зон — суммарный расход он несёт на своём участке. Зоны без
 * подходящего терминала остаются неназначенными (их расход виден в
 * `computeZoneAirflows`, а сводка считает их в «неназначено»).
 */
export function assignZoneAirflowsToTerminals(
  nodes: Readonly<Record<AnyNodeId, unknown>>,
  zones: readonly ZoneNode[],
  options: TerminalAssignmentOptions = {},
): TerminalAssignment[] {
  const terminals: DuctTerminalNode[] = []
  for (const node of Object.values(nodes)) {
    if (node && typeof node === 'object' && 'type' in node && node.type === 'duct-terminal') {
      terminals.push(node as DuctTerminalNode)
    }
  }
  if (terminals.length === 0) return []

  const assignments: TerminalAssignment[] = []
  for (const airflow of computeZoneAirflows(zones)) {
    if (airflow.requiredFlowM3h === null || airflow.requiredFlowM3h <= 0) continue
    const centroid = zoneCentroid(zones.find((zone) => zone.id === airflow.zoneId)?.polygon ?? [])
    let best: DuctTerminalNode | null = null
    let bestDistance = Infinity
    for (const terminal of terminals) {
      if (!terminalMatchesDirection(terminal, airflow.direction)) continue
      const d = planDistanceM(centroid, [terminal.position[0], terminal.position[2]])
      if (d >= bestDistance) continue
      if (options.maxDistanceM !== undefined && d > options.maxDistanceM) continue
      best = terminal
      bestDistance = d
    }
    if (!best) continue
    assignments.push({
      terminalId: best.id,
      zoneId: airflow.zoneId,
      zoneName: airflow.name,
      flowM3h: airflow.requiredFlowM3h,
      direction: airflow.direction,
      distanceM: bestDistance,
    })
  }
  return assignments
}

/** Собрать карту «терминал → суммарный расход» из назначений зон (несколько
 *  зон на один терминал складываются). Готова для `computeNetworkFlows`. */
export function terminalFlowMap(
  assignments: readonly TerminalAssignment[],
): Record<AnyNodeId, number> {
  const map: Record<AnyNodeId, number> = {}
  for (const assignment of assignments) {
    map[assignment.terminalId] = (map[assignment.terminalId] ?? 0) + assignment.flowM3h
  }
  return map
}
