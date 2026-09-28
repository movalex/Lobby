// Per-editor state shared by this feature's module-level pieces (overrides, context menu, overlay):
// the runtime installed at mount, the keyboard listener that queues keys for new topics, and the latest
// feature context. Reading the runtime inside a tldraw computed/useValue is reactive (the overlay can
// render before the feature mounts).

import { atom, type Editor } from 'tldraw'
import type { FeatureContext } from '../types.ts'
import type { MindmapKeyboard } from './keyboard.ts'
import type { MindmapRuntime } from './runtime.ts'

interface Slot {
  rt: MindmapRuntime
  keys: MindmapKeyboard | null
}

const slots = new WeakMap<Editor, Slot>()
const contexts = new WeakMap<Editor, FeatureContext>()
const installs = atom('dr-mindmap-installs', 0)

export function setRuntime(editor: Editor, rt: MindmapRuntime | null, keys: MindmapKeyboard | null = null) {
  if (rt) slots.set(editor, { rt, keys })
  else slots.delete(editor)
  installs.set(installs.get() + 1)
}

export function getRuntime(editor: Editor): MindmapRuntime | null {
  installs.get()
  return slots.get(editor)?.rt ?? null
}

export function getKeyboard(editor: Editor): MindmapKeyboard | null {
  return slots.get(editor)?.keys ?? null
}

export function setMindmapCtx(editor: Editor, ctx: FeatureContext) {
  contexts.set(editor, ctx)
}

export function getMindmapCtx(editor: Editor): FeatureContext | null {
  return contexts.get(editor) ?? null
}
