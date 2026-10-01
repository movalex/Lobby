// Pointer handling for Lobby's custom tools (docs/EXCALIDRAW-MIGRATION.md §2.3.4). With a custom tool
// active Excalidraw creates nothing; it keeps dispatching onPointerDown / onPointerUp (also for read-only
// roles when `interaction.enabled.tools.custom` is on, types.d.ts:612-622). Lobby acts on pointer-up:
// a click, not a drag (a drag with a custom tool pans nothing and creates nothing).

import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { CUSTOM_TOOLS, type CustomTool } from './tools.ts'

export interface CustomToolClick {
  tool: CustomTool
  /** Scene coordinates of the pointer-down. */
  x: number
  y: number
  /** Screen distance between down and up, px. */
  moved: number
}

export interface CustomToolsOptions {
  onClick: (click: CustomToolClick) => void
  /** A click that moved more than this (screen px) is a drag and ignored. Default 6. */
  clickSlop?: number
}

const BY_TYPE = new Map(Object.entries(CUSTOM_TOOLS).map(([k, v]) => [v as string, k as CustomTool]))

export function attachCustomTools(api: ExcalidrawImperativeAPI, opts: CustomToolsOptions): () => void {
  const slop = opts.clickSlop ?? 6
  let down: { x: number; y: number; clientX: number; clientY: number } | null = null
  const offDown = api.onPointerDown((tool, state, event) => {
    if (tool.type !== 'custom' || !BY_TYPE.has(tool.customType)) return
    down = { x: state.origin.x, y: state.origin.y, clientX: event.clientX, clientY: event.clientY }
  })
  const offUp = api.onPointerUp((tool, _state, event) => {
    const d = down
    down = null
    if (!d || tool.type !== 'custom') return
    const name = BY_TYPE.get(tool.customType)
    if (!name) return
    const moved = Math.hypot(event.clientX - d.clientX, event.clientY - d.clientY)
    if (moved > slop) return
    opts.onClick({ tool: name, x: d.x, y: d.y, moved })
  })
  return () => {
    offDown()
    offUp()
  }
}
