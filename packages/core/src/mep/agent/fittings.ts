import type { DuctSectionProfile } from '../aerodynamics'
import { profileBodyWidthM } from '../aerodynamics'
import type { SystemType } from '../norms-types'
import { normalizeRoutingPreferences, type RoutingPreferences } from '../routing-preferences'
import type { PlanPoint } from '../routing-rules'
import type { PathElevation } from './elevations'
import type { RecognizedTopology } from './recognize-topology'
import type { SizedAgentPath } from './section-sizing'

/**
 * Этап 5 конвейера агента автотрассировки (PLAN-AGENT §2.2): фиттинги
 * сопряжений по «Предпочтениям трассировки». Решения:
 *  - отвод на каждом изгибе полилинии (угол снапится на ряд 15/30/45/90°);
 *  - врезка ответвления — тройник или седелка по отношению диаметров
 *    (режим auto), угол врезки снапится на 45/90°;
 *  - вертикальный участок между вершинами с разными осями — пара отводов 90°.
 * Переходы сечений вдоль магистрали (тaper) и сама материализация узлов —
 * этап B5 (build-plan). Чистая логика, без хранилища.
 */

const DEG = 180 / Math.PI

export type AgentFittingSpec = {
  /** Детерминированный ключ для материализации и undo. */
  key: string
  fittingType: 'tee' | 'saddle' | 'elbow'
  system: SystemType
  at: PlanPoint
  /** Для отводов: фактический угол поворота. */
  angleDeg?: number
  radiusFactor?: number
  profile?: DuctSectionProfile
  /** Для врезок: сечение ответвления. */
  branchProfile?: DuctSectionProfile
  note: string
}

export type AgentFittingIssueCode = 'unsized-junction'

export type AgentFittingIssue = {
  severity: 'warning'
  code: AgentFittingIssueCode
  message: string
}

const BEND_ANGLE_EPS_DEG = 8

/** Диаметр профиля для отношений «ветка/магистраль» (гидравлический для rect). */
function profileDiameterMm(profile: DuctSectionProfile): number {
  return profileBodyWidthM(profile) * 1000
}

/** Фиттинг врезки: седелка, когда ответвление не больше доли магистрали. */
export function chooseBranchFittingKind(
  trunkSizeMm: number,
  branchSizeMm: number,
  preferences: RoutingPreferences,
): 'tee' | 'saddle' {
  if (preferences.branchFitting === 'tee') return 'tee'
  if (preferences.branchFitting === 'saddle') return 'saddle'
  const ratio = trunkSizeMm > 0 ? branchSizeMm / trunkSizeMm : 1
  return ratio <= preferences.saddleMaxDiameterRatio ? 'saddle' : 'tee'
}

/** Ближайший допустимый угол ОТКЛОНЕНИЯ трассы (ряд агента: 15/30/45/90;
 *  врезки: 45/90). Направления заданы векторами на плане; при равенстве
 *  расстояний до двух допусков берётся `fallback` (приоритет предпочтения). */
export function snapTurnAngleDeg(
  dirA: PlanPoint,
  dirB: PlanPoint,
  allowed: readonly number[],
  fallback: number,
): number {
  const lenA = Math.hypot(dirA[0], dirA[1])
  const lenB = Math.hypot(dirB[0], dirB[1])
  if (lenA < 1e-9 || lenB < 1e-9) return fallback
  const cos = (dirA[0] * dirB[0] + dirA[1] * dirB[1]) / (lenA * lenB)
  const interiorDeg = Math.acos(Math.min(1, Math.max(-1, cos))) * DEG
  const deflectDeg = 180 - interiorDeg
  let best = allowed[0]!
  for (const candidate of allowed) {
    if (Math.abs(candidate - deflectDeg) < Math.abs(best - deflectDeg)) best = candidate
  }
  // Ничья (в пределах точности acos) разрешается в пользу предпочтения.
  const distBest = Math.abs(best - deflectDeg)
  const distFallback = Math.abs(fallback - deflectDeg)
  if (distFallback <= distBest + 1e-9) return fallback
  return best
}

function segmentDir(from: PlanPoint, to: PlanPoint): PlanPoint {
  return [to[0] - from[0], to[1] - from[1]]
}

/**
 * Расставить фиттинги сопряжений по топологии, подобранным сечениям и осям.
 * Детерминировано: обход путей по порядку, вершины слева направо.
 */
