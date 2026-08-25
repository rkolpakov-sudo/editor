'use client'

import {
  type AnyNode,
  type AnyNodeId,
  assignZoneAirflowsToTerminals,
  type BypassPlan,
  buildBypassRunMutations,
  buildDuctPlan,
  DuctSegmentNode as DuctSegmentSchema,
  planAllBypassRuns,
  planBuildMutations,
  planGostSplit,
  terminalFlowMap,
  useScene,
  type ZoneNode,
} from '@pascal-app/core'

export type BypassApplyReport = {
  applied: number
  skipped: number
  switchedTo90: number
  skippedReasons: string[]
  plans: BypassPlan[]
}

/**
 * Применить все запланированные обводы пересечений П/В одной командой
 * (один undo-шаг — один `applyNodeChanges`-set). Каждый обвод планируется
 * по всей трассе вытяжки сразу (Этап 9): существующий участок обрезается
 * до части «до», между утками и в конце создаются прямые звенья, и
 * фиттинги-утки. Повторные пересечения на одном вытяжном участке больше
 * не пропускаются — планируются все, что помещаются по длине прямой.
 */
export function applyAllBypasses(): BypassApplyReport {
  const scene = useScene.getState()
  const runs = planAllBypassRuns(scene.nodes)

  const create: { node: AnyNode; parentId?: AnyNodeId }[] = []
  const update: { id: AnyNodeId; data: Partial<AnyNode> }[] = []
  let applied = 0

  for (const run of runs) {
    const exhaust = scene.nodes[run.exhaustNodeId]
    if (exhaust?.type !== 'duct-segment') continue
    if (run.bypasses.length === 0) continue
    const mutations = buildBypassRunMutations(run, exhaust)
    update.push({
      id: exhaust.id,
      data: { path: mutations.beforePath.map((point) => [...point]) },
    })
    const parentId = (exhaust.parentId ?? undefined) as AnyNodeId | undefined
    for (const intermediate of mutations.intermediateSegments) {
      create.push({ node: intermediate, parentId })
    }
    create.push({ node: mutations.afterSegment, parentId })
    for (const fitting of mutations.fittings) {
      create.push({ node: fitting, parentId })
    }
    applied += run.bypasses.length
  }

  scene.applyNodeChanges({ create, update })

  const switchedTo90 = runs.reduce(
    (sum, run) => sum + run.bypasses.filter((bypass) => bypass.autoSwitchedTo90).length,
    0,
  )
  const skipped = runs.reduce((sum, run) => sum + run.skipped.length, 0)
  return {
    applied,
    skipped,
    switchedTo90,
    skippedReasons: runs.flatMap((run) => run.skipped.map(({ reason }) => reason)),
    plans: [],
  }
}

export type GostSplitOutcome =
  | { kind: 'applied'; pieces: number }
  | { kind: 'not-a-segment' }
  | { kind: 'not-straight' }
  | { kind: 'already-standard' }
  | { kind: 'cannot-fit-gost' }

/**
 * «Разбить по ГОСТ» — заменить прямой участок на звенья стандартных длин
 * ГОСТ Р 70349 одной командой (один undo-шаг). Новые участки получают
 * свежие id, профиль и свойства наследуются.
 */
export function applyGostSegmentation(segmentId: AnyNodeId): GostSplitOutcome {
  const scene = useScene.getState()
  const node = scene.nodes[segmentId]
  if (node?.type !== 'duct-segment') return { kind: 'not-a-segment' }
  const plan = planGostSplit(node)
  if (!plan) {
    return node.path.length === 2 ? { kind: 'cannot-fit-gost' } : { kind: 'not-straight' }
  }
  if (plan.lengthsM.length <= 1) return { kind: 'already-standard' }

  // Strip the old id so each sub-segment mints a fresh one.
  const { id: _oldId, ...rest } = node
  const create = plan.splitPoints.slice(0, -1).map((from, index) => {
    const to = plan.splitPoints[index + 1]!
    return {
      node: DuctSegmentSchema.parse({ ...rest, path: [from, to] }),
      parentId: (node.parentId ?? undefined) as AnyNodeId | undefined,
    }
  })

  scene.applyNodeChanges({ create, delete: [segmentId] })
  return { kind: 'applied', pieces: plan.lengthsM.length }
}

export type RoutingApplyReport =
  | {
      status: 'no-sketch'
    }
  | {
      status: 'blocked'
      blockers: string[]
    }
  | {
      status: 'applied'
      created: number
      removed: number
      solutions: string[]
      violations: string[]
      notes: string[]
    }

/** Допустимые системные узлы для флага «собрано агентом» (регенерация W5). */
const AGENT_BUILT_TYPES = new Set(['duct-segment', 'duct-fitting'])

/**
 * «Трассировка»: эскиз уровня → план построения → материализация одной
 * undo-командой (W4/W5). Повторный запуск перестраивает сеть: узлы прошлой
 * сборки агента (metadata.agentRouting) удаляются.
 */
export function applyRoutingPlan(): RoutingApplyReport {
  const scene = useScene.getState()
  const sketchNode = Object.values(scene.nodes).find((node) => node?.type === 'duct-sketch')
  if (!sketchNode) return { status: 'no-sketch' }

  const zones = Object.values(scene.nodes).filter(
    (node): node is ZoneNode => node?.type === 'zone' && node.spaceRole === 'room',
  )
  const assignments = assignZoneAirflowsToTerminals(scene.nodes, zones)
  const terminalFlows = terminalFlowMap(assignments)

  const plan = buildDuctPlan({
    sketch: sketchNode,
    nodes: scene.nodes,
    terminalFlows,
  })
  if (!plan.canBuild) {
    return { status: 'blocked', blockers: plan.blockers.map((issue) => issue.message) }
  }

  const agentNodeIds = Object.values(scene.nodes)
    .filter(
      (node) =>
        node != null &&
        AGENT_BUILT_TYPES.has(node.type) &&
        (node.metadata as { agentRouting?: boolean } | undefined)?.agentRouting === true,
    )
    .map((node) => node.id)

  const mutations = planBuildMutations(plan, {
    parentId: (sketchNode.parentId ?? undefined) as AnyNodeId | undefined,
    existingAgentNodeIds: agentNodeIds,
  })

  scene.applyNodeChanges({
    create: mutations.create.map(({ node, parentId }) => ({ node, parentId })),
    delete: mutations.delete,
  })

  return {
    status: 'applied',
    created: mutations.create.length,
    removed: mutations.delete.length,
    solutions: plan.solutions,
    violations: plan.violations.map((issue) => issue.message),
    notes: mutations.notes,
  }
}
