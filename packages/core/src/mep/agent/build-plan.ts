import type { AnyNode, AnyNodeId, DuctSketchNode } from '../../schema'
import type { DuctSectionProfile } from '../aerodynamics'
import type { SystemType } from '../norms-types'
import { normalizeRoutingPreferences, type RoutingPreferences } from '../routing-preferences'
import type { PlanPoint } from '../routing-rules'
import { segmentSegmentIntersection } from '../routing-rules'
import { planAutoBranches } from './branches'
import { type ElevationOptions, resolvePathElevations } from './elevations'
import type { AgentFittingSpec } from './fittings'
import { planAgentFittings } from './fittings'
import type { AgentFlowsResult, AgentTerminalRow } from './flows'
import { computeAgentFlows } from './flows'
import type { RecognizedTopology } from './recognize-topology'
import { recognizeTopology } from './recognize-topology'
import type { SizedAgentPath } from './section-sizing'
import { sizeAgentPaths } from './section-sizing'
import {
  type SketchIssue,
  hasBlockers as sketchHasBlockers,
  validateSketch,
} from './validate-sketch'

/**
 * Этап B5 — сборщик плана построения (PLAN-AGENT §2.2): чистая функция
 * «эскиз + сцена уровня → DuctBuildPlan». Фиксированный порядок конвейера
 * (W4): валидация → топология → расходы → сечения → высоты → фиттинги →
 * пересечения П/В. Результат для панели «Решения трассировки» и одной
 * undo-команды материализации (этап C): запланированные трассы, фиттинги,
 * аннотации решений (solutions), предупреждения best-effort (violations) и
 * блокеры (blockers) по политике W3 — блокер запрещает построение.
 */

export type PlannedRun = {
  key: string
  system: SystemType
  sourceRunIndex: number
  /** Вершины трассы на плане, м (установки/врезки учтены разрезами). */
  points: PlanPoint[]
  /** Ось воздуховода на каждой вершине, м над полом уровня. */
  axisM: number[]
  profile: DuctSectionProfile | null
  flowM3h: number
  velocityMps: number
}

export type PlanIssueSource =
  | 'validate'
  | 'topology'
  | 'flows'
  | 'sizing'
  | 'elevations'
  | 'fittings'
  | 'crossings'

export type DuctBuildPlanIssue = {
  severity: 'blocker' | 'warning'
  source: PlanIssueSource
  code: string
  message: string
}

export type DuctBuildPlan = {
  /** True — блокеров нет, материализация разрешена. */
  canBuild: boolean
  runs: PlannedRun[]
  fittings: AgentFittingSpec[]
  /** Данные таблицы подтверждения «терминал ← помещение ← расход» (W2). */
  terminals: AgentTerminalRow[]
  /** Аннотации решений агента для панели «Решения трассировки». */
  solutions: string[]
  /** Предупреждения W3: строить best-effort + красные маркеры. */
  violations: DuctBuildPlanIssue[]
  /** Блокеры W3: не строить, пока не устранены. */
  blockers: DuctBuildPlanIssue[]
}

export type BuildDuctPlanInput = {
  sketch: Pick<DuctSketchNode, 'runs'>
  /** Узлы уровня: установки и терминалы для привязки концов. */
  nodes: Readonly<Record<AnyNodeId, AnyNode>>
  /** Терминал → расход (м³/ч) из зон по СП 54. */
  terminalFlows?: Readonly<Record<AnyNodeId, number>>
  /** Терминал → помещение для таблицы подтверждения (W2). */
  terminalZones?: Readonly<Record<AnyNodeId, { zoneId: string; label?: string }>>
  /** Высоты: потолок уровня и зазоры (см. `ElevationOptions`). */
  elevations?: Omit<ElevationOptions, 'ceilingHeightMByPath'> & {
    ceilingHeightMByPath?: Readonly<Record<number, number>>
  }
  preferences?: Partial<RoutingPreferences>
  /** C3: терминалы для автоответвления «к ближайшей магистрали».
   *  Уже привязанные к эскизу игнорируются. */
  autoBranchTerminalIds?: readonly AnyNodeId[]
}

function toIssues(
  source: PlanIssueSource,
  entries: readonly { severity: 'blocker' | 'warning'; code: string; message: string }[],
): DuctBuildPlanIssue[] {
  return entries.map((entry) => ({
    severity: entry.severity,
    source,
    code: entry.code,
    message: entry.message,
  }))
}

