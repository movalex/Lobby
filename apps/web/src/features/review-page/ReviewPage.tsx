// OWNER: WS4 (wave S, the client review page). The page itself (docs/WAVE-S-CONTRACTS.md §6): the board's review items in
// order, one column, phone first (16 px gutters, 44 px targets, a sticky "3 of 7 approved"), each with a large picture,
// its status and buttons, and its open comments; Previous / Next move between items. It reads the review through
// ./client.ts and the comments through the board's own store; the pictures come from the board that is mounted under it
// (the same ticket, sync session, access checks and asset loader), so nothing new is exposed.
import type { CommentThread, ReviewItem, ReviewRound } from '@draftroom/contracts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { downloadsAllowed } from '../../file-card/ported/downloads.ts'
import { useUserKind } from '../../invite/guest.tsx'
import { useValue } from '../../lib/signals.ts'
import { controllerFor } from '../comments/ported/controller.ts'
import { presentationOrder } from '../present-export/ported/frames.ts'
import { elementFacts, useReviewData } from './data.ts'
import { ItemCard } from './ItemCard.tsx'
import {
  neighbours,
  type PageEntry,
  pageEntries,
  progressDetail,
  progressText,
  roundLabel,
  type ThreadScope,
  threadsFor,
} from './model.ts'
import { FramePictures } from './picture.ts'
import type { SummaryProgress } from './summary.ts'

/** How far below the scroll region's top an item counts as "the one you are on". */
const ACTIVE_BAND_PX = 96

const reducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function SummaryButton({
  ctx,
  entries,
  round,
  threads,
  scopeOf,
  announce,
}: {
  ctx: CanvasFeatureContext
  entries: readonly PageEntry[]
  round: ReviewRound | null
  threads: readonly CommentThread[]
  scopeOf(entry: PageEntry): ThreadScope
  announce(text: string): void
}) {
  const [state, setState] = useState<{ busy: boolean; text: string }>({ busy: false, text: '' })
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])
  const run = async () => {
    if (state.busy) return
    const controller = new AbortController()
    abort.current = controller
    setState({ busy: true, text: 'Preparing the summary…' })
    try {
      const { downloadReviewSummary } = await import('./summary.ts')
      const out = await downloadReviewSummary({
        ctx,
        entries,
        round,
        threads,
        scopeOf,
        signal: controller.signal,
        onProgress: (p: SummaryProgress) =>
          setState({
            busy: true,
            text:
              p.phase === 'pictures'
                ? `Drawing item ${Math.min(p.done + 1, p.total)} of ${p.total}…`
                : p.phase === 'pages'
                  ? 'Making the PDF…'
                  : 'Collecting the history…',
          }),
      })
      const note =
        out.notShown > 0
          ? ` ${out.notShown} item${out.notShown === 1 ? ' was' : 's were'} left out: a summary holds at most 60 pages.`
          : ''
      setState({ busy: false, text: `Saved “${out.filename}” (${out.pageCount} pages).${note}` })
      announce(`Summary saved: ${out.filename}`)
    } catch (e) {
      if (controller.signal.aborted) return
      console.error('review summary failed', e)
      setState({ busy: false, text: 'The summary could not be made. Try again.' })
    }
  }
  return (
    <div className="dr-rp__summary">
      <button
        type="button"
        className="dr-rp__btn"
        data-testid="review-summary-pdf"
        aria-disabled={state.busy || undefined}
        onClick={() => void run()}
      >
        {state.busy ? 'Preparing…' : 'Summary (PDF)'}
      </button>
      <p className="dr-rp__summary-note" role="status" data-testid="review-summary-status">
        {state.text}
      </p>
    </div>
  )
}

