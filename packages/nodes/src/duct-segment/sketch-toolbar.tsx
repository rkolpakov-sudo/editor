'use client'

import { type AnyNodeId, type DuctSketchRun, useScene } from '@pascal-app/core'
import { applyRoutingPlan } from '@pascal-app/editor'
import { useMemo, useState } from 'react'

/**
 * Закреплённый тулбар duct-инструмента (UX: дублирует клавиатурные
 * сокращения кнопками — PLAN-AGENT A2 + доработка UX). Позиционируется
 * поверх канваса справа снизу; события панели не всплывают в план.
 */

export type DuctToolMode = 'build' | 'sketch'
export type DuctToolSystem = 'supply' | 'exhaust' | 'return'

const SYSTEM_META: Record<DuctToolSystem, { letter: string; label: string; color: string }> = {
  supply: { letter: 'П', label: 'Приток', color: '#d4825a' },
  exhaust: { letter: 'В', label: 'Вытяжка', color: '#5ab46a' },
  return: { letter: 'Р', label: 'Рециркуляция', color: '#5a8ad4' },
}

const MODE_LABEL: Record<DuctToolMode, string> = {
  build: 'Сборка',
  sketch: 'Эскиз',
}

function formatLengthM(meters: number): string {
  return `${meters.toFixed(1).replace('.', ',')} м`
}

export type DuctSketchToolbarProps = {
  mode: DuctToolMode
  onSetMode: (mode: DuctToolMode) => void
  system: DuctToolSystem
  onSetSystem: (system: DuctToolSystem) => void
  draftPointCount: number
  draftLengthM: number
  lastPoint: [number, number, number] | null
  activeLevelId: string | null
  onFinish: () => void
  onCancelDraft: () => void
}

/** Ближайший терминал/установка к точке, м (для индикатора привязки). */
function nearestBindTarget(
  x: number,
  z: number,
  nodes: Record<string, AnyNodeId extends never ? never : any>,
): { label: string; distanceM: number } | null {
  let best: { label: string; distanceM: number } | null = null
  for (const node of Object.values(nodes)) {
    if (!node) continue
    if (node.type !== 'duct-terminal' && node.type !== 'hvac-equipment') continue
    const position = (node as { position?: [number, number, number] }).position
    if (!position) continue
    const distanceM = Math.hypot(position[0] - x, position[2] - z)
    if (best === null || distanceM < best.distanceM) {
      best = {
        label: node.type === 'duct-terminal' ? 'решётка/диффузор' : 'установка',
        distanceM,
      }
    }
  }
  return best
}

