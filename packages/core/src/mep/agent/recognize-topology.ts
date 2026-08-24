import type { AnyNode, AnyNodeId, DuctSketchElevation, DuctSketchRun } from '../../schema'
import type { SystemType } from '../norms-types'

/**
 * Этап 1 конвейера агента автотрассировки (PLAN-AGENT §2.2): распознавание
 * топологии эскиза. Полилиния может проходить сквозь установку — путь режется
 * в точке установки; свободные концы привязываются к оборудованию/терминалам
 * или друг к другу (стык магистрали из кусков, врезка ответвления в тело
 * магистрали) с допуском связи. Несвязанные концы — блокеры: «привязка концов
 * обязательна» (W1). Чистая логика поверх позиций узлов сцены, без хранилища.
 */

/** Допуск связи конца полилинии с установкой/терминалом/другой полилинией, м.
 *  Показывается в UI рядом с привязками (W1: допуск — правило с визуализацией). */
export const DEFAULT_BIND_TOLERANCE_M = 0.5

const COINCIDENT_EPS_M = 1e-6

export type SketchPathPoint = { x: number; z: number; elev: DuctSketchElevation }

export type EndpointBinding =
  | { kind: 'equipment'; nodeId: AnyNodeId; distanceM: number }
  | { kind: 'terminal'; nodeId: AnyNodeId; distanceM: number }
  | { kind: 'junction'; peerPathIndex: number; peerEnd: 'start' | 'end' }
  | {
      kind: 'tap'
      hostPathIndex: number /** Параметр врезки вдоль тела хозяина, 0..1. */
      hostT: number
    }
  | { kind: 'unbound' }

export type RecognizedPath = {
  pathIndex: number
  system: SystemType
  /** Индекс исходной полилинии эскиза, из которой получен путь. */
  sourceRunIndex: number
  points: SketchPathPoint[]
  lengthM: number
  start: EndpointBinding
  end: EndpointBinding
}

export type TopologyIssue = {
  severity: 'blocker' | 'warning'
  code: 'unbound-start' | 'unbound-end'
  message: string
  runIndex?: number
}

export type RecognizedTopology = {
  paths: RecognizedPath[]
  issues: TopologyIssue[]
}

export type RecognizeTopologyOptions = {
  bindToleranceM?: number
}

type Anchor = { nodeId: AnyNodeId; x: number; z: number }

type WorkPath = {
  system: SystemType
  sourceRunIndex: number
  points: SketchPathPoint[]
}

type PolylineProjection = {
  distanceM: number
  segIndex: number
  localT: number
  /** Метры от начала полилинии до проекции. */
  alongM: number
  totalM: number
}

function closestOnPolyline(
  points: readonly SketchPathPoint[],
  px: number,
  pz: number,
): PolylineProjection {
  const cum: number[] = [0]
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!
    const b = points[i + 1]!
    cum.push(cum[i]! + Math.hypot(b.x - a.x, b.z - a.z))
  }
  const totalM = cum[cum.length - 1]!

  let best: PolylineProjection = { distanceM: Infinity, segIndex: 0, localT: 0, alongM: 0, totalM }
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!
    const b = points[i + 1]!
    const rx = b.x - a.x
    const rz = b.z - a.z
    const len = cum[i + 1]! - cum[i]!
    const t =
      len <= COINCIDENT_EPS_M
        ? 0
        : Math.min(1, Math.max(0, ((px - a.x) * rx + (pz - a.z) * rz) / (len * len)))
    const distanceM = Math.hypot(px - (a.x + t * rx), pz - (a.z + t * rz))
    if (distanceM < best.distanceM) {
      best = {
        distanceM,
        segIndex: i,
        localT: t,
        alongM: cum[i]! + t * len,
        totalM,
      }
    }
  }
  return best
}

function pointOnPolyline(points: readonly SketchPathPoint[], projection: PolylineProjection) {
  const a = points[projection.segIndex]!
  const b = points[projection.segIndex + 1]!
  return {
    x: a.x + projection.localT * (b.x - a.x),
    z: a.z + projection.localT * (b.z - a.z),
    // Высота наследуется от ближайшей вершины участка — уточнится на этапе высот (B3).
    elev: projection.localT < 0.5 ? a.elev : b.elev,
  }
}

/** Разрезать пути в точках установок: установка на теле полилинии даёт два
 *  пути по сторонам от неё (W1 «разрез пути в точке установки»). Установка
 *  на конце пути разреза не требует — конец свяжется при привязке. */
