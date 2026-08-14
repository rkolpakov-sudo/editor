import { describe, expect, test } from 'bun:test'
import { detectSpacesForLevel, planAutoZonesForLevel } from '../lib/space-detection'
import type { AnyNode, AnyNodeId } from '../schema'
import {
  type DuctFittingNode,
  DuctSegmentNode,
  DuctTerminalNode,
  HvacEquipmentNode,
  WallNode,
  ZoneNode,
} from '../schema'
import { ductSectionAreaM2, pressureDropPa, velocityMps } from './aerodynamics'
import { assignZoneAirflowsToTerminals, computeZoneAirflows, terminalFlowMap } from './air-exchange'
import {
  buildBypassMutations,
  buildBypassRunMutations,
  detectBypassCrossings,
  planAllBypasses,
  planAllBypassRuns,
} from './bypass'
import { resolveRequiredAirflowM3h } from './constants'
import { registerDuctNetworkStubs } from './duct-network-stubs'
import { ductSegmentLengthM } from './gost-segmentation'
import { computeNetworkFlows } from './network-flows'
import { computeNetworkPressure } from './network-pressure'
import { sizeDuctNetworks, sizedProfiles } from './network-sizing'
import { sizeDuctSection } from './sizing'
import { buildDuctSpecification } from './specification'

/**
 * Этап 7 — интеграционный тест полного пайплайна:
 *   «план → зоны → трассы П/В → пересечение → автообвод → расчёт → спецификация».
 * Прогоняет реальные модули движка подряд на одной сцене: замкнутый контур
 * стен порождает авто-зону, приточная и вытяжная трассы пересекаются,
 * сервис утки планирует и применяет обвод одной командой, аэродинамика
 * подбирает ГОСТ-сечение под норматив помещения, а спецификация считает
 * воздуховоды, утку, крепления и проходы через стены.
 */

type Point = [number, number, number]

/** Стены замкнутой комнаты 6 × 4 м (контур по часовой стрелке). */
function roomWalls(): WallNode[] {
  return [
    WallNode.parse({ id: 'wall_a' as AnyNodeId, start: [0, 0], end: [6, 0], height: 2.6 }),
    WallNode.parse({ id: 'wall_b' as AnyNodeId, start: [6, 0], end: [6, 4], height: 2.6 }),
    WallNode.parse({ id: 'wall_c' as AnyNodeId, start: [6, 4], end: [0, 4], height: 2.6 }),
    WallNode.parse({ id: 'wall_d' as AnyNodeId, start: [0, 4], end: [0, 0], height: 2.6 }),
  ]
}

function segment(
  path: Point[],
  opts: {
    id: string
    system: 'supply' | 'exhaust' | 'return'
    diameter?: number
    shape?: 'round' | 'rect' | 'oval'
    width?: number
    height?: number
  },
): DuctSegmentNode {
  return DuctSegmentNode.parse({
    id: opts.id as AnyNodeId,
    path,
    system: opts.system,
    shape: opts.shape ?? 'round',
    diameter: opts.diameter ?? 160,
    width: opts.width ?? 400,
    height: opts.height ?? 200,
  })
}

function sceneOf(...nodes: AnyNode[]): Record<AnyNodeId, AnyNode> {
  return Object.fromEntries(nodes.map((node) => [node.id, node])) as Record<AnyNodeId, AnyNode>
}

/** Применить план обвода к записи сцены: обрезать вытяжку «до», добавить
 *  хвостовой участок «после» и фиттинг-утку (как `applyAllBypasses`). */
function applyBypassPlan(
  nodes: Record<AnyNodeId, AnyNode>,
  exhaust: DuctSegmentNode,
): Record<AnyNodeId, AnyNode> {
  const plans = planAllBypasses(nodes)
  expect(plans.plans.length).toBeGreaterThan(0)
  const plan = plans.plans[0]!
  const mutations = buildBypassMutations(plan, exhaust)
  const next: Record<AnyNodeId, AnyNode> = { ...nodes }
  next[exhaust.id] = { ...exhaust, path: plan.beforePath } as DuctSegmentNode
  next[mutations.afterSegment.id] = mutations.afterSegment
  next[mutations.fitting.id] = mutations.fitting
  return next
}

