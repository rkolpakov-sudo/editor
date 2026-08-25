import type { AnyNodeId, DuctTerminalNode } from '../../schema'
import type { SystemType } from '../norms-types'
import type { RoutingPreferences } from '../routing-preferences'
import type { PlanPoint } from '../routing-rules'
import type { RecognizedTopology } from './recognize-topology'

/**
 * Этап 6 конвейера агента (PLAN-AGENT §2.2, C3): автоответвления «терминал →
 * ближайшая магистраль». Терминал, который пользователь НЕ привязал к эскизу,
 * агент сам подводит к ближайшей трассе той же системы в пределах допуска
 * подключения (`terminalConnectToleranceM`, предпочтение трассировки). План
 * встраивается в топологию как дополнительный путь с tap-привязкой к телу
 * магистрали — все следующие этапы (расходы, сечения, высоты, фиттинги,
 * материализация) работают с ним без изменений. Чистая логика, без хранилища.
 */

export type AutoBranchPlan = {
  terminalId: AnyNodeId
  system: SystemType
  /** Точка терминала на плане. */
  terminalPoint: PlanPoint
  /** Точка врезки в магистраль на плане. */
  tapPoint: PlanPoint
  /** Индекс пути-хозяина (магистрали) в топологии. */
  hostPathIndex: number
  /** Параметр врезки вдоль тела хозяина 0..1. */
  hostT: number
}

export type AutoBranchIssueCode = 'no-trunk-within-tolerance' | 'no-trunk-of-system'

export type AutoBranchIssue = {
  severity: 'warning'
  code: AutoBranchIssueCode
  message: string
  terminalId: AnyNodeId
}

export type AutoBranchResult = {
  branches: AutoBranchPlan[]
  issues: AutoBranchIssue[]
}

type TerminalLike = {
  id: AnyNodeId
  position: [number, number, number]
  terminalType: DuctTerminalNode['terminalType']
}

function terminalSystem(terminalType: DuctTerminalNode['terminalType']): SystemType {
  return terminalType === 'return-grille' ? 'exhaust' : 'supply'
}

/** Ближайшая точка сегмента к точке P с параметром t вдоль полилинии. */
function nearestOnPath(
  points: readonly PlanPoint[],
  px: number,
  pz: number,
): { distanceM: number; point: PlanPoint; t: number } | null {
  const cum: number[] = [0]
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!
    const b = points[i + 1]!
    cum.push(cum[i]! + Math.hypot(b[0] - a[0], b[1] - a[1]))
  }
  const totalM = cum[cum.length - 1]!
  if (totalM <= 0) return null
  let best: { distanceM: number; point: PlanPoint; t: number } | null = null
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!
    const b = points[i + 1]!
    const rx = b[0] - a[0]
    const rz = b[1] - a[1]
    const len = cum[i + 1]! - cum[i]!
    const t =
      len <= 1e-9
        ? 0
        : Math.min(1, Math.max(0, ((px - a[0]) * rx + (pz - a[1]) * rz) / (len * len)))
    const x = a[0] + t * rx
    const z = a[1] + t * rz
    const distanceM = Math.hypot(px - x, pz - z)
    if (!best || distanceM < best.distanceM) {
      best = {
        distanceM,
        point: [x, z],
        t: totalM > 0 ? (cum[i]! + t * len) / totalM : 0,
      }
    }
  }
  return best
}

/**
 * Спланировать автоответвления для переданных терминалов. Уже привязанные к
 * эскизу терминалы должен отфильтровать вызывающий (по топологии).
 */
export function planAutoBranches(
  topology: RecognizedTopology,
  terminals: readonly TerminalLike[],
  prefs: RoutingPreferences,
): AutoBranchResult {
  const toleranceM = prefs.terminalConnectToleranceM
  const branches: AutoBranchPlan[] = []
  const issues: AutoBranchIssue[] = []

  for (const terminal of terminals) {
    const system = terminalSystem(terminal.terminalType)
    const [x, , z] = terminal.position
    let best: { distanceM: number; point: PlanPoint; t: number; pathIndex: number } | null = null

    for (let pathIndex = 0; pathIndex < topology.paths.length; pathIndex += 1) {
      const path = topology.paths[pathIndex]!
      if (path.system !== system) continue
      const planPoints: PlanPoint[] = path.points.map((point) => [point.x, point.z])
      const hit = nearestOnPath(planPoints, x, z)
      if (!hit || hit.distanceM > toleranceM) continue
      if (!best || hit.distanceM < best.distanceM) {
        best = { ...hit, pathIndex }
      }
    }

    if (!best) {
      const hasSystemPath = topology.paths.some((path) => path.system === system)
      issues.push({
        severity: 'warning',
        code: hasSystemPath ? 'no-trunk-within-tolerance' : 'no-trunk-of-system',
        message: hasSystemPath
          ? `Терминал ${terminal.id}: рядом (≤ ${toleranceM} м) нет магистрали ${system === 'supply' ? 'притока' : 'вытяжки'} — проверьте трассу или допуск подключения.`
          : `Терминал ${terminal.id}: нет трассы ${system === 'supply' ? 'притока' : 'вытяжки'} для автоответвления.`,
        terminalId: terminal.id,
      })
      continue
    }

    branches.push({
      terminalId: terminal.id,
      system,
      terminalPoint: [x, z],
      tapPoint: best.point,
      hostPathIndex: best.pathIndex,
      hostT: best.t,
    })
  }

  return { branches, issues }
}
