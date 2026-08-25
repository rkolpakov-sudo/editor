import type { AnyNode, AnyNodeId } from '../../schema'

/**
 * Очистка эскиза (PLAN-AGENT §2.1 «Очистить эскиз» — отдельная команда).
 * Чистая логика: возвращает узлы `duct-sketch` для удаления одной undo-командой.
 * Эскиз — источник истины для регенерации; после очистки повторная
 * «Трассировка» строит сеть заново с чистого листа.
 */

export type SketchClearPlan = {
  delete: AnyNodeId[]
  /** Сколько полилиний удалено (для отчёта панели). */
  runCount: number
}

/** План удаления эскиза уровня: все узлы `duct-sketch` в сцене. */
export function planSketchClear(nodes: Readonly<Record<AnyNodeId, AnyNode>>): SketchClearPlan {
  const deleteIds: AnyNodeId[] = []
  let runCount = 0
  for (const node of Object.values(nodes)) {
    if (node?.type !== 'duct-sketch') continue
    deleteIds.push(node.id)
    runCount += node.runs?.length ?? 0
  }
  return { delete: deleteIds, runCount }
}
