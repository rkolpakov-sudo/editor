import type { DuctSketchRun } from '../../schema'
import type { SystemType } from '../norms-types'
import type { PlanPoint } from '../routing-rules'

/**
 * Этап 0 конвейера агента автотрассировки (PLAN-AGENT §2.2): валидация
 * эскиза до распознавания топологии. Политика W3 — блокеры («не строить»)
 * отделены от предупреждений («строить best-effort + маркер»); каждое
 * сообщение — конкретное и actionable (W1, W13). Чистая логика: только
 * геометрия полилиний и опциональный контекст уровня, без хранилища.
 */

/** Совпадение точек считаем нулевым участком. Метры на плане. */
const COINCIDENT_EPS_M = 1e-6

export type SketchIssueSeverity = 'blocker' | 'warning'

export type SketchIssue = {
  severity: SketchIssueSeverity
  /** Машиночитаемый код для UI (панель «Решения трассировки»). */
  code:
    | 'no-runs'
    | 'single-point-run'
    | 'zero-length-segment'
    | 'self-crossing'
    | 'self-overlap'
    | 'runs-overlap'
    | 'no-equipment'
    | 'no-exhaust-run'
    | 'no-supply-run'
    | 'out-of-bounds'
  message: string
  /** Полилиния эскиза, к которой относится замечание. */
  runIndex?: number
  /** Индекс точки внутри полилинии (начало дефектного участка). */
  pointIndex?: number
}

/** Габариты уровня в метрах (мин/макс по X/Z плана). */
export type LevelBounds = { minXM: number; minZM: number; maxXM: number; maxZM: number }

export type SketchValidationOptions = {
  /** Есть ли на уровне установка (hvac-equipment). Неизвестно — проверка пропускается. */
  hasEquipment?: boolean
  /** Габариты уровня: точки вне границ — блокер (W13 «эскиз вне габаритов»). */
  bounds?: LevelBounds
}

/** Коллинеарное наложение двух отрезков: середина общей части и её длина.
 *  Касание в одной точке (в т.ч. стык соседних участков) — не наложение. */
function collinearOverlap(
  a: PlanPoint,
  b: PlanPoint,
  c: PlanPoint,
  d: PlanPoint,
): { at: PlanPoint; lengthM: number } | null {
  const rx = b[0] - a[0]
  const ry = b[1] - a[1]
  const sx = d[0] - c[0]
  const sy = d[1] - c[1]
  const lenR = Math.hypot(rx, ry)
  const lenS = Math.hypot(sx, sy)
  if (lenR < COINCIDENT_EPS_M || lenS < COINCIDENT_EPS_M) return null
  const cross = rx * sy - ry * sx
  if (Math.abs(cross) > 1e-9 * lenR * lenS) return null
  // Параллельности мало: отрезки должны лежать на одной прямой.
  const offC = Math.abs(rx * (c[1] - a[1]) - ry * (c[0] - a[0])) / lenR
  if (offC > COINCIDENT_EPS_M) return null
  const tc = ((c[0] - a[0]) * rx + (c[1] - a[1]) * ry) / (lenR * lenR)
  const td = ((d[0] - a[0]) * rx + (d[1] - a[1]) * ry) / (lenR * lenR)
  const lo = Math.max(0, Math.min(tc, td))
  const hi = Math.min(1, Math.max(tc, td))
  const overlap = hi - lo
  if (overlap * lenR <= COINCIDENT_EPS_M) return null
  const mid = (lo + hi) / 2
  return { at: [a[0] + rx * mid, a[1] + ry * mid], lengthM: overlap * lenR }
}

/** Собственное пересечение отрезков строго внутри обоих (касания в общих
 *  вершинах полилинии — норма, не дефект). */
function properSelfCrossing(a: PlanPoint, b: PlanPoint, c: PlanPoint, d: PlanPoint): boolean {
  const rx = b[0] - a[0]
  const ry = b[1] - a[1]
  const sx = d[0] - c[0]
  const sy = d[1] - c[1]
  const denom = rx * sy - ry * sx
  if (Math.abs(denom) < 1e-9) return false
  const cx = c[0] - a[0]
  const cy = c[1] - a[1]
  const t = (cx * sy - cy * sx) / denom
  const u = (cx * ry - cy * rx) / denom
  const inner = 1e-6
  return t > inner && t < 1 - inner && u > inner && u < 1 - inner
}

const SYSTEM_LABELS: Record<SystemType, string> = {
  supply: 'П',
  exhaust: 'В',
  return: 'Р',
}

/**
 * Валидировать полилинии эскиза. Возвращает список замечаний; построение
 * разрешено только при отсутствии блокеров (`hasBlockers`). Элементы
 * детерминированы: сначала проверки отдельных полилиний (в порядке эскиза),
 * затем межполилиненные наложения, затем контекст уровня.
 */
