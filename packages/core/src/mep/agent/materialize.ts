import type { AnyNode, AnyNodeId } from '../../schema'
import { DuctFittingNode, DuctSegmentNode } from '../../schema'
import { type DuctSectionProfile, profileBodyWidthM } from '../aerodynamics'
import type { PlanPoint } from '../routing-rules'
import type { DuctBuildPlan } from './build-plan'

/**
 * Этап 9 конвейера агента (PLAN-AGENT §2.2): план построения → мутации узлов
 * `{ create, delete }` для одной undo-команды (`applyNodeChanges`).
 * Геометрия повторяет конвенции реального инструмента (packages/nodes/shared/
 * auto-fitting): отводы подрезают примыкающие звенья на длину плеча, тройник
 * режет магистраль с зазором ±плечо и ставится ровно в точке врезки, ветка
 * начинается от патрубка тройника. Повороты — перенос базиса (как
 * `planCornerJoint`, но на чистой math без three) с извлечением Euler XYZ по
 * конвенции three (порядок XYZ). Ограничения v1: седелка материализуется
 * тройником (портов седелки в реестре ещё нет); перепады осей дают наклонные
 * участки без пары вертикальных отводов.
 */

type Vec2 = readonly [number, number]
type Vec3 = readonly [number, number, number]

const MIN_LEG_M = 0.05
const BEND_MIN_DEG = 8
const BEND_MAX_DEG = 172

export type MaterializeOptions = {
  /** Родитель для создаваемых узлов (уровень/контейнер эскиза). */
  parentId?: AnyNodeId
  /** Узлы предыдущей сборки агента — попадают в delete (W5 регенерация). */
  existingAgentNodeIds?: readonly AnyNodeId[]
}

export type BuildMutations = {
  create: { node: AnyNode; parentId?: AnyNodeId }[]
  delete: AnyNodeId[]
  notes: string[]
}

function norm2(v: Vec2): Vec2 {
  const l = Math.hypot(v[0], v[1])
  return l < 1e-12 ? ([0, 0] as const) : ([v[0] / l, v[1] / l] as const)
}

function norm3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2])
  return l < 1e-12 ? ([0, 0, 0] as const) : ([v[0] / l, v[1] / l, v[2] / l] as const)
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/** Ортонормальный базис [n1, n2, n1×n2]: первый вдоль a, второй — компонент
 *  b, перпендикулярная a. Тот же construction rule, что `frame()` в
 *  packages/nodes/shared/auto-fitting. */
function frameBasis(a: Vec3, b: Vec3): [Vec3, Vec3, Vec3] | null {
  const n1 = norm3(a)
  if (n1.every((c) => c === 0)) return null
  const proj = dot3(b, n1)
  const w = norm3([b[0] - n1[0] * proj, b[1] - n1[1] * proj, b[2] - n1[2] * proj])
  if (w.every((c) => c === 0)) return null
  return [n1, w, cross3(n1, w)]
}

/** Euler XYZ (конвенция three) из матрицы поворота R (row-major, столбцы —
 *  образы локальных осей): y = asin(m13); x = atan2(−m23, m33);
 *  z = atan2(−m12, m11). */
function eulerXYZFromMatrix(r: readonly (readonly number[])[]): Vec3 {
  const m13 = Math.min(1, Math.max(-1, r[0]![2]!))
  const y = Math.asin(m13)
  if (Math.abs(m13) < 0.9999999) {
    return [Math.atan2(-r[1]![2]!, r[2]![2]!), y, Math.atan2(-r[0]![1]!, r[0]![0]!)]
  }
  return [Math.atan2(r[2]![1]!, r[1]![1]!), y, 0]
}

function matMul(a: readonly (readonly number[])[], b: readonly (readonly number[])[]): number[][] {
  const out: number[][] = []
  for (let i = 0; i < 3; i += 1) {
    out.push([])
    for (let j = 0; j < 3; j += 1) {
      out[i]!.push(a[i]![0]! * b[0]![j]! + a[i]![1]! * b[1]![j]! + a[i]![2]! * b[2]![j]!)
    }
  }
  return out
}

