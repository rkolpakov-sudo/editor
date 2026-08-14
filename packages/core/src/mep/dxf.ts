import type { AnyNode, AnyNodeId, DuctFittingNode } from '../schema'
import { computeBypassGeometry } from './bypass'
import { systemMarkingLetter } from './gost-segmentation'
import type { SystemType } from './norms-types'
import {
  checkFireBarrierCrossing,
  checkWallPenetration,
  type PlanPoint,
  type WallLike,
  wallBarrierRect,
} from './routing-rules'

/**
 * Экспорт плана вентиляции в ASCII DXF (Этап 6; Этап 10 — v2). Чистая
 * функция над сценой: проецирует трассы воздуховодов на план (x, z → X, Y),
 * раскладывает их по слоям системы (П/В/Р), рисует фиттинги по типу
 * (отвод — дуга, утка — S-полилиния из `computeBypassGeometry`, тройник/
 * крестовина — линии, переходы — сужающиеся пары) с размерами мм в тексте,
 * решётки квадратами, гильзы/клапаны на пересечениях со стенами и легенду
 * систем. Маркировка П1/В1/Р1 по ГОСТ 21.602. Не требует Three.js — только
 * строки.
 */

export type DxfExportOptions = {
  /** Высота текста маркировки в метрах плана. */
  labelHeightM?: number
  /** Рисовать фитинги (по типу) — включено по умолчанию. */
  drawFittings?: boolean
  /** Рисовать решётки/диффузоры (квадраты) — включено по умолчанию. */
  drawTerminals?: boolean
  /** Рисовать гильзы/клапаны на пересечениях со стенами (Этап 10). */
  drawPenetrations?: boolean
  /** Готовая маркировка сетей; без неё — по буквам системы (П1/В1/Р1). */
  markings?: Readonly<Record<AnyNodeId, string>>
  /** Стены для учёта проходов (гильзы). Может быть просто `WallNode[]`. */
  walls?: readonly WallLike[]
  /** Огнестойкие преграды для противопожарных клапанов (СП 7.13130). */
  fireRatedBarriers?: readonly WallLike[]
  /** Высота легенды/подписей размеров (Этап 10). */
  legendHeightM?: number
}

const DXF_LAYER_COLORS: Record<string, number> = {
  '0': 7,
  MEP_SUPPLY: 1,
  MEP_EXHAUST: 3,
  MEP_RETURN: 5,
  MEP_FITTING: 8,
  MEP_TERMINAL: 2,
  MEP_SLEEVE: 4,
  MEP_FIRE_DAMPER: 6,
}

const MEP_LAYERS = [
  '0',
  'MEP_SUPPLY',
  'MEP_EXHAUST',
  'MEP_RETURN',
  'MEP_FITTING',
  'MEP_TERMINAL',
  'MEP_SLEEVE',
  'MEP_FIRE_DAMPER',
]

function layerForSystem(system: SystemType): string {
  return system === 'supply' ? 'MEP_SUPPLY' : system === 'exhaust' ? 'MEP_EXHAUST' : 'MEP_RETURN'
}

/** Плановая проекция точки path/position [x, y, z] → [X, Y] плана DXF. */
function planPoint(point: readonly [number, number, number]): PlanPoint {
  return [point[0], point[2]]
}

/** Маркировка без зависимости от реестра: по одному номеру на каждую систему
 *  (П1 / В1 / Р1). Для сетевой нумерации передайте `markings` из
 *  `planSystemMarkings` (вызывающий слой). */
function perSystemMarkings(nodes: Readonly<Record<AnyNodeId, AnyNode>>): Record<AnyNodeId, string> {
  const markings: Record<AnyNodeId, string> = {}
  const counters: Record<SystemType, number> = { supply: 0, exhaust: 0, return: 0 }
  for (const node of Object.values(nodes)) {
    if (!node) continue
    if (node.type !== 'duct-segment' && node.type !== 'duct-fitting') continue
    const system = node.system as SystemType
    counters[system] += 1
    markings[node.id] = `${systemMarkingLetter(system)}${counters[system]}`
  }
  return markings
}

class DxfWriter {
  #lines: string[] = []
  #handle = 0

  code(code: number, value: string | number): void {
    this.#lines.push(String(code))
    this.#lines.push(String(value))
  }

