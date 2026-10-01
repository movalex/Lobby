// Shared pieces of the room-internal protocol tests (wave 2F): the REAL sync server process with
// DRAFTROOM_ENGINE=excalidraw (O1's element harness, test/element-room/support/stack.ts, imported as is),
// the internal routes called over HTTP with the internal secret, and plain elements.

import type { El } from '../element-room/support/elements.ts'
import { frame, label, note, rect, text, withLabel } from '../element-room/support/elements.ts'
import type { ElementStack } from '../element-room/support/stack.ts'
import { callInternal } from '../harness/tickets.ts'

export interface Answer<T = unknown> {
  status: number
  body: T
}

export async function call<T = unknown>(
  st: ElementStack,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Answer<T>> {
  const res = await callInternal(st.server.url, method, path, body === undefined ? {} : { body })
  const raw = await res.text()
  return { status: res.status, body: (raw ? JSON.parse(raw) : null) as T }
}

export const seed = (st: ElementStack, boardId: string, elements: El[], doc: Record<string, unknown> = {}) =>
  call<{ boardId: string; records: number }>(st, 'POST', `/internal/boards/${boardId}/seed`, {
    format: 'lobby-elements',
    elements,
    doc,
  })

/** A note with its label (`<id>.t`), both valid for the strict schema. */
export function noteWithText(id: string, words: string, o: El = {}): El[] {
  const n = note(id, o)
  const l = label(`${id}.t`, id, {
    text: words,
    originalText: words,
    x: (n.x ?? 0) + 20,
    y: (n.y ?? 0) + 80,
    frameId: n.frameId ?? null,
  })
  return [withLabel(n, l), l]
}

/** A small board: a frame "Ideas" holding two notes, a rectangle outside with a label, a free text. */
export function sampleBoard(): El[] {
  const f = frame('F', { x: 0, y: 0, width: 800, height: 600, name: 'Ideas' })
  const rLabel = label('R.t', 'R', { text: 'box', originalText: 'box', x: 1020, y: 30 })
  return [
    f,
    ...noteWithText('N1', 'first idea', { x: 40, y: 40, frameId: 'F' }),
    ...noteWithText('N2', 'second idea', { x: 300, y: 40, frameId: 'F' }),
    withLabel(rect('R', { x: 1000, y: 0 }), rLabel),
    rLabel,
    text('T', { x: 0, y: 800, text: 'free words', originalText: 'free words' }),
  ]
}

/** Retries `fn` while it answers 503 (a room still open until its idle eviction). */
export async function whenEvicted<T>(fn: () => Promise<Answer<T>>, ms = 15_000): Promise<Answer<T>> {
  const until = Date.now() + ms
  for (;;) {
    const a = await fn()
    if (a.status !== 503 || Date.now() > until) return a
    await new Promise((r) => setTimeout(r, 100))
  }
}
