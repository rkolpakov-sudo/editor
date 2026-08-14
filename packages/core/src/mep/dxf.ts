import type { AnyNode, AnyNodeId } from '../schema'
import { systemMarkingLetter } from './gost-segmentation'
import type { SystemType } from './norms-types'

/**
 * Экспорт плана вентиляции в ASCII DXF (Этап 6). Чистая функция над сценой:
 * проецирует трассы воздуховодов на план (x, z → X, Y), раскладывает их по
 * слоям системы (П/В/Р), рисует фитинги кругами, решётки квадратами и ставит
 * маркировку П1/В1/Р1 по ГОСТ 21.602. Не требует Three.js — только строки.
 */

export type DxfExportOptions = {
  /** Высота текста маркировки в метрах плана. */
  labelHeightM?: number
  /** Рисовать фитинги (круги) — включено по умолчанию. */
  drawFittings?: boolean
  /** Рисовать решётки/диффузоры (квадраты) — включено по умолчанию. */
  drawTerminals?: boolean
  /** Готовая маркировка сетей; без неё — по буквам системы (П1/В1/Р1). */
  markings?: Readonly<Record<AnyNodeId, string>>
}

const DXF_LAYER_COLORS: Record<string, number> = {
  '0': 7,
  MEP_SUPPLY: 1,
  MEP_EXHAUST: 3,
  MEP_RETURN: 5,
  MEP_FITTING: 8,
  MEP_TERMINAL: 2,
}

function layerForSystem(system: SystemType): string {
  return system === 'supply' ? 'MEP_SUPPLY' : system === 'exhaust' ? 'MEP_EXHAUST' : 'MEP_RETURN'
}

/** Плановая проекция точки path/position [x, y, z] → [X, Y] плана DXF. */
function planPoint(point: readonly [number, number, number]): readonly [number, number] {
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

/** Сгенерировать ASCII DXF плана вентиляции для сцены. */
export function ductsToDxf(
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
  options: DxfExportOptions = {},
): string {
  const labelHeightM = options.labelHeightM ?? 0.35
  const drawFittings = options.drawFittings ?? true
  const drawTerminals = options.drawTerminals ?? true
  const markings = options.markings ?? perSystemMarkings(nodes)

  const layers = ['0', 'MEP_SUPPLY', 'MEP_EXHAUST', 'MEP_RETURN', 'MEP_FITTING', 'MEP_TERMINAL']

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
      const mid: readonly [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      entities.text(mid[0], mid[1], labelHeightM, mark, layer)
    }
  }

  // ── Fittings → circles on the MEP_FITTING layer ─────────────────────────
  if (drawFittings) {
    for (const node of Object.values(nodes)) {
      if (node?.type !== 'duct-fitting') continue
      const [x, z] = planPoint(node.position)
      const body = node.shape === 'round' ? node.diameter : Math.max(node.width, node.height)
      entities.circle(x, z, Math.max(body / 1000 / 2, 0.05), 'MEP_FITTING')
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

  const body = [
    layerTable(layers),
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
