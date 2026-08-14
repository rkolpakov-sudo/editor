import type {
  AnyNode,
  AnyNodeId,
  DuctFittingNode,
  DuctSegmentNode,
  DuctTerminalNode,
} from '../schema'
import { type DuctSectionProfile, ductSectionPerimeterM } from './aerodynamics'
import { DUCT_SEGMENT_LENGTHS_M } from './constants'
import { planGostSegmentation } from './gost-segmentation'
import type { SystemType } from './norms-types'
import {
  checkFireBarrierCrossing,
  checkWallPenetration,
  planRunMounting,
  supportCountForRun,
  type WallLike,
  wallBarrierRect,
} from './routing-rules'

/**
 * Ведомость материалов (спецификация) системы вентиляции по ГОСТ-номенклатуре
 * Р 70349 / СП 73 — «Спецификация» Этапа 6. Чистая логика над сценой: группирует
 * воздуховоды по профилю и системе, разлагает на стандартные звенья ГОСТ,
 * считает фасонные части, решётки, крепления и проходы через стены.
 * Не зависит от реестра (registry) — работает на любом `Record<AnyNodeId, AnyNode>`.
 */

/** Reference density of sheet steel, kg/m³ (оцинкованная сталь). */
export const STEEL_DENSITY_KG_M3 = 7850
/** Working sheet thickness for the mass column, m (docs/mep/02: 0,5–1,0 мм). */
export const SPEC_SHEET_THICKNESS_M = 0.8e-3

export type DuctSpecUnit = 'шт' | 'м' | 'м²' | 'кг'

export type DuctSpecItem = {
  /** Позиция в ведомости (1, 2, 3, …). */
  pos: number
  /** Наименование, напр. «Воздуховод круглый Ø160». */
  name: string
  /** Обозначение по ГОСТ / типовому ряду. */
  designation: string
  /** Система, если позиция принадлежит одной из П/В/Р. */
  system?: SystemType
  unit: DuctSpecUnit
  quantity: number
  /** Суммарная длина, м (для воздуховодов). */
  lengthM?: number
  /** Примечание — разбивка на звенья ГОСТ, свободные длины и т.п. */
  note?: string
}

export type SystemSummaryRow = {
  system: SystemType
  /** Маркировка по ГОСТ 21.602 (П1 / В1 / Р1). */
  marking: string
  segments: number
  fittings: number
  terminals: number
  lengthM: number
  sheetAreaM2: number
  massKg: number
}

export type DuctSpecification = {
  systems: SystemSummaryRow[]
  sections: {
    ducts: DuctSpecItem[]
    fittings: DuctSpecItem[]
    terminals: DuctSpecItem[]
    hardware: DuctSpecItem[]
  }
  totals: {
    lengthM: number
    sheetAreaM2: number
    massKg: number
    supports: number
    sleeves: number
    fireDampers: number
    fittings: number
    terminals: number
  }
  warnings: string[]
}

export type DuctSpecificationOptions = {
  /** Стены для учёта проходов (гильзы). Может быть просто `WallNode[]`. */
  walls?: readonly WallLike[]
  /** Огнестойкие преграды для учёта противопожарных клапанов (СП 7.13130). */
  fireRatedBarriers?: readonly WallLike[]
  /** Готовая маркировка сетей (см. `planSystemMarkings`); без неё — по буквам системы. */
  markings?: Readonly<Record<AnyNodeId, string>>
}

// ── Segment profile helpers ───────────────────────────────────────────────

type SegmentSize = {
  sizeKey: string
  label: string
  sizeMm: number
  profile: DuctSectionProfile
}

function segmentSize(node: DuctSegmentNode): SegmentSize {
  if (node.shape === 'round') {
    return {
      sizeKey: `r${node.diameter}`,
      label: `Ø${node.diameter}`,
      sizeMm: node.diameter,
      profile: { shape: 'round', diameterMm: node.diameter },
    }
  }
  return {
    sizeKey: `x${node.width}x${node.height}`,
    label: `${node.width}×${node.height}`,
    sizeMm: Math.max(node.width, node.height),
    profile: { shape: node.shape, widthMm: node.width, heightMm: node.height },
  }
}

function fittingSizeLabel(node: DuctFittingNode): string {
  if (node.shape === 'round') return `Ø${node.diameter}`
  return `${node.width}×${node.height}`
}

