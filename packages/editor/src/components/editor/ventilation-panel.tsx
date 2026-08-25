'use client'

import type { AnyNode, AnyNodeId, DuctNetwork, WallNode, ZoneNode } from '@pascal-app/core'
import {
  assignZoneAirflowsToTerminals,
  buildDuctNetworks,
  buildDuctSpecification,
  computeNetworkFlows,
  computeNetworkPressure,
  computeZoneAirflows,
  DEFAULT_ROUTING_PREFERENCES,
  ductsToDxf,
  normalizeRoutingPreferences,
  planAllBypasses,
  planSystemMarkings,
  type RoutingPreferences,
  recommendEquipment,
  sizeDuctNetworks,
  sizedProfiles,
  specificationToCsv,
  terminalFlowMap,
  useScene,
  validateDuctNetwork,
} from '@pascal-app/core'
import {
  AlertTriangle,
  Calculator,
  Check,
  ClipboardList,
  Download,
  Eraser,
  Fan,
  Map as MapIcon,
  SlidersHorizontal,
  Wind,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  applyAllBypasses,
  applyRoutingPlan,
  type BypassApplyReport,
  clearSketch,
  countAgentBuiltNodes,
  type RoutingApplyReport,
} from '../../lib/mep-actions'
import { cn } from '../../lib/utils'
import useEditor from '../../store/use-editor'

const SUPPLY_COLOR = '#d4825a'
const EXHAUST_COLOR = '#5ab46a'
const RETURN_COLOR = '#5a8ad4'

const SYSTEM_META: Record<string, { letter: string; color: string; label: string }> = {
  supply: { letter: 'П', color: SUPPLY_COLOR, label: 'Приток' },
  exhaust: { letter: 'В', color: EXHAUST_COLOR, label: 'Вытяжка' },
  return: { letter: 'Р', color: RETURN_COLOR, label: 'Рециркуляция' },
}

function systemChip(system: string) {
  const meta = SYSTEM_META[system] ?? {
    letter: system[0]?.toUpperCase() ?? '?',
    color: '#9ca3af',
    label: system,
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-medium text-[10px]"
      key={system}
      style={{ borderColor: `${meta.color}66`, color: meta.color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta.color }} />
      {meta.letter} · {meta.label}
    </span>
  )
}

/**
 * Панель «Вентиляция» — список систем П/В, кнопка «Автообвод пересечений»,
 * сводка потерь и замечания связности. Read-only поверх сцены; тумблер
 * приходит из тулбара (как Riser Diagram). Автообвод применяет мутации
 * одной командой (один undo-шаг).
 */
function shortNodeId(id: string): string {
  return id.replace(/^duct-segment_/, '')
}

function profileLabel(profile: {
  shape: string
  diameterMm?: number
  widthMm?: number
  heightMm?: number
}): string {
  return profile.shape === 'round'
    ? `Ø${profile.diameterMm}`
    : `${profile.widthMm}×${profile.heightMm}`
}

/**
 * Этап 8 — секция «Расчёт сети»: воздухообмен зон → расходы на участках →
 * подбор сечений по СП 60 → потери по путям с критическим путём и
 * балансировкой ответвлений. Таблица «участок → Q, сечение, v, ΔP» с
 * подсветкой участков вне норм-диапазона и шумовой проверки.
 */
