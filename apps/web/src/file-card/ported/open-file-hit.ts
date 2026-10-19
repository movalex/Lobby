// Wave W (WS3, docs/WAVE-W-CONTRACTS.md §5): a search hit inside a file opens the file at its page. Search (Ctrl+K's
// "In this workspace", the dashboard's "Inside boards") links such a hit to `/b/<id>?file=<ver>&page=<n>`
// (contracts FILE_HIT_QUERY; dashboard/search/content-search.ts fileHitHref). On the board, this resolves the version
// to an element through the scene index (`canvas.index.withLobbyKey('file')`: a file card first, else a placed page of
// that file), selects it, brings it into view and opens the page viewer (PdfViewer) at that page; then the two params
// leave the address (a reload lands on the board as usual). A version the board no longer shows says so. A tab of the
// web before wave W ignores the params and opens the board.
//
// Mounted as a screen overlay of the media feature that renders nothing (FileHitOpener): it reads the address on
// every navigation (useLocationKey), so a hit of the board already open works too, and waits for the room's first
// sync (roomReadyOf) before it decides that the file is not there.

import { FILE_HIT_QUERY } from '@draftroom/contracts'
import { useEffect } from 'react'
import {
  type CanvasElement,
  type CanvasFeatureContext,
  type LobbyCanvas,
  roomReadyOf,
} from '../../canvas/api/index.ts'
import { withoutParams } from '../../lib/deep-link.ts'
import { useLocationKey } from '../../lib/routing.ts'
import { useValue } from '../../lib/signals.ts'
import { factsOf, fileItemKind } from './model.ts'
import { openPdfViewer } from './viewer-state.ts'

const VERSION_RE = /^ver_[0-9A-Za-z]{10,40}$/
/** The highest page a link names (canvas-schema's page ids go to 9999). */
const MAX_PAGE = 9999
/** After the room is ready, how long a late catch-up may still bring the file in before "not on this board". */
export const FILE_HIT_GRACE_MS = 3_000

export interface FileHitLink {
  versionId: string
  page: number
}

/** The file hit an address names (`?file=<ver>&page=<n>`), or null; a missing or malformed page is page 1. */
export function readFileHit(href: string): FileHitLink | null {
  let url: URL
  try {
    url = new URL(href, 'http://lobby.invalid')
  } catch {
    return null
  }
  const versionId = url.searchParams.get(FILE_HIT_QUERY.file) ?? ''
  if (!VERSION_RE.test(versionId)) return null
  const raw = url.searchParams.get(FILE_HIT_QUERY.page) ?? ''
  const n = /^[1-9][0-9]{0,3}$/.test(raw) ? Number(raw) : 1
  return { versionId, page: Math.min(n, MAX_PAGE) }
}

/**
 * The element that shows `versionId` on this board: a file card (the viewer's own home), else a placed page of that
 * file (its facts name the same version), in paint order. Null when the board shows neither.
 */
export function elementForVersion(canvas: Pick<LobbyCanvas, 'index'>, versionId: string): string | null {
  let page: string | null = null
  for (const el of canvas.index.withLobbyKey('file') as readonly CanvasElement[]) {
    if (factsOf(el)?.versionId !== versionId) continue
    const kind = fileItemKind(el)
    if (kind === 'card') return el.id
    if (kind === 'page' && page === null) page = el.id
  }
  return page
}

function dropFileHitParams(): void {
  try {
    window.history.replaceState(
      window.history.state,
      '',
      withoutParams(window.location.href, [FILE_HIT_QUERY.file, FILE_HIT_QUERY.page]),
    )
  } catch {
    // a blocked history API: the link replays on reload, which opens the same file again
  }
}

/** Opens the hit on this board now; false when the board does not show its file (yet). */
export function openFileHit(ctx: CanvasFeatureContext, hit: FileHitLink): boolean {
  const id = elementForVersion(ctx.canvas, hit.versionId)
  if (!id) return false
  ctx.canvas.select([id])
  const b = ctx.canvas.boundsOf([id])
  if (b) ctx.canvas.viewport.zoomTo(b, { inset: 96, maxZoom: 1 })
  openPdfViewer(ctx.registries, id, hit.page)
  return true
}

/** The media feature's screen overlay: opens a `?file=` link once the board can answer it. Renders nothing. */
export function FileHitOpener({ ctx }: { ctx: CanvasFeatureContext }): null {
  const location = useLocationKey()
  const ready = useValue('media-file-hit-ready', () => roomReadyOf(ctx.canvas).get(), [ctx])
  useEffect(() => {
    // `location` re-runs this on every navigation (a hit of the board already open)
    if (!location || !ready) return
    const hit = readFileHit(window.location.href)
    if (!hit) return
    if (openFileHit(ctx, hit)) {
      dropFileHitParams()
      return
    }
    // a catch-up may still be on its way: look again as the scene changes, for a moment
    let done = false
    const finish = (found: boolean) => {
      if (done) return
      done = true
      off()
      clearTimeout(timer)
      dropFileHitParams()
      if (!found)
        ctx.notify({
          key: 'file-hit-missing',
          text: 'That file is not on this board any more.',
          testId: 'file-hit-missing',
        })
    }
    const off = ctx.canvas.index.onChanged(() => {
      if (openFileHit(ctx, hit)) finish(true)
    })
    const timer = setTimeout(() => finish(false), FILE_HIT_GRACE_MS)
    return () => {
      done = true
      off()
      clearTimeout(timer)
    }
  }, [ctx, location, ready])
  return null
}
