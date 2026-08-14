'use client'

import {
  type AnyNodeId,
  type DuctSegmentNode,
  ductSectionAreaM2,
  ductSectionHydraulicDiameterM,
  ductSegmentLengthM,
  planGostSegmentation,
  planSystemMarkings,
  pressureDropPa,
  sizeDuctSection,
  useScene,
  velocityMps,
} from '@pascal-app/core'
import { ActionButton, applyGostSegmentation, PanelSection } from '@pascal-app/editor'
import { useViewer } from '@pascal-app/viewer'
import { Scissors } from 'lucide-react'
import { useMemo, useState } from 'react'

function gostSizeLabel(segment: DuctSegmentNode): string {
  if (segment.shape === 'round') return `Ø${segment.diameter} мм`
  return `${segment.width}×${segment.height} мм (${segment.shape === 'oval' ? 'ов.' : 'пр.'})`
}

function segmentProfile(segment: DuctSegmentNode) {
  return segment.shape === 'round'
    ? { shape: 'round' as const, diameterMm: segment.diameter }
    : { shape: segment.shape, widthMm: segment.width, heightMm: segment.height }
}

/**
 * MEP-инспектор участка (Этап 5): маркировка П1/В1 по ГОСТ 21.602, сечение
 * по ГОСТ Р 70349, длина и разбивка на ГОСТ-звенья, число креплений, а при
 * заданном расходе — скорость, ΔP и рекомендуемое сечение по СП 60 прил. Л.
 * Кнопка «Разбить по ГОСТ» заменяет прямой участок на стандартные звенья.
 */