function NetworkCalcSection({
  nodes,
  markings,
  networks,
}: {
  nodes: Record<AnyNodeId, AnyNode>
  markings: Record<AnyNodeId, string>
  networks: DuctNetwork[]
}) {
  const [open, setOpen] = useState(false)

  const calc = useMemo(() => {
    const zones = Object.values(nodes).filter(
      (node): node is ZoneNode => node?.type === 'zone' && node.spaceRole === 'room',
    )
    const airflows = computeZoneAirflows(zones)
    const assignments = assignZoneAirflowsToTerminals(nodes, zones)
    const terminalFlows = terminalFlowMap(assignments)
    const flows = computeNetworkFlows(nodes, { terminalFlows })
    const sizing = sizeDuctNetworks(nodes, { flows })
    const pressure = computeNetworkPressure(nodes, { flows, profiles: sizedProfiles(sizing) })
    const unassigned = airflows.filter(
      (airflow) =>
        airflow.requiredFlowM3h !== null &&
        airflow.requiredFlowM3h > 0 &&
        !assignments.some((assignment) => assignment.zoneId === airflow.zoneId),
    )
    return { zones, airflows, assignments, flows, sizing, pressure, unassigned }
  }, [nodes])

  const hasRooms = calc.zones.length > 0

  return (
    <div className="rounded-xl border border-border/45 bg-background/75">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <Calculator className="h-3.5 w-3.5 text-muted-foreground" />
        <button
          className="flex-1 text-left font-medium text-xs"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          Расчёт сети
        </button>
        {!hasRooms && <span className="text-[10px] text-muted-foreground">нет зон-помещений</span>}
      </div>

      {open && (
        <div className="space-y-2 border-t border-border/40 p-2.5">
          {!hasRooms ? (
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Добавьте зоны помещений с категорией по СП (инспектор зоны → «Вентиляция»), чтобы
              рассчитать воздухообмен, расходы на участках и сетевые потери.
            </p>
          ) : (
            <>
              {calc.unassigned.length > 0 && (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-200">
                  {calc.unassigned.length} помещение(й) без подходящего терминала (притока/вытяжки)
                  — их расход не учтён в сети.
                </p>
              )}

              {calc.pressure.map((pressureResult, index) => {
                const network = networks[index]
                const mark = network
                  ? (markings[network.nodeIds[0]!] ?? pressureResult.systems[0] ?? '?')
                  : '?'
                const flowResult = calc.flows[index]
                const unbalanced = pressureResult.balances.filter(
                  (balance) => !balance.withinTolerance,
                ).length
                return (
                  <div
                    className="rounded-lg border border-border/40 bg-background/60 px-2.5 py-1.5 text-[10px]"
                    key={index}
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="rounded-md bg-white/10 px-1.5 py-0.5 font-mono font-semibold">
                        {mark}
                      </span>
                      <span className="text-muted-foreground">
                        ΣQ{' '}
                        <span className="font-mono text-foreground">
                          {(flowResult?.totalFlowM3h ?? 0).toFixed(0)} м³/ч
                        </span>
                      </span>
                      <span className="text-muted-foreground">
                        Крит. путь{' '}
                        <span className="font-mono text-foreground">
                          {pressureResult.totalPressurePa.toFixed(1)} Па
                        </span>
                      </span>
                      <span className="text-muted-foreground">
                        Путей{' '}
                        <span className="font-mono text-foreground">
                          {pressureResult.paths.length}
                        </span>
                      </span>
                      {unbalanced > 0 && (
                        <span className="ml-auto rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-amber-300">
                          {unbalanced} разбалансировк.
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}

              <table className="w-full text-left text-[10px]">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border/40">
                    <th className="px-1.5 py-1 font-medium">Участок</th>
                    <th className="px-1.5 py-1 font-medium">С</th>
                    <th className="px-1.5 py-1 text-right font-medium">Q, м³/ч</th>
                    <th className="px-1.5 py-1 font-medium">Сечение</th>
                    <th className="px-1.5 py-1 text-right font-medium">v, м/с</th>
                    <th className="px-1.5 py-1 text-right font-medium">ΔP, Па</th>
                  </tr>
                </thead>
                <tbody>
                  {calc.sizing
                    .flatMap((result) => result.segments)
                    .map((segment) => {
                      const warn = !segment.inNormBand || segment.noiseCheckRequired
                      return (
                        <tr
                          className={`border-b border-border/25 ${warn ? 'bg-amber-500/5' : ''}`}
                          key={segment.segmentId}
                        >
                          <td className="px-1.5 py-1 font-mono" title={segment.segmentId}>
                            {shortNodeId(segment.segmentId)}
                          </td>
                          <td className="px-1.5 py-1">
                            <span
                              className="font-mono font-semibold"
                              style={{ color: SYSTEM_META[segment.system]?.color }}
                            >
                              {SYSTEM_META[segment.system]!.letter}
                            </span>
                          </td>
                          <td className="px-1.5 py-1 text-right font-mono">
                            {segment.flowM3h.toFixed(0)}
                          </td>
                          <td className="px-1.5 py-1 font-mono">{profileLabel(segment.profile)}</td>
                          <td className="px-1.5 py-1 text-right font-mono">
                            {segment.velocityMps.toFixed(1)}
                          </td>
                          <td className="px-1.5 py-1 text-right font-mono">
                            {segment.frictionDropPa.toFixed(1)}
                          </td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>

              {(calc.sizing.some((result) => result.warnings.length > 0) ||
                calc.pressure.some((result) => result.warnings.length > 0)) && (
                <div className="space-y-1">
                  {calc.sizing.flatMap((result, index) =>
                    result.warnings.map((warning, warningIndex) => (
                      <p
                        className="flex items-start gap-1.5 text-[10px] text-amber-200"
                        key={`s${index}-${warningIndex}`}
                      >
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        {warning}
                      </p>
                    )),
                  )}
                  {calc.pressure.flatMap((result, index) =>
                    result.warnings.map((warning, warningIndex) => (
                      <p
                        className="flex items-start gap-1.5 text-[10px] text-amber-200"
                        key={`p${index}-${warningIndex}`}
                      >
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        {warning}
                      </p>
                    )),
                  )}
                </div>
              )}

              <p className="text-[9px] text-muted-foreground">
                Подсветка — скорость вне норм-диапазона СП 60 прил. Л или шумовая проверка (&gt;5
                м/с). Порог балансировки ответвлений 15% — рабочее значение до верификации по СП 60.
                Статусы верификации: ξ отводов и фиттингов — FITTING_ZETA_VERIFIED=false (справочник
                ОВиК / Идельчик, до сверки с нормой).
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function VentilationPanel() {
  const isOpen = useEditor((s) => s.isVentilationOpen)
  if (!isOpen) return null
  return <VentilationContent />
}

function VentilationContent() {
  const setVentilationOpen = useEditor((s) => s.setVentilationOpen)
  const nodes = useScene((s) => s.nodes)
  const [report, setReport] = useState<BypassApplyReport | null>(null)
  const [routingReport, setRoutingReport] = useState<RoutingApplyReport | null>(null)
  const [showSpec, setShowSpec] = useState(false)
  const [preferences, setPreferences] = useState<Partial<RoutingPreferences>>({})
  const [showPreferences, setShowPreferences] = useState(false)
  const [sketchCleared, setSketchCleared] = useState<number | null>(null)
  const prefs = normalizeRoutingPreferences(preferences)

  const networks = useMemo(() => buildDuctNetworks(nodes), [nodes])
  const markings = useMemo(() => planSystemMarkings(nodes), [nodes])
  const bypass = useMemo(() => planAllBypasses(nodes), [nodes])
  const findings = useMemo(() => validateDuctNetwork(nodes), [nodes])
  // Этап 10: сетевой подбор (Этап 8) привязывается к строкам спецификации.
  const sizing = useMemo(() => {
    const zones = Object.values(nodes).filter(
      (node): node is ZoneNode => node?.type === 'zone' && node.spaceRole === 'room',
    )
    const assignments = assignZoneAirflowsToTerminals(nodes, zones)
    const flows = computeNetworkFlows(nodes, {
      terminalFlows: terminalFlowMap(assignments),
    })
    return sizeDuctNetworks(nodes, { flows })
  }, [nodes])
  const walls = useMemo(
    () => Object.values(nodes).filter((node): node is WallNode => node?.type === 'wall'),
    [nodes],
  )
  // C2: рекомендация оборудования по потребностям П/В из зон (до трассировки).
  const equipmentRecommendation = useMemo(() => {
    const zones = Object.values(nodes).filter(
      (node): node is ZoneNode => node?.type === 'zone' && node.spaceRole === 'room',
    )
    const airflows = computeZoneAirflows(zones)
    let supply = 0
    let exhaust = 0
    for (const airflow of airflows) {
      const flow = airflow.requiredFlowM3h ?? 0
      if (airflow.direction === 'supply') supply += flow
      else exhaust += flow
    }
    return recommendEquipment(supply, exhaust)
  }, [nodes])
  const specification = useMemo(
    () => buildDuctSpecification(nodes, { markings, sizing }),
    [nodes, markings, sizing],
  )

  const hasDucts = networks.length > 0
  const hasCrossings = bypass.plans.length + bypass.skipped.length > 0
  const totalLengthM = networks.reduce((sum, network) => sum + network.lengthM, 0)
  // W5: узлы прошлой сборки агента — предупреждение перед повторной трассировкой.
  const agentBuiltCount = useMemo(() => countAgentBuiltNodes(nodes), [nodes])

  const handleAutoBypass = () => {
    const next = applyAllBypasses()
    setReport(next)
  }

  const handleRouting = () => {
    const next = applyRoutingPlan(preferences)
    setRoutingReport(next)
    setSketchCleared(null)
  }

  const handleClearSketch = () => {
    const result = clearSketch()
    setSketchCleared(result.removed)
    setRoutingReport(null)
  }

  const handleDownload = (filename: string, content: string, type: string) => {
    const url = URL.createObjectURL(new Blob([content], { type }))
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }

  const handleExportCsv = () => {
    handleDownload(
      `specification_${new Date().toISOString().split('T')[0]}.csv`,
      specificationToCsv(specification),
      'text/csv;charset=utf-8',
    )
  }

  const handleExportDxf = () => {
    handleDownload(
      `ventilation_plan_${new Date().toISOString().split('T')[0]}.dxf`,
      ductsToDxf(nodes, { markings, walls }),
      'application/dxf',
    )
  }

  return (
    <div className="dark pointer-events-auto absolute top-4 right-4 z-30 flex max-h-[80vh] w-[24rem] flex-col overflow-hidden rounded-2xl border border-border/40 bg-background/95 text-foreground shadow-lg backdrop-blur-xl">
      <div className="flex items-center justify-between border-border/40 border-b px-4 py-2.5">
        <div className="flex flex-col">
          <span className="flex items-center gap-1.5 font-medium text-sm">
            <Wind className="h-4 w-4 text-sky-400" /> Вентиляция
          </span>
          <span className="text-muted-foreground text-xs">Системы П/В · ГОСТ 21.602</span>
        </div>
        <button
          aria-label="Close ventilation panel"
          className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-white/10"
          onClick={() => setVentilationOpen(false)}
          type="button"
        >
          <X className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      <div className="flex items-center gap-3 border-border/40 border-b px-4 py-2 text-xs">
        {(['supply', 'exhaust', 'return'] as const).map((system) => (
          <span className="flex items-center gap-1.5" key={system}>
            <span className="h-0.5 w-4" style={{ background: SYSTEM_META[system]!.color }} />
            {SYSTEM_META[system]!.letter}
          </span>
        ))}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {!hasDucts ? (
          <div className="flex h-32 items-center justify-center px-6 text-center text-muted-foreground text-sm">
            Воздуховоды ещё не нарисованы. Добавьте трассы П/В, чтобы увидеть системы и пересечения.
          </div>
        ) : (
          <>
            <div className="rounded-xl border border-border/45 bg-background/60 px-3 py-2 text-xs">
              <span className="text-muted-foreground">Участков в сетях: </span>
              <span className="font-mono font-medium text-foreground">{networks.length}</span>
              <span className="ml-3 text-muted-foreground">Суммарная длина: </span>
              <span className="font-mono font-medium text-foreground">
                {totalLengthM.toFixed(1)} м
              </span>
            </div>

            <div className="space-y-2">
              {networks.map((network) => {
                const mark = markings[network.nodeIds[0]!] ?? network.systems[0] ?? '?'
                return (
                  <div
                    className="rounded-xl border border-border/45 bg-background/75 p-2.5"
                    key={network.nodeIds[0]}
                  >
                    <div className="flex items-center gap-2">
                      <span className="rounded-md bg-white/10 px-2 py-0.5 font-mono font-semibold text-xs">
                        {mark}
                      </span>
                      <div className="flex min-w-0 flex-wrap gap-1">
                        {network.systems.map((system) => systemChip(system))}
                      </div>
                      <span
                        className={cn(
                          'ml-auto shrink-0 text-[10px]',
                          network.connectedToEquipment ? 'text-emerald-400' : 'text-amber-400',
                        )}
                      >
                        {network.connectedToEquipment ? 'С установкой' : 'Нет установки'}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                      <span>
                        Длина{' '}
                        <span className="font-mono text-foreground">
                          {network.lengthM.toFixed(1)} м
                        </span>
                      </span>
                      <span>
                        Свободных концов{' '}
                        <span
                          className={cn(
                            'font-mono',
                            network.openEndCount > 0 ? 'text-amber-400' : 'text-foreground',
                          )}
                        >
                          {network.openEndCount}
                        </span>
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>

            {findings.length > 0 && (
              <div className="space-y-1.5">
                {findings.map((finding, index) => (
                  <div
                    className={cn(
                      'flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs',
                      finding.severity === 'error'
                        ? 'border-red-500/30 bg-red-500/10 text-red-200'
                        : 'border-amber-500/30 bg-amber-500/10 text-amber-200',
                    )}
                    key={`${finding.code}-${index}`}
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{finding.message}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="font-medium text-xs">Автообвод пересечений П/В</p>
                  <p className="text-muted-foreground text-[10px]">
                    {hasCrossings
                      ? `${bypass.plans.length} пересечений готово, ${bypass.skipped.length} пропущено`
                      : 'Пересечений не найдено'}
                  </p>
                </div>
                <button
                  className="shrink-0 rounded-md border border-sky-400/40 bg-sky-500/20 px-2.5 py-1.5 font-medium text-xs text-sky-200 transition-colors hover:bg-sky-500/30 disabled:cursor-default disabled:opacity-40"
                  disabled={bypass.plans.length === 0}
                  onClick={handleAutoBypass}
                  type="button"
                >
                  Обойти
                </button>
              </div>

              {bypass.plans.map((plan) => (
                <div
                  className="mt-2 flex items-start gap-2 rounded-lg border border-border/40 bg-background/60 px-2 py-1.5 text-[10px]"
                  key={`${plan.crossing.supplyNodeId}-${plan.crossing.exhaustNodeId}`}
                >
                  <span className="font-mono font-semibold" style={{ color: SUPPLY_COLOR }}>
                    П
                  </span>
                  <span className="text-muted-foreground">∩</span>
                  <span className="font-mono font-semibold" style={{ color: EXHAUST_COLOR }}>
                    В
                  </span>
                  <span className="text-muted-foreground">
                    — утка {plan.angleDeg}° · сдвиг {plan.offsetMm} мм ·{' '}
                    {plan.bypassLengthM.toFixed(2)} м
                  </span>
                  {plan.autoSwitchedTo90 && (
                    <span
                      className="ml-auto rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-amber-300"
                      title="45° не поместился по длине прямой — выбран 90°"
                    >
                      45→90°
                    </span>
                  )}
                </div>
              ))}
              {bypass.skipped.length > 0 && (
                <div className="mt-2 text-[10px] text-muted-foreground">
                  {bypass.skipped.length} пересечений:{' '}
                  {bypass.skipped[0]?.reason === 'no-room'
                    ? 'не хватает длины прямой'
                    : 'нет геометрии'}
                </div>
              )}
            </div>

            {report && (
              <div
                className={cn(
                  'rounded-xl border px-3 py-2 text-xs',
                  report.applied > 0
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                    : 'border-border/45 bg-background/60 text-muted-foreground',
                )}
              >
                <span className="flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5" />
                  {report.applied > 0
                    ? `Построено обводов: ${report.applied}`
                    : 'Обводов не построено'}
                </span>
                {report.switchedTo90 > 0 && (
                  <span className="mt-0.5 block">
                    Подсказка: {report.switchedTo90} утка(и) автоматически переключены на 90° — 45°
                    не помещается по длине прямой.
                  </span>
                )}
              </div>
            )}

            <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-2.5">
              <div className="flex items-center gap-2">
                <Fan className="h-3.5 w-3.5 text-emerald-300" />
                <p className="font-medium text-xs">Рекомендация оборудования</p>
              </div>
              {equipmentRecommendation.length === 0 ? (
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                  Назначьте тип помещения зонам (СП 54) — рекомендация появится по воздухообмену.
                </p>
              ) : (
                <div className="mt-1.5 space-y-2">
                  {equipmentRecommendation.map((recommendation) => (
                    <div
                      className="rounded-lg border border-border/40 bg-background/60 px-2.5 py-2"
                      key={recommendation.category}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-xs">{recommendation.label}</span>
                        <span className="font-mono text-[10px] text-emerald-300">
                          {recommendation.flowM3h.toFixed(0)} м³/ч → {recommendation.nominalM3h}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {recommendation.reason}
                      </p>
                      {recommendation.notes.length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
                          {recommendation.notes.map((note) => (
                            <li key={note}>· {note}</li>
                          ))}
                        </ul>
                      )}
                      {recommendation.references.length > 0 && (
                        <p className="mt-1 text-[9px] text-muted-foreground/60">
                          {recommendation.references.join(' · ')}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-violet-500/30 bg-violet-500/10 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="font-medium text-xs">Агент трассировки</p>
                  <p className="text-muted-foreground text-[10px]">
                    Эскиз П/В → сеть по нормам (СП 54/СП 60), одна undo-команда
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    className="rounded-md border border-border/40 bg-background/60 px-2 py-1.5 font-medium text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                    onClick={handleClearSketch}
                    title="Удалить эскиз (полилинии) одной командой — «Очистить эскиз»"
                    type="button"
                  >
                    <Eraser className="mr-1 inline h-3 w-3" />
                    Очистить эскиз
                  </button>
                  <button
                    className="rounded-md border border-violet-400/40 bg-violet-500/20 px-2.5 py-1.5 font-medium text-xs text-violet-100 transition-colors hover:bg-violet-500/30 disabled:cursor-default disabled:opacity-40"
                    onClick={handleRouting}
                    type="button"
                  >
                    Трассировка
                  </button>
                </div>
              </div>

              {/* W5: перед повторной сборкой предупреждаем, что прошлая пересоздаётся. */}
              {agentBuiltCount > 0 && (
                <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[10px] text-amber-200">
                  <span className="flex items-center gap-1.5">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    Повторная «Трассировка» пересоздаст {agentBuiltCount} узлов прошлой сборки —
                    ручные правки этих трасс будут потеряны (один undo-шаг).
                  </span>
                </div>
              )}

              {sketchCleared !== null && (
                <div className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[10px] text-emerald-200">
                  <span className="flex items-center gap-1.5">
                    <Check className="h-3 w-3 shrink-0" />
                    Эскиз очищен: удалено полилиний — {sketchCleared}.
                  </span>
                </div>
              )}

              {routingReport?.status === 'no-sketch' && (
                <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200">
                  <span className="flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Нет эскиза: нарисуйте трассы в режиме «Эскиз» duct-инструмента (K).
                  </span>
                </div>
              )}

              {routingReport?.status === 'blocked' && (
                <div className="mt-2 space-y-1.5">
                  {routingReport.blockers.map((blocker) => (
                    <div
                      className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-2 text-xs text-red-200"
                      key={blocker}
                    >
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{blocker}</span>
                    </div>
                  ))}
                </div>
              )}

              {routingReport?.status === 'applied' && (
                <div className="mt-2 space-y-2">
                  <div className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 text-xs text-emerald-200">
                    <Check className="h-3.5 w-3.5" />
                    Построено участков: {routingReport.created}
                    {routingReport.removed > 0 && ` · пересоздано: ${routingReport.removed}`}
                  </div>

                  {routingReport.violations.length > 0 && (
                    <div className="space-y-1.5">
                      {routingReport.violations.map((violation) => (
                        <div
                          className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200"
                          key={violation}
                        >
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>{violation}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {routingReport.solutions.length > 0 && (
                    <details className="rounded-lg border border-border/40 bg-background/60 px-2.5 py-2">
                      <summary className="flex items-center gap-1.5 cursor-pointer text-xs text-muted-foreground">
                        <MapIcon className="h-3.5 w-3.5" />
                        Решения трассировки ({routingReport.solutions.length})
                      </summary>
                      <ul className="mt-1.5 space-y-1">
                        {routingReport.solutions.map((solution) => (
                          <li className="text-[10px] text-muted-foreground" key={solution}>
                            {solution}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {routingReport.notes.length > 0 && (
                    <div className="text-[10px] text-muted-foreground">
                      {routingReport.notes.map((note) => (
                        <p key={note}>· {note}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-border/45 bg-background/75">
              <div className="flex items-center gap-2 px-2.5 py-2">
                <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                <button
                  className="flex-1 text-left font-medium text-xs"
                  onClick={() => setShowPreferences((value) => !value)}
                  type="button"
                >
                  Предпочтения трассировки
                </button>
                <span className="text-[10px] text-muted-foreground">
                  аналог Revit Routing Prefs
                </span>
              </div>

              {showPreferences && (
                <div className="space-y-2 border-t border-border/40 p-2.5">
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[10px]">
                    <label className="flex flex-col gap-1 text-muted-foreground">
                      Врезка ответвления
                      <select
                        className="rounded-md border border-border/40 bg-background/80 px-1.5 py-1 text-foreground"
                        value={prefs.branchFitting}
                        onChange={(event) =>
                          setPreferences((value) => ({
                            ...value,
                            branchFitting: event.target
                              .value as RoutingPreferences['branchFitting'],
                          }))
                        }
                      >
                        <option value="auto">Авто (по d/D)</option>
                        <option value="tee">Тройник</option>
                        <option value="saddle">Седелка</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-muted-foreground">
                      Угол врезки
                      <select
                        className="rounded-md border border-border/40 bg-background/80 px-1.5 py-1 text-foreground"
                        value={prefs.branchTapAngleDeg}
                        onChange={(event) =>
                          setPreferences((value) => ({
                            ...value,
                            branchTapAngleDeg: event.target.value === '90' ? 90 : 45,
                          }))
                        }
                      >
                        <option value={45}>45° (меньше потерь)</option>
                        <option value={90}>90°</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-muted-foreground">
                      Радиус отводов R/D
                      <select
                        className="rounded-md border border-border/40 bg-background/80 px-1.5 py-1 text-foreground"
                        value={prefs.elbowRadiusFactor}
                        onChange={(event) =>
                          setPreferences((value) => ({
                            ...value,
                            elbowRadiusFactor: Number(event.target.value),
                          }))
                        }
                      >
                        <option value={1}>1D (короткий)</option>
                        <option value={1.5}>1.5D (стандарт)</option>
                        <option value={2}>2D</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-muted-foreground">
                      Метод подбора
                      <select
                        className="rounded-md border border-border/40 bg-background/80 px-1.5 py-1 text-foreground"
                        value={prefs.sizingMethod}
                        onChange={(event) =>
                          setPreferences((value) => ({
                            ...value,
                            sizingMethod: event.target.value as RoutingPreferences['sizingMethod'],
                          }))
                        }
                      >
                        <option value="velocity-sp60">Скорость СП 60</option>
                        <option value="equal-friction">Равные потери</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-muted-foreground">
                      Допуск терминала, м
                      <input
                        className="rounded-md border border-border/40 bg-background/80 px-1.5 py-1 text-foreground"
                        type="number"
                        min={0.05}
                        max={5}
                        step={0.1}
                        value={prefs.terminalConnectToleranceM}
                        onChange={(event) =>
                          setPreferences((value) => ({
                            ...value,
                            terminalConnectToleranceM: Number(event.target.value),
                          }))
                        }
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-muted-foreground">
                      Зазор утки, мм
                      <input
                        className="rounded-md border border-border/40 bg-background/80 px-1.5 py-1 text-foreground"
                        type="number"
                        min={20}
                        max={500}
                        step={10}
                        value={prefs.bypassGapMm}
                        onChange={(event) =>
                          setPreferences((value) => ({
                            ...value,
                            bypassGapMm: Number(event.target.value),
                          }))
                        }
                      />
                    </label>
                  </div>
                  {prefs.sizingMethod === 'equal-friction' && (
                    <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
                      Цель удельных потерь, Па/м
                      <input
                        className="rounded-md border border-border/40 bg-background/80 px-1.5 py-1 text-foreground"
                        type="number"
                        min={0.1}
                        max={10}
                        step={0.1}
                        value={prefs.equalFrictionPaPerM}
                        onChange={(event) =>
                          setPreferences((value) => ({
                            ...value,
                            equalFrictionPaPerM: Number(event.target.value),
                          }))
                        }
                      />
                    </label>
                  )}
                  <button
                    className="rounded-md border border-border/40 bg-background/60 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => setPreferences({ ...DEFAULT_ROUTING_PREFERENCES })}
                    type="button"
                  >
                    Сбросить к умолчаниям
                  </button>
                </div>
              )}
            </div>

            <NetworkCalcSection markings={markings} networks={networks} nodes={nodes} />

            <div className="rounded-xl border border-border/45 bg-background/75">
              <div className="flex items-center gap-2 px-2.5 py-2">
                <ClipboardList className="h-3.5 w-3.5 text-muted-foreground" />
                <button
                  className="flex-1 text-left font-medium text-xs"
                  onClick={() => setShowSpec((v) => !v)}
                  type="button"
                >
                  Спецификация
                </button>
                {showSpec && (
                  <div className="flex items-center gap-1">
                    <button
                      className="flex items-center gap-1 rounded-md border border-border/40 bg-background/60 px-1.5 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                      onClick={handleExportCsv}
                      title="Скачать ведомость CSV"
                      type="button"
                    >
                      <Download className="h-3 w-3" /> CSV
                    </button>
                    <button
                      className="flex items-center gap-1 rounded-md border border-border/40 bg-background/60 px-1.5 py-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                      onClick={handleExportDxf}
                      title="Скачать план вентиляции DXF (П/В)"
                      type="button"
                    >
                      <Download className="h-3 w-3" /> DXF
                    </button>
                  </div>
                )}
              </div>

              {showSpec && (
                <div className="max-h-48 overflow-y-auto border-t border-border/40">
                  <table className="w-full text-left text-[10px]">
                    <thead className="sticky top-0 bg-background/95 text-muted-foreground">
                      <tr className="border-b border-border/40">
                        <th className="px-2 py-1 font-medium">Поз.</th>
                        <th className="px-2 py-1 font-medium">Наименование</th>
                        <th className="px-2 py-1 font-medium">С</th>
                        <th className="px-2 py-1 text-right font-medium">Ед.</th>
                        <th className="px-2 py-1 text-right font-medium">Кол-во</th>
                        <th className="px-2 py-1 text-right font-medium">Длина, м</th>
                      </tr>
                    </thead>
                    <tbody>
                      {specification.sections.ducts.map((row) => (
                        <tr className="border-b border-border/30" key={`d${row.pos}`}>
                          <td className="px-2 py-1 text-muted-foreground">{row.pos}</td>
                          <td className="px-2 py-1" title={row.note}>
                            {row.name}
                          </td>
                          <td className="px-2 py-1">
                            {row.system ? (
                              <span
                                className="font-mono font-semibold"
                                style={{ color: SYSTEM_META[row.system]?.color }}
                              >
                                {SYSTEM_META[row.system]!.letter}
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-2 py-1 text-right text-muted-foreground">{row.unit}</td>
                          <td className="px-2 py-1 text-right font-mono">{row.quantity}</td>
                          <td className="px-2 py-1 text-right font-mono">
                            {row.lengthM !== undefined ? row.lengthM.toFixed(2) : '—'}
                          </td>
                        </tr>
                      ))}
                      {specification.sections.fittings.map((row) => (
                        <tr className="border-b border-border/30" key={`f${row.pos}`}>
                          <td className="px-2 py-1 text-muted-foreground">{row.pos}</td>
                          <td className="px-2 py-1">{row.name}</td>
                          <td className="px-2 py-1">—</td>
                          <td className="px-2 py-1 text-right text-muted-foreground">{row.unit}</td>
                          <td className="px-2 py-1 text-right font-mono">{row.quantity}</td>
                          <td className="px-2 py-1 text-right font-mono">—</td>
                        </tr>
                      ))}
                      {specification.sections.terminals.map((row) => (
                        <tr className="border-b border-border/30" key={`t${row.pos}`}>
                          <td className="px-2 py-1 text-muted-foreground">{row.pos}</td>
                          <td className="px-2 py-1">{row.name}</td>
                          <td className="px-2 py-1">—</td>
                          <td className="px-2 py-1 text-right text-muted-foreground">{row.unit}</td>
                          <td className="px-2 py-1 text-right font-mono">{row.quantity}</td>
                          <td className="px-2 py-1 text-right font-mono">—</td>
                        </tr>
                      ))}
                      {specification.sections.hardware.map((row) => (
                        <tr className="border-b border-border/30" key={`h${row.pos}`}>
                          <td className="px-2 py-1 text-muted-foreground">{row.pos}</td>
                          <td className="px-2 py-1">{row.name}</td>
                          <td className="px-2 py-1">—</td>
                          <td className="px-2 py-1 text-right text-muted-foreground">{row.unit}</td>
                          <td className="px-2 py-1 text-right font-mono">{row.quantity}</td>
                          <td className="px-2 py-1 text-right font-mono">—</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border/40 bg-background/60 px-2.5 py-1.5 text-[10px] text-muted-foreground">
                    <span>
                      Длина:{' '}
                      <span className="font-mono text-foreground">
                        {specification.totals.lengthM.toFixed(1)} м
                      </span>
                    </span>
                    <span>
                      Сталь:{' '}
                      <span className="font-mono text-foreground">
                        {specification.totals.sheetAreaM2.toFixed(1)} м²
                      </span>
                    </span>
                    <span>
                      Масса:{' '}
                      <span className="font-mono text-foreground">
                        {specification.totals.massKg.toFixed(1)} кг
                      </span>
                    </span>
                    <span>
                      Крепления:{' '}
                      <span className="font-mono text-foreground">
                        {specification.totals.supports}
                      </span>
                    </span>
                    <span>
                      Гильзы:{' '}
                      <span className="font-mono text-foreground">
                        {specification.totals.sleeves}
                      </span>
                    </span>
                  </div>
                  {specification.warnings.length > 0 && (
                    <div className="space-y-1 px-2.5 py-1.5">
                      {specification.warnings.map((warning, index) => (
                        <p
                          className="flex items-start gap-1.5 text-[10px] text-amber-200"
                          key={index}
                        >
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                          {warning}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
