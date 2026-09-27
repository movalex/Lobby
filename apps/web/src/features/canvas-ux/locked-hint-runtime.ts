// F8 wiring: a left pointer down (select tool, editable board) on a shape that is locked, or inside a
// locked frame or group, shows the locked hint next to it (LockedHintBar in Overlay.tsx). tldraw ignores
// such shapes for selection, so without this a click or drag on them just does nothing. The next pointer
// down anywhere else, Escape, or a few seconds, dismiss it.

import type { Editor, TLEventInfo, TLShape } from 'tldraw'
import { lockedHint } from './bridge.ts'
import { type LockChainLike, lockedHintMessage, lockSource, unlockLabel } from './locked-hint.ts'

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

let hintSeq = 0

function chainOf(editor: Editor, shape: TLShape): LockChainLike[] {
  return [shape, ...editor.getShapeAncestors(shape).reverse()].map((s) => ({
    id: s.id,
    type: s.type,
    isLocked: s.isLocked,
    name: s.type === 'frame' ? String((s.props as { name?: unknown }).name ?? '') : undefined,
  }))
}

export function registerLockedHint(editor: Editor): () => void {
  const hint = lockedHint(editor)
  const onEvent = (info: TLEventInfo) => {
    if (info.type !== 'pointer' || info.name !== 'pointer_down') return
    const clear = () => {
      if (hint.get()) hint.set(null)
    }
    if (info.button !== 0 || editor.getIsReadonly() || editor.getCurrentToolId() !== 'select') return clear()
    const point = editor.inputs.getCurrentPagePoint()
    const hit = editor.getShapeAtPoint(point, {
      hitInside: true,
      hitLabels: true,
      hitLocked: true,
      margin: editor.getHitTestMargin(),
    })
    if (!hit || !editor.isShapeOrAncestorLocked(hit)) return clear()
    const chain = chainOf(editor, hit)
    const source = lockSource(chain)
    const self = chain[0]
    if (!source || !self) return clear()
    hint.set({
      id: ++hintSeq,
      sourceId: source.id,
      message: lockedHintMessage(self, source, IS_MAC),
      unlockLabel: unlockLabel(source),
      point: { x: point.x, y: point.y },
    })
  }
  editor.on('event', onEvent)
  return () => {
    editor.off('event', onEvent)
    hint.set(null)
  }
}
