// OWNER: WS3 (wave S, media comments). The review viewer's `threads` slot (docs/WAVE-S-CONTRACTS.md §4): the threads
// of the version shown, in the file's order (by time, by page), each with its timecode or page; a row picks its
// thread (the video seeks there and pauses, the PDF turns to its page) and opens it with its replies; the composer
// of a new comment at the place the body chose ("Comment at 00:12.4", "Comment on page 3", a spot); and "Export
// comments" (CSV, and for a video a marker list and an EDL) for whoever may download from this board.
import type { CommentThread } from '@draftroom/contracts'
import { useEffect, useRef, useState } from 'react'
import { downloadsAllowed, notifyDownloadsOff } from '../../../file-card/ported/downloads.ts'
import { useUserKind } from '../../../invite/guest.tsx'
import { useValue } from '../../../lib/signals.ts'
import { Composer } from '../../comments/Composer.tsx'
import { snippet } from '../../comments/model.ts'
import { controllerFor } from '../../comments/ported/controller.ts'
import { ThreadView } from '../../comments/ThreadView.tsx'
import { downloadBlob } from '../../present-export/download.ts'
import {
  commentsCsv,
  commentsEdl,
  type ExportKind,
  type ExportThread,
  exportFile,
  markersCsv,
} from '../export/exports.ts'
import type { ViewerSlotProps } from '../slots.ts'
import { formatClock, frameRateOrNull } from '../video/timecode.ts'
import { type MediaPlace, type MediaThread, mediaAnchor, threadsOfAsset } from './model.ts'
import { patchSession, requestSeek } from './session.ts'
import { mediaCommentsOn, ReactKeys, useMedia } from './shared.tsx'
import { useVersionNumbers } from './versions.ts'

/** Where a thread is in its file, as the list and the composer say it. */
export function placeLabel(place: MediaPlace): string {
  const parts: string[] = []
  if (place.timeMs !== undefined) parts.push(`at ${formatClock(place.timeMs)}`)
  if (place.page !== undefined) parts.push(`on page ${place.page}`)
  if (place.spot) parts.push(parts.length ? 'with a spot' : 'on a spot')
  return parts.join(', ') || 'on the file'
}

export function ThreadsSlot(props: ViewerSlotProps) {
  if (!mediaCommentsOn()) return null
  return (
    <ReactKeys>
      <Threads {...props} />
    </ReactKeys>
  )
}

