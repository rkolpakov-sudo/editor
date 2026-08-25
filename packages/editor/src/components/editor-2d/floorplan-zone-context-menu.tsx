'use client'

import { type AnyNodeId, useScene, type ZoneNode } from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { useCallback, useEffect, useState } from 'react'
import { clientToPlan } from '../../lib/floorplan/plan-coords'
import { floorplanEmitter } from '../../lib/floorplan-events'
import { RoomUnifiedPanel } from './room-unified-panel'

type MenuAnchor = { nodeId: AnyNodeId; x: number; y: number }

/** Точка внутри полигона зоны (лучевой алгоритм, строго внутри). */
function pointInPolygon(
  x: number,
  z: number,
  polygon: readonly (readonly [number, number])[],
): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i]![0]
    const zi = polygon[i]![1]
    const xj = polygon[j]![0]
    const zj = polygon[j]![1]
    const intersects = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

/**
 * Единое контекстное меню комнаты (правая кнопка). Обычная панель у курсора —
 * без порталов/триггеров, поэтому открытие меню НЕ снимает выделение комнаты.
 * Левая кнопка остаётся стандартным выделением (инспектор справа с теми же
 * характеристиками).
 */
export function FloorplanZoneContextMenu() {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const node = useScene((state) => (anchor ? state.nodes[anchor.nodeId] : undefined))

  const openForZone = useCallback((nodeId: AnyNodeId, clientX: number, clientY: number) => {
    setAnchor({ nodeId, x: clientX, y: clientY })
  }, [])

  // Пока меню открыто, выделение комнаты не должно сбрасываться: если оно
  // очистилось в тот же кадр (обработчики кликов/фокуса), возвращаем
  // выделение на комнату (только при пустом выделении — выбор другого узла
  // не трогаем).
  useEffect(() => {
    if (!anchor) return
    const unsub = useViewer.subscribe(() => {
      const current = useViewer.getState().selection.selectedIds
      if (current.length === 0) {
        useViewer.getState().setSelection({ selectedIds: [anchor.nodeId] })
      }
    })
    return unsub
  }, [anchor])

  // Кликабельная заливка зоны обрабатывает правый клик в registry-слое
  // (эмитит floorplan:node-context-menu) — открываем по нему панель.
  useEffect(() => {
    const open = (event: { nodeId: AnyNodeId; clientX: number; clientY: number }) => {
      setAnchor({ nodeId: event.nodeId, x: event.clientX, y: event.clientY })
    }
    floorplanEmitter.on('floorplan:node-context-menu', open)
    return () => floorplanEmitter.off('floorplan:node-context-menu', open)
  }, [])

  // Правая кнопка по комнате — единое контекстное меню у курсора (fallback,
  // когда событие не перехватил registry-слой).
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return
      if (
        !document
          .querySelector<SVGGElement>('g[data-floorplan-scene]')
          ?.ownerSVGElement?.contains(event.target)
      ) {
        return
      }
      const planPoint = clientToPlan(event.clientX, event.clientY)
      if (!planPoint) return
      const nodes = useScene.getState().nodes
      for (const candidate of Object.values(nodes)) {
        if (candidate?.type !== 'zone') continue
        const zone = candidate as ZoneNode
        if (zone.spaceRole !== 'room') continue
        if (!pointInPolygon(planPoint[0], planPoint[1], zone.polygon)) continue
        event.preventDefault()
        event.stopPropagation()
        // Не сбрасываем выделение, установленное левым кликом: выделяем
        // только если зона ещё не выбрана.
        if (!useViewer.getState().selection.selectedIds.includes(zone.id)) {
          useViewer.getState().setSelection({ selectedIds: [zone.id] })
        }
        openForZone(zone.id, event.clientX, event.clientY)
        return
      }
    }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [openForZone])

  // Закрытие по клику вне панели или Escape.
  useEffect(() => {
    if (!anchor) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-room-panel]')) return
      setAnchor(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAnchor(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [anchor])

  if (!anchor || !node || node.type !== 'zone') return null

  return <RoomUnifiedPanel x={anchor.x} y={anchor.y} zone={node as ZoneNode} />
}