  nextHandle(): string {
    this.#handle += 1
    return this.#handle.toString(16).padStart(4, '0')
  }

  line(x1: number, y1: number, x2: number, y2: number, layer: string): void {
    this.code(0, 'LINE')
    this.code(5, this.nextHandle())
    this.code(8, layer)
    this.code(10, x1)
    this.code(20, y1)
    this.code(30, 0)
    this.code(11, x2)
    this.code(21, y2)
    this.code(31, 0)
  }

  text(x: number, y: number, height: number, content: string, layer: string): void {
    this.code(0, 'TEXT')
    this.code(5, this.nextHandle())
    this.code(8, layer)
    this.code(10, x)
    this.code(20, y)
    this.code(30, 0)
    this.code(40, height)
    this.code(1, content)
    this.code(72, 1)
    this.code(11, x)
    this.code(21, y)
  }

  circle(x: number, y: number, radius: number, layer: string): void {
    this.code(0, 'CIRCLE')
    this.code(5, this.nextHandle())
    this.code(8, layer)
    this.code(10, x)
    this.code(20, y)
    this.code(30, 0)
    this.code(40, radius)
  }

  arc(x: number, y: number, radius: number, startDeg: number, endDeg: number, layer: string): void {
    this.code(0, 'ARC')
    this.code(5, this.nextHandle())
    this.code(8, layer)
    this.code(10, x)
    this.code(20, y)
    this.code(30, 0)
    this.code(40, radius)
    this.code(50, startDeg)
    this.code(51, endDeg)
  }

  polyline(points: readonly PlanPoint[], layer: string): void {
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]!
      const b = points[i + 1]!
      this.line(a[0], a[1], b[0], b[1], layer)
    }
  }

  square(x: number, y: number, half: number, layer: string): void {
    this.line(x - half, y - half, x + half, y - half, layer)
    this.line(x + half, y - half, x + half, y + half, layer)
    this.line(x + half, y + half, x - half, y + half, layer)
    this.line(x - half, y + half, x - half, y - half, layer)
  }

  toString(): string {
    return this.#lines.join('\n')
  }
}

/** Название секции слоя: [SECTION, 2, TABLES, TABLE, 2, LAYER, 70, <n>, …] */
function layerTable(layers: string[]): string {
  const writer = new DxfWriter()
  writer.code(0, 'SECTION')
  writer.code(2, 'TABLES')

  writer.code(0, 'TABLE')
  writer.code(2, 'LTYPE')
  writer.code(70, 1)
  writer.code(0, 'LTYPE')
  writer.code(2, 'CONTINUOUS')
  writer.code(70, 0)
  writer.code(3, 'Solid line')
  writer.code(72, 65)
  writer.code(73, 0)
  writer.code(40, 0.0)
  writer.code(0, 'ENDTAB')

  writer.code(0, 'TABLE')
  writer.code(2, 'LAYER')
  writer.code(70, layers.length)
  for (const name of layers) {
    writer.code(0, 'LAYER')
    writer.code(2, name)
    writer.code(70, 0)
    writer.code(62, DXF_LAYER_COLORS[name] ?? 7)
    writer.code(6, 'CONTINUOUS')
  }
  writer.code(0, 'ENDTAB')

  writer.code(0, 'ENDSEC')
  return writer.toString()
}

// ── Fitting plan symbols (Этап 10) ────────────────────────────────────────

/** Body size of a fitting, mm — the plan symbol's half-width reference. */
function fittingSizeMm(node: DuctFittingNode): number {
  return node.shape === 'round' ? node.diameter : Math.max(node.width, node.height)
}

function fittingSizeLabel(node: DuctFittingNode): string {
  return node.shape === 'round' ? `Ø${node.diameter}` : `${node.width}×${node.height}`
}

function fittingSecondaryLabel(node: DuctFittingNode): string {
  return node.shape2 === 'round' ? `Ø${node.diameter2}` : `${node.width2}×${node.height2}`
}

/** Collar stub length in meters, matching the nodes' port convention. */
function fittingLegM(diameterMm: number): number {
  return Math.max(0.14, (diameterMm / 1000 / 2) * 2.5)
}

/** Local plan point → level-local plan point, applying the fitting's yaw
 *  (rotation about the vertical axis) the way the 3D renderer does. */