function fittingBranchLabel(node: DuctFittingNode): string {
  if (node.shape2 === 'round') return `Ø${node.diameter2}`
  return `${node.width2}×${node.height2}`
}

/** Total polyline length of a segment, m. */
function segmentLengthM(node: DuctSegmentNode): number {
  let total = 0
  for (let i = 0; i < node.path.length - 1; i += 1) {
    const a = node.path[i]!
    const b = node.path[i + 1]!
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  }
  return total
}

/** Supports on a (possibly bent) segment, counted per straight leg. */
function segmentSupports(node: DuctSegmentNode, size: SegmentSize): number {
  let count = 0
  for (let i = 0; i < node.path.length - 1; i += 1) {
    const a = node.path[i]!
    const b = node.path[i + 1]!
    const legLength = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    count += supportCountForRun(legLength, node.shape, size.sizeMm)
  }
  return count
}

// ── Main builder ──────────────────────────────────────────────────────────

/** Marking fallback when the caller did not pass `planSystemMarkings`: one
 *  system letter per air loop type. */
function defaultMarkings(nodes: Readonly<Record<AnyNodeId, AnyNode>>): Record<AnyNodeId, string> {
  const markings: Record<AnyNodeId, string> = {}
  const counters: Record<SystemType, number> = { supply: 0, exhaust: 0, return: 0 }
  for (const node of Object.values(nodes)) {
    if (!node) continue
    if (node.type !== 'duct-segment' && node.type !== 'duct-fitting') continue
    const system = node.system as SystemType
    counters[system] += 1
    markings[node.id] = `${system === 'supply' ? 'П' : system === 'exhaust' ? 'В' : 'Р'}${
      counters[system]
    }`
  }
  return markings
}

/** Канонический ключ длины (без «.0»): 1.0 → «1», 2.5 → «2.5». */
function pieceKey(lengthM: number): string {
  return String(Math.round(lengthM * 100) / 100)
}

/** Отображение длины с дробной частью: 2.5 → «2,5», 1.0 → «1,0». */
function formatPieceLength(lengthM: number): string {
  return (Math.round(lengthM * 100) / 100).toFixed(1).replace('.', ',')
}

function formatPieces(pieces: Map<string, number>, customCount: number): string | null {
  const parts: string[] = []
  const sorted = [...DUCT_SEGMENT_LENGTHS_M].sort((a, b) => b - a)
  for (const length of sorted) {
    const count = pieces.get(pieceKey(length))
    if (count && count > 0) parts.push(`${formatPieceLength(length)} м × ${count}`)
  }
  if (customCount > 0) parts.push(`${customCount} × нестандартная длина`)
  return parts.length > 0 ? `Звенья: ${parts.join(', ')}` : null
}

/** Группировка звеньев ГОСТ для группы участков: {длина → кол-во} + счётчик
 *  нестандартных (не разложившихся) участков. */
function gostPieceCounts(segments: readonly DuctSegmentNode[]): {
  pieces: Map<string, number>
  customCount: number
} {
  const pieces = new Map<string, number>()
  let customCount = 0
  for (const segment of segments) {
    const plan = planGostSegmentation(segmentLengthM(segment))
    if (!plan) {
      customCount += 1
      continue
    }
    for (const piece of plan) {
      const key = pieceKey(piece)
      pieces.set(key, (pieces.get(key) ?? 0) + 1)
    }
  }
  return { pieces, customCount }
}

