'use client'

import {
  type AnyNode,
  type AnyNodeId,
  type BypassPlan,
  buildBypassMutations,
  DuctSegmentNode as DuctSegmentSchema,
  planAllBypasses,
  planGostSplit,
  useScene,
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
 * (один undo-шаг — один `applyNodeChanges`-set). Каждый обвод: обрезает
 * существующий вытяжной участок до части «до», создаёт хвостовой участок
 * «после» и фиттинг-утку. Повторные пересечения на одном вытяжном участке
 * пропускаются — второй план ссылается на уже изменённую трассу.
 */
export function applyAllBypasses(): BypassApplyReport {
  const scene = useScene.getState()
  const { plans, skipped } = planAllBypasses(scene.nodes)

  const create: { node: AnyNode; parentId?: AnyNodeId }[] = []
  const update: { id: AnyNodeId; data: Partial<AnyNode> }[] = []
  const touchedExhaustIds = new Set<AnyNodeId>()
  let applied = 0

  for (const plan of plans) {
    const exhaust = scene.nodes[plan.crossing.exhaustNodeId]
    if (exhaust?.type !== 'duct-segment') continue
    if (touchedExhaustIds.has(exhaust.id)) continue
    const mutations = buildBypassMutations(plan, exhaust)
    update.push({
      id: exhaust.id,
      data: { path: plan.beforePath.map((point) => [...point]) },
    })
    create.push({ node: mutations.afterSegment })
    create.push({ node: mutations.fitting })
    touchedExhaustIds.add(exhaust.id)
    applied += 1
  }

  scene.applyNodeChanges({ create, update })

  const switchedTo90 = plans.filter((plan) => plan.autoSwitchedTo90).length
  return {
    applied,
    skipped: skipped.length,
    switchedTo90,
    skippedReasons: skipped.map(({ reason }) => reason),
    plans,
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
