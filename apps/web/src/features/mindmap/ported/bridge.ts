// Per-canvas state of the ported mind map, shared by its declarations (keys, commands, menus) and its
// overlay components: the runtime, the key queue and the export gate installed at mount. Reading it
// inside `useValue`/`computed` is reactive (an overlay can render before the feature mounts).

import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { atom } from '../../../lib/signals.ts'
import type { Mindmap } from './commands.ts'

const slots = new WeakMap<LobbyCanvas, Mindmap>()
const installs = atom('mindmap.installs', 0)

export function setMindmap(canvas: LobbyCanvas, m: Mindmap | null): void {
  if (m) slots.set(canvas, m)
  else slots.delete(canvas)
  installs.set(installs.get() + 1)
}

export function mindmapOf(canvas: LobbyCanvas): Mindmap | null {
  installs.get()
  return slots.get(canvas) ?? null
}
