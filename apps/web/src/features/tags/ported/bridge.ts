// Per-canvas state of the ported tags feature, shared by its declarations (menus, the selection bar) and
// its overlay components: the runtime installed at mount and the feature context (notices, the dock).
// Reading it inside `useValue`/`computed` is reactive (an overlay can render before the feature mounts).

import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { atom } from '../../../lib/signals.ts'
import type { TagsRuntime } from './runtime.ts'

export interface Tags {
  readonly rt: TagsRuntime
  readonly ctx: CanvasFeatureContext
}

const slots = new WeakMap<LobbyCanvas, Tags>()
const installs = atom('tags.installs', 0)

export function setTags(canvas: LobbyCanvas, t: Tags | null): void {
  if (t) slots.set(canvas, t)
  else slots.delete(canvas)
  installs.set(installs.get() + 1)
}

export function tagsOf(canvas: LobbyCanvas): Tags | null {
  installs.get()
  return slots.get(canvas) ?? null
}