function fittingPlanPoint(node: DuctFittingNode, local: PlanPoint): PlanPoint {
  const yaw = node.rotation[1]
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  return [
    node.position[0] + local[0] * cos + local[1] * sin,
    node.position[2] - local[0] * sin + local[1] * cos,
  ]
}

/** Подпись фиттинга с размерами мм для плана. */
function fittingTypeLabel(node: DuctFittingNode): string {
  const size = fittingSizeLabel(node)
  const secondary = fittingSecondaryLabel(node)
  switch (node.fittingType) {
    case 'elbow':
      return `Отвод ${node.angle}° ${size}`
    case 'offset':
      return `Утка ${node.angle}° ${size}`
    case 'tee':
      return `Тройник ${size}/${secondary}`
    case 'cross':
      return `Крест ${size}/${secondary}`
    case 'reducer':
    case 'transition':
      return `Переход ${size}→${secondary}`
    case 'saddle':
      return `Седелка ${size}`
    case 'hood':
      return `Зонт ${size}`
  }
}

function drawFitting(writer: DxfWriter, node: DuctFittingNode, labelHeightM: number): void {
  const layer = 'MEP_FITTING'
  const center = fittingPlanPoint(node, [0, 0])
  switch (node.fittingType) {
    case 'elbow': {
      // Flow turns from +X to +Z by `angle`°: the arc's centre sits at
      // (0, +R) in the local frame, the bend sweeps 270° → 270°+angle.
      const radiusM = ((node.radiusFactor ?? 1.5) * fittingSizeMm(node)) / 1000
      const c = fittingPlanPoint(node, [0, radiusM])
      writer.arc(c[0], c[1], radiusM, 270, 270 + node.angle, layer)
      break
    }
    case 'offset': {
      const geometry = computeBypassGeometry(
        node.offset,
        node.angle,
        node.offsetRadiusFactor,
        node.diameter,
      )
      if (geometry) {
        const pts = geometry.keyPointsLocal.map((p) => fittingPlanPoint(node, p))
        writer.polyline(pts, layer)
      }
      break
    }
    case 'tee': {
      const runLeg = fittingLegM(node.diameter)
      const branchLeg = fittingLegM(node.diameter2)
      const phi = (node.branchAngle * Math.PI) / 180
      const runIn = fittingPlanPoint(node, [-runLeg, 0])
      const runOut = fittingPlanPoint(node, [runLeg, 0])
      writer.line(runIn[0], runIn[1], runOut[0], runOut[1], layer)
      const branch = fittingPlanPoint(node, [branchLeg * Math.cos(phi), branchLeg * Math.sin(phi)])
      writer.line(center[0], center[1], branch[0], branch[1], layer)
      break
    }
    case 'cross': {
      const runLeg = fittingLegM(node.diameter)
      const branchLeg = fittingLegM(node.diameter2)
      const runIn = fittingPlanPoint(node, [-runLeg, 0])
      const runOut = fittingPlanPoint(node, [runLeg, 0])
      writer.line(runIn[0], runIn[1], runOut[0], runOut[1], layer)
      const b1 = fittingPlanPoint(node, [0, branchLeg])
      const b2 = fittingPlanPoint(node, [0, -branchLeg])
      writer.line(center[0], center[1], b1[0], b1[1], layer)
      writer.line(center[0], center[1], b2[0], b2[1], layer)
      break
    }
    case 'reducer':
    case 'transition': {
      // Tapered plan profile: rect end half-width (or Ø/2) → Ø2/2.
      const rIn = (node.fittingType === 'reducer' ? node.diameter : node.width) / 2
      const rOut = node.diameter2 / 2
      const leg = fittingLegM(node.diameter)
      const topIn = fittingPlanPoint(node, [0, rIn / 1000])
      const topOut = fittingPlanPoint(node, [leg, rOut / 1000])
      const botIn = fittingPlanPoint(node, [0, -rIn / 1000])
      const botOut = fittingPlanPoint(node, [leg, -rOut / 1000])
      writer.line(topIn[0], topIn[1], topOut[0], topOut[1], layer)
      writer.line(botIn[0], botIn[1], botOut[0], botOut[1], layer)
      writer.line(topIn[0], topIn[1], botIn[0], botIn[1], layer)
      writer.line(topOut[0], topOut[1], botOut[0], botOut[1], layer)
      break
    }
    case 'saddle': {
      // Врезка в бок: короткая ось + полукруглый бобышек в сторону.
      const leg = fittingLegM(node.diameter)
      const r = Math.max(fittingSizeMm(node) / 1000 / 2, 0.05)
      const runIn = fittingPlanPoint(node, [-leg, 0])
      const runOut = fittingPlanPoint(node, [leg, 0])
      writer.line(runIn[0], runIn[1], runOut[0], runOut[1], layer)
      writer.arc(center[0], center[1], r, 0, 180, layer)
      break
    }
    case 'hood': {
      // Зонт на выход в атмосферу: конус (два клина от центра к ширине).
      const r = Math.max(fittingSizeMm(node) / 1000 / 2, 0.05)
      const tip = fittingPlanPoint(node, [-fittingLegM(node.diameter), 0])
      const left = fittingPlanPoint(node, [fittingLegM(node.diameter), r])
      const right = fittingPlanPoint(node, [fittingLegM(node.diameter), -r])
      writer.line(center[0], center[1], left[0], left[1], layer)
      writer.line(center[0], center[1], right[0], right[1], layer)
      writer.line(left[0], left[1], right[0], right[1], layer)
      break
    }
    default: {
      const radius = Math.max(fittingSizeMm(node) / 1000 / 2, 0.05)
      writer.circle(center[0], center[1], radius, layer)
    }
  }
  // Размер в мм как текст у знака фиттинга.
  const offsetY = Math.max(fittingSizeMm(node) / 1000 / 2, 0.05) + labelHeightM * 0.5
  writer.text(center[0], center[1] + offsetY, labelHeightM * 0.7, fittingTypeLabel(node), layer)
}