/** Пересечения П/В на плане → решения об утке (геометрия — этап 9). */
function planCrossings(topology: RecognizedTopology): string[] {
  const solutions: string[] = []
  for (let i = 0; i < topology.paths.length; i += 1) {
    const a = topology.paths[i]!
    if (a.system === 'return') continue
    for (let j = i + 1; j < topology.paths.length; j += 1) {
      const b = topology.paths[j]!
      if (b.system === a.system || b.system === 'return') continue
      for (let si = 0; si < a.points.length - 1; si += 1) {
        for (let sj = 0; sj < b.points.length - 1; sj += 1) {
          const hit = segmentSegmentIntersection(
            [a.points[si]!.x, a.points[si]!.z],
            [a.points[si + 1]!.x, a.points[si + 1]!.z],
            [b.points[sj]!.x, b.points[sj]!.z],
            [b.points[sj + 1]!.x, b.points[sj + 1]!.z],
          )
          if (!hit) continue
          const exhaust = b.system === 'exhaust' ? b : a
          const supply = b.system === 'exhaust' ? a : b
          solutions.push(
            `Утка: вытяжка №${exhaust.sourceRunIndex + 1} обходит приток №${supply.sourceRunIndex + 1} в плане (зазор корпусов ≥ 50 мм), точка (${hit.point[0].toFixed(2)}, ${hit.point[1].toFixed(2)})`,
          )
          sj = b.points.length
          break
        }
      }
    }
  }
  return solutions
}

/** Боковой зазор параллельных трасс П/В, при котором нужен разворот по
 *  высоте (узкий коридор), м — рабочее значение, не норма. */
const PARALLEL_RUN_CLEARANCE_M = 0.3
/** Допустимая параллельность направлений (косинус угла), 15°. */
const PARALLEL_COS_MIN = Math.cos((15 * Math.PI) / 180)
/** Точка считается общей (стык у установки), а не «рядом лежащей», м. */
const SHARED_ENDPOINT_EPS_M = 1e-6

/** Ближайшее расстояние между отрезками [a0,a1] и [b0,b1] на плане. */
function planSegmentDistance(a0: PlanPoint, a1: PlanPoint, b0: PlanPoint, b1: PlanPoint): number {
  const dx = a1[0] - a0[0]
  const dz = a1[1] - a0[1]
  const len = Math.hypot(dx, dz)
  if (len < 1e-9) return Math.hypot(b0[0] - a0[0], b0[1] - a0[1])
  // Перпендикулярное расстояние от b0 до прямой A.
  return Math.abs(dx * (b0[1] - a0[1]) - dz * (b0[0] - a0[0])) / len
}

/**
 * Параллельные трассы П/В в узком коридоре (§2.5): если приток и вытяжка
 * идут рядом (боковой зазор < 0.3 м) на параллельных прямых с перекрытием
 * проекций — предупреждение развести по высоте. Стыки у установки (общие
 * концы отрезков) не считаются «коридором». Геометрия утки — этап 9.
 */
function planParallelClearances(topology: RecognizedTopology): DuctBuildPlanIssue[] {
  const issues: DuctBuildPlanIssue[] = []
  for (let i = 0; i < topology.paths.length; i += 1) {
    const a = topology.paths[i]!
    if (a.system === 'return') continue
    for (let j = i + 1; j < topology.paths.length; j += 1) {
      const b = topology.paths[j]!
      if (b.system === a.system || b.system === 'return') continue
      for (let si = 0; si < a.points.length - 1; si += 1) {
        const a0 = [a.points[si]!.x, a.points[si]!.z] as PlanPoint
        const a1 = [a.points[si + 1]!.x, a.points[si + 1]!.z] as PlanPoint
        const dirA: PlanPoint = [a1[0] - a0[0], a1[1] - a0[1]]
        const lenA = Math.hypot(dirA[0], dirA[1])
        if (lenA < 1e-9) continue
        for (let sj = 0; sj < b.points.length - 1; sj += 1) {
          const b0 = [b.points[sj]!.x, b.points[sj]!.z] as PlanPoint
          const b1 = [b.points[sj + 1]!.x, b.points[sj + 1]!.z] as PlanPoint
          const dirB: PlanPoint = [b1[0] - b0[0], b1[1] - b0[1]]
          const lenB = Math.hypot(dirB[0], dirB[1])
          if (lenB < 1e-9) continue
          // Параллельность направлений (с учётом противоположного хода).
          const cos = Math.abs((dirA[0] * dirB[0] + dirA[1] * dirB[1]) / (lenA * lenB))
          if (cos < PARALLEL_COS_MIN) continue
          // Общие концы (стык у установки) — не «рядом идущий коридор».
          const shared =
            Math.hypot(a0[0] - b0[0], a0[1] - b0[1]) < SHARED_ENDPOINT_EPS_M ||
            Math.hypot(a0[0] - b1[0], a0[1] - b1[1]) < SHARED_ENDPOINT_EPS_M ||
            Math.hypot(a1[0] - b0[0], a1[1] - b0[1]) < SHARED_ENDPOINT_EPS_M ||
            Math.hypot(a1[0] - b1[0], a1[1] - b1[1]) < SHARED_ENDPOINT_EPS_M
          if (shared) continue
          const gapM = Math.min(
            planSegmentDistance(a0, a1, b0, b1),
            planSegmentDistance(b0, b1, a0, a1),
          )
          if (gapM > PARALLEL_RUN_CLEARANCE_M) continue
          // Перекрытие проекций на ось A.
          const ta0 = ((b0[0] - a0[0]) * dirA[0] + (b0[1] - a0[1]) * dirA[1]) / (lenA * lenA)
          const ta1 = ((b1[0] - a0[0]) * dirA[0] + (b1[1] - a0[1]) * dirA[1]) / (lenA * lenA)
          const overlap = Math.min(1, Math.max(ta0, ta1)) - Math.max(0, Math.min(ta0, ta1))
          if (overlap <= 0) continue
          issues.push({
            severity: 'warning',
            source: 'crossings',
            code: 'parallel-pv-clearance',
            message: `Приток №${a.sourceRunIndex + 1} и вытяжка №${b.sourceRunIndex + 1} идут параллельно на расстоянии ${gapM.toFixed(2)} м — в узком коридоре разведите трассы по высоте.`,
          })
          sj = b.points.length
          break
        }
      }
    }
  }
  return issues
}