function transpose(m: readonly (readonly number[])[]): number[][] {
  return [
    [m[0]![0]!, m[1]![0]!, m[2]![0]!],
    [m[0]![1]!, m[1]![1]!, m[2]![1]!],
    [m[0]![2]!, m[1]![2]!, m[2]![2]!],
  ]
}

/** Перенос базиса: поворот, переводящий локальную пару (la, lb) в мировую
 *  (wa, wb). Аналог `worldFrame · localFrameᵀ` из planCornerJoint. */
function basisTransferEuler(la: Vec3, lb: Vec3, wa: Vec3, wb: Vec3): Vec3 | null {
  const local = frameBasis(la, lb)
  const world = frameBasis(wa, wb)
  if (!local || !world) return null
  return eulerXYZFromMatrix(matMul(world, transpose(local)))
}

/** Плечо фасонной части, м — как `fittingLegLength` в duct-fitting/ports. */
function fittingLegLengthM(diameterMm: number): number {
  return Math.max(0.14, (diameterMm / 1000 / 2) * 2.5)
}

function profileDiameterMm(profile: DuctSectionProfile): number {
  return profileBodyWidthM(profile) * 1000
}

function cumulativeLengths(points: readonly PlanPoint[]): number[] {
  const cum: number[] = [0]
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!
    const b = points[i + 1]!
    cum.push(cum[i]! + Math.hypot(b[0] - a[0], b[1] - a[1]))
  }
  return cum
}

type RunGeometry = {
  points: PlanPoint[]
  axisM: number[]
  cum: number[]
  totalM: number
}

function yAtS(run: RunGeometry, s: number): number {
  const { points, axisM, cum } = run
  if (points.length === 1 || run.totalM <= 0) return axisM[0] ?? 0
  for (let k = 0; k < points.length - 1; k += 1) {
    if (s <= cum[k + 1]! || k === points.length - 2) {
      const span = cum[k + 1]! - cum[k]!
      const t = span <= 1e-12 ? 0 : (s - cum[k]!) / span
      return (axisM[k] ?? 0) + t * ((axisM[k + 1] ?? 0) - (axisM[k] ?? 0))
    }
  }
  return axisM[axisM.length - 1] ?? 0
}

function pointAtS(run: RunGeometry, s: number): Vec3 {
  const { points, cum } = run
  const clamped = Math.min(run.totalM, Math.max(0, s))
  for (let k = 0; k < points.length - 1; k += 1) {
    if (clamped <= cum[k + 1]! || k === points.length - 2) {
      const a = points[k]!
      const b = points[k + 1]!
      const span = cum[k + 1]! - cum[k]!
      const t = span <= 1e-12 ? 0 : (clamped - cum[k]!) / span
      return [a[0] + t * (b[0] - a[0]), yAtS(run, clamped), a[1] + t * (b[1] - a[1])]
    }
  }
  const last = points[points.length - 1]!
  return [last[0], run.axisM[run.axisM.length - 1] ?? 0, last[1]]
}

function segDir2(run: RunGeometry, segmentIndex: number): Vec2 {
  const a = run.points[segmentIndex]!
  const b = run.points[segmentIndex + 1]!
  return norm2([b[0] - a[0], b[1] - a[1]])
}

/** Срез полилинии по дуге [sa, sb] в 3D (y интерполируется по осям вершин). */
function slicePoints3D(run: RunGeometry, sa: number, sb: number): Vec3[] {
  const out: Vec3[] = [pointAtS(run, sa)]
  for (let k = 1; k < run.points.length - 1; k += 1) {
    if (run.cum[k]! > sa + 1e-9 && run.cum[k]! < sb - 1e-9) {
      const p = run.points[k]!
      out.push([p[0], run.axisM[k] ?? 0, p[1]])
    }
  }
  out.push(pointAtS(run, sb))
  return out
}

/** Плановая точка (x, z) на дуге s (без высоты). */
function planPointAtS(run: RunGeometry, s: number): [number, number] {
  const point = pointAtS(run, s)
  return [point[0], point[2]]
}