export function validateSketch(
  runs: readonly DuctSketchRun[],
  options: SketchValidationOptions = {},
): SketchIssue[] {
  const issues: SketchIssue[] = []

  if (runs.length === 0) {
    issues.push({
      severity: 'blocker',
      code: 'no-runs',
      message: 'Эскиз пуст: нарисуйте трассы режимом «Эскиз» duct-инструмента.',
    })
    return issues
  }

  runs.forEach((run, runIndex) => {
    if (run.points.length < 2) {
      issues.push({
        severity: 'blocker',
        code: 'single-point-run',
        message: `Полилиния №${runIndex + 1}: ${run.points.length} точка(и) — нужно минимум 2.`,
        runIndex,
        pointIndex: 0,
      })
      return
    }

    run.points.forEach((point, pointIndex) => {
      const next = run.points[pointIndex + 1]
      if (!next) return
      if (Math.hypot(next.x - point.x, next.z - point.z) <= COINCIDENT_EPS_M) {
        issues.push({
          severity: 'blocker',
          code: 'zero-length-segment',
          message: `Полилиния №${runIndex + 1}: нулевой участок ${pointIndex}→${pointIndex + 1} — удалите двойную точку.`,
          runIndex,
          pointIndex,
        })
      }
    })

    const vertices: PlanPoint[] = run.points.map((point) => [point.x, point.z])
    for (let i = 0; i < vertices.length - 1; i += 1) {
      for (let j = i + 1; j < vertices.length - 1; j += 1) {
        const a = vertices[i]!
        const b = vertices[i + 1]!
        const c = vertices[j]!
        const d = vertices[j + 1]!
        if (j > i + 1) {
          const crossed = properSelfCrossing(a, b, c, d)
          if (crossed) {
            issues.push({
              severity: 'blocker',
              code: 'self-crossing',
              message: `Полилиния №${runIndex + 1}: самопересечение участков ${i}→${i + 1} и ${j}→${j + 1} — разбейте её на отдельные полилинии.`,
              runIndex,
              pointIndex: i,
            })
          }
        }
        const overlap = collinearOverlap(a, b, c, d)
        if (overlap) {
          issues.push({
            severity: 'blocker',
            code: 'self-overlap',
            message: `Полилиния №${runIndex + 1}: участок ${j}→${j + 1} идёт назад по участку ${i}→${i + 1} — уберите петлю.`,
            runIndex,
            pointIndex: j,
          })
        }
      }
    }

    const bounds = options.bounds
    if (bounds) {
      const outsideIndex = run.points.findIndex(
        (point) =>
          point.x < bounds.minXM ||
          point.x > bounds.maxXM ||
          point.z < bounds.minZM ||
          point.z > bounds.maxZM,
      )
      if (outsideIndex >= 0) {
        issues.push({
          severity: 'blocker',
          code: 'out-of-bounds',
          message: `Полилиния №${runIndex + 1}: точка ${outsideIndex} вне габаритов уровня — верните трассу в план.`,
          runIndex,
          pointIndex: outsideIndex,
        })
      }
    }
  })

  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      const overlap = firstRunsOverlap(runs[i]!, runs[j]!)
      if (!overlap) continue
      const sameSystem = runs[i]!.system === runs[j]!.system
      issues.push({
        severity: 'warning',
        code: 'runs-overlap',
        message: sameSystem
          ? `Полилинии №${i + 1} и №${j + 1} (${SYSTEM_LABELS[runs[i]!.system]}): участки накладываются друг на друга — уберите дубль трассы.`
          : `Полилинии №${i + 1} и №${j + 1} (П и В): трассы лежат на одной оси — разведите их в плане, утка рассчитана на пересечение, а не на наложение.`,
        runIndex: i,
      })
      void overlap
    }
  }

  const systems = new Set(runs.map((run) => run.system))
  if (systems.has('supply') && !systems.has('exhaust')) {
    issues.push({
      severity: 'warning',
      code: 'no-exhaust-run',
      message: 'Есть трасса притока, но нет вытяжки: баланс П/В проверить нельзя.',
    })
  }
  if (systems.has('exhaust') && !systems.has('supply')) {
    issues.push({
      severity: 'warning',
      code: 'no-supply-run',
      message: 'Есть трасса вытяжки, но нет притока: баланс П/В проверить нельзя.',
    })
  }

  if (options.hasEquipment === false) {
    issues.push({
      severity: 'blocker',
      code: 'no-equipment',
      message: 'На уровне нет установки (hvac-equipment): поставьте её до трассировки.',
    })
  }

  return issues
}

function firstRunsOverlap(a: DuctSketchRun, b: DuctSketchRun) {
  for (let i = 0; i < a.points.length - 1; i += 1) {
    for (let j = 0; j < b.points.length - 1; j += 1) {
      const hit = collinearOverlap(
        [a.points[i]!.x, a.points[i]!.z],
        [a.points[i + 1]!.x, a.points[i + 1]!.z],
        [b.points[j]!.x, b.points[j]!.z],
        [b.points[j + 1]!.x, b.points[j + 1]!.z],
      )
      if (hit) return hit
    }
  }
  return null
}

/** Есть ли среди замечаний блокеры — строить сеть нельзя. */
export function hasBlockers(issues: readonly SketchIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'blocker')
}
