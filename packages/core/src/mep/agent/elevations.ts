import { type DuctSectionProfile, profileBodyWidthM } from '../aerodynamics'
import { DUCT_CLEARANCE_MM } from '../constants'
import type { RecognizedTopology } from './recognize-topology'

/**
 * Этап 4 конвейера агента автотрассировки (PLAN-AGENT §2.2, §2.5): оси
 * воздуховода на вершинах эскиза. Модель «как в Revit»: `'auto'` держит ось
 * под потолком (потолок − зазор − изоляция − H/2), fixed `{ axisM }` пинит
 * ось к абсолютной отметке над полом уровня; соседние вершины с разными
 * осями дают вертикальный участок (два отвода R=1.5D добавит этап фиттингов).
 * Проверки: верх (с изоляцией) ≤ перекрытие − зазор; низ ≥ пола. Нарушения —
 * блокеры W3: смонтировать такой участок невозможно. Параллель П/В и
 * разворот по высоте — решение построения (build-plan), не здесь.
 */

const MM_TO_M = 1 / 1000

/** Ось по умолчанию, когда профиль ещё не подобран ('auto' без сечения):
 *  тело Ø250 как консервативная оценка магистрали + предупреждение. */
const ASSUMED_BODY_M = 0.25

export type ElevationOptions = {
  /** Чистая высота потолка уровня, м (по умолчанию 2.7 — дефолт зоны). */
  ceilingHeightM?: number
  /** Нормативный зазор верха воздуховода до перекрытия, мм
   *  (по умолчанию минимум `DUCT_CLEARANCE_MM`). */
  clearanceMm?: number
  /** Толщина изоляции поверх воздуховода, мм (учёт в проверке верха и auto). */
  insulationMm?: number
  /** Потолок по путям: у пути может быть своя зона выше/ниже уровня. */
  ceilingHeightMByPath?: Readonly<Record<number, number>>
}

export type PathElevation = {
  pathIndex: number
  /** Ось воздуховода на каждой вершине пути, м над полом уровня. */
  axisM: number[]
  /** Вертикальные участки между соседними вершинами с разными осями. */
  verticals: { afterVertexIndex: number; riseM: number }[]
}

export type ElevationIssueCode = 'duct-above-ceiling' | 'duct-below-floor' | 'auto-without-profile'

export type ElevationIssue = {
  severity: 'blocker' | 'warning'
  code: ElevationIssueCode
  message: string
  pathIndex?: number
  vertexIndex?: number
}

export type ElevationResult = {
  elevations: PathElevation[]
  issues: ElevationIssue[]
}

const AXIS_EPS_M = 1e-6

/** Оси вершин всех путей топологии + проверки размещения по высоте. */
export function resolvePathElevations(
  topology: RecognizedTopology,
  profilesByPath: Readonly<Record<number, DuctSectionProfile | null>>,
  options: ElevationOptions = {},
): ElevationResult {
  const ceilingDefault = options.ceilingHeightM ?? 2.7
  const clearanceM = (options.clearanceMm ?? DUCT_CLEARANCE_MM.min) * MM_TO_M
  const insulationM = (options.insulationMm ?? 0) * MM_TO_M
  const issues: ElevationIssue[] = []

  const elevations: PathElevation[] = topology.paths.map((path, pathIndex) => {
    const profile = profilesByPath[pathIndex] ?? null
    const bodyM = profile ? profileBodyWidthM(profile) : ASSUMED_BODY_M
    if (!profile) {
      issues.push({
        severity: 'warning',
        code: 'auto-without-profile',
        message: `Полилиния №${path.sourceRunIndex + 1} (${path.system}): сечение не подобрано — ось 'auto' считается для тела Ø${(ASSUMED_BODY_M * 1000).toFixed(0)} мм.`,
        pathIndex,
      })
    }
    const ceilingM = options.ceilingHeightMByPath?.[pathIndex] ?? ceilingDefault
    const halfBodyM = bodyM / 2
    const topLimitM = ceilingM - clearanceM

    const axisM = path.points.map((point, vertexIndex) => {
      if (point.elev === 'auto') return topLimitM - insulationM - halfBodyM
      const axis = point.elev.axisM
      const topM = axis + halfBodyM + insulationM
      if (topM > topLimitM + AXIS_EPS_M) {
        issues.push({
          severity: 'blocker',
          code: 'duct-above-ceiling',
          message: `Полилиния №${path.sourceRunIndex + 1}: верх воздуховода (${topM.toFixed(3)} м) выше потолка с зазором (${topLimitM.toFixed(3)} м) — опустите фиксированную ось.`,
          pathIndex,
          vertexIndex,
        })
      }
      const bottomM = axis - halfBodyM
      if (bottomM < -AXIS_EPS_M) {
        issues.push({
          severity: 'blocker',
          code: 'duct-below-floor',
          message: `Полилиния №${path.sourceRunIndex + 1}: низ воздуховода (${bottomM.toFixed(3)} м) ниже пола — поднимите фиксированную ось.`,
          pathIndex,
          vertexIndex,
        })
      }
      return axis
    })

    const verticals: PathElevation['verticals'] = []
    for (let i = 0; i < axisM.length - 1; i += 1) {
      const riseM = axisM[i + 1]! - axisM[i]!
      if (Math.abs(riseM) > AXIS_EPS_M) verticals.push({ afterVertexIndex: i, riseM })
    }

    return { pathIndex, axisM, verticals }
  })

  return { elevations, issues }
}