function Threads(props: ViewerSlotProps) {
  const { ctx, request, file } = props
  const [showResolved, setShowResolved] = useState(false)
  const { store, session, state, threads, canComment, meta } = useMedia(props, { resolved: showResolved })
  const draftKey = `media:${request.versionId}`
  const list = useRef<HTMLOListElement>(null)

  // The thread asked for (a marker, "Jump to 00:12.4") scrolls into view.
  useEffect(() => {
    if (!state.selected) return
    list.current
      ?.querySelector(`[data-thread-id="${CSS.escape(state.selected)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [state.selected])
  // A request that names a thread on a page: that page.
  useEffect(() => {
    const t = request.threadId ? store.thread(request.threadId) : undefined
    if (t?.anchor.kind === 'asset' && t.anchor.page !== undefined)
      patchSession(session, { page: t.anchor.page })
  }, [request.threadId, store, session])

  const pick = (t: MediaThread) => {
    if (t.anchor.timeMs !== undefined) requestSeek(session, t.anchor.timeMs)
    if (t.anchor.page !== undefined) patchSession(session, { page: t.anchor.page })
    patchSession(session, { selected: state.selected === t.id ? null : t.id, draft: null })
    void store.markRead(t.id)
  }
  const post = async (draft: Parameters<typeof store.createThread>[1]) => {
    const place = state.draft
    if (!place) return false
    const anchor = mediaAnchor(request, place)
    const thread = await store.createThread(anchor, draft, {
      ...(place.spot ? { spot: place.spot } : {}),
      draftKey,
      open: false,
    })
    if (!thread) return false
    patchSession(session, { draft: null, selected: thread.id })
    return true
  }

  return (
    <div className="dr-rvm-threads" data-testid="rv-threads">
      <header className="dr-rvm-threads__head">
        <h3>
          Comments{' '}
          <span className="dr-rvm-count" data-testid="rv-thread-count">
            {threads.length}
          </span>
        </h3>
        <label className="dr-rvm-toggle">
          <input
            type="checkbox"
            data-testid="rv-show-resolved"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          Resolved
        </label>
        <ExportMenu {...props} fps={frameRateOrNull(meta.meta?.probe?.frameRate)} />
      </header>
      {state.draft && (
        <section className="dr-rvm-compose" data-testid="rv-composer" aria-label="New comment">
          <p className="dr-rvm-compose__where" data-testid="rv-composer-where">
            New comment {placeLabel(state.draft)}
          </p>
          <Composer
            key={`${state.draft.timeMs ?? ''}:${state.draft.page ?? ''}:${state.draft.spot?.u ?? ''}:${state.draft.spot?.v ?? ''}`}
            store={store}
            draftKey={draftKey}
            label="New comment"
            placeholder="Add a comment… (@ to mention)"
            submitLabel="Post"
            autoFocus
            onSubmit={post}
            onCancel={() => patchSession(session, { draft: null })}
          />
        </section>
      )}
      {threads.length === 0 && !state.draft && (
        <p className="dr-rvm-empty" data-testid="rv-threads-empty">
          {canComment
            ? file.kind === 'video'
              ? 'No comments on this version yet. Pause where you want to comment, or press C.'
              : 'No comments on this version yet. Click the picture to comment on a spot.'
            : 'No comments on this version yet.'}
        </p>
      )}
      <ol ref={list} className="dr-rvm-list">
        {threads.map((t) => {
          const open = state.selected === t.id
          const first = t.comments[0]
          return (
            <li key={t.id} className="dr-rvm-row" data-thread-id={t.id} data-open={open || undefined}>
              <button
                type="button"
                className="dr-rvm-row__pick"
                data-testid="rv-thread-row"
                data-thread-id={t.id}
                data-time-ms={t.anchor.timeMs}
                data-page={t.anchor.page}
                aria-expanded={open}
                onClick={() => pick(t)}
              >
                <span className="dr-rvm-chip" data-testid="rv-thread-at">
                  {t.anchor.timeMs !== undefined
                    ? formatClock(t.anchor.timeMs)
                    : t.anchor.page !== undefined
                      ? `p. ${t.anchor.page}`
                      : t.spot
                        ? 'Spot'
                        : 'File'}
                </span>
                <span className="dr-rvm-row__text">
                  <strong>{t.createdBy.name}</strong> {first ? snippet(first.body, 90) : ''}
                </span>
                {t.comments.length > 1 && <span className="dr-rvm-row__n">{t.comments.length - 1}</span>}
                {t.status === 'resolved' && <span className="dr-rvm-row__tag">Resolved</span>}
              </button>
              {open && (
                <div className="dr-rvm-row__thread dr-cthread" data-testid="rv-thread">
                  <ThreadView
                    store={store}
                    thread={t}
                    isOwner={ctx.role === 'owner'}
                    locationLabel={placeLabel({ ...t.anchor, ...(t.spot ? { spot: t.spot } : {}) })}
                    onClose={() => patchSession(session, { selected: null })}
                    autoFocusReply={false}
                  />
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** The version label the exports write: "v2" once the version list (WS2) numbers it, else its id. */
const versionLabelOf = (versionId: string, numbers: ReadonlyMap<string, number>) => {
  const n = numbers.get(versionId)
  return n ? `v${n}` : versionId
}

function ExportMenu(props: ViewerSlotProps & { fps: number | null }) {
  const { ctx, request, file, fps } = props
  const store = controllerFor(ctx).store
  const numbers = useVersionNumbers(ctx.board.id, request.assetId)
  const kind = useUserKind()
  const guest = kind === null ? null : kind === 'guest'
  const allowed = useValue('review-viewer-export', () => downloadsAllowed(ctx, guest), [ctx, guest])
  const team = useValue('review-viewer-export-team', () => store.privacy.get().teamOnly, [store])
  const [open, setOpen] = useState(false)
  const [withTeam, setWithTeam] = useState(false)
  if (!allowed) {
    return (
      <button
        type="button"
        className="dr-btn dr-btn--sm dr-btn--ghost"
        data-testid="rv-export-off"
        aria-disabled="true"
        onClick={() => notifyDownloadsOff(ctx)}
      >
        Export
      </button>
    )
  }
  const save = (what: ExportKind) => {
    const all: CommentThread[] = Object.values(store.threads.get())
    // team-only threads only for the team, and only when they ticked the box (the report's rule)
    const visible = (t: CommentThread) =>
      t.comments.length > 0 && (t.visibility !== 'team' || (team && withTeam))
    const rows: ExportThread[] = threadsOfAsset(all, request.assetId)
      .filter(visible)
      .map((thread) => ({ thread, versionLabel: versionLabelOf(thread.anchor.versionId, numbers) }))
    const shownVersion = rows.filter(
      (r) => r.thread.anchor.kind === 'asset' && r.thread.anchor.versionId === request.versionId,
    )
    const body =
      what === 'csv'
        ? commentsCsv(rows, fps)
        : what === 'markers'
          ? markersCsv(shownVersion, fps)
          : commentsEdl(shownVersion, { title: file.name || 'Comments', clipName: file.name || 'clip', fps })
    const out = exportFile(what, file.name)
    downloadBlob(new Blob([body], { type: out.type }), out.name)
    setOpen(false)
  }
  return (
    <div className="dr-rvm-export">
      <button
        type="button"
        className="dr-btn dr-btn--sm"
        data-testid="rv-export"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen(!open)}
      >
        Export
      </button>
      {open && (
        <div className="dr-rvm-export__menu" data-testid="rv-export-menu">
          <button
            type="button"
            className="dr-btn dr-btn--sm dr-btn--ghost"
            data-testid="rv-export-csv"
            onClick={() => save('csv')}
          >
            Comments (CSV)
          </button>
          {file.kind === 'video' && (
            <>
              <button
                type="button"
                className="dr-btn dr-btn--sm dr-btn--ghost"
                data-testid="rv-export-markers"
                onClick={() => save('markers')}
              >
                Markers (Premiere CSV)
              </button>
              <button
                type="button"
                className="dr-btn dr-btn--sm dr-btn--ghost"
                data-testid="rv-export-edl"
                onClick={() => save('edl')}
              >
                Markers (EDL)
              </button>
            </>
          )}
          {team && (
            <label className="dr-rvm-toggle">
              <input
                type="checkbox"
                data-testid="rv-export-team"
                checked={withTeam}
                onChange={(e) => setWithTeam(e.target.checked)}
              />
              Include team-only comments
            </label>
          )}
        </div>
      )}
    </div>
  )
}