/**
 * Собрать план построения из эскиза и узлов уровня. Никогда не бросает:
 * все проблемы эскиза попадают в blockers/violations.
 */
export function buildDuctPlan(input: BuildDuctPlanInput): DuctBuildPlan {
  const prefs = normalizeRoutingPreferences(input.preferences)
  const runs = input.sketch.runs
  const blockers: DuctBuildPlanIssue[] = []
  const violations: DuctBuildPlanIssue[] = []
  const solutions: string[] = []

  // 0. Валидация эскиза (W1, W13).
  const hasEquipment = Object.values(input.nodes).some((node) => node.type === 'hvac-equipment')
  const sketchIssues: SketchIssue[] = validateSketch(runs, { hasEquipment })
  for (const issue of toIssues('validate', sketchIssues)) {
    if (issue.severity === 'blocker') blockers.push(issue)
    else violations.push(issue)
  }

  // 1. Топология: разрезы у установок, привязка концов.
  let topology = recognizeTopology(runs, input.nodes)
  for (const issue of toIssues('topology', topology.issues)) {
    if (issue.severity === 'blocker') blockers.push(issue)
    else violations.push(issue)
  }

  // 1.5. C3: автоответвления непривязанных терминалов к ближайшей магистрали.
  if (input.autoBranchTerminalIds && input.autoBranchTerminalIds.length > 0) {
    const boundTerminals = new Set<AnyNodeId>()
    for (const path of topology.paths) {
      for (const end of ['start', 'end'] as const) {
        const binding = end === 'start' ? path.start : path.end
        if (binding.kind === 'terminal') boundTerminals.add(binding.nodeId)
      }
    }
    const terminals = input.autoBranchTerminalIds
      .filter((id) => !boundTerminals.has(id))
      .map((id) => input.nodes[id])
      .filter(
        (
          node,
        ): node is AnyNode & {
          position: [number, number, number]
          terminalType: 'supply-register' | 'diffuser' | 'return-grille'
        } => node?.type === 'duct-terminal',
      )
      .map((node) => ({
        id: node.id,
        position: node.position,
        terminalType: node.terminalType,
      }))
    const branchResult = planAutoBranches(topology, terminals, prefs)
    for (const issue of branchResult.issues) {
      violations.push({
        severity: 'warning',
        source: 'crossings',
        code: issue.code,
        message: issue.message,
      })
    }
    if (branchResult.branches.length > 0) {
      const base = topology.paths.length
      const branchPaths: RecognizedTopology['paths'] = branchResult.branches.map(
        (branch, index) => {
          const pathIndex = base + index
          return {
            pathIndex,
            system: branch.system,
            sourceRunIndex: -1,
            points: [
              { x: branch.terminalPoint[0], z: branch.terminalPoint[1], elev: 'auto' },
              { x: branch.tapPoint[0], z: branch.tapPoint[1], elev: 'auto' },
            ],
            lengthM: Math.hypot(
              branch.terminalPoint[0] - branch.tapPoint[0],
              branch.terminalPoint[1] - branch.tapPoint[1],
            ),
            start: { kind: 'terminal', nodeId: branch.terminalId, distanceM: 0 },
            end: { kind: 'tap', hostPathIndex: branch.hostPathIndex, hostT: branch.hostT },
          }
        },
      )
      topology = { ...topology, paths: [...topology.paths, ...branchPaths] }
      for (const branch of branchResult.branches) {
        solutions.push(
          `Автоответвление: терминал ${branch.terminalId} → магистраль №${branch.hostPathIndex + 1} в точке (${branch.tapPoint[0].toFixed(2)}, ${branch.tapPoint[1].toFixed(2)}).`,
        )
      }
    }
  }

  // 2. Расходы: дерево от установки, баланс П/В, монотонность.
  const flows: AgentFlowsResult = computeAgentFlows(topology, {
    terminalFlows: input.terminalFlows ?? {},
    terminalZones: input.terminalZones,
  })
  for (const issue of toIssues('flows', flows.issues)) {
    if (issue.severity === 'blocker') blockers.push(issue)
    else violations.push(issue)
  }

  // 3. Сечения: скорость СП 60 | равные потери.
  const sizingResult = sizeAgentPaths(topology, flows, {
    method: prefs.sizingMethod,
    frictionPaPerM: prefs.equalFrictionPaPerM,
  })
  for (const issue of toIssues('sizing', sizingResult.issues)) {
    if (issue.severity === 'blocker') blockers.push(issue)
    else violations.push(issue)
  }

  // 4. Высоты: оси вершин, авто-вертикали, проверки размещения.
  const profilesByPath = Object.fromEntries(
    sizingResult.paths.map((path) => [path.pathIndex, path.profile]),
  )
  const elevationResult = resolvePathElevations(topology, profilesByPath, input.elevations)
  for (const issue of toIssues('elevations', elevationResult.issues)) {
    if (issue.severity === 'blocker') blockers.push(issue)
    else violations.push(issue)
  }

  // 5–6. Фиттинги сопряжений (ответвления C3 — отдельный этап).
  const fittingPlan = planAgentFittings(
    topology,
    sizingResult.paths,
    elevationResult.elevations,
    prefs,
  )
  solutions.push(...fittingPlan.fittings.map((fitting) => `${fitting.note} [${fitting.key}]`))
  violations.push(...toIssues('fittings', fittingPlan.issues))

  // 7. Пересечения П/В → утка + параллельные П/В в узком коридоре (§2.5).
  solutions.push(...planCrossings(topology))
  violations.push(...planParallelClearances(topology))

  // Аннотации подобранных участков и итогов баланса.
  for (const path of sizingResult.paths) {
    const profile = path.profile
    const sizeLabel =
      profile?.shape === 'round'
        ? `Ø${profile.diameterMm}`
        : profile
          ? `${profile.widthMm}×${profile.heightMm}`
          : 'без сечения'
    solutions.push(
      `Участок №${path.sourceRunIndex + 1}: ${path.flowM3h.toFixed(0)} м³/ч → ${sizeLabel}, v=${path.velocityMps.toFixed(1)} м/с`,
    )
  }
  if (flows.imbalancePercent !== null) {
    solutions.push(
      `Баланс П/В: приток ${flows.supplyTotalM3h.toFixed(0)} / вытяжка ${flows.exhaustTotalM3h.toFixed(0)} м³/ч, дисбаланс ${flows.imbalancePercent.toFixed(0)}%`,
    )
  }

  // Запланированные трассы.
  const plannedRuns: PlannedRun[] = topology.paths.map((path, pathIndex) => {
    const sized: SizedAgentPath | undefined = sizingResult.paths[pathIndex]
    return {
      key: `run${path.sourceRunIndex}path${pathIndex}`,
      system: path.system,
      sourceRunIndex: path.sourceRunIndex,
      points: path.points.map((point) => [point.x, point.z]),
      axisM: elevationResult.elevations[pathIndex]?.axisM ?? [],
      profile: sized?.profile ?? null,
      flowM3h: sized?.flowM3h ?? 0,
      velocityMps: sized?.velocityMps ?? 0,
    }
  })

  // 8. Финальная политика W4/W3: строим только без блокеров.
  const canBuild = blockers.length === 0 && !sketchHasBlockers(sketchIssues)

  return {
    canBuild,
    runs: plannedRuns,
    fittings: fittingPlan.fittings,
    terminals: flows.terminals,
    solutions,
    violations,
    blockers,
  }
}