export function ReviewPage({ ctx, close }: { ctx: CanvasFeatureContext; close(): void }) {
  const { review, loaded, apply } = useReviewData(ctx)
  const controller = controllerFor(ctx)
  const store = controller.store
  const threads = store.signals.useValue(store.threads)
  const canComment = store.signals.useValue(store.canComment)
  const kind = useUserKind()
  const guest = kind === null ? null : kind === 'guest'
  const canDownload = useValue('review-page-downloads', () => downloadsAllowed(ctx, guest), [ctx, guest])
  const pictures = useMemo(() => new FramePictures(ctx.canvas), [ctx.canvas])
  useEffect(() => () => pictures.dispose(), [pictures])
  // the comments feature loads the store on mount; a page opened first loads it itself
  useEffect(() => {
    if (store.status.get() === 'loading') void store.load()
  }, [store])

  const entries = useValue('review-page-entries', () => {
    const rank = new Map(presentationOrder(ctx.canvas).map((f, i) => [f.id, i]))
    return pageEntries(
      review,
      (id) => elementFacts(ctx.canvas, id),
      (id) => rank.get(id) ?? null,
    )
  }, [ctx, review])
  const allThreads = useMemo(() => Object.values(threads), [threads])
  const scopeOf = useCallback(
    (entry: PageEntry): ThreadScope => ({
      members:
        entry.kind === 'frame'
          ? new Set(ctx.canvas.index.byFrame(entry.item.elementId).map((e) => e.id))
          : new Set<string>(),
      bounds: ctx.canvas.bounds(entry.item.elementId),
    }),
    [ctx.canvas],
  )
  const threadsOfItem = useValue('review-page-threads', () => {
    const out = new Map<string, CommentThread[]>()
    for (const e of entries) {
      out.set(e.item.id, threadsFor(allThreads, e, scopeOf(e)))
    }
    return out
  }, [entries, allThreads, scopeOf])

  const [active, setActive] = useState(0)
  const [said, setSaid] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const cards = useRef(new Map<string, HTMLElement>())
  const frame = useRef(0)
  const activeIndex = Math.min(active, Math.max(0, entries.length - 1))

  const updateActive = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const box = scroller.current
      if (!box) return
      const top = box.getBoundingClientRect().top + ACTIVE_BAND_PX
      let at = 0
      entries.forEach((e, i) => {
        const el = cards.current.get(e.item.id)
        if (el && el.getBoundingClientRect().top <= top) at = i
      })
      // scrolled to the very end: the last item is the one on screen
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) at = Math.max(at, entries.length - 1)
      setActive(at)
    })
  }, [entries])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const goTo = (i: number | null) => {
    if (i === null) return
    const e = entries[i]
    const el = e ? cards.current.get(e.item.id) : null
    if (!el) return
    setActive(i)
    el.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' })
  }

  const onApplied = useCallback(
    (item: ReviewItem, thread?: CommentThread) => {
      apply(item)
      if (thread) store.applyThread(thread)
    },
    [apply, store],
  )

  const nav = neighbours(activeIndex, entries.length)
  const archived = ctx.board.status === 'archived'
  const round = roundLabel(review)
  const openRound = review.rounds.find((r) => r.id === review.openRoundId && r.closedAt === null) ?? null
  const counts = entries.length
  const approvedShare = counts === 0 ? 0 : entries.filter((e) => e.item.status === 'approved').length / counts

  return (
    <div className="dr-rp__panel">
      <header className="dr-rp__head">
        <div className="dr-rp__titles">
          <p className="dr-rp__kicker">Review{round ? ` · ${round}` : ''}</p>
          <h1 className="dr-rp__title" id="dr-rp-title" data-testid="review-title">
            {ctx.board.title}
          </h1>
        </div>
        <button
          type="button"
          className="dr-rp__btn dr-rp__btn--quiet"
          data-testid="review-close"
          onClick={close}
        >
          Open the board
        </button>
      </header>
      {counts > 0 && (
        <div className="dr-rp__progress" data-testid="review-progress-bar">
          <p className="dr-rp__progress-text" role="status" data-testid="review-progress">
            <strong>{progressText(entries)}</strong>
            {progressDetail(entries) ? <span> · {progressDetail(entries)}</span> : null}
          </p>
          <div className="dr-rp__meter" aria-hidden="true">
            <span style={{ width: `${Math.round(approvedShare * 100)}%` }} />
          </div>
          {canDownload && (
            <SummaryButton
              ctx={ctx}
              entries={entries}
              round={openRound}
              threads={allThreads}
              scopeOf={scopeOf}
              announce={setSaid}
            />
          )}
        </div>
      )}
      <div className="dr-rp__scroll" ref={scroller} onScroll={updateActive} data-testid="review-scroll">
        {archived && (
          <p className="dr-rp__banner" data-testid="review-closed">
            This review is closed. You can still read it.
          </p>
        )}
        {!archived && loaded && counts > 0 && !review.can.setStatus && (
          <p className="dr-rp__banner" data-testid="review-readonly">
            You can follow this review but not answer it.
          </p>
        )}
        {!loaded && <p className="dr-rp__empty">Loading the review…</p>}
        {loaded && counts === 0 && (
          <p className="dr-rp__empty" data-testid="review-empty">
            Nothing is waiting for review on this board yet.
          </p>
        )}
        {entries.map((e) => (
          <ItemCard
            key={e.item.id}
            ctx={ctx}
            entry={e}
            total={counts}
            active={e.index === activeIndex}
            pictures={pictures}
            can={review.can}
            threads={threadsOfItem.get(e.item.id) ?? []}
            store={store}
            canComment={canComment}
            playable
            onApplied={onApplied}
            announce={setSaid}
            cardRef={(el) => {
              if (el) cards.current.set(e.item.id, el)
              else cards.current.delete(e.item.id)
            }}
          />
        ))}
      </div>
      {counts > 1 && (
        <nav className="dr-rp__nav" aria-label="Move between items">
          <button
            type="button"
            className="dr-rp__btn"
            data-testid="review-prev"
            disabled={nav.prev === null}
            onClick={() => goTo(nav.prev)}
          >
            Previous
          </button>
          <p className="dr-rp__nav-pos" data-testid="review-position">
            {activeIndex + 1} of {counts}
          </p>
          <button
            type="button"
            className="dr-rp__btn dr-rp__btn--primary"
            data-testid="review-next"
            disabled={nav.next === null}
            onClick={() => goTo(nav.next)}
          >
            Next
          </button>
        </nav>
      )}
      <p className="dr-sr-only" role="status" aria-live="polite" data-testid="review-live">
        {said}
      </p>
    </div>
  )
}
