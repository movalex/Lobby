// OWNER: WS3 (wave S, media comments). The review viewer's `body` for a PDF or an Office document (kind pdf: shown
// through its conversion, the "flattened preview" wording stays the PDF viewer's) (docs/WAVE-S-CONTRACTS.md §4):
// the worker's page previews, a page strip whose pages carry a marker with their open threads on this version,
// "Comment on page 3", and the page's spot pins. A click on the page opens the composer there, with that spot.
//
// Keys inside the viewer: ← → (and PageUp/PageDown) turn pages, C comments on the page shown.
import { type KeyboardEvent, useEffect, useMemo, useRef } from 'react'
import { derivativeUrl } from '../../../assets/contract.ts'
import {
  documentPageCount,
  previewPages,
  stepPage,
  validPage,
  viewerPageSize,
} from '../../../file-card/pdf-pages.ts'
import type { ViewerSlotProps } from '../slots.ts'
import { spotAt, spotsShown, threadsPerPage } from '../threads/model.ts'
import { patchSession } from '../threads/session.ts'
import {
  DraftPin,
  mediaCommentsOn,
  SpotPin,
  STAGE_PAD,
  startComment,
  useBoxSize,
  useMedia,
} from '../threads/shared.tsx'

export function PdfBody(props: ViewerSlotProps) {
  if (!mediaCommentsOn()) return null
  return <Pages {...props} />
}

function Pages(props: ViewerSlotProps) {
  const { ctx, request, file } = props
  const { session, state, threads, canComment, meta } = useMedia(props)
  const stage = useRef<HTMLElement>(null)
  const rail = useRef<HTMLElement>(null)
  const pages = useMemo(() => previewPages(meta.meta), [meta.meta])
  const available = useMemo(() => pages.map((p) => p.page), [pages])
  const total = documentPageCount(meta.meta, { pageCount: null }, pages.length)
  const current = validPage(available, state.page)
  const page = pages.find((p) => p.page === current) ?? null
  const counts = threadsPerPage(threads)
  const box = useBoxSize(stage)
  const size = page
    ? viewerPageSize(
        { w: page.full.width, h: page.full.height },
        { w: Math.max(0, box.w - 2 * STAGE_PAD), h: Math.max(0, box.h - 2 * STAGE_PAD) },
        1,
      )
    : { w: 0, h: 0 }

  useEffect(() => {
    stage.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    rail.current?.querySelector(`[data-page="${current}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const go = (p: number) => patchSession(session, { page: validPage(available, p) })
  const step = (d: number) => go(stepPage(available, current, d))
  const commentOnPage = (spot?: { u: number; v: number }) => {
    if (!canComment || !page) return
    startComment(session, { page: current, ...(spot ? { spot } : {}) })
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLTextAreaElement || e.altKey || e.metaKey || e.ctrlKey) return
    let handled = true
    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
        step(1)
        break
      case 'ArrowLeft':
      case 'PageUp':
        step(-1)
        break
      case 'c':
      case 'C':
        commentOnPage()
        break
      default:
        handled = false
    }
    if (handled) e.preventDefault()
  }

  const shown = spotsShown(threads, { page: current })
  return (
    <div className="dr-rvm-pdf" data-testid="rv-pdf">
      <nav ref={rail} className="dr-rvm-rail" aria-label="Pages">
        <ol>
          {pages.map((p) => {
            const n = counts.get(p.page) ?? 0
            return (
              <li key={p.page}>
                <button
                  type="button"
                  className="dr-rvm-rail__page"
                  data-testid="rv-page-thumb"
                  data-page={p.page}
                  aria-current={p.page === current ? 'page' : undefined}
                  aria-label={`Page ${p.page}${n ? `, ${n} comment${n === 1 ? '' : 's'}` : ''}`}
                  onClick={() => go(p.page)}
                >
                  <img
                    src={derivativeUrl(ctx.board.id, request.assetId, request.versionId, p.thumb.id)}
                    alt=""
                    loading="lazy"
                    draggable={false}
                  />
                  <span className="dr-rvm-rail__num">{p.page}</span>
                  {n > 0 && (
                    <span className="dr-rvm-rail__marker" data-testid="rv-page-marker" data-page={p.page}>
                      {n}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ol>
      </nav>
      <div className="dr-rvm-pdf__main">
        <div className="dr-rvm-bar">
          <button
            type="button"
            className="dr-btn dr-btn--sm dr-btn--ghost"
            data-testid="rv-page-prev"
            aria-label="Previous page"
            onClick={() => step(-1)}
          >
            ‹
          </button>
          <output className="dr-rvm-zoom" data-testid="rv-page-counter" aria-live="polite">
            Page {current} of {total || '…'}
          </output>
          <button
            type="button"
            className="dr-btn dr-btn--sm dr-btn--ghost"
            data-testid="rv-page-next"
            aria-label="Next page"
            onClick={() => step(1)}
          >
            ›
          </button>
          <span className="dr-rvm-spacer" />
          {canComment && page && (
            <button
              type="button"
              className="dr-btn dr-btn--sm dr-btn--primary"
              data-testid="rv-comment-here"
              onClick={() => commentOnPage()}
            >
              Comment on page {current}
            </button>
          )}
        </div>
        <section
          ref={stage}
          className="dr-rvm-stage"
          data-testid="rv-pdf-stage"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the page takes the page keys
          tabIndex={0}
          aria-label={`Page ${current} of ${file.name || 'the document'}: click to comment on a spot`}
          onKeyDown={onKeyDown}
        >
          {page ? (
            // biome-ignore lint/a11y/useKeyWithClickEvents: C (on the stage) comments on the page by keyboard
            // biome-ignore lint/a11y/noStaticElementInteractions: a click on the page is a comment on that spot
            <div
              className="dr-rvm-picture"
              data-testid="rv-page"
              data-page={current}
              style={size.w ? { width: size.w, height: size.h } : undefined}
              onClick={(e) => {
                const spot = spotAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY)
                if (spot) commentOnPage(spot)
              }}
            >
              <img
                key={page.full.id}
                src={derivativeUrl(ctx.board.id, request.assetId, request.versionId, page.full.id)}
                alt={`Page ${current}`}
                draggable={false}
              />
              {shown.map((t) => (
                <SpotPin
                  key={t.id}
                  thread={t}
                  selected={state.selected === t.id}
                  onPick={() => patchSession(session, { selected: t.id, draft: null })}
                />
              ))}
              {state.draft?.spot && state.draft.page === current && <DraftPin spot={state.draft.spot} />}
            </div>
          ) : (
            <p className="dr-rvm-note">
              {meta.missing
                ? 'This file is not available on this board.'
                : meta.meta?.status === 'ready'
                  ? 'This document has no page previews.'
                  : 'Loading page previews…'}
            </p>
          )}
        </section>
      </div>
    </div>
  )
}