// ── Wall penetrations (Этап 10) ───────────────────────────────────────────

function drawPenetrations(
  writer: DxfWriter,
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
  walls: readonly WallLike[],
  barriers: readonly WallLike[],
): void {
  for (const node of Object.values(nodes)) {
    if (node?.type !== 'duct-segment') continue
    const sizeMm = node.shape === 'round' ? node.diameter : Math.max(node.width, node.height)
    for (let i = 0; i < node.path.length - 1; i += 1) {
      const leg = {
        from: [node.path[i]![0], node.path[i]![2]] as const,
        to: [node.path[i + 1]![0], node.path[i + 1]![2]] as const,
        shape: node.shape,
        sizeMm,
      }
      for (const wall of walls) {
        const sleeve = checkWallPenetration(leg, wallBarrierRect(wall))
        if (sleeve) writer.circle(sleeve.at[0], sleeve.at[1], 0.08, 'MEP_SLEEVE')
      }
      for (const barrier of barriers) {
        const damper = checkFireBarrierCrossing(leg, wallBarrierRect(barrier))
        if (damper) writer.circle(damper.at[0], damper.at[1], 0.12, 'MEP_FIRE_DAMPER')
      }
    }
  }
}

// ── System legend (Этап 10) ───────────────────────────────────────────────

const SYSTEM_LEGEND_NAME: Record<SystemType, string> = {
  supply: 'Приток',
  exhaust: 'Вытяжка',
  return: 'Рециркуляция',
}

function planBounds(
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let found = false
  const take = (point: PlanPoint) => {
    found = true
    minX = Math.min(minX, point[0])
    minY = Math.min(minY, point[1])
    maxX = Math.max(maxX, point[0])
    maxY = Math.max(maxY, point[1])
  }
  for (const node of Object.values(nodes)) {
    if (!node) continue
    if (node.type === 'duct-segment') {
      for (const point of node.path) take(planPoint(point))
    } else if (node.type === 'duct-fitting' || node.type === 'duct-terminal') {
      take(planPoint(node.position))
    }
  }
  return found ? { minX, minY, maxX, maxY } : null
}

