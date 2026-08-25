'use client'

import { type AnyNodeId, useScene, type ZoneNode } from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { useCallback, useEffect, useState } from 'react'
import { clientToPlan } from '../../lib/floorplan/plan-coords'
import { DropdownMenu, DropdownMenuTrigger } from '../ui/primitives/dropdown-menu'
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
 * Единый инструмент комнаты (UX-объединение): открывается левым или правым
 * кликом по любому месту помещения на 2D-плане и показывает все
 * характеристики — имя, тип по СП 54, воздухообмен, площадь/высоту, терминалы
 * с расходами и рекомендацию оборудования. Заменяет разрозненные меню
 * (контекстное «Тип помещения» + инспектор зоны) одним.
 */
export function FloorplanZoneContextMenu() {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const node = useScene((state) => (anchor ? state.nodes[anchor.nodeId] : undefined))

  const openForZone = useCallback((nodeId: AnyNodeId, clientX: number, clientY: number) => {
    setAnchor({ nodeId, x: clientX, y: clientY })
  }, [])

  useEffect(() => {
    const hitTestRoom = (event: MouseEvent): boolean => {
      // Клик должен быть по площади плана (внутри его SVG), а не по панели/меню.
      const target = event.target instanceof Element ? event.target : null
      const sceneGroup = document.querySelector<SVGGElement>('g[data-floorplan-scene]')
      if (!sceneGroup?.ownerSVGElement?.contains(target)) return false
      const planPoint = clientToPlan(event.clientX, event.clientY)
      if (!planPoint) return false
      const nodes = useScene.getState().nodes
      for (const candidate of Object.values(nodes)) {
        if (candidate?.type !== 'zone') continue
        const zone = candidate as ZoneNode
        if (zone.spaceRole !== 'room') continue
        if (!pointInPolygon(planPoint[0], planPoint[1], zone.polygon)) continue
        useViewer.getState().setSelection({ selectedIds: [zone.id] })
        openForZone(zone.id, event.clientX, event.clientY)
        return true
      }
      return false
    }

    // Правый клик по комнате — единая панель (глобальный fallback для заливки).
    const onContextMenu = (event: MouseEvent) => {
      if (!hitTestRoom(event)) return
      event.preventDefault()
      event.stopPropagation()
    }
    // Левый клик по комнате — тоже единая панель. Срабатывает только когда
    // клик не перехватил элемент поверх (стена/плита/терминал): их обработчики
    // останавливают всплытие, поэтому до document клик не доходит.
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      if (!hitTestRoom(event)) return
      event.preventDefault()
      event.stopPropagation()
    }
    document.addEventListener('contextmenu', onContextMenu)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [openForZone])

  if (!anchor || !node || node.type !== 'zone') return null

  return (
    <DropdownMenu open onOpenChange={(open) => !open && setAnchor(null)}>
      <DropdownMenuTrigger
        aria-hidden
        className="fixed h-px w-px"
        style={{ left: anchor.x, top: anchor.y }}
      />
      <RoomUnifiedPanel zone={node as ZoneNode} />
    </DropdownMenu>
  )
}
