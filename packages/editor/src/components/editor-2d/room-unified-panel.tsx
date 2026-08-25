'use client'

import {
  assignZoneAirflowsToTerminals,
  recommendEquipment,
  resolveRequiredAirflowM3h,
  SPACE_CATEGORIES,
  SPACE_CATEGORY_LABELS,
  SPACE_CATEGORY_RATES,
  type SpaceCategory,
  terminalDirection,
  useScene,
  type ZoneNode,
} from '@pascal-app/core'
import { useEffect, useMemo, useState } from 'react'
import { DropdownMenuContent, DropdownMenuLabel } from '../ui/primitives/dropdown-menu'

const EXHAUST_CATEGORIES = new Set<SpaceCategory>([
  'kitchen_gas',
  'kitchen_electric',
  'bath',
  'toilet',
  'combined_wc',
])

function polygonAreaM2(polygon: ZoneNode['polygon']): number {
  let twiceSignedArea = 0
  for (let i = 0; i < polygon.length; i++) {
    const [x0, y0] = polygon[i]!
    const [x1, y1] = polygon[(i + 1) % polygon.length]!
    twiceSignedArea += x0 * y1 - x1 * y0
  }
  return Math.abs(twiceSignedArea) / 2
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border/50 bg-background/40 px-2.5 py-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium text-foreground">{value}</span>
    </div>
  )
}

/**
 * Единый инструмент комнаты (PLAN-AGENT A3 + UX-объединение): все
 * характеристики помещения в одном месте — имя, тип по СП 54, воздухообмен,
 * площадь и высота потолка, терминалы с расходами и итог расчёта с
 * рекомендацией оборудования. Открывается левым или правым кликом по комнате
 * и используется инспектором зоны (Scene) — без второго отдельного меню.
 */
export function RoomUnifiedPanel({ zone }: { zone: ZoneNode }) {
  const updateNode = useScene((state) => state.updateNode)
  const nodes = useScene((state) => state.nodes)
  const [nameDraft, setNameDraft] = useState(zone.name)

  useEffect(() => setNameDraft(zone.name), [zone.name])

  const areaM2 = useMemo(() => polygonAreaM2(zone.polygon), [zone.polygon])
  const airflow = resolveRequiredAirflowM3h(zone.spaceCategory, { areaM2 })
  const isExhaust = EXHAUST_CATEGORIES.has(zone.spaceCategory)

  const terminals = useMemo(() => {
    const assignments = assignZoneAirflowsToTerminals(nodes, [zone])
    return assignments
      .filter((assignment) => assignment.zoneId === zone.id)
      .map((assignment) => {
        const terminal = Object.values(nodes).find(
          (node) => node?.type === 'duct-terminal' && node.id === assignment.terminalId,
        )
        return {
          terminalId: assignment.terminalId,
          name: terminal?.name ?? assignment.terminalId,
          flowM3h: assignment.flowM3h,
          direction: terminalDirection(terminal as never),
        }
      })
  }, [nodes, zone])

  const recommendation = useMemo(() => {
    const supply = terminals
      .filter((terminal) => terminal.direction === 'supply')
      .reduce((sum, terminal) => sum + terminal.flowM3h, 0)
    const exhaust = terminals
      .filter((terminal) => terminal.direction === 'return')
      .reduce((sum, terminal) => sum + terminal.flowM3h, 0)
    return recommendEquipment(supply, exhaust)
  }, [terminals])

  const commitName = () => {
    const next = nameDraft.trim()
    if (next && next !== zone.name) updateNode(zone.id, { name: next })
    else setNameDraft(zone.name)
  }

  return (
    <DropdownMenuContent
      align="start"
      className="min-w-72"
      onCloseAutoFocus={(event) => event.preventDefault()}
      side="right"
    >
      <div className="px-3 py-2">
        <DropdownMenuLabel className="px-0 text-sm">Помещение</DropdownMenuLabel>
        <input
          className="mt-1 w-full rounded-md border border-border/50 bg-[#2C2C2E] px-2 py-1.5 text-foreground text-sm outline-none focus:border-sky-500/50"
          onChange={(event) => setNameDraft(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
          type="text"
          value={nameDraft}
        />

        <div className="mt-3 flex flex-col gap-1">
          <span className="text-muted-foreground text-[10px]">Тип помещения (СП 54)</span>
          <select
            className="rounded-md border border-border/50 bg-[#2C2C2E] px-2 py-1.5 text-foreground text-xs outline-none"
            onChange={(event) =>
              updateNode(zone.id, {
                spaceCategory: event.target.value as SpaceCategory,
                name: SPACE_CATEGORY_LABELS[event.target.value as SpaceCategory],
              })
            }
            value={zone.spaceCategory}
          >
            {SPACE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {SPACE_CATEGORY_LABELS[category]} — {SPACE_CATEGORY_RATES[category]}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-3 flex flex-col gap-1.5">
          <InfoRow label="Норма воздухообмена" value={SPACE_CATEGORY_RATES[zone.spaceCategory]} />
          <InfoRow
            label="Требуемый расход"
            value={airflow !== null ? `${Math.round(airflow)} м³/ч` : 'по заданию'}
          />
          <InfoRow label="Система" value={isExhaust ? 'В — вытяжка' : 'П — приток'} />
          <InfoRow label="Площадь" value={`${areaM2.toFixed(1).replace('.', ',')} м²`} />
          <InfoRow
            label="Высота потолка"
            value={`${Number(zone.ceilingHeight.toFixed(2)).toString().replace('.', ',')} м`}
          />
        </div>

        <div className="mt-3">
          <span className="text-muted-foreground text-[10px]">Терминалы</span>
          {terminals.length === 0 ? (
            <p className="mt-1 text-muted-foreground text-[10px]">
              Решёток/диффузоров в комнате нет — добавьте терминалы через каталог MEP.
            </p>
          ) : (
            <div className="mt-1 flex flex-col gap-1">
              {terminals.map((terminal) => (
                <InfoRow
                  key={terminal.terminalId}
                  label={`${terminal.direction === 'return' ? 'Вытяжка' : 'Приток'} · ${terminal.name}`}
                  value={`${terminal.flowM3h.toFixed(0)} м³/ч`}
                />
              ))}
            </div>
          )}
        </div>

        {recommendation.length > 0 && (
          <div className="mt-3">
            <span className="text-muted-foreground text-[10px]">Рекомендация оборудования</span>
            <div className="mt-1 flex flex-col gap-1">
              {recommendation.map((entry) => (
                <div
                  className="rounded-md border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-1.5 text-[10px]"
                  key={entry.category}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground">{entry.label}</span>
                    <span className="font-mono text-emerald-300">
                      {entry.flowM3h.toFixed(0)} м³/ч → {entry.nominalM3h}
                    </span>
                  </div>
                  <p className="mt-0.5 text-muted-foreground">{entry.reason}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </DropdownMenuContent>
  )
}