/** Build the full material specification for all duct nodes in the scene. */
export function buildDuctSpecification(
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
  options: DuctSpecificationOptions = {},
): DuctSpecification {
  const markings = options.markings ?? defaultMarkings(nodes)
  const segments: DuctSegmentNode[] = []
  const fittings: DuctFittingNode[] = []
  const terminals: DuctTerminalNode[] = []
  for (const node of Object.values(nodes)) {
    if (!node) continue
    if (node.type === 'duct-segment') segments.push(node)
    else if (node.type === 'duct-fitting') fittings.push(node)
    else if (node.type === 'duct-terminal') terminals.push(node)
  }

  // ── Duct groups ─────────────────────────────────────────────────────────
  type DuctGroup = {
    key: string
    system: SystemType
    shape: DuctSegmentNode['shape']
    size: SegmentSize
    segments: DuctSegmentNode[]
    lengthM: number
    supports: number
  }
  const ductGroups = new Map<string, DuctGroup>()
  for (const segment of segments) {
    const size = segmentSize(segment)
    const key = `${segment.system}|${segment.shape}|${size.sizeKey}`
    let group = ductGroups.get(key)
    if (!group) {
      group = {
        key,
        system: segment.system,
        shape: segment.shape,
        size,
        segments: [],
        lengthM: 0,
        supports: 0,
      }
      ductGroups.set(key, group)
    }
    group.segments.push(segment)
    group.lengthM += segmentLengthM(segment)
    group.supports += segmentSupports(segment, size)
  }

  // ── Wall penetrations (sleeves + fire dampers) ─────────────────────────
  const walls = options.walls ?? []
  const barriers = options.fireRatedBarriers ?? []
  let sleeves = 0
  let fireDampers = 0
  for (const segment of segments) {
    const size = segmentSize(segment)
    for (let i = 0; i < segment.path.length - 1; i += 1) {
      const a = segment.path[i]!
      const b = segment.path[i + 1]!
      const leg = {
        from: [a[0], a[2]] as const,
        to: [b[0], b[2]] as const,
        shape: segment.shape,
        sizeMm: size.sizeMm,
      }
      for (const wall of walls) {
        if (checkWallPenetration(leg, wallBarrierRect(wall))) sleeves += 1
      }
      for (const barrier of barriers) {
        if (checkFireBarrierCrossing(leg, wallBarrierRect(barrier))) fireDampers += 1
      }
    }
  }

  // ── System summaries ────────────────────────────────────────────────────
  const bySystem = new Map<SystemType, DuctGroup[]>()
  for (const group of ductGroups.values()) {
    const list = bySystem.get(group.system) ?? []
    list.push(group)
    bySystem.set(group.system, list)
  }
  const systems: SystemSummaryRow[] = (['supply', 'exhaust', 'return'] as const)
    .map((system) => {
      const groups = bySystem.get(system) ?? []
      const lengthM = groups.reduce((sum, g) => sum + g.lengthM, 0)
      const sheetAreaM2 = groups.reduce(
        (sum, g) => sum + ductSectionPerimeterM(g.size.profile) * g.lengthM,
        0,
      )
      const massKg = sheetAreaM2 * SPEC_SHEET_THICKNESS_M * STEEL_DENSITY_KG_M3
      const fittingsCount = fittings.filter((f) => f.system === system).length
      const terminalsCount = terminals.filter(
        (t) => (t.terminalType === 'return-grille' ? 'return' : 'supply') === system,
      ).length
      const firstSegmentId = segments.find((s) => s.system === system)?.id
      return {
        system,
        marking:
          (firstSegmentId !== undefined ? markings[firstSegmentId] : undefined) ??
          (system === 'supply' ? 'П1' : system === 'exhaust' ? 'В1' : 'Р1'),
        segments: groups.reduce((sum, g) => sum + g.segments.length, 0),
        fittings: fittingsCount,
        terminals: terminalsCount,
        lengthM,
        sheetAreaM2,
        massKg,
      }
    })
    .filter((row) => row.segments > 0 || row.fittings > 0 || row.terminals > 0)

  // ── Table rows ──────────────────────────────────────────────────────────
  const warnings: string[] = []
  let pos = 0
  const nextPos = () => (pos += 1)

  const ductRows: DuctSpecItem[] = []
  for (const [key, group] of [...ductGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    void key
    const { pieces, customCount } = gostPieceCounts(group.segments)
    const shapeName =
      group.shape === 'round'
        ? 'круглый'
        : group.shape === 'rect'
          ? 'прямоугольный'
          : 'плоско-овальный'
    const designation = `ГОСТ Р 70349 · ${group.size.label}`
    ductRows.push({
      pos: nextPos(),
      name: `Воздуховод ${shapeName} ${group.size.label}`,
      designation,
      system: group.system,
      unit: 'м',
      quantity: Math.round(group.lengthM * 1000) / 1000,
      lengthM: group.lengthM,
      note: formatPieces(pieces, customCount) ?? undefined,
    })
    if (customCount > 0) {
      warnings.push(
        `Позиция «${ductRows[ductRows.length - 1]!.name}» содержит ${customCount} участок(ов) нестандартной длины — их нужно изготовить по месту.`,
      )
    }
    if (group.supports > 0) {
      ductRows.push({
        pos: nextPos(),
        name: `Кронштейн для воздуховода ${group.size.label}`,
        designation: 'СП 73.13330',
        system: group.system,
        unit: 'шт',
        quantity: group.supports,
        note: `Шаг: ${planRunMounting({
          from: [0, 0],
          to: [1, 0],
          shape: group.shape,
          sizeMm: group.size.sizeMm,
        })
          .spacingM.toFixed(0)
          .replace('.', ',')} м`,
      })
    }
  }

  const fittingRows: DuctSpecItem[] = []
  type FittingGroup = {
    node: DuctFittingNode
    name: string
    designation: string
    count: number
  }
  const fittingGroups = new Map<string, FittingGroup>()
  const pushFitting = (node: DuctFittingNode, name: string, designation: string) => {
    const key = `${node.fittingType}|${node.system}|${name}`
    const entry = fittingGroups.get(key)
    if (entry) {
      entry.count += 1
    } else {
      fittingGroups.set(key, { node, name, designation, count: 1 })
    }
  }
  for (const fitting of fittings) {
    const label = fittingSizeLabel(fitting)
    switch (fitting.fittingType) {
      case 'elbow':
        pushFitting(
          fitting,
          `Отвод ${fitting.angle}° ${label} R=${fitting.offsetRadiusFactor}D`,
          'ГОСТ Р 70349 · отвод',
        )
        break
      case 'offset':
        pushFitting(
          fitting,
          `Утка ${fitting.angle}° ${label}, сдвиг ${fitting.offset} мм`,
          'ГОСТ Р 70349 · утка',
        )
        break
      case 'reducer':
        pushFitting(
          fitting,
          `Переход ${label} → ${fittingBranchLabel(fitting)}`,
          'ГОСТ Р 70349 · переход',
        )
        break
      case 'transition':
        pushFitting(
          fitting,
          `Переход кругло-прямоугольный ${label} → Ø${fitting.diameter2}`,
          'ГОСТ Р 70349 · переход',
        )
        break
      case 'tee':
        pushFitting(
          fitting,
          `Тройник ${label}, ответвление ${fittingBranchLabel(fitting)}`,
          'ГОСТ Р 70349 · тройник',
        )
        break
      case 'cross':
        pushFitting(
          fitting,
          `Крестовина ${label}, ответвления ${fittingBranchLabel(fitting)}`,
          'ГОСТ Р 70349 · крестовина',
        )
        break
    }
  }
  for (const [key, entry] of [...fittingGroups.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    void key
    fittingRows.push({
      pos: nextPos(),
      name: entry.name,
      designation: entry.designation,
      system: entry.node.system,
      unit: 'шт',
      quantity: entry.count,
    })
  }

  const terminalRows: DuctSpecItem[] = []
  for (const type of ['supply-register', 'diffuser', 'return-grille'] as const) {
    const items = terminals.filter((t) => t.terminalType === type)
    if (items.length === 0) continue
    const name =
      type === 'supply-register'
        ? 'Решётка приточная'
        : type === 'diffuser'
          ? 'Диффузор потолочный'
          : 'Решётка вытяжная'
    terminalRows.push({
      pos: nextPos(),
      name,
      designation: 'Типовой ряд производителя',
      system: (type === 'return-grille' ? 'return' : 'supply') as SystemType,
      unit: 'шт',
      quantity: items.length,
    })
  }

  const hardwareRows: DuctSpecItem[] = []
  if (sleeves > 0) {
    hardwareRows.push({
      pos: nextPos(),
      name: 'Гильза (проход через стену)',
      designation: 'СП 73.13330 · негорючее уплотнение',
      unit: 'шт',
      quantity: sleeves,
      note: 'См. Этап 6 — проходы через стены',
    })
  }
  if (fireDampers > 0) {
    hardwareRows.push({
      pos: nextPos(),
      name: 'Клапан противопожарный',
      designation: 'СП 7.13130',
      unit: 'шт',
      quantity: fireDampers,
    })
  }

  const totals = {
    lengthM:
      ductGroups.size > 0 ? [...ductGroups.values()].reduce((sum, g) => sum + g.lengthM, 0) : 0,
    sheetAreaM2: [...ductGroups.values()].reduce(
      (sum, g) => sum + ductSectionPerimeterM(g.size.profile) * g.lengthM,
      0,
    ),
    massKg: [...ductGroups.values()].reduce(
      (sum, g) =>
        sum +
        ductSectionPerimeterM(g.size.profile) *
          g.lengthM *
          SPEC_SHEET_THICKNESS_M *
          STEEL_DENSITY_KG_M3,
      0,
    ),
    supports: [...ductGroups.values()].reduce((sum, g) => sum + g.supports, 0),
    sleeves,
    fireDampers,
    fittings: fittings.length,
    terminals: terminals.length,
  }

  return {
    systems,
    sections: {
      ducts: ductRows,
      fittings: fittingRows,
      terminals: terminalRows,
      hardware: hardwareRows,
    },
    totals,
    warnings,
  }
}

// ── CSV serialization ─────────────────────────────────────────────────────

const SECTION_LABEL: Record<keyof DuctSpecification['sections'], string> = {
  ducts: 'Воздуховоды',
  fittings: 'Фасонные части',
  terminals: 'Воздухораспределители',
  hardware: 'Изделия и крепления',
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function specRowToCsv(row: DuctSpecItem, marking: (system?: SystemType) => string): string {
  return [
    row.pos,
    row.name,
    row.designation,
    marking(row.system),
    row.unit,
    row.quantity,
    row.lengthM !== undefined ? row.lengthM.toFixed(2) : '',
    row.note ?? '',
  ]
    .map(csvCell)
    .join(';')
}

/** Ведомость в формате CSV (разделитель «;», совместим с русской Excel). */
export function specificationToCsv(specification: DuctSpecification): string {
  const marking = (system?: SystemType) => {
    if (!system) return '—'
    return specification.systems.find((row) => row.system === system)?.marking ?? system
  }
  const header = [
    'Позиция',
    'Наименование',
    'Обозначение',
    'Система',
    'Ед.',
    'Кол-во',
    'Длина, м',
    'Примечание',
  ]
  const lines: string[] = [header.map(csvCell).join(';')]
  for (const [section, rows] of Object.entries(specification.sections) as [
    keyof DuctSpecification['sections'],
    DuctSpecItem[],
  ][]) {
    lines.push(`[${SECTION_LABEL[section]}]`)
    for (const row of rows) lines.push(specRowToCsv(row, marking))
  }
  const totals = specification.totals
  lines.push('[Итого]')
  lines.push(`;Суммарная длина воздуховодов;;;;${totals.lengthM.toFixed(2)};м`)
  lines.push(`;Площадь листовой стали;;;;${totals.sheetAreaM2.toFixed(2)};м²`)
  lines.push(
    `;Масса стали (δ=${(SPEC_SHEET_THICKNESS_M * 1000).toFixed(1)} мм);;;;${totals.massKg.toFixed(1)};кг`,
  )
  lines.push(`;Крепления;;;;${totals.supports};шт`)
  lines.push(`;Гильзы;;;;${totals.sleeves};шт`)
  lines.push(`;Клапаны противопожарные;;;;${totals.fireDampers};шт`)
  return `${lines.join('\n')}\n`
}

/** Ведомость в виде простого текста для панели/печати. */
export function specificationToText(specification: DuctSpecification): string {
  const lines: string[] = []
  for (const row of specification.systems) {
    lines.push(
      `${row.marking} (${row.system}) — ${row.lengthM.toFixed(1)} м, ${row.segments} участков, ${row.fittings} фитингов, ${row.terminals} решёток`,
    )
  }
  for (const [section, rows] of Object.entries(specification.sections) as [
    keyof DuctSpecification['sections'],
    DuctSpecItem[],
  ][]) {
    lines.push(`\n${SECTION_LABEL[section]}:`)
    for (const row of rows) {
      lines.push(
        `  ${row.pos}. ${row.name} — ${row.quantity} ${row.unit}${row.lengthM !== undefined ? ` (${row.lengthM.toFixed(2)} м)` : ''}`,
      )
    }
  }
  return lines.join('\n')
}
