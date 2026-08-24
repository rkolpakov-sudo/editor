import type { AnyNodeId } from '../../schema'
import type { SystemType } from '../norms-types'
import type { EndpointBinding, RecognizedPath, RecognizedTopology } from './recognize-topology'

/**
 * Этап 2 конвейера агента автотрассировки (PLAN-AGENT §2.2): расходы поверх
 * распознанной топологии. Строит дерево каждой системы от установки через
 * привязки путей (стык конец-в-конец / врезка в тело), собирает данные
 * таблицы подтверждения «терминал ← помещение ← расход» (W2), пропагирует
 * расходы терминалов к установке, проверяет баланс П/В и монотонность
 * «ветка ≤ магистраль» (W9). Политика W3: блокер — только физически
 * невозможное (сирота без маршрута до установки, цикл путей, отрицательная
 * монотонность); дисбаланс и неназначенные терминалы — предупреждения
 * best-effort. Чистая логика, без хранилища и Three.js.
 */

/** Рабочий допуск дисбаланса П/В, % от большей стороны. НЕ верифицирован по
 *  СП 54/СП 60 — статус показывается в UI рядом с проверкой
 *  (см. docs/mep/05-sources-log.md). */
export const SUPPLY_EXHAUST_BALANCE_TOL_PCT = 20

const FLOW_EPS = 1e-6

export type AgentTerminalRow = {
  terminalId: AnyNodeId
  system: SystemType
  zoneId?: string
  label?: string
  flowM3h: number
  /** True — расход назначен явно (зона/задание), иначе 0. */
  assigned: boolean
}

export type AgentPathFlow = {
  pathIndex: number
  sourceRunIndex: number
  system: SystemType
  /** Сумма расходов терминалов поддерева пути, м³/ч. */
  flowM3h: number
}

export type AgentFlowIssueCode =
  | 'orphan-path'
  | 'path-cycle'
  | 'unassigned-terminals'
  | 'supply-exhaust-imbalance'
  | 'flow-monotonicity'

export type AgentFlowIssue = {
  severity: 'blocker' | 'warning'
  code: AgentFlowIssueCode
  message: string
  pathIndex?: number
}

export type AgentFlowOptions = {
  /** Терминал → расход (м³/ч), из зон по СП 54. Отсутствующие несут 0. */
  terminalFlows?: Readonly<Record<AnyNodeId, number>>
  /** Терминал → помещение для таблицы подтверждения (W2). */
  terminalZones?: Readonly<Record<AnyNodeId, { zoneId: string; label?: string }>>
  /** Допуск дисбаланса П/В, % (по умолчанию `SUPPLY_EXHAUST_BALANCE_TOL_PCT`). */
  balanceTolerancePercent?: number
}

export type AgentFlowsResult = {
  /** Расход каждого пути топологии; пути вне деревьев несут 0. */
  paths: AgentPathFlow[]
  /** Данные таблицы подтверждения «терминал ← помещение ← расход» (W2). */
  terminals: AgentTerminalRow[]
  /** Суммарный расход притока по деревьям от установки, м³/ч. */
  supplyTotalM3h: number
  /** Суммарный расход вытяжки по деревьям от установки, м³/ч. */
  exhaustTotalM3h: number
  /** Дисбаланс, % от большей стороны; null — одна из сторон отсутствует. */
  imbalancePercent: number | null
  issues: AgentFlowIssue[]
}

type EndRef = { pathIndex: number; end: 'start' | 'end' }

const otherEnd = (end: 'start' | 'end'): 'start' | 'end' => (end === 'start' ? 'end' : 'start')

const bindingAt = (path: RecognizedPath, end: 'start' | 'end'): EndpointBinding =>
  end === 'start' ? path.start : path.end

/**
 * Расходы по распознанной топологии: дерево от установки, пропагация к
 * магистрали, баланс П/В, монотонность. Детерминировано порядком путей.
 */
