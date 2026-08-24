import type { AnyNodeId } from '@pascal-app/core'
import mitt from 'mitt'

type FloorplanEditorEvents = {
  // Right-click over a registry entry on the 2D plan (view-space pointer
  // position included so menus can anchor at the cursor).
  'floorplan:node-context-menu': {
    nodeId: AnyNodeId
    clientX: number
    clientY: number
  }
}

export const floorplanEmitter = mitt<FloorplanEditorEvents>()