export default function DuctSegmentMepPanel() {
  const selectedId = useViewer((s) => s.selection.selectedIds[0]) as AnyNodeId | undefined
  const nodes = useScene((s) => s.nodes)
  const segment = selectedId ? (nodes[selectedId] as DuctSegmentNode | undefined) : undefined
  const markings = useMemo(() => planSystemMarkings(nodes), [nodes])
  const [flowInput, setFlowInput] = useState('')
  const [splitOutcome, setSplitOutcome] = useState<string | null>(null)

  const flowM3h = flowInput === '' ? null : Number(flowInput)
  const analysis = useMemo(() => {
    if (!segment || flowM3h === null || !Number.isFinite(flowM3h) || flowM3h <= 0) return null
    const profile = segmentProfile(segment)
    const areaM2 = ductSectionAreaM2(profile)
    const dH = ductSectionHydraulicDiameterM(profile)
    const v = velocityMps(flowM3h, areaM2)
    const lengthM = ductSegmentLengthM(segment)
    const dP = pressureDropPa({ lengthM, hydraulicDiameterM: dH, velocityMps: v })
    const resize = sizeDuctSection({
      flowM3h,
      system: segment.system,
      shape: segment.shape === 'round' ? 'round' : 'rect',
    })
    return { velocityMps: v, pressureDropPa: dP, resize }
  }, [segment, flowM3h])

  if (!segment) return null

  const lengthM = ductSegmentLengthM(segment)
  const gostPieces = planGostSegmentation(lengthM)
  const marking = selectedId ? (markings[selectedId] ?? undefined) : undefined
  const flow = flowM3h === null || !Number.isFinite(flowM3h) ? null : flowM3h

  const handleSplit = () => {
    if (!selectedId) return
    const outcome = applyGostSegmentation(selectedId)
    if (outcome.kind === 'applied') setSplitOutcome(`Разбито на ${outcome.pieces} звеньев`)
    else if (outcome.kind === 'already-standard') setSplitOutcome('Уже стандартная длина')
    else if (outcome.kind === 'not-straight') setSplitOutcome('Только прямые участки')
    else if (outcome.kind === 'cannot-fit-gost') setSplitOutcome('Не делится на ГОСТ-длины')
    else setSplitOutcome('Не воздуховод')
  }

  return (
    <PanelSection title="Вентиляция · участок">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 rounded-md border border-border/50 bg-background/35 px-2.5 py-1.5 text-xs">
          <span className="text-muted-foreground">Система</span>
          <span className="ml-auto font-mono font-semibold">
            {marking ??
              (segment.system === 'supply' ? 'П' : segment.system === 'exhaust' ? 'В' : 'Р')}
          </span>
        </div>

        <div className="flex items-center gap-2 rounded-md border border-border/50 bg-background/35 px-2.5 py-1.5 text-xs">
          <span className="text-muted-foreground">Сечение ГОСТ</span>
          <span className="ml-auto font-mono font-medium">{gostSizeLabel(segment)}</span>
        </div>

        <div className="flex items-center gap-2 rounded-md border border-border/50 bg-background/35 px-2.5 py-1.5 text-xs">
          <span className="text-muted-foreground">Длина трассы</span>
          <span className="ml-auto font-mono font-medium">{lengthM.toFixed(2)} м</span>
        </div>

        <div className="flex items-center gap-2 rounded-md border border-border/50 bg-background/35 px-2.5 py-1.5 text-xs">
          <span className="text-muted-foreground">Разбивка по ГОСТ</span>
          <span className="ml-auto font-mono font-medium">
            {gostPieces
              ? gostPieces.map((piece) => `${piece.toFixed(2)} м`).join(' + ')
              : 'не делится'}
          </span>
        </div>

        <div className="flex items-center gap-2 rounded-md border border-border/50 bg-background/35 px-2.5 py-1.5 text-xs">
          <span className="text-muted-foreground">Крепления (СП 73)</span>
          <span className="ml-auto font-mono font-medium">
            {Math.floor(
              lengthM / (segment.shape === 'round' ? (segment.diameter <= 400 ? 4 : 3) : 3),
            ) + 1}{' '}
            шт
          </span>
        </div>

        <label className="flex h-9 items-center gap-2 rounded-md border border-border/50 bg-[#2C2C2E] px-2.5 text-xs">
          <span className="text-muted-foreground">Расход</span>
          <input
            className="min-w-0 flex-1 bg-transparent text-right text-foreground outline-none selection:bg-primary/30"
            inputMode="numeric"
            onChange={(event) => setFlowInput(event.target.value)}
            placeholder="м³/ч"
            type="number"
            value={flowInput}
          />
        </label>

        {flow !== null && analysis ? (
          <div className="space-y-1.5 text-xs">
            <div className="flex items-center gap-2 rounded-md border border-border/50 bg-background/35 px-2.5 py-1.5">
              <span className="text-muted-foreground">Скорость</span>
              <span className="ml-auto font-mono font-medium">
                {analysis.velocityMps.toFixed(2)} м/с
              </span>
            </div>
            <div className="flex items-center gap-2 rounded-md border border-border/50 bg-background/35 px-2.5 py-1.5">
              <span className="text-muted-foreground">ΔP участка</span>
              <span className="ml-auto font-mono font-medium">
                {analysis.pressureDropPa.toFixed(1)} Па
              </span>
            </div>
            {analysis.resize ? (
              <div className="flex items-center gap-2 rounded-md border border-border/50 bg-background/35 px-2.5 py-1.5">
                <span className="text-muted-foreground">Подбор по СП 60</span>
                <span className="ml-auto font-mono font-medium">
                  {analysis.resize.profile.shape === 'round'
                    ? `Ø${analysis.resize.profile.diameterMm} мм`
                    : `${analysis.resize.profile.widthMm}×${analysis.resize.profile.heightMm} мм`}
                  {analysis.resize.noiseCheckRequired ? ' · шум!' : ''}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        <ActionButton
          className="h-8 w-full flex-none"
          icon={<Scissors className="h-3.5 w-3.5" />}
          label="Разбить по ГОСТ"
          onClick={handleSplit}
          title="Заменить прямой участок на звенья стандартных длин ГОСТ Р 70349"
          type="button"
        />
        {splitOutcome && <div className="text-[10px] text-muted-foreground">{splitOutcome}</div>}
      </div>
    </PanelSection>
  )
}
