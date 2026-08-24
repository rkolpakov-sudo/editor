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
import { useEffect, useState } from 'react'
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

/**
 * Right-click menu for room zones on the 2D floor plan (MEP stage A3).
 * Opens at the cursor over any zone — auto-detected rooms and manual ones
 * alike — and reclassifies the room per СП 54 via the «Тип помещения»
 * submenu.
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

  if (!anchor || !node || node.type !== 'zone') return null
  const zone = node as ZoneNode

  const reclassify = (category: string) => {
    useScene.getState().updateNode(zone.id, { spaceCategory: category as SpaceCategory })
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