function cutPathsAtAnchors(paths: WorkPath[], anchors: Anchor[], toleranceM: number): void {
  let progress = true
  while (progress) {
    progress = false
    for (let pathIndex = 0; pathIndex < paths.length && !progress; pathIndex += 1) {
      const path = paths[pathIndex]!
      let bestAnchor: Anchor | null = null
      let bestProjection: PolylineProjection | null = null
      for (const anchor of anchors) {
        const projection = closestOnPolyline(path.points, anchor.x, anchor.z)
        if (projection.distanceM > toleranceM) continue
        const insideStart = projection.alongM > COINCIDENT_EPS_M
        const insideEnd = projection.totalM - projection.alongM > COINCIDENT_EPS_M
        if (!insideStart || !insideEnd) continue
        if (!bestProjection || projection.distanceM < bestProjection.distanceM) {
          bestAnchor = anchor
          bestProjection = projection
        }
      }
      if (!bestAnchor || !bestProjection) continue

      const cut = pointOnPolyline(path.points, bestProjection)
      const head = path.points[bestProjection.segIndex]!
      const tail = path.points[bestProjection.segIndex + 1]!
      let before: SketchPathPoint[]
      let after: SketchPathPoint[]
      if (Math.hypot(cut.x - head.x, cut.z - head.z) <= COINCIDENT_EPS_M) {
        before = path.points.slice(0, bestProjection.segIndex + 1)
        after = path.points.slice(bestProjection.segIndex)
      } else if (Math.hypot(cut.x - tail.x, cut.z - tail.z) <= COINCIDENT_EPS_M) {
        before = path.points.slice(0, bestProjection.segIndex + 2)
        after = path.points.slice(bestProjection.segIndex + 1)
      } else {
        before = [...path.points.slice(0, bestProjection.segIndex + 1), cut]
        after = [cut, ...path.points.slice(bestProjection.segIndex + 1)]
      }
      paths.splice(pathIndex, 1, { ...path, points: before }, { ...path, points: after })
      progress = true
    }
  }
}

function collectAnchors(nodes: Readonly<Record<AnyNodeId, AnyNode>>): {
  equipment: Anchor[]
  terminals: Anchor[]
} {
  const equipment: Anchor[] = []
  const terminals: Anchor[] = []
  for (const node of Object.values(nodes)) {
    if (node.type !== 'hvac-equipment' && node.type !== 'duct-terminal') continue
    const [x, , z] = node.position
    const anchor = { nodeId: node.id, x, z }
    if (node.type === 'hvac-equipment') equipment.push(anchor)
    else terminals.push(anchor)
  }
  return { equipment, terminals }
}

type LooseEnd = { pathIndex: number; end: 'start' | 'end'; x: number; z: number }

/**
 * Распознать топологию: разрез путей у установок и привязка концов к
 * оборудованию/терминалам/другим путям той же системы. Оборудование имеет
 * приоритет над терминалом; стык конец-в-конец приоритетнее врезки в тело;
 * кандидаты применяются жадно по возрастанию дистанции (детерминировано).
 */
