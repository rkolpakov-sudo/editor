import { BYPASS_MIN_GAP_MM, ELBOW_RADIUS_FACTOR, ELBOW_RADIUS_FACTOR_SHORT } from './constants'
import { EQUAL_FRICTION_DEFAULT_PA_PER_M } from './sizing'

/**
 * «Предпочтения трассировки» — редактируемые данные по образцу Revit Routing
 * Preferences (PLAN-AGENT §2.3), не код. Этапы конвейера агента читают их:
 * подбор сечений — `sizingMethod`/`equalFrictionPaPerM`, фиттинги сопряжений —
 * `branchFitting`/`saddleMaxDiameterRatio`/`branchTapAngleDeg`/`elbowRadiusFactor`,
 * автоответвления (C3) — `terminalConnectToleranceM`, утка — `bypassGapMm`.
 * Каждое решение агента в панели аннотируется ссылкой на конкретное
 * предпочтение. UI редактирования — этап C.
 */

export type BranchFittingPreference = 'auto' | 'tee' | 'saddle'
export type SizingMethodPreference = 'velocity-sp60' | 'equal-friction'

export type RoutingPreferences = {
  /** Фиттинг врезки ответвления в магистраль; `auto` решает по отношению
   *  диаметров (`saddleMaxDiameterRatio`). */
  branchFitting: BranchFittingPreference
  /** Порог «ответвление ≤ доля магистрали» для седелки в режиме auto. */
  saddleMaxDiameterRatio: number
  /** Приоритетный угол врезки ответвления (45° теряет меньше давления). */
  branchTapAngleDeg: 45 | 90
  /** Радиус отводов, R/D. */
  elbowRadiusFactor: number
  /** Метод подбора сечений. */
  sizingMethod: SizingMethodPreference
  /** Цель удельных потерь метода равных потерь, Па/м. */
  equalFrictionPaPerM: number
  /** Допуск подключения терминала к магистрали (автоответвления C3), м. */
  terminalConnectToleranceM: number
  /** Зазор между корпусами на утке, мм (СП-практика монтажа). */
  bypassGapMm: number
}

/** Рабочий порог седелки: ответвление не больше половины магистрали по
 *  диаметру. Не норматив — предпочтение по умолчанию, меняется в UI. */
export const DEFAULT_SADDLE_MAX_DIAMETER_RATIO = 0.5

/** Допуск подключения терминала к магистрали по умолчанию, м (шире допуска
 *  привязки концов эскиза: автотрасса сама доходит до магистрали). */
export const DEFAULT_TERMINAL_CONNECT_TOLERANCE_M = 1

export const DEFAULT_ROUTING_PREFERENCES: RoutingPreferences = {
  branchFitting: 'auto',
  saddleMaxDiameterRatio: DEFAULT_SADDLE_MAX_DIAMETER_RATIO,
  branchTapAngleDeg: 45,
  elbowRadiusFactor: ELBOW_RADIUS_FACTOR,
  sizingMethod: 'velocity-sp60',
  equalFrictionPaPerM: EQUAL_FRICTION_DEFAULT_PA_PER_M,
  terminalConnectToleranceM: DEFAULT_TERMINAL_CONNECT_TOLERANCE_M,
  bypassGapMm: BYPASS_MIN_GAP_MM,
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/** Нормализовать частичные/пользовательские предпочтения: неизвестные
 *  значения заменяются дефолтами, числа зажимаются в разумные диапазоны. */
export function normalizeRoutingPreferences(
  input: Partial<RoutingPreferences> = {},
): RoutingPreferences {
  const merged = { ...DEFAULT_ROUTING_PREFERENCES, ...input }
  return {
    branchFitting:
      merged.branchFitting === 'tee' || merged.branchFitting === 'saddle'
        ? merged.branchFitting
        : 'auto',
    saddleMaxDiameterRatio: clampNumber(
      merged.saddleMaxDiameterRatio,
      0.2,
      0.95,
      DEFAULT_SADDLE_MAX_DIAMETER_RATIO,
    ),
    branchTapAngleDeg: merged.branchTapAngleDeg === 90 ? 90 : 45,
    elbowRadiusFactor: clampNumber(
      merged.elbowRadiusFactor,
      ELBOW_RADIUS_FACTOR_SHORT,
      2,
      ELBOW_RADIUS_FACTOR,
    ),
    sizingMethod: merged.sizingMethod === 'equal-friction' ? 'equal-friction' : 'velocity-sp60',
    equalFrictionPaPerM: clampNumber(
      merged.equalFrictionPaPerM,
      0.1,
      10,
      EQUAL_FRICTION_DEFAULT_PA_PER_M,
    ),
    terminalConnectToleranceM: clampNumber(
      merged.terminalConnectToleranceM,
      0.05,
      5,
      DEFAULT_TERMINAL_CONNECT_TOLERANCE_M,
    ),
    bypassGapMm: Math.round(clampNumber(merged.bypassGapMm, 20, 500, BYPASS_MIN_GAP_MM)),
  }
}
