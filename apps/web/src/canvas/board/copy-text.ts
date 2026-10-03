/**
 * What a read-only role takes with Ctrl/Cmd+C (CR-3A-4): the words of the selection, as plain text.
 * Excalidraw's own copy is off for them (its `onCopy` returns on a non-interactive canvas), and Lobby does
 * not hand a viewer the engine's clipboard format (the elements themselves, ready to paste into another
 * board): the case this serves is a reviewer copying a note's text into an email.
 *
 * A note or shape gives its label, a text its words, a frame its name and, selected as a frame, the words
 * of what is inside it. A selected label counts as its container. Hidden items (a collapsed mind-map
 * branch) and deleted ones give nothing. The pieces come top to bottom, then left to right, one per line.
 *
 * Pure (Node-tested); the session passes the LobbyCanvas.
 */
import type { LobbyCanvas } from '../api/lobby-canvas.ts'
import type { CanvasElement } from '../port.ts'

/** The canvas members the copy reads. */
export type CopyCanvas = Pick<LobbyCanvas, 'selection' | 'get' | 'items' | 'isHidden'> & {
  readonly text: Pick<LobbyCanvas['text'], 'of'>
}

/** A copy never puts more than this many characters on the clipboard. */
export const MAX_COPY_CHARS = 200_000

export function selectionText(canvas: CopyCanvas): string {
  const picked = new Map<string, CanvasElement>()
  const take = (el: CanvasElement | undefined | null) => {
    if (!el || el.isDeleted || picked.has(el.id) || canvas.isHidden(el.id)) return
    picked.set(el.id, el)
  }
  let all: readonly CanvasElement[] | null = null
  for (const id of canvas.selection) {
    const el = canvas.get(id)
    if (!el || el.isDeleted) continue
    // a selected label is its container's words
    take(el.type === 'text' && el.containerId ? (canvas.get(el.containerId) ?? el) : el)
    if (el.type === 'frame') {
      all ??= canvas.items()
      for (const c of all) if (c.frameId === el.id && !(c.type === 'text' && c.containerId)) take(c)
    }
  }
  const parts: string[] = []
  const ordered = [...picked.values()].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))
  for (const el of ordered) {
    const text = canvas.text.of(el.id).trim()
    if (text) parts.push(text)
  }
  return parts.join('\n').slice(0, MAX_COPY_CHARS)
}
