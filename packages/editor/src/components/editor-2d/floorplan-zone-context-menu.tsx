'use client'

import {
  type AnyNodeId,
  SPACE_CATEGORIES,
  SPACE_CATEGORY_LABELS,
  SPACE_CATEGORY_RATES,
  type SpaceCategory,
  useScene,
  type ZoneNode,
} from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { useEffect, useState } from 'react'
import { clientToPlan } from '../../lib/floorplan/plan-coords'
import { floorplanEmitter } from '../../lib/floorplan-events'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/primitives/dropdown-menu'

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
 * Right-click menu for room zones on the 2D floor plan (MEP stage A3).
 * Opens at the cursor over any zone — auto-detected rooms and manual ones
 * alike — and reclassifies the room per СП 54 via the «Тип помещения»
 * submenu. Right-click works anywhere inside the room: the registry entry
 * covers the label/stroke, and a document-level fallback hit-tests the zone
 * polygon for clicks on the (non-interactive) fill so drawing walls inside
 * a room keeps working.
 */
export function FloorplanZoneContextMenu() {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const node = useScene((state) => (anchor ? state.nodes[anchor.nodeId] : undefined))

  useEffect(() => {
    const open = (event: { nodeId: AnyNodeId; clientX: number; clientY: number }) => {
      setAnchor({ nodeId: event.nodeId, x: event.clientX, y: event.clientY })
    }
    floorplanEmitter.on('floorplan:node-context-menu', open)
    return () => floorplanEmitter.off('floorplan:node-context-menu', open)
  }, [])

  // Fallback: правый клик по заливке помещения (не по подписи/контуру, которые
  // обрабатывает registry-слой) — находим зону по точке и открываем меню.
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return
      if (!event.target.closest('g[data-floorplan-scene]')) return
      const planPoint = clientToPlan(event.clientX, event.clientY)
      if (!planPoint) return
      const nodes = useScene.getState().nodes
      for (const candidate of Object.values(nodes)) {
        if (candidate?.type !== 'zone') continue
        const zone = candidate as ZoneNode
        if (!pointInPolygon(planPoint[0], planPoint[1], zone.polygon)) continue
        event.preventDefault()
        event.stopPropagation()
        useViewer.getState().setSelection({ selectedIds: [zone.id] })
        floorplanEmitter.emit('floorplan:node-context-menu', {
          nodeId: zone.id,
          clientX: event.clientX,
          clientY: event.clientY,
        })
        return
      }
    }
    document.addEventListener('contextmenu', onContextMenu)
    return () => document.removeEventListener('contextmenu', onContextMenu)
  }, [])

  if (!anchor || !node || node.type !== 'zone') return null
  const zone = node as ZoneNode

  const reclassify = (category: string) => {
    // Тип помещения становится наименованием комнаты (русское, из СП 54).
    useScene.getState().updateNode(zone.id, {
      spaceCategory: category as SpaceCategory,
      name: SPACE_CATEGORY_LABELS[category as SpaceCategory],
    })
  }

  return (
    <DropdownMenu open onOpenChange={(open) => !open && setAnchor(null)}>
      <DropdownMenuTrigger
        aria-hidden
        className="fixed h-px w-px"
        style={{ left: anchor.x, top: anchor.y }}
      />
      <DropdownMenuContent
        className="min-w-56"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuLabel>{zone.name}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Тип помещения</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={zone.spaceCategory} onValueChange={reclassify}>
              {SPACE_CATEGORIES.map((category) => (
                <DropdownMenuRadioItem key={category} value={category}>
                  {SPACE_CATEGORY_LABELS[category]}
                  <DropdownMenuShortcut>{SPACE_CATEGORY_RATES[category]}</DropdownMenuShortcut>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