/** Срез полилинии по дуге [sa, sb] на постоянной оси (горизонтальное звено
 *  у ризера): план тот же, y зафиксирован на `axis`. */
function slicePoints3DAtAxis(run: RunGeometry, sa: number, sb: number, axis: number): Vec3[] {
  const start = planPointAtS(run, sa)
  const out: Vec3[] = [[start[0], axis, start[1]]]
  for (let k = 1; k < run.points.length - 1; k += 1) {
    if (run.cum[k]! > sa + 1e-9 && run.cum[k]! < sb - 1e-9) {
      const p = run.points[k]!
      out.push([p[0], axis, p[1]])
    }
  }
  const end = planPointAtS(run, sb)
  out.push([end[0], axis, end[1]])
  return out
}

/** Есть ли перепад осей на вершине строго внутри дуги (sa, sb) — т.е. звено
 *  пересекает вертикаль, которую не вынесли в ризер. */
function hasAxisChangeInside(run: RunGeometry, sa: number, sb: number): boolean {
  for (let k = 1; k < run.axisM.length; k += 1) {
    const s = run.cum[k]!
    if (s <= sa + 1e-9 || s >= sb - 1e-9) continue
    if (Math.abs(run.axisM[k]! - run.axisM[k - 1]!) > 1e-6) return true
  }
  return false
}

/** Создать ризер (вертикальный переход): вертикальное звено между двумя
 *  отводами 90° на перепаде осей вершины `vertexIndex`. */
function createRiser(params: {
  create: BuildMutations['create']
  diameterMm: number
  legElbow: number
  runIndex: number
  run: RunGeometry
  system: DuctBuildPlan['runs'][number]['system']
  parentId?: AnyNodeId
  riser: { vertexIndex: number; riseM: number; axisBefore: number; axisAfter: number }
  notes: string[]
  fittings: DuctBuildPlan['fittings']
}): void {
  const { create, diameterMm, legElbow, runIndex, run, system, parentId, riser, notes, fittings } =
    params
  const v = riser.vertexIndex
  const point = run.points[v]!
  const sign = riser.riseM > 0 ? 1 : -1
  const topY = riser.axisBefore + sign * legElbow
  const bottomY = riser.axisAfter - sign * legElbow
  if (sign > 0 ? bottomY <= topY + 1e-6 : bottomY >= topY - 1e-6) {
    notes.push(
      `Ривер ${runIndex}v${v}: не помещается вертикальное звено — оставлен наклонный участок.`,
    )
    return
  }
  // Вертикальное звено между патрубками двух отводов.
  create.push({
    node: DuctSegmentNode.parse({
      object: 'node',
      parentId: null,
      visible: true,
      metadata: { agentRouting: true },
      path: [
        [point[0], topY, point[1]],
        [point[0], bottomY, point[1]],
      ],
      shape: 'round',
      diameter: diameterMm,
      system,
      ductMaterial: 'sheet-metal',
    }),
    parentId,
  })

  // Отводы: riser-a (горизонталь → вертикаль), riser-b (вертикаль → горизонталь).
  const inDir = norm3([point[0] - run.points[v - 1]![0], 0, point[1] - run.points[v - 1]![1]])
  const outDir = norm3([
    run.points[Math.min(v + 1, run.points.length - 1)]![0] - point[0],
    0,
    run.points[Math.min(v + 1, run.points.length - 1)]![1] - point[1],
  ])
  const vertical: Vec3 = [0, sign, 0]
  const rotationA = basisTransferEuler([1, 0, 0], [0, 0, 1], inDir, vertical)
  const rotationB = basisTransferEuler([1, 0, 0], [0, 0, 1], vertical, outDir)
  if (!rotationA || !rotationB) {
    notes.push(`Ривер ${runIndex}v${v}: вырожденная геометрия — оставлен наклонный участок.`)
    return
  }
  const specA = fittings.find((f) => f.key === `p${runIndex}v${v - 1}-riser-a`)
  const specB = fittings.find((f) => f.key === `p${runIndex}v${v - 1}-riser-b`)
  const radiusFactor = specA?.radiusFactor ?? specB?.radiusFactor ?? 1.5
  create.push({
    node: DuctFittingNode.parse({
      object: 'node',
      parentId: null,
      visible: true,
      metadata: { agentRouting: true },
      name: 'Отвод',
      fittingType: 'elbow',
      shape: 'round',
      diameter: diameterMm,
      diameter2: diameterMm,
      angle: 90,
      radiusFactor,
      ductMaterial: 'sheet-metal',
      system,
      position: [point[0], riser.axisBefore, point[1]],
      rotation: rotationA,
    }),
    parentId,
  })
  create.push({
    node: DuctFittingNode.parse({
      object: 'node',
      parentId: null,
      visible: true,
      metadata: { agentRouting: true },
      name: 'Отвод',
      fittingType: 'elbow',
      shape: 'round',
      diameter: diameterMm,
      diameter2: diameterMm,
      angle: 90,
      radiusFactor,
      ductMaterial: 'sheet-metal',
      system,
      position: [point[0], riser.axisAfter, point[1]],
      rotation: rotationB,
    }),
    parentId,
  })
  notes.push(
    `Ривер ${runIndex}v${v}: вертикальный переход ${riser.axisBefore.toFixed(2)} → ${riser.axisAfter.toFixed(2)} м (2 отвода 90°, R=${radiusFactor}D).`,
  )
}

