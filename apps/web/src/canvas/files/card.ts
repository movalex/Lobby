// Opening a file card (docs/EXCALIDRAW-MIGRATION.md §2.10.4; check B7 "double-click opens the PDF
// viewer"). A file card is an `image` element with `customData.lobby.file`; Excalidraw would start image
// cropping on a double-click (a local edit), so a capture-phase `dblclick` on the board wrapper takes a
// double-click on a card first, for every role (a DOM listener works under the interaction config too),
// and opens Lobby's viewer instead. Hidden (collapsed) and moving elements are skipped by the same hit
// test the guard uses.
import { viewportCoordsToSceneCoords } from '@excalidraw/common'
import type { ExcalidrawElement } from '@excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { elementAtScenePoint } from '../overrides.ts'
import type { FileFacts } from './place.ts'

/** The card facts of an element, if it is a file card (or an image) with valid facts. */
export function cardFactsOf(el: { type: string; customData?: unknown } | null | undefined): FileFacts | null {
  if (el?.type !== 'image') return null
  const f = (el.customData as { lobby?: { file?: Partial<FileFacts> } } | undefined)?.lobby?.file
  if (!f || typeof f.assetId !== 'string' || typeof f.versionId !== 'string' || typeof f.kind !== 'string')
    return null
  return f as FileFacts
}

export interface FileCardOpenOptions {
  wrapper: HTMLElement
  api: Pick<ExcalidrawImperativeAPI, 'getAppState' | 'getSceneElements'>
  /** which cards open (default: PDFs; images keep Excalidraw's own behaviour off: see the header) */
  opens?: (facts: FileFacts) => boolean
  isBlocked?: (id: string) => boolean
  open(facts: FileFacts, elementId: string): void
}

export function installFileCardOpen(opts: FileCardOpenOptions): () => void {
  const opens = opts.opens ?? ((f) => f.kind === 'pdf')
  const onDblClick = (e: MouseEvent) => {
    const t = e.target as { tagName?: string; classList?: { contains(c: string): boolean } } | null
    if (t?.tagName !== 'CANVAS' || !t.classList?.contains('interactive')) return
    const appState = opts.api.getAppState()
    const p = viewportCoordsToSceneCoords({ clientX: e.clientX, clientY: e.clientY }, appState)
    const el = elementAtScenePoint(
      opts.api.getSceneElements() as ExcalidrawElement[],
      appState,
      p.x,
      p.y,
      opts.isBlocked ? (x) => !!opts.isBlocked?.(x.id) : undefined,
    )
    const facts = cardFactsOf(el)
    if (!el || !facts || !opens(facts)) return
    e.stopPropagation()
    e.stopImmediatePropagation()
    e.preventDefault()
    opts.open(facts, el.id)
  }
  opts.wrapper.addEventListener('dblclick', onDblClick, { capture: true })
  return () => opts.wrapper.removeEventListener('dblclick', onDblClick, { capture: true })
}