function drawSystemLegend(
  writer: DxfWriter,
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
  markings: Readonly<Record<AnyNodeId, string>>,
  heightM: number,
  bounds: { minX: number; minY: number },
): void {
  const systems = (['supply', 'exhaust', 'return'] as const).filter((system) =>
    Object.values(nodes).some(
      (node) =>
        node &&
        (node.type === 'duct-segment' || node.type === 'duct-fitting') &&
        node.system === system,
    ),
  )
  if (systems.length === 0) return
  const x = bounds.minX
  let y = bounds.minY - heightM * 2
  writer.text(x, y, heightM, 'Системы', '0')
  for (const system of systems) {
    const firstId = Object.keys(markings).find((id) => {
      const node = nodes[id as AnyNodeId]
      return (
        node &&
        (node.type === 'duct-segment' || node.type === 'duct-fitting') &&
        node.system === system
      )
    })
    const mark =
      (firstId !== undefined ? markings[firstId as AnyNodeId] : undefined) ??
      `${systemMarkingLetter(system)}1`
    y -= heightM * 1.7
    writer.text(
      x,
      y,
      heightM,
      `${mark} — ${SYSTEM_LEGEND_NAME[system]} (${layerForSystem(system)})`,
      layerForSystem(system),
    )
  }
}

/** Сгенерировать ASCII DXF плана вентиляции для сцены. */
export function ductsToDxf(
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
  options: DxfExportOptions = {},
): string {
  const labelHeightM = options.labelHeightM ?? 0.35
  const legendHeightM = options.legendHeightM ?? labelHeightM * 0.7
  const drawFittings = options.drawFittings ?? true
  const drawTerminals = options.drawTerminals ?? true
  const drawPenetrationsOption = options.drawPenetrations ?? true
  const walls = options.walls ?? []
  const barriers = options.fireRatedBarriers ?? []
  const markings = options.markings ?? perSystemMarkings(nodes)

  const writer = new DxfWriter()
  writer.code(0, 'SECTION')
  writer.code(2, 'HEADER')
  writer.code(9, '$ACADVER')
  writer.code(1, 'AC1015')
  writer.code(9, '$INSUNITS')
  writer.code(70, 6)
  writer.code(0, 'ENDSEC')
  const header = writer.toString()

  const entities = new DxfWriter()

  // ── Duct segments → plan polylines (one LINE per leg) ───────────────────
  for (const node of Object.values(nodes)) {
    if (node?.type !== 'duct-segment') continue
    const layer = layerForSystem(node.system)
    for (let i = 0; i < node.path.length - 1; i += 1) {
      const from = planPoint(node.path[i]!)
      const to = planPoint(node.path[i + 1]!)
      entities.line(from[0], from[1], to[0], to[1], layer)
    }

    // Маркировка П1/В1/Р1 в середине первого звена участка.
    const mark = markings[node.id]
    if (mark && node.path.length >= 2) {
      const a = planPoint(node.path[0]!)
      const b = planPoint(node.path[node.path.length - 1]!)
      const mid: PlanPoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      entities.text(mid[0], mid[1], labelHeightM, mark, layer)
    }
  }

  // ── Fittings → typed plan symbols on the MEP_FITTING layer (Этап 10) ────
  if (drawFittings) {
    for (const node of Object.values(nodes)) {
      if (node?.type !== 'duct-fitting') continue
      drawFitting(entities, node, labelHeightM)
    }
  }

  // ── Terminals → squares on the MEP_TERMINAL layer ───────────────────────
  if (drawTerminals) {
    for (const node of Object.values(nodes)) {
      if (node?.type !== 'duct-terminal') continue
      const [x, z] = planPoint(node.position)
      entities.square(x, z, Math.max(node.width / 2, 0.1), 'MEP_TERMINAL')
    }
  }

  // ── Wall penetrations: гильзы/клапаны на пересечениях (Этап 10) ────────
  if (drawPenetrationsOption) {
    drawPenetrations(entities, nodes, walls, barriers)
  }

  // ── Legend of systems below the plan (Этап 10) ──────────────────────────
  const bounds = planBounds(nodes)
  if (bounds) {
    drawSystemLegend(entities, nodes, markings, legendHeightM, bounds)
  }

  const body = [
    layerTable(MEP_LAYERS),
    '0\nSECTION\n2\nENTITIES',
    entities.toString(),
    '0\nENDSEC',
  ].join('\n')

  return `${header}\n${body}\n0\nEOF\n`
}

/** Слой, на который попадёт узел (используется в легенде/панели). */
export function dxfLayerForNode(node: AnyNode): string {
  if (node.type === 'duct-fitting') return 'MEP_FITTING'
  if (node.type === 'duct-terminal') return 'MEP_TERMINAL'
  if (node.type === 'duct-segment') return layerForSystem(node.system)
  return '0'
}

/** Буквенная маркировка системы для легенды DXF. */
export { systemMarkingLetter as dxfSystemLetter }