export function computeAgentFlows(
  topology: RecognizedTopology,
  options: AgentFlowOptions = {},
): AgentFlowsResult {
  const terminalFlows = options.terminalFlows ?? {}
  const terminalZones = options.terminalZones ?? {}
  const tolerancePct = options.balanceTolerancePercent ?? SUPPLY_EXHAUST_BALANCE_TOL_PCT
  const paths = topology.paths
  const issues: AgentFlowIssue[] = []

  // Прямые терминалы пути, корни (концы у установки), врезки по хозяину.
  const directTerminals = new Map<number, AnyNodeId[]>()
  const roots: EndRef[] = []
  const tapsIntoHost = new Map<number, EndRef[]>()
  paths.forEach((path, pathIndex) => {
    for (const end of ['start', 'end'] as const) {
      const binding = bindingAt(path, end)
      if (binding.kind === 'terminal') {
        const list = directTerminals.get(pathIndex) ?? []
        list.push(binding.nodeId)
        directTerminals.set(pathIndex, list)
      } else if (binding.kind === 'equipment') {
        roots.push({ pathIndex, end })
      } else if (binding.kind === 'tap') {
        const list = tapsIntoHost.get(binding.hostPathIndex) ?? []
        list.push({ pathIndex, end })
        tapsIntoHost.set(binding.hostPathIndex, list)
      }
    }
  })

  // Обход леса от установок: preorder даёт порядок «родители раньше детей».
  const visited = new Set<number>()
  const order: number[] = []
  const parentOf = new Map<number, number>()
  const cycleReported = new Set<number>()
  const reportCycle = (pathIndex: number) => {
    if (cycleReported.has(pathIndex)) return
    cycleReported.add(pathIndex)
    issues.push({
      severity: 'blocker',
      code: 'path-cycle',
      message: `Полилиния №${paths[pathIndex]!.sourceRunIndex + 1}: путь замыкает кольцо — уберите замыкающий участок.`,
      pathIndex,
    })
  }
  const enter = (pathIndex: number, fromEnd: 'start' | 'end', parent: number | null): void => {
    if (visited.has(pathIndex)) {
      reportCycle(pathIndex)
      return
    }
    visited.add(pathIndex)
    order.push(pathIndex)
    if (parent !== null) parentOf.set(pathIndex, parent)

    const path = paths[pathIndex]!
    const farEnd = otherEnd(fromEnd)
    const far = bindingAt(path, farEnd)
    if (far.kind === 'junction') {
      enter(far.peerPathIndex, far.peerEnd, pathIndex)
    }
    for (const tip of tapsIntoHost.get(pathIndex) ?? []) {
      enter(tip.pathIndex, tip.end, pathIndex)
    }
  }
  for (const root of roots) enter(root.pathIndex, root.end, null)

  // Расходы: база — прямые терминалы пути, затем сумма детей к родителю.
  const pathFlow = new Map<number, number>()
  for (let i = 0; i < paths.length; i += 1) {
    let sum = 0
    for (const terminalId of directTerminals.get(i) ?? []) sum += terminalFlows[terminalId] ?? 0
    pathFlow.set(i, sum)
  }
  for (let k = order.length - 1; k >= 0; k -= 1) {
    const pathIndex = order[k]!
    const parent = parentOf.get(pathIndex)
    if (parent === undefined) continue
    pathFlow.set(parent, (pathFlow.get(parent) ?? 0) + (pathFlow.get(pathIndex) ?? 0))
  }

  // Сироты: компоненты без маршрута до установки; расход им не начисляется.
  for (let i = 0; i < paths.length; i += 1) {
    if (visited.has(i)) continue
    pathFlow.set(i, 0)
    issues.push({
      severity: 'blocker',
      code: 'orphan-path',
      message: `Полилиния №${paths[i]!.sourceRunIndex + 1} (${paths[i]!.system}): нет маршрута до установки — доведите трассу до неё или до дерева той же системы.`,
      pathIndex: i,
    })
  }

  // Монотонность W9 (защита от отрицательных назначений): ветка ≤ магистраль.
  for (const [pathIndex, parent] of parentOf) {
    const child = paths[pathIndex]!
    const trunkFlow = pathFlow.get(parent) ?? 0
    if ((pathFlow.get(pathIndex) ?? 0) <= trunkFlow + FLOW_EPS) continue
    issues.push({
      severity: 'blocker',
      code: 'flow-monotonicity',
      message: `Полилиния №${child.sourceRunIndex + 1} (${child.system}): расход ветки превышает магистраль — проверьте назначения расходов (W9).`,
      pathIndex,
    })
  }

  // Таблица подтверждения W2: все терминальные привязки всех систем.
  const terminals: AgentTerminalRow[] = []
  let unassignedCount = 0
  paths.forEach((path) => {
    for (const end of ['start', 'end'] as const) {
      const binding = bindingAt(path, end)
      if (binding.kind !== 'terminal') continue
      const flowM3h = terminalFlows[binding.nodeId] ?? 0
      const assigned = binding.nodeId in terminalFlows && flowM3h > 0
      if (!assigned) unassignedCount += 1
      const zone = terminalZones[binding.nodeId]
      terminals.push({
        terminalId: binding.nodeId,
        system: path.system,
        ...(zone ? { zoneId: zone.zoneId, label: zone.label } : {}),
        flowM3h,
        assigned,
      })
    }
  })
  if (unassignedCount > 0) {
    issues.push({
      severity: 'warning',
      code: 'unassigned-terminals',
      message: `${unassignedCount} терминал(ов) без расхода: назначьте тип помещения зонам (СП 54) перед построением.`,
    })
  }

  // Баланс П/В — обязательная проверка сценария (п. 8).
  const totalFor = (system: SystemType): number => {
    let sum = 0
    for (const root of roots) {
      if (paths[root.pathIndex]!.system === system) sum += pathFlow.get(root.pathIndex) ?? 0
    }
    return sum
  }
  const supplyTotalM3h = totalFor('supply')
  const exhaustTotalM3h = totalFor('exhaust')
  const imbalancePercent =
    supplyTotalM3h > 0 && exhaustTotalM3h > 0
      ? (Math.abs(supplyTotalM3h - exhaustTotalM3h) / Math.max(supplyTotalM3h, exhaustTotalM3h)) *
        100
      : null
  if (imbalancePercent !== null && imbalancePercent > tolerancePct + FLOW_EPS) {
    issues.push({
      severity: 'warning',
      code: 'supply-exhaust-imbalance',
      message: `Дисбаланс П/В ${imbalancePercent.toFixed(0)}% (П ${supplyTotalM3h.toFixed(0)} / В ${exhaustTotalM3h.toFixed(0)} м³/ч) больше допуска ${tolerancePct}% — сверьте расходы притока и вытяжки.`,
    })
  }

  return {
    paths: paths.map((path, pathIndex) => ({
      pathIndex,
      sourceRunIndex: path.sourceRunIndex,
      system: path.system,
      flowM3h: pathFlow.get(pathIndex) ?? 0,
    })),
    terminals,
    supplyTotalM3h,
    exhaustTotalM3h,
    imbalancePercent,
    issues,
  }
}