export function DuctSketchToolbar(props: DuctSketchToolbarProps) {
  const {
    mode,
    onSetMode,
    system,
    onSetSystem,
    draftPointCount,
    draftLengthM,
    lastPoint,
    activeLevelId,
    onFinish,
    onCancelDraft,
  } = props
  const nodes = useScene((state) => state.nodes)
  const [traceReport, setTraceReport] = useState<string | null>(null)
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try {
      return window.localStorage.getItem('pascal:duct-sketch-onboarded') !== '1'
    } catch {
      return true
    }
  })

  const sketchNode = useMemo(
    () => Object.values(nodes).find((node) => node?.type === 'duct-sketch'),
    [nodes],
  )
  const runs: DuctSketchRun[] = useMemo(() => {
    if (!sketchNode) return []
    return ((sketchNode as { runs?: DuctSketchRun[] }).runs ?? []) as DuctSketchRun[]
  }, [sketchNode])

  const meta = SYSTEM_META[system]
  const canFinish = draftPointCount >= 2

  const bind = lastPoint ? nearestBindTarget(lastPoint[0], lastPoint[2], nodes) : null
  const bindOk = bind !== null && bind.distanceM <= 0.5

  const deleteRun = (index: number) => {
    if (!sketchNode) return
    const nextRuns = runs.filter((_, i) => i !== index)
    useScene.getState().updateNode(sketchNode.id, { runs: nextRuns } as never)
  }

  const trace = () => {
    const report = applyRoutingPlan()
    if (report.status === 'applied') {
      setTraceReport(`Построено участков: ${report.created}`)
    } else if (report.status === 'blocked') {
      setTraceReport(`Блокер: ${report.blockers[0] ?? 'см. панель «Вентиляция»'}`)
    } else {
      setTraceReport('Нет эскиза: нарисуйте линии (K → клики → Enter)')
    }
  }

  return (
    <div
      className="pointer-events-auto absolute right-4 bottom-24 z-40 flex w-64 flex-col gap-2.5 rounded-xl border border-border/60 bg-background/95 p-3 text-xs shadow-lg backdrop-blur-xl"
      data-duct-toolbar=""
      onContextMenu={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-xs">Воздуховод</span>
        <div className="flex rounded-md border border-border/50 p-0.5">
          {(['build', 'sketch'] as const).map((value) => (
            <button
              className={
                mode === value
                  ? 'rounded bg-sky-500/25 px-2 py-0.5 font-medium text-sky-200'
                  : 'rounded px-2 py-0.5 text-muted-foreground hover:text-foreground'
              }
              key={value}
              onClick={() => onSetMode(value)}
              type="button"
            >
              {MODE_LABEL[value]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        {(['supply', 'exhaust', 'return'] as const).map((value) => {
          const chip = SYSTEM_META[value]
          const active = system === value
          return (
            <button
              className={
                active
                  ? 'flex flex-1 items-center justify-center gap-1 rounded-md border px-1.5 py-1 font-medium'
                  : 'flex flex-1 items-center justify-center gap-1 rounded-md border border-border/50 px-1.5 py-1 text-muted-foreground hover:text-foreground'
              }
              key={value}
              onClick={() => onSetSystem(value)}
              style={
                active
                  ? {
                      borderColor: `${chip.color}88`,
                      background: `${chip.color}22`,
                      color: chip.color,
                    }
                  : undefined
              }
              type="button"
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: chip.color }} />
              {chip.letter}
            </button>
          )
        })}
        <span className="text-muted-foreground text-[10px]">{meta.label}</span>
      </div>

      {showOnboarding && mode === 'sketch' && (
        <div className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-1.5 text-[10px] text-sky-100">
          Рисуйте линии от установки к решёткам. Клик — точка, Enter — закончить линию.
          <button
            className="ml-1 font-medium text-sky-300 hover:underline"
            onClick={() => {
              setShowOnboarding(false)
              try {
                window.localStorage.setItem('pascal:duct-sketch-onboarded', '1')
              } catch {}
            }}
            type="button"
          >
            Понятно
          </button>
        </div>
      )}

      {mode === 'sketch' && (
        <>
          <div className="flex items-center justify-between rounded-md border border-border/50 bg-background/40 px-2.5 py-1.5">
            <span className="text-muted-foreground">Текущая линия</span>
            <span className="font-mono text-foreground">
              {draftPointCount > 0
                ? `${draftPointCount} тчк · ${formatLengthM(draftLengthM)}`
                : '—'}
            </span>
          </div>
          {lastPoint !== null && (
            <div
              className={
                bindOk
                  ? 'flex items-center justify-between rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-emerald-200'
                  : 'flex items-center justify-between rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-amber-200'
              }
            >
              <span className="text-[10px]">
                {bindOk ? 'Конец у оборудования — привяжется' : 'Конец не у оборудования'}
              </span>
              <span className="font-mono text-[10px]">
                {bind ? `${bind.distanceM.toFixed(1).replace('.', ',')} м` : ''}
              </span>
            </div>
          )}
          <div className="flex gap-1.5">
            <button
              className="flex-1 rounded-md border border-sky-400/40 bg-sky-500/20 px-2 py-1.5 font-medium text-xs text-sky-100 transition-colors hover:bg-sky-500/30 disabled:cursor-default disabled:opacity-40"
              disabled={!canFinish}
              onClick={onFinish}
              type="button"
            >
              Завершить линию
            </button>
            <button
              className="flex-1 rounded-md border border-border/50 bg-background/60 px-2 py-1.5 font-medium text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-40"
              disabled={draftPointCount === 0}
              onClick={onCancelDraft}
              type="button"
            >
              Отменить линию
            </button>
          </div>
          {runs.length > 0 && (
            <div className="rounded-md border border-border/50 bg-background/40 px-2.5 py-1.5">
              <span className="text-muted-foreground text-[10px]">Линии эскиза</span>
              <div className="mt-1 flex flex-col gap-0.5">
                {runs.map((run, index) => {
                  const chip = SYSTEM_META[run.system]
                  return (
                    <div className="flex items-center justify-between text-[10px]" key={index}>
                      <span className="flex items-center gap-1.5">
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: chip.color }}
                        />
                        <span className="text-muted-foreground">
                          {chip.label} · {run.points.length} тчк
                        </span>
                      </span>
                      <button
                        aria-label="Удалить линию эскиза"
                        className="text-muted-foreground hover:text-red-300"
                        onClick={() => deleteRun(index)}
                        type="button"
                      >
                        ✕
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          <button
            className="rounded-md border border-violet-400/40 bg-violet-500/20 px-2.5 py-1.5 font-medium text-xs text-violet-100 transition-colors hover:bg-violet-500/30"
            onClick={trace}
            type="button"
          >
            Трассировать эскиз
          </button>
          {traceReport !== null && (
            <p className="text-[10px] text-muted-foreground">{traceReport}</p>
          )}
        </>
      )}

      <p className="text-[9px] leading-snug text-muted-foreground/70">
        K — режим · S — система · Enter — завершить · Esc — отмена
      </p>
    </div>
  )
}
