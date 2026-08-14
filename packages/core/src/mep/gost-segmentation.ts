import type { AnyNode, AnyNodeId, DuctSegmentNode } from '../schema'
import { DUCT_SEGMENT_LENGTHS_M } from './constants'
import { buildDuctNetworks } from './duct-network'
import type { SystemType } from './norms-types'

/**
 * ГОСТ Р 70349 straight-section decomposition + system marking (П1 / В1 /
 * Р1 per ГОСТ 21.602). Pure logic — the stage-5 inspector ("Разбить по
 * ГОСТ") and the ventilation panel share the same pickers.
 */

/** Буквенная маркировка системы по ГОСТ 21.602: П (приток), В (вытяжка),
 *  Р (рециркуляция). */
export const SYSTEM_MARKING_CHAR: Record<SystemType, string> = {
  supply: 'П',
  exhaust: 'В',
  return: 'Р',
}

/** «П» / «В» / «Р» — буквенный индекс системы для маркировки П1/В1. */
export function systemMarkingLetter(system: SystemType): string {
  return SYSTEM_MARKING_CHAR[system]
}

/** Полная маркировка системы: буква + номер (П1, В2, Р1). */
export function systemMarkingLabel(system: SystemType, number: number): string {
  return `${SYSTEM_MARKING_CHAR[system]}${number}`
}

/** Центральная длина сегмента воздуховода: сумма длин звеньев path, м. */
export function ductSegmentLengthM(segment: DuctSegmentNode): number {
  let total = 0
  for (let i = 0; i < segment.path.length - 1; i += 1) {
    const a = segment.path[i]!
    const b = segment.path[i + 1]!
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  }
  return total
}

/**
 * Разложить длину прямого участка на ГОСТ-длины (0,5 / 1,0 / 1,25 / 2,0 /
 * 2,5 м): жадный набор из самых длинных стандартных звеньев с остатком,
 * который сам является стандартной длиной. Null, когда ряд не покрывает
 * длину (меньше 0,5 м или остаток не стандартный).
 */
export function planGostSegmentation(lengthM: number): number[] | null {
  if (!Number.isFinite(lengthM)) return null
  const eps = 1e-6
  const minLength = DUCT_SEGMENT_LENGTHS_M[0]!
  if (lengthM < minLength - eps) return null

  const lengths = [...DUCT_SEGMENT_LENGTHS_M].sort((a, b) => b - a)
  const round = (value: number) => Math.round(value * 1000) / 1000

  for (const base of lengths) {
    if (base > lengthM + eps) continue
    const count = Math.floor(lengthM / base)
    const remainder = round(lengthM - base * count)
    if (Math.abs(remainder) < eps) return Array(count).fill(base)
    if (lengths.includes(remainder)) return [...Array(count).fill(base), remainder]
    if (count >= 2) {
      const merged = round(remainder + base)
      if (lengths.includes(merged)) return [...Array(count - 1).fill(base), merged]
    }
  }
  return null
}

/** Вершины разбиения прямого участка на ГОСТ-звенья: [начало, …вершины, конец]. */
export function gostSplitPoints(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  lengthsM: readonly number[],
): Array<[number, number, number]> {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const dz = to[2] - from[2]
  const total = Math.hypot(dx, dy, dz) || 1
  const points: Array<[number, number, number]> = [[...from]]
  let acc = 0
  for (const piece of lengthsM) {
    acc += piece
    const t = acc / total
    points.push([from[0] + dx * t, from[1] + dy * t, from[2] + dz * t])
  }
  points[points.length - 1] = [...to]
  return points
}

export type GostSplitPlan = {
  /** Стандартные длины звеньев, м (сумма = длине участка). */
  lengthsM: number[]
  /** Вершины разбиения (lengthsM.length + 1 точка: старт, узлы, финиш). */
  splitPoints: Array<[number, number, number]>
}

/**
 * План «Разбить по ГОСТ» для прямого (двухточечного) участка. Null для
 * ломаных трасс (несколько звеньев) или когда ряд не покрывает длину.
 */
export function planGostSplit(segment: DuctSegmentNode): GostSplitPlan | null {
  if (segment.path.length !== 2) return null
  const from = segment.path[0]!
  const to = segment.path[1]!
  const lengthM = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2])
  const lengthsM = planGostSegmentation(lengthM)
  if (!lengthsM) return null
  return { lengthsM, splitPoints: gostSplitPoints(from, to, lengthsM) }
}

/**
 * Сквозная маркировка П1/В1/Р1 по сетям: каждой сети присваивается номер
 * внутри своей системы, все её участки и фиттинги получают одну маркировку.
 */
export function planSystemMarkings(
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
): Record<AnyNodeId, string> {
  const markings: Record<AnyNodeId, string> = {}
  const counters: Record<SystemType, number> = { supply: 0, exhaust: 0, return: 0 }
  for (const network of buildDuctNetworks(nodes)) {
    let system: SystemType | null = null
    for (const id of network.nodeIds) {
      const node = nodes[id]
      if (node && (node.type === 'duct-segment' || node.type === 'duct-fitting') && node.system) {
        system = node.system as SystemType
        break
      }
    }
    if (!system) continue
    counters[system] += 1
    const label = systemMarkingLabel(system, counters[system]!)
    for (const id of network.nodeIds) {
      const node = nodes[id]
      if (node && (node.type === 'duct-segment' || node.type === 'duct-fitting')) {
        markings[id] = label
      }
    }
  }
  return markings
}