function segmentPayload(
  path: Vec3[],
  profile: DuctSectionProfile,
  system: DuctBuildPlan['runs'][number]['system'],
): AnyNode {
  return DuctSegmentNode.parse({
    object: 'node',
    parentId: null,
    visible: true,
    metadata: { agentRouting: true },
    path: path.map((p) => [p[0], p[1], p[2]]),
    shape: profile.shape === 'round' ? 'round' : profile.shape,
    ...(profile.shape === 'round'
      ? { diameter: profile.diameterMm }
      : { width: profile.widthMm, height: profile.heightMm }),
    system,
    ductMaterial: 'sheet-metal',
  })
}

/**
 * Разложить план построения на мутации узлов одной undo-команды.
 * Детерминировано порядком plan.runs / plan.fittings.
 */
export function planBuildMutations(
  plan: DuctBuildPlan,
  options: MaterializeOptions = {},
): BuildMutations {
  const create: BuildMutations['create'] = []
  const deleteIds: AnyNodeId[] = [...(options.existingAgentNodeIds ?? [])]
  const notes: string[] = []
  const parentId = options.parentId

  const runs: RunGeometry[] = plan.runs.map((planned) => ({
    points: planned.points,
    axisM: planned.axisM,
    cum: cumulativeLengths(planned.points),
    totalM: 0,
  }))
  runs.forEach((run) => {
    run.totalM = run.cum[run.cum.length - 1] ?? 0
  })

  // Врезки: разрез хозяина с зазором ±плечо,payload тройника и патрубок ветки.
  const hostCuts = new Map<number, { s: number; halfGapM: number; key: string }[]>()
  const branchCollars = new Map<number, { point: Vec3; atStart: boolean }>()
  let saddleNoteShown = false
  for (const spec of plan.fittings) {
    if (spec.fittingType !== 'tee' && spec.fittingType !== 'saddle') continue
    if (spec.hostPathIndex == null || spec.hostT == null) continue
    const hostIndex = spec.hostPathIndex
    const host = runs[hostIndex]
    const branchRun = spec.pathIndex != null ? runs[spec.pathIndex] : undefined
    const branchPlanned = spec.pathIndex != null ? plan.runs[spec.pathIndex] : undefined
    const hostProfile = spec.profile
    const branchProfile = spec.branchProfile ?? branchPlanned?.profile ?? null
    if (!host || !hostProfile || !branchProfile || !branchRun) {
      notes.push(`Врезка ${spec.key}: пропущена — нет сечения магистрали или ветки.`)
      continue
    }
    const hostDiameterMm = profileDiameterMm(hostProfile)
    const branchDiameterMm = profileDiameterMm(branchProfile)
    const legRun = fittingLegLengthM(hostDiameterMm)
    const s = Math.min(host.totalM, Math.max(0, spec.hostT * host.totalM))
    if (s - legRun < MIN_LEG_M || s + legRun > host.totalM - MIN_LEG_M) {
      notes.push(`Врезка ${spec.key}: рядом с концом магистрали нет места под тройник — пропущена.`)
      continue
    }

    const tip = pointAtS(host, s)
    const axis3 = norm3([...segDir2(host, segmentIndexAt(host, s)), 0])
    const tipIsStart =
      Math.hypot(branchRun.points[0]![0] - tip[0], branchRun.points[0]![1] - tip[2]) <
      Math.hypot(
        branchRun.points[branchRun.points.length - 1]![0] - tip[0],
        branchRun.points[branchRun.points.length - 1]![1] - tip[2],
      )
    const farPoint = tipIsStart
      ? branchRun.points[Math.min(1, branchRun.points.length - 1)]!
      : branchRun.points[Math.max(0, branchRun.points.length - 2)]!
    const away = norm3([farPoint[0] - tip[0], 0, farPoint[1] - tip[2]])
    const along = dot3(away, axis3)
    const across3 = norm3([away[0] - axis3[0] * along, 0, away[2] - axis3[2] * along])
    if (Number.isNaN(across3[0]) || (across3[0] === 0 && across3[2] === 0)) {
      notes.push(`Врезка ${spec.key}: ветка коллинеарна магистрали — пропущена.`)
      continue
    }
    const acrossLen = Math.hypot(across3[0], across3[2])
    const rawAngleDeg = (Math.atan2(acrossLen, along) * 180) / Math.PI
    const branchAngleDeg = Math.min(135, Math.max(45, rawAngleDeg))
    const phi = (branchAngleDeg * Math.PI) / 180
    const branchOutDir = norm3([
      axis3[0]! * Math.cos(phi) + across3[0]! * Math.sin(phi),
      0,
      axis3[2]! * Math.cos(phi) + across3[2]! * Math.sin(phi),
    ])
    const legBranch = fittingLegLengthM(branchDiameterMm)
    const rotation = basisTransferEuler([1, 0, 0], [0, 0, 1], axis3, across3)
    if (!rotation) {
      notes.push(`Врезка ${spec.key}: вырожденная геометрия — пропущена.`)
      continue
    }

    create.push({
      node: DuctFittingNode.parse({
        object: 'node',
        parentId: null,
        visible: true,
        metadata: { agentRouting: true },
        name: spec.fittingType === 'saddle' ? 'Седелка (тройником)' : 'Тройник',
        fittingType: 'tee',
        shape: 'round',
        diameter: hostDiameterMm,
        diameter2: branchDiameterMm,
        angle: branchAngleDeg,
        radiusFactor: spec.radiusFactor ?? 1.5,
        ductMaterial: 'sheet-metal',
        system: spec.system,
        position: [tip[0], tip[1], tip[2]],
        rotation,
      }),
      parentId,
    })
    if (spec.fittingType === 'saddle' && !saddleNoteShown) {
      saddleNoteShown = true
      notes.push(
        'Седелки материализуются тройниками: порты седелки в реестре пока не смоделированы.',
      )
    }

    const list = hostCuts.get(hostIndex) ?? []
    list.push({ s, halfGapM: legRun, key: spec.key })
    hostCuts.set(hostIndex, list)

    if (spec.pathIndex != null) {
      const collar: Vec3 = [
        tip[0] + branchOutDir[0]! * legBranch,
        tip[1],
        tip[2] + branchOutDir[2]! * legBranch,
      ]
      branchCollars.set(spec.pathIndex, { point: collar, atStart: tipIsStart })
    }
  }

  // Звенья и отводы каждого пути.
  for (let runIndex = 0; runIndex < plan.runs.length; runIndex += 1) {
    const planned = plan.runs[runIndex]!
    const run = runs[runIndex]!
    const profile = planned.profile
    if (!profile) {
      notes.push(
        `Трасса №${planned.sourceRunIndex + 1}: без подобранного сечения — не материализована.`,
      )
      continue
    }
    if (planned.points.length < 2) continue
    const diameterMm = profileDiameterMm(profile)
    const legElbow = fittingLegLengthM(diameterMm)

    // Патрубок тройника удлиняет конец ветки до точки подключения.
    const collar = branchCollars.get(runIndex)
    if (collar?.atStart) {
      run.points = [[collar.point[0], collar.point[2]], ...run.points.slice(1)]
      run.cum = cumulativeLengths(run.points)
      run.totalM = run.cum[run.cum.length - 1] ?? 0
    } else if (collar) {
      run.points = [...run.points.slice(0, -1), [collar.point[0], collar.point[2]]]
      run.cum = cumulativeLengths(run.points)
      run.totalM = run.cum[run.cum.length - 1] ?? 0
    }

    // Границы звеньев: пары «левая/правая» вокруг изгиба (зазор ±плечо
    // отвода), врезки (зазор ±плечо тройника) и вертикального перехода
    // (ризер: зазор ±плечо отвода + вертикальный участок). Между парой звено
    // не создаётся — зазор занимает фасонная часть.
    type RiserBoundary = {
      vertexIndex: number
      riseM: number
      axisBefore: number
      axisAfter: number
    }
    type Boundary =
      | { s: number; kind: 'end' }
      | {
          s: number
          kind: 'left'
          gap: 'bend' | 'tap' | 'riser'
          vertex?: number
          riser?: RiserBoundary
        }
      | { s: number; kind: 'right'; gap: 'bend' | 'tap' | 'riser' }
    const boundaries: Boundary[] = [
      { s: 0, kind: 'end' },
      { s: run.totalM, kind: 'end' },
    ]
    const bendSpecByKey = new Map<string, (typeof plan.fittings)[number]>()
    for (let v = 1; v < run.points.length - 1; v += 1) {
      const dIn = segDir2(run, v - 1)
      const dOut = segDir2(run, v)
      const cos = dIn[0]! * dOut[0]! + dIn[1]! * dOut[1]!
      const deflectDeg = (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI
      if (deflectDeg < BEND_MIN_DEG || deflectDeg > BEND_MAX_DEG) continue
      const s = run.cum[v]!
      if (s - legElbow < MIN_LEG_M || s + legElbow > run.totalM - MIN_LEG_M) {
        notes.push(
          `Отвод на изгибе ${runIndex}v${v}: рядом с концом трассы нет места под отвод — пропущен.`,
        )
        continue
      }
      boundaries.push({ s: s - legElbow, kind: 'left', gap: 'bend', vertex: v })
      boundaries.push({ s: s + legElbow, kind: 'right', gap: 'bend' })
      const spec = plan.fittings.find((f) => f.key === `p${runIndex}v${v}-elbow`)
      if (spec) bendSpecByKey.set(spec.key, spec)
    }
    // Вертикальные переходы (§2.5): перепад осей соседних вершин — пара
    // отводов 90° + вертикальный участок. Слишком малый перепад (нет места
    // под два отвода) оставляет наклонный участок (v1 fallback, как раньше).
    for (let v = 1; v < run.points.length; v += 1) {
      const axisBefore = run.axisM[v - 1] ?? 0
      const axisAfter = run.axisM[v] ?? 0
      const riseM = axisAfter - axisBefore
      if (Math.abs(riseM) <= 1e-6) continue
      const s = run.cum[v]!
      if (s - legElbow < MIN_LEG_M || s + legElbow > run.totalM - MIN_LEG_M) {
        notes.push(
          `Ривер ${runIndex}v${v}: рядом с концом трассы нет места под пару отводов — оставлен наклонный участок.`,
        )
        continue
      }
      if (Math.abs(riseM) < 2 * legElbow + MIN_LEG_M) {
        notes.push(
          `Ривер ${runIndex}v${v}: перепад осей ${Math.abs(riseM).toFixed(2)} м мал для пары отводов — оставлен наклонный участок.`,
        )
        continue
      }
      boundaries.push({
        s: s - legElbow,
        kind: 'left',
        gap: 'riser',
        riser: { vertexIndex: v, riseM, axisBefore, axisAfter },
      })
      boundaries.push({ s: s + legElbow, kind: 'right', gap: 'riser' })
    }
    for (const cut of hostCuts.get(runIndex) ?? []) {
      boundaries.push({ s: cut.s - cut.halfGapM, kind: 'left', gap: 'tap' })
      boundaries.push({ s: cut.s + cut.halfGapM, kind: 'right', gap: 'tap' })
    }

    boundaries.sort((a, b) => a.s - b.s)
    const clean: Boundary[] = []
    for (const boundary of boundaries) {
      const prev = clean[clean.length - 1]
      if (prev && boundary.s - prev.s < MIN_LEG_M) continue
      clean.push(boundary)
    }

    for (let k = 0; k < clean.length - 1; k += 1) {
      const prev = clean[k]!
      const next = clean[k + 1]!
      // Зазор пары «левая→правая» занимает фасонная часть — звено не нужно.
      if (prev.kind === 'left' && next.kind === 'right') {
        if (prev.gap === 'riser' && prev.riser) {
          createRiser({
            create,
            diameterMm,
            legElbow,
            runIndex,
            run,
            system: planned.system,
            parentId,
            riser: prev.riser,
            notes,
            fittings: plan.fittings,
          })
        }
        continue
      }
      if (next.s - prev.s < MIN_LEG_M) continue
      // Звено у ризера идёт горизонтально на оси своей начальной вершины;
      // звено без перепада осей — как раньше (интерполяция по осям).
      const adjoinsRiser =
        (prev.kind !== 'end' && prev.gap === 'riser') ||
        (next.kind !== 'end' && next.gap === 'riser')
      const flatAtStart = adjoinsRiser && !hasAxisChangeInside(run, prev.s, next.s)
      const path = flatAtStart
        ? slicePoints3DAtAxis(run, prev.s, next.s, run.axisM[segmentIndexAt(run, prev.s)] ?? 0)
        : slicePoints3D(run, prev.s, next.s)
      create.push({
        node: segmentPayload(path, profile, planned.system),
        parentId,
      })
    }

    // Отводы на границах-изгибах.
    for (const boundary of clean) {
      if (boundary.kind !== 'left' || boundary.gap !== 'bend' || boundary.vertex == null) continue
      const v = boundary.vertex
      const corner = run.points[v]!
      const junction: Vec3 = [corner[0], run.axisM[v] ?? 0, corner[1]]
      const in3 = norm3([...segDir2(run, v - 1), 0])
      const out3 = norm3([...segDir2(run, v), 0])
      const cos = in3[0]! * out3[0]! + in3[2]! * out3[2]!
      const angleDeg = Math.round(
        Math.min(90, Math.max(0, (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI)),
      )
      const phi = (angleDeg * Math.PI) / 180
      const rotation = basisTransferEuler([1, 0, 0], [Math.cos(phi), 0, Math.sin(phi)], in3, out3)
      if (!rotation) continue
      const spec = bendSpecByKey.get(`p${runIndex}v${v}-elbow`)
      create.push({
        node: DuctFittingNode.parse({
          object: 'node',
          parentId: null,
          visible: true,
          metadata: { agentRouting: true },
          name: 'Отвод',
          fittingType: 'elbow',
          shape: 'round',
          diameter: diameterMm,
          diameter2: diameterMm,
          angle: angleDeg,
          radiusFactor: spec?.radiusFactor ?? 1.5,
          ductMaterial: 'sheet-metal',
          system: planned.system,
          position: [junction[0], junction[1], junction[2]],
          rotation,
        }),
        parentId,
      })
    }
  }

  return { create, delete: deleteIds, notes }
}

function segmentIndexAt(run: RunGeometry, s: number): number {
  for (let k = 0; k < run.points.length - 1; k += 1) {
    if (s <= run.cum[k + 1]! || k === run.points.length - 2) return k
  }
  return run.points.length - 2
}