export function planAgentFittings(
  topology: RecognizedTopology,
  sizedPaths: readonly SizedAgentPath[],
  elevations: readonly PathElevation[] | null = null,
  rawPreferences: Partial<RoutingPreferences> = {},
): { fittings: AgentFittingSpec[]; issues: AgentFittingIssue[] } {
  const prefs = normalizeRoutingPreferences(rawPreferences)
  const fittings: AgentFittingSpec[] = []
  const issues: AgentFittingIssue[] = []
  const profileOf = new Map(sizedPaths.map((path) => [path.pathIndex, path.profile]))

  // 1. Отводы на изгибах полилиний.
  topology.paths.forEach((path, pathIndex) => {
    const profile = profileOf.get(pathIndex) ?? null
    if (!profile || path.points.length < 3) return
    for (let vertexIndex = 1; vertexIndex < path.points.length - 1; vertexIndex += 1) {
      const prev = path.points[vertexIndex - 1]!
      const corner = path.points[vertexIndex]!
      const next = path.points[vertexIndex + 1]!
      const angleDeg = snapTurnAngleDeg(
        segmentDir([corner.x, corner.z], [prev.x, prev.z]),
        segmentDir([corner.x, corner.z], [next.x, next.z]),
        [15, 30, 45, 90],
        90,
      )
      // Прямое продолжение (0°) и разворот назад (~180°) — не изгибы.
      if (angleDeg < BEND_ANGLE_EPS_DEG || angleDeg > 180 - BEND_ANGLE_EPS_DEG) continue
      fittings.push({
        key: `p${pathIndex}v${vertexIndex}-elbow`,
        fittingType: 'elbow',
        system: path.system,
        at: [corner.x, corner.z],
        angleDeg,
        radiusFactor: prefs.elbowRadiusFactor,
        profile,
        note: `Отвод ${angleDeg}° R=${prefs.elbowRadiusFactor}D — изгиб полилинии №${path.sourceRunIndex + 1}`,
      })
    }
  })

  // 2. Врезки ответвлений (tap): тройник/седелка по предпочтению и сечениям.
  topology.paths.forEach((path, pathIndex) => {
    const binding =
      path.end.kind === 'tap' ? path.end : path.start.kind === 'tap' ? path.start : null
    if (binding?.kind !== 'tap') return
    const branchProfile = profileOf.get(pathIndex) ?? null
    const hostProfile = profileOf.get(binding.hostPathIndex) ?? null
    const tip = path.end.kind === 'tap' ? path.points[path.points.length - 1]! : path.points[0]!
    const hostPath = topology.paths[binding.hostPathIndex]
    if (!hostPath) return
    const label = `№${path.sourceRunIndex + 1} → №${hostPath.sourceRunIndex + 1}`
    if (!branchProfile || !hostProfile) {
      issues.push({
        severity: 'warning',
        code: 'unsized-junction',
        message: `Врезка ${label}: сечение не подобрано — врезка будет построена тройником без перехода.`,
      })
      return
    }
    const trunkMm = profileDiameterMm(hostProfile)
    const branchMm = profileDiameterMm(branchProfile)
    const kind = chooseBranchFittingKind(trunkMm, branchMm, prefs)

    // Угол врезки: направление первого участка ветки против направления
    // тела хозяина в точке касания.
    const projectionT = Math.min(0.999, Math.max(0.001, binding.hostT))
    const segIndex = Math.min(
      hostPath.points.length - 2,
      Math.floor(projectionT * (hostPath.points.length - 1)),
    )
    const hostFrom = hostPath.points[segIndex]!
    const hostTo = hostPath.points[segIndex + 1]!
    const branchTipPrev =
      path.end.kind === 'tap'
        ? (path.points[path.points.length - 2] ?? tip)
        : (path.points[1] ?? tip)
    const angleDeg = snapTurnAngleDeg(
      segmentDir([tip.x, tip.z], [branchTipPrev.x, branchTipPrev.z]),
      segmentDir([hostFrom.x, hostFrom.z], [hostTo.x, hostTo.z]),
      [45, 90],
      prefs.branchTapAngleDeg,
    )

    const autoNote =
      prefs.branchFitting === 'auto'
        ? ` (auto: d/D = ${(branchMm / trunkMm).toFixed(2)} ${kind === 'saddle' ? '≤' : '>'} ${prefs.saddleMaxDiameterRatio})`
        : ` (по предпочтению: ${prefs.branchFitting})`
    fittings.push({
      key: `p${pathIndex}-tap-${binding.hostPathIndex}-${binding.hostT.toFixed(3)}`,
      fittingType: kind,
      system: path.system,
      at: [tip.x, tip.z],
      angleDeg,
      radiusFactor: prefs.elbowRadiusFactor,
      profile: hostProfile,
      branchProfile,
      note: `${kind === 'saddle' ? 'Седелка' : 'Тройник'} Ø${branchMm.toFixed(0)}→Ø${trunkMm.toFixed(0)}, врезка ${angleDeg}°${autoNote}`,
    })
  })

  // 3. Вертикальные участки: пара отводов 90° на перепаде осей.
  if (elevations) {
    elevations.forEach((elevation) => {
      const path = topology.paths[elevation.pathIndex]
      const profile = profileOf.get(elevation.pathIndex) ?? null
      if (!path || !profile) return
      for (const vertical of elevation.verticals) {
        const start = path.points[vertical.afterVertexIndex]!
        const end = path.points[vertical.afterVertexIndex + 1]!
        const riseLabel = `${vertical.riseM > 0 ? '+' : ''}${vertical.riseM.toFixed(2)} м`
        fittings.push({
          key: `p${elevation.pathIndex}v${vertical.afterVertexIndex}-riser-a`,
          fittingType: 'elbow',
          system: path.system,
          at: [start.x, start.z],
          angleDeg: 90,
          radiusFactor: prefs.elbowRadiusFactor,
          profile,
          note: `Вертикальный участок ${riseLabel}: отвод у начала`,
        })
        fittings.push({
          key: `p${elevation.pathIndex}v${vertical.afterVertexIndex}-riser-b`,
          fittingType: 'elbow',
          system: path.system,
          at: [end.x, end.z],
          angleDeg: 90,
          radiusFactor: prefs.elbowRadiusFactor,
          profile,
          note: `Вертикальный участок ${riseLabel}: отвод у конца`,
        })
      }
    })
  }

  return { fittings, issues }
}