describe('MEP pipeline: план → зоны → трассы П/В → пересечение → автообвод → расчёт → спецификация', () => {
  test('замкнутый контур стен порождает авто-зону помещения', () => {
    const walls = roomWalls()
    const { spaces } = detectSpacesForLevel('level-1', walls)
    expect(spaces).toHaveLength(1)
    expect(spaces[0]!.polygon).toHaveLength(4)
    expect(spaces[0]!.wallIds).toHaveLength(4)

    const plan = planAutoZonesForLevel(spaces, [])
    expect(plan.create).toHaveLength(1)
    expect(plan.update).toHaveLength(0)
    expect(plan.delete).toHaveLength(0)

    const zone = plan.create[0]!
    expect(zone.name).toBe('Room 1')
    expect(zone.spaceRole).toBe('room')
    expect(zone.spaceCategory).toBe('public')
    expect(zone.autoFromWalls).toBe(true)
    expect(new Set(zone.boundaryWallIds)).toEqual(new Set(walls.map((wall) => wall.id)))
  })

  test('категория помещения по СП 54 задаёт требуемый воздухообмен', () => {
    // Кухня с газовой плитой — 90 м³/ч вытяжки (СП 54, docs/mep/01).
    expect(resolveRequiredAirflowM3h('kitchen_gas')).toBe(90)
    expect(resolveRequiredAirflowM3h('kitchen_electric')).toBe(60)
    expect(resolveRequiredAirflowM3h('bath')).toBe(25)
    // Жилая комната — 3 м³/ч на м² притока.
    expect(resolveRequiredAirflowM3h('living', { areaM2: 20 })).toBe(60)
  })

  test('пересечение П/В обнаруживается на одной отметке', () => {
    const supply = segment(
      [
        [-1, 2.6, 2],
        [7, 2.6, 2],
      ],
      { id: 'duct-segment_supply', system: 'supply', diameter: 400 },
    )
    const exhaust = segment(
      [
        [3, 2.6, -1],
        [3, 2.6, 5],
      ],
      { id: 'duct-segment_exhaust', system: 'exhaust', diameter: 200 },
    )
    const crossings = detectBypassCrossings(sceneOf(supply, exhaust))
    expect(crossings).toHaveLength(1)
    const crossing = crossings[0]!
    expect(crossing.supplyNodeId).toBe('duct-segment_supply')
    expect(crossing.exhaustNodeId).toBe('duct-segment_exhaust')
    expect(crossing.supplySizeMm).toBe(400)
    expect(crossing.exhaustSizeMm).toBe(200)
    expect(crossing.point[0]).toBeCloseTo(3, 5)
    expect(crossing.point[1]).toBeCloseTo(2, 5)
  })

  test('автообвод планирует утку со смещением supply + 2×50 мм и применяет её', () => {
    const supply = segment(
      [
        [-1, 2.6, 2],
        [7, 2.6, 2],
      ],
      { id: 'duct-segment_supply', system: 'supply', diameter: 400 },
    )
    const exhaust = segment(
      [
        [3, 2.6, -1],
        [3, 2.6, 5],
      ],
      { id: 'duct-segment_exhaust', system: 'exhaust', diameter: 200 },
    )
    const nodes = sceneOf(supply, exhaust)

    const { plans, skipped } = planAllBypasses(nodes)
    expect(skipped).toHaveLength(0)
    expect(plans).toHaveLength(1)
    const plan = plans[0]!
    expect(plan.angleDeg).toBe(45)
    expect(plan.autoSwitchedTo90).toBe(false)
    expect(plan.offsetMm).toBe(400 + 2 * 50)

    const next = applyBypassPlan(nodes, exhaust)
    const segments = Object.values(next).filter(
      (node): node is DuctSegmentNode => node.type === 'duct-segment',
    )
    const fittings = Object.values(next).filter(
      (node): node is DuctFittingNode => node.type === 'duct-fitting',
    )
    // Приток + вытяжка «до» + вытяжка «после».
    expect(segments).toHaveLength(3)
    expect(fittings).toHaveLength(1)
    expect(fittings[0]!.fittingType).toBe('offset')
    expect(fittings[0]!.system).toBe('exhaust')
    // После обвода приточная трасса осталась прямой.
    const supplyNode = next['duct-segment_supply']!
    expect((supplyNode as DuctSegmentNode).path).toEqual(supply.path)
    // Повторный проход конфликтов не находит — утка решила пересечение.
    expect(detectBypassCrossings(next)).toHaveLength(0)
  })

  test('расчёт подбирает ГОСТ-сечение под нормативный воздухообмен', () => {
    // Кухня 90 м³/ч, вытяжка, до 2000 ч/год → Л.1: 3,0–4,0 м/с.
    const sized = sizeDuctSection({ flowM3h: 90, system: 'exhaust', hoursBand: 'lt2000' })
    expect(sized).not.toBeNull()
    expect(sized!.profile).toEqual({ shape: 'round', diameterMm: 100 })
    expect(sized!.velocityMps).toBeGreaterThanOrEqual(3.0)
    expect(sized!.velocityMps).toBeLessThanOrEqual(4.0)
    expect(sized!.noiseCheckRequired).toBe(false)
    // Пересчёт: v = Q/(3600·F), ΔP по Рейнольдсу/Дарси для протяжённого участка.
    const areaM2 = ductSectionAreaM2(sized!.profile)
    expect(velocityMps(90, areaM2)).toBeCloseTo(sized!.velocityMps, 5)
    expect(
      pressureDropPa({ lengthM: 5, hydraulicDiameterM: 0.1, velocityMps: sized!.velocityMps }),
    ).toBeGreaterThan(0)
  })

  test('спецификация считает воздуховоды, утку, крепления и гильзы', () => {
    const supply = segment(
      [
        [-1, 2.6, 2],
        [7, 2.6, 2],
      ],
      { id: 'duct-segment_supply', system: 'supply', diameter: 400 },
    )
    const exhaust = segment(
      [
        [3, 2.6, -1],
        [3, 2.6, 5],
      ],
      { id: 'duct-segment_exhaust', system: 'exhaust', diameter: 200 },
    )
    const walls = roomWalls()
    const nodes = applyBypassPlan(sceneOf(supply, exhaust), exhaust)

    const spec = buildDuctSpecification(nodes, { walls })

    // Системы П/В с маркировкой по ГОСТ 21.602.
    expect(spec.systems.map((row) => row.system)).toEqual(
      expect.arrayContaining(['supply', 'exhaust']),
    )
    const supplySystem = spec.systems.find((row) => row.system === 'supply')!
    const exhaustSystem = spec.systems.find((row) => row.system === 'exhaust')!
    expect(supplySystem.marking).toBe('П1')
    expect(exhaustSystem.marking).toBe('В1')
    expect(exhaustSystem.lengthM).toBeGreaterThan(0)

    // Утка попадает в фасонные части.
    const utka = spec.sections.fittings.find((row) => row.name.includes('Утка'))
    expect(utka).toBeDefined()
    expect(utka!.quantity).toBe(1)

    // Приток через 2 стены, вытяжка через 2 → 4 гильзы.
    expect(spec.totals.sleeves).toBe(4)
    expect(spec.totals.fireDampers).toBe(0)
    expect(spec.totals.fittings).toBe(1)
    expect(spec.totals.lengthM).toBeGreaterThan(0)
    // Крепления на приточном Ø400 участке (шаг 4 м, длина 8 м → 3 шт).
    const bracket = spec.sections.ducts.find((row) => row.name.includes('Кронштейн'))
    expect(bracket).toBeDefined()
    expect(bracket!.quantity).toBeGreaterThan(0)
  })

  test('полный пайплайн: комната → зона → трассы → обвод → расчёт → спецификация', () => {
    // 1) План: замкнутый контур стен.
    const walls = roomWalls()
    const { spaces } = detectSpacesForLevel('level-1', walls)
    expect(spaces).toHaveLength(1)

    // 2) Зоны: авто-зона помещения, классифицируем как кухню.
    const zonePlan = planAutoZonesForLevel(spaces, [])
    const zone = ZoneNode.parse({ ...zonePlan.create[0]!, spaceCategory: 'kitchen_gas' })
    const flow = resolveRequiredAirflowM3h(zone.spaceCategory)
    expect(flow).toBe(90)

    // 3) Трассы П/В.
    const supply = segment(
      [
        [-1, 2.6, 2],
        [7, 2.6, 2],
      ],
      { id: 'duct-segment_supply', system: 'supply', diameter: 400 },
    )
    const exhaust = segment(
      [
        [3, 2.6, -1],
        [3, 2.6, 5],
      ],
      { id: 'duct-segment_exhaust', system: 'exhaust', diameter: 200 },
    )
    const scene = sceneOf(zone, supply, exhaust)

    // 4) Пересечение.
    expect(detectBypassCrossings(scene)).toHaveLength(1)

    // 5) Автообвод применяется одной командой.
    const bypassed = applyBypassPlan(scene, exhaust)
    expect(detectBypassCrossings(bypassed)).toHaveLength(0)

    // 6) Расчёт: сечение под норматив кухни.
    const sized = sizeDuctSection({ flowM3h: flow!, system: 'exhaust', hoursBand: 'lt2000' })
    expect(sized).not.toBeNull()
    expect(sized!.velocityMps).toBeLessThanOrEqual(sized!.recommendedVelocity.max)

    // 7) Спецификация: обе системы, утка, проходы через стены.
    const spec = buildDuctSpecification(bypassed, { walls })
    expect(spec.systems.some((row) => row.system === 'supply')).toBe(true)
    expect(spec.systems.some((row) => row.system === 'exhaust')).toBe(true)
    expect(spec.sections.fittings.some((row) => row.name.includes('Утка'))).toBe(true)
    expect(spec.totals.sleeves).toBeGreaterThanOrEqual(4)
    expect(spec.totals.massKg).toBeGreaterThan(0)
  })

  test('Этап 8: кухня 90 → расход на участках → подбор Ø100 → ΔP сети', () => {
    registerDuctNetworkStubs()

    // 1) План и авто-зона кухни (СП 54 → 90 м³/ч вытяжки).
    const walls = roomWalls()
    const { spaces } = detectSpacesForLevel('level-1', walls)
    const zonePlan = planAutoZonesForLevel(spaces, [])
    const zone = ZoneNode.parse({ ...zonePlan.create[0]!, spaceCategory: 'kitchen_gas' })
    const [airflow] = computeZoneAirflows([zone])
    expect(airflow!.requiredFlowM3h).toBe(90)
    expect(airflow!.direction).toBe('exhaust')

    // 2) Вытяжная сеть: установка → магистраль (два участка) → вытяжная решётка.
    const equipment = HvacEquipmentNode.parse({
      id: 'hvac-equipment_fan',
      position: [0, 2.6, 0],
      equipmentType: 'furnace',
    } as AnyNode)
    const seg1 = segment(
      [
        [0, 2.6, 0],
        [4, 2.6, 0],
      ],
      { id: 'duct-segment_exh1', system: 'exhaust', diameter: 160 },
    )
    const seg2 = segment(
      [
        [4, 2.6, 0],
        [7, 2.6, 0],
      ],
      { id: 'duct-segment_exh2', system: 'exhaust', diameter: 160 },
    )
    const grille = DuctTerminalNode.parse({
      id: 'duct-terminal_grille',
      position: [7, 2.6, 0],
      terminalType: 'return-grille',
    } as AnyNode)
    const scene = sceneOf(zone, equipment, seg1, seg2, grille)

    // 3) Зона → терминал → расходы по сети.
    const assignments = assignZoneAirflowsToTerminals(scene, [zone])
    expect(assignments).toHaveLength(1)
    expect(assignments[0]!.terminalId).toBe(grille.id)
    const flows = computeNetworkFlows(scene, { terminalFlows: terminalFlowMap(assignments) })
    expect(flows).toHaveLength(1)
    const network = flows[0]!
    expect(network.connectedToEquipment).toBe(true)
    expect(network.totalFlowM3h).toBe(90)
    expect(network.segmentFlows[seg1.id]).toBeCloseTo(90, 9)
    expect(network.segmentFlows[seg2.id]).toBeCloseTo(90, 9)

    // 4) Сетевой подбор: каждый участок по своему расходу → Ø100, v в Л.1.
    const sizing = sizeDuctNetworks(scene, { flows })
    expect(sizing).toHaveLength(1)
    const sized1 = sizing[0]!.segments.find((row) => row.segmentId === seg1.id)!
    const sized2 = sizing[0]!.segments.find((row) => row.segmentId === seg2.id)!
    expect(sized1.profile).toEqual({ shape: 'round', diameterMm: 100 })
    expect(sized2.profile).toEqual({ shape: 'round', diameterMm: 100 })
    expect(sized1.inNormBand).toBe(true)

    // 5) Потери по сети (по подобранным сечениям): критический путь > 0.
    const pressure = computeNetworkPressure(scene, {
      flows,
      profiles: sizedProfiles(sizing),
    })
    expect(pressure).toHaveLength(1)
    expect(pressure[0]!.paths).toHaveLength(1)
    expect(pressure[0]!.criticalPath).not.toBeNull()
    expect(pressure[0]!.totalPressurePa).toBeGreaterThan(0)
  })

  test('Этап 9: одна вытяжка пересекает два притока — обе утки планируются и спецификация считает обе', () => {
    // 1) Трассы: вытяжка вдоль Z, два притока вдоль X на z=-2 и z=+2.
    const supply1 = segment(
      [
        [-4, 2.6, -2],
        [4, 2.6, -2],
      ],
      { id: 'duct-segment_s1', system: 'supply', diameter: 300 },
    )
    const supply2 = segment(
      [
        [-4, 2.6, 2],
        [4, 2.6, 2],
      ],
      { id: 'duct-segment_s2', system: 'supply', diameter: 300 },
    )
    const exhaust = segment(
      [
        [0, 2.6, -6],
        [0, 2.6, 6],
      ],
      { id: 'duct-segment_exhaust', system: 'exhaust', diameter: 160 },
    )
    const scene = sceneOf(supply1, supply2, exhaust)
    expect(detectBypassCrossings(scene)).toHaveLength(2)

    // 2) Run-планирование: обе утки одной командой.
    const run = planAllBypassRuns(scene)[0]!
    expect(run.bypasses).toHaveLength(2)
    expect(run.skipped).toHaveLength(0)

    // 3) Применяем мутации к сцене.
    const next: Record<AnyNodeId, AnyNode> = { ...scene }
    const mutations = buildBypassRunMutations(run, exhaust)
    next[exhaust.id] = { ...exhaust, path: mutations.beforePath } as DuctSegmentNode
    for (const piece of [...mutations.intermediateSegments, mutations.afterSegment]) {
      next[piece.id] = piece
    }
    for (const fitting of mutations.fittings) next[fitting.id] = fitting
    expect(detectBypassCrossings(next)).toHaveLength(0)

    // 4) Спецификация видит обе утки в фасонных частях.
    const spec = buildDuctSpecification(next, {})
    const utkaRows = spec.sections.fittings.filter((row) => row.name.includes('Утка'))
    expect(utkaRows).toHaveLength(1)
    expect(utkaRows[0]!.quantity).toBe(2)
    // Вытяжка теперь «до» + «между» + «после» (3 прямых участка); S-обходы
    // живут в фиттингах, поэтому суммарная прямая длина меньше исходных 12 м.
    const exhaustSegments = Object.values(next)
      .filter((node): node is DuctSegmentNode => node.type === 'duct-segment')
      .filter((node) => node.system === 'exhaust')
    expect(exhaustSegments).toHaveLength(3)
    const exhaustTotal = exhaustSegments.reduce((sum, node) => sum + ductSegmentLengthM(node), 0)
    expect(exhaustTotal).toBeLessThan(12)
    expect(exhaustTotal).toBeGreaterThan(8)
  })
})