export function recognizeTopology(
  runs: readonly DuctSketchRun[],
  nodes: Readonly<Record<AnyNodeId, AnyNode>>,
  options: RecognizeTopologyOptions = {},
): RecognizedTopology {
  const toleranceM = options.bindToleranceM ?? DEFAULT_BIND_TOLERANCE_M
  const { equipment, terminals } = collectAnchors(nodes)

  const work: WorkPath[] = runs.map((run, sourceRunIndex) => ({
    system: run.system,
    sourceRunIndex,
    points: run.points.map((point) => ({ x: point.x, z: point.z, elev: point.elev })),
  }))
  cutPathsAtAnchors(work, equipment, toleranceM)

  const bindings: EndpointBinding[][] = work.map(() => [{ kind: 'unbound' }, { kind: 'unbound' }])
  const endOf = (pathIndex: number, which: 'start' | 'end'): LooseEnd => {
    const points = work[pathIndex]!.points
    const point = which === 'start' ? points[0]! : points[points.length - 1]!
    return { pathIndex, end: which, x: point.x, z: point.z }
  }

  for (let pathIndex = 0; pathIndex < work.length; pathIndex += 1) {
    for (const which of ['start', 'end'] as const) {
      const tip = endOf(pathIndex, which)
      const bindToAnchor = (anchors: Anchor[]): EndpointBinding | null => {
        let best: EndpointBinding | null = null
        for (const anchor of anchors) {
          const distanceM = Math.hypot(tip.x - anchor.x, tip.z - anchor.z)
          if (distanceM > toleranceM) continue
          if (!best || distanceM < best.distanceM) {
            best =
              anchors === equipment
                ? { kind: 'equipment', nodeId: anchor.nodeId, distanceM }
                : { kind: 'terminal', nodeId: anchor.nodeId, distanceM }
          }
        }
        return best
      }
      const bound = bindToAnchor(equipment) ?? bindToAnchor(terminals)
      if (bound) bindings[pathIndex]![which === 'start' ? 0 : 1] = bound
    }
  }

  const isBound = (tip: LooseEnd) =>
    bindings[tip.pathIndex]![tip.end === 'start' ? 0 : 1]!.kind !== 'unbound'
  const setBound = (tip: LooseEnd, binding: EndpointBinding) => {
    bindings[tip.pathIndex]![tip.end === 'start' ? 0 : 1] = binding
  }
  const systemOf = (tip: LooseEnd) => work[tip.pathIndex]!.system

  const loose: LooseEnd[] = []
  for (let pathIndex = 0; pathIndex < work.length; pathIndex += 1) {
    for (const which of ['start', 'end'] as const) {
      const tip = endOf(pathIndex, which)
      if (!isBound(tip)) loose.push(tip)
    }
  }

  type Candidate =
    | { kind: 'junction'; distanceM: number; a: LooseEnd; b: LooseEnd }
    | { kind: 'tap'; distanceM: number; tip: LooseEnd; hostPathIndex: number; hostT: number }

  const candidates: Candidate[] = []
  for (let i = 0; i < loose.length; i += 1) {
    for (let j = i + 1; j < loose.length; j += 1) {
      const a = loose[i]!
      const b = loose[j]!
      if (a.pathIndex === b.pathIndex) continue
      if (systemOf(a) !== systemOf(b)) continue
      const distanceM = Math.hypot(a.x - b.x, a.z - b.z)
      if (distanceM > toleranceM) continue
      candidates.push({ kind: 'junction', distanceM, a, b })
    }
  }
  for (const tip of loose) {
    for (let hostIndex = 0; hostIndex < work.length; hostIndex += 1) {
      if (hostIndex === tip.pathIndex) continue
      if (work[hostIndex]!.system !== systemOf(tip)) continue
      const projection = closestOnPolyline(work[hostIndex]!.points, tip.x, tip.z)
      if (projection.distanceM > toleranceM) continue
      const touchesHostEnd =
        projection.alongM <= COINCIDENT_EPS_M ||
        projection.totalM - projection.alongM <= COINCIDENT_EPS_M
      // Контакт с концом хозяина обрабатывается парой конец-в-конец выше.
      if (touchesHostEnd) continue
      candidates.push({
        kind: 'tap',
        distanceM: projection.distanceM,
        tip,
        hostPathIndex: hostIndex,
        hostT: projection.totalM > 0 ? projection.alongM / projection.totalM : 0,
      })
    }
  }

  candidates.sort((x, y) => x.distanceM - y.distanceM)
  for (const candidate of candidates) {
    if (candidate.kind === 'junction') {
      if (isBound(candidate.a) || isBound(candidate.b)) continue
      setBound(candidate.a, {
        kind: 'junction',
        peerPathIndex: candidate.b.pathIndex,
        peerEnd: candidate.b.end,
      })
      setBound(candidate.b, {
        kind: 'junction',
        peerPathIndex: candidate.a.pathIndex,
        peerEnd: candidate.a.end,
      })
    } else {
      if (isBound(candidate.tip)) continue
      setBound(candidate.tip, {
        kind: 'tap',
        hostPathIndex: candidate.hostPathIndex,
        hostT: candidate.hostT,
      })
    }
  }

  const issues: TopologyIssue[] = []
  for (const tip of loose) {
    if (isBound(tip)) continue
    const runIndex = work[tip.pathIndex]!.sourceRunIndex
    issues.push({
      severity: 'blocker',
      code: tip.end === 'start' ? 'unbound-start' : 'unbound-end',
      message: `Полилиния №${runIndex + 1}: ${tip.end === 'start' ? 'начало' : 'конец'} ни к чему не привязано — доведите до установки или терминала, либо до другой полилинии той же системы (допуск ${toleranceM} м).`,
      runIndex,
    })
  }

  const paths: RecognizedPath[] = work.map((path, pathIndex) => {
    let lengthM = 0
    for (let i = 0; i < path.points.length - 1; i += 1) {
      const a = path.points[i]!
      const b = path.points[i + 1]!
      lengthM += Math.hypot(b.x - a.x, b.z - a.z)
    }
    return {
      pathIndex,
      system: path.system,
      sourceRunIndex: path.sourceRunIndex,
      points: path.points,
      lengthM,
      start: bindings[pathIndex]![0]!,
      end: bindings[pathIndex]![1]!,
    }
  })

  return { paths, issues }
}
