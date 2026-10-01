// A minimal PDF viewer for spike B's file cards (check B7 "double-click opens the PDF viewer"): the pages
// the worker rendered (the version's `page` derivatives), through the same-origin derivative route with
// `?board=`. Portalled outside the board wrapper. The full viewer (`file-card/PdfViewer.tsx`) is tldraw-
// bound and is ported in wave 3.
import { type AssetVersionMeta, derivativeUrl, metaUrl } from '@draftroom/dev-assets/shared'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { cardFactsOf } from '../../files/card.ts'
import type { FileFacts } from '../../files/place.ts'
import type { OverlayLayerProps } from '../../registries.ts'
import { onScreen, usePortTick, useSubscription } from './hooks.ts'

type Listener = () => void

export class ViewerStore {
  current: { facts: FileFacts; elementId: string } | null = null
  private readonly listeners = new Set<Listener>()
  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  open(facts: FileFacts, elementId: string) {
    this.current = { facts, elementId }
    for (const l of [...this.listeners]) l()
  }
  close() {
    this.current = null
    for (const l of [...this.listeners]) l()
  }
}

function Pages({ boardId, facts }: { boardId: string; facts: FileFacts }) {
  const [meta, setMeta] = useState<AssetVersionMeta | null>(null)
  useEffect(() => {
    let live = true
    void fetch(metaUrl(boardId, facts.assetId, facts.versionId), {
      cache: 'no-store',
      credentials: 'same-origin',
    })
      .then((r) => (r.ok ? (r.json() as Promise<AssetVersionMeta>) : null))
      .then((m) => {
        if (live) setMeta(m)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [boardId, facts.assetId, facts.versionId])
  if (!meta) return <p data-lobby-pdf-loading="">Loading…</p>
  const pages = (meta.derivatives ?? [])
    .filter((d) => d.role === 'page' && typeof d.page === 'number')
    .sort((a, b) => (a.page ?? 0) - (b.page ?? 0))
  if (!pages.length) return <p data-lobby-pdf-empty="">No pages yet.</p>
  return (
    <>
      {pages.map((d) => (
        <img
          key={d.id}
          data-lobby-pdf-page={d.page ?? 0}
          alt={`Page ${d.page}`}
          src={derivativeUrl(boardId, facts.assetId, facts.versionId, d.id)}
          style={{
            display: 'block',
            width: '100%',
            maxWidth: 800,
            margin: '0 auto 12px',
            background: '#fff',
          }}
        />
      ))}
    </>
  )
}

export function makeViewer(store: ViewerStore, boardId: () => string | null) {
  return function FileViewer(_: { port: unknown }) {
    useSubscription(store.subscribe)
    const cur = store.current
    const bid = boardId()
    if (!cur || !bid) return null
    return createPortal(
      <div
        data-lobby-pdf-viewer={cur.facts.versionId}
        role="dialog"
        aria-label={cur.facts.name}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 60,
          background: 'rgba(20,20,24,.85)',
          overflow: 'auto',
          padding: 16,
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') store.close()
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#fff', marginBottom: 12 }}>
          <strong style={{ font: '600 15px system-ui', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {cur.facts.name}
          </strong>
          <button type="button" data-lobby-pdf-close="" onClick={() => store.close()}>
            Close
          </button>
        </div>
        <Pages boardId={bid} facts={cur.facts} />
      </div>,
      document.body,
    )
  }
}

/**
 * File cards' chips (kind and name) and Lobby's placeholder for images the loader has not handed to the
 * engine yet, or gave up on (B7's failure injection: the placeholder shows, the loader retries, nothing is
 * pushed). Re-checked twice a second while any placeholder is on screen.
 */
export function makeCardLayer(
  isHidden: (id: string) => boolean,
  loaderState: (fileId: string) => string | undefined,
) {
  return function CardLayer({ port }: OverlayLayerProps) {
    usePortTick(port, ['changed', 'viewportChanged'])
    const [, setTick] = useState(0)
    const out = []
    let waiting = false
    for (const el of port.items()) {
      if (el.type !== 'image' || isHidden(el.id)) continue
      const b = port.bounds(el.id)
      if (!b) continue
      const tl = onScreen(port, b.x, b.y)
      const br = onScreen(port, b.x + b.width, b.y + b.height)
      if (!tl || !br) continue
      const fileId = (el as { fileId?: string | null }).fileId ?? ''
      const state = loaderState(fileId)
      const facts = cardFactsOf(el)
      if (state !== 'loaded') {
        waiting = true
        out.push(
          <div
            key={`ph:${el.id}`}
            data-lobby-image-placeholder={el.id}
            data-state={state ?? 'unknown'}
            style={{
              position: 'fixed',
              left: tl.x,
              top: tl.y,
              width: Math.max(0, br.x - tl.x),
              height: Math.max(0, br.y - tl.y),
              boxSizing: 'border-box',
              border: '1px dashed #99a',
              background: 'repeating-linear-gradient(45deg,#f3f3f6,#f3f3f6 8px,#e9e9ee 8px,#e9e9ee 16px)',
              color: '#556',
              font: '12px system-ui',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
              zIndex: 3,
            }}
          >
            {state === 'failed' ? 'Image unavailable' : 'Loading…'}
          </div>,
        )
      }
      if (facts && facts.kind !== 'image') {
        out.push(
          <div
            key={`chip:${el.id}`}
            data-lobby-card-chip={el.id}
            data-kind={facts.kind}
            style={{
              position: 'fixed',
              left: tl.x + 6,
              top: br.y - 26,
              maxWidth: Math.max(40, br.x - tl.x - 12),
              padding: '2px 6px',
              borderRadius: 6,
              background: 'rgba(20,20,24,.8)',
              color: '#fff',
              font: '600 11px/16px system-ui',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              zIndex: 4,
            }}
          >
            {facts.kind.toUpperCase()} · {facts.name}
          </div>,
        )
      }
    }
    useEffect(() => {
      if (!waiting) return
      const t = setInterval(() => setTick((n) => n + 1), 500)
      return () => clearInterval(t)
    }, [waiting])
    return <>{out}</>
  }
}
