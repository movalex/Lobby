// The `history` dock panel: named checkpoints (save, restore as a new private board), duplicate,
// "Recently deleted" (restore puts objects back where they were; editors only, and never even fetched
// for anyone else: authz-001) and the portable .json export. Duplicate, restore as new and the export
// are turned off, with the reason, when the board owner turned exporting off for this person (the
// sharing feature's export-policy store, read only; the api refuses them too: EXPORT_DISABLED).

import {
  type BoardCheckpoint,
  CHECKPOINT_EVENTS,
  type DeletedShapeEntry,
  type ListDeletedResponse,
} from '@draftroom/contracts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type TLShapeId, useValue } from 'tldraw'
import { isApiError } from '../../api/client.ts'
import { useUserKind } from '../../invite/guest.tsx'
import { formatRelativeTime, pluralize } from '../../lib/format.ts'
import { linkClick } from '../../lib/routing.ts'
import { EXPORT_OFF_TEXT, exportAllowedOnBoard } from '../sharing/export-policy.ts'
import type { FeatureContext } from '../types.ts'
import { fetchBoardArchive, historyApi, saveBlob } from './api.ts'
import { CheckpointList } from './CheckpointList.tsx'
import { CheckpointPreview } from './CheckpointPreview.tsx'
import { checkpointPermissions, deletedCheckpointSummary } from './checkpoints-model.ts'
import {
  archiveFileName,
  checkpointNameToSave,
  copyActions,
  createdSummary,
  defaultCheckpointName,
  deletedDetail,
  deletedTitle,
  historyPermissions,
  restoredOnBoard,
  restoreSummary,
  touchesDeleted,
} from './model.ts'

const DELETED_REFRESH_MS = 700
const APPEAR_TIMEOUT_MS = 4_000

type Status = { text: string; tone: 'info' | 'error'; openBoardId?: string; openTitle?: string }

const message = (e: unknown, fallback: string) => (isApiError(e) ? e.message : fallback)

export function HistoryPanel({ ctx }: { ctx: FeatureContext; close(): void }) {
  const { board, role, editor, events, notify, me, openPanel } = ctx
  const api = useMemo(() => historyApi(ctx.api), [ctx.api])
  const workspaceRole = me.workspaces.find((w) => w.id === board.workspaceId)?.role ?? null
  // Domain access: only creators duplicate or restore as a new board (the api refuses anyone else).
  const perms = historyPermissions(role, board.status, workspaceRole, { creator: me.access.creator })
  // History is for people with an account (DANA-05): the rail never offers it to a name-only guest
  // (index.tsx) and the api refuses them the checkpoint list (403). Nothing is fetched before the
  // kind is known, and should the panel be open when it turns out to be a guest's, it closes.
  const kind = useUserKind()
  const isAccount = kind === 'account'
  useEffect(() => {
    if (kind === 'guest') openPanel(null)
  }, [kind, openPanel])
  // "Recently deleted" is for editors with an account (wave 3, SEAM-06).
  const canSeeDeleted = perms.canSeeDeleted && isAccount
  // Live: the owner can turn exporting off (or back on) while this panel is open.
  const canExport = useValue('dr-history-export', () => exportAllowedOnBoard(board.id), [board.id])
  const copy = copyActions(perms, canExport)
  const checkpointPerms = checkpointPermissions(role, board.status, workspaceRole)

  const [snapshots, setSnapshots] = useState<BoardCheckpoint[] | null>(null)
  const [previewing, setPreviewing] = useState<BoardCheckpoint | null>(null)
  const [deleted, setDeleted] = useState<ListDeletedResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [keepSharing, setKeepSharing] = useState(false)
  const placeholder = useMemo(() => defaultCheckpointName(), [])

  // ---- loading ------------------------------------------------------------------------------------

  const loadSnapshots = useCallback(
    async (signal?: AbortSignal) => {
      if (!isAccount) return
      try {
        setSnapshots(await api.listCheckpoints(board.id, signal))
        setLoadError(null)
      } catch (e) {
        if (!signal?.aborted) setLoadError(message(e, 'Checkpoints could not be loaded.'))
      }
    },
    [api, board.id, isAccount],
  )
  const deletedSeq = useRef(0)
  const loadDeleted = useCallback(async () => {
    const seq = ++deletedSeq.current
    // Not an editor (any more: roles change live): drop the list and do not ask the server for it.
    if (!canSeeDeleted) {
      setDeleted(null)
      setSelected((cur) => (cur.size ? new Set() : cur))
      return
    }
    try {
      const list = await api.listDeleted(board.id)
      if (seq === deletedSeq.current) setDeleted(list)
    } catch (e) {
      if (seq === deletedSeq.current)
        setLoadError(message(e, 'Recently deleted objects could not be loaded.'))
    }
  }, [api, board.id, canSeeDeleted])

  useEffect(() => {
    const controller = new AbortController()
    void loadSnapshots(controller.signal)
    void loadDeleted()
    return () => controller.abort()
  }, [loadSnapshots, loadDeleted])

  // Server hints (another person saved or restored), and every stream reconnect.
  useEffect(() => {
    const offs = [
      events.on('history.snapshot', () => void loadSnapshots()),
      // Deleted by an owner, or thinned out by retention (automatic checkpoints).
      events.on(CHECKPOINT_EVENTS.removed, () => void loadSnapshots()),
      events.on('history.deleted', () => void loadDeleted()),
      events.onResync(() => {
        void loadSnapshots()
        void loadDeleted()
      }),
    ]
    return () => {
      for (const off of offs) off()
    }
  }, [events, loadSnapshots, loadDeleted])

  // Deletes (anyone's: they arrive through sync) and undone deletes refresh the list, debounced.
  const listed = useRef<ReadonlySet<string>>(new Set())
  listed.current = new Set(deleted?.entries.map((e) => e.shapeId))
  useEffect(() => {
    if (!canSeeDeleted) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = editor.store.listen(
      ({ changes }) => {
        if (!touchesDeleted(changes, listed.current)) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => void loadDeleted(), DELETED_REFRESH_MS)
      },
      { scope: 'document', source: 'all' },
    )
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [editor, loadDeleted, canSeeDeleted])

  // ---- actions ------------------------------------------------------------------------------------

  const run = async (key: string, fn: () => Promise<void>) => {
    if (busy) return
    setBusy(key)
    setStatus(null)
    try {
      await fn()
    } finally {
      setBusy(null)
    }
  }

  const save = () =>
    run('save', async () => {
      const toSave = checkpointNameToSave(name)
      try {
        const snap: BoardCheckpoint = { reason: null, ...(await api.saveSnapshot(board.id, toSave)) }
        setSnapshots((all) => [snap, ...(all ?? []).filter((s) => s.id !== snap.id)])
        setName('')
        setStatus({ text: `Saved “${snap.name}”.`, tone: 'info' })
      } catch (e) {
        setStatus({ text: message(e, 'The checkpoint could not be saved.'), tone: 'error' })
      }
    })

  const deleteCheckpoint = (snap: BoardCheckpoint) =>
    run(`delete:${snap.id}`, async () => {
      try {
        await api.deleteCheckpoint(snap.id)
        setSnapshots((all) => (all ?? []).filter((s) => s.id !== snap.id))
        setStatus({ text: deletedCheckpointSummary(snap), tone: 'info' })
      } catch (e) {
        setStatus({ text: message(e, 'The checkpoint could not be deleted.'), tone: 'error' })
        void loadSnapshots()
      }
    })

  const restoreAsNew = (snap: BoardCheckpoint) =>
    run(`restore:${snap.id}`, async () => {
      if (!exportAllowedOnBoard(board.id)) return
      try {
        const created = await api.restoreAsNew(snap.id)
        setStatus({
          text: createdSummary('restore', created),
          tone: 'info',
          openBoardId: created.board.id,
          openTitle: created.board.title,
        })
        notify({ key: 'history:created', text: `New board “${created.board.title}” is ready.` })
      } catch (e) {
        setStatus({ text: message(e, 'The checkpoint could not be restored.'), tone: 'error' })
      }
    })

  const duplicate = () =>
    run('duplicate', async () => {
      if (!exportAllowedOnBoard(board.id)) return
      try {
        const created = await api.duplicate(board.id, keepSharing ? { keepSharing: true } : {})
        setStatus({
          text: createdSummary('duplicate', created),
          tone: 'info',
          openBoardId: created.board.id,
          openTitle: created.board.title,
        })
      } catch (e) {
        setStatus({ text: message(e, 'The board could not be duplicated.'), tone: 'error' })
      }
    })

  const exportJson = () =>
    run('export', async () => {
      if (!exportAllowedOnBoard(board.id)) return
      try {
        saveBlob(await fetchBoardArchive(board.id), archiveFileName(board.title))
        setStatus({
          text: 'Board exported as a .json file (files are listed by reference, not included).',
          tone: 'info',
        })
      } catch (e) {
        setStatus({ text: message(e, 'The board could not be exported.'), tone: 'error' })
      }
    })

  const restoreDeleted = (ids: string[]) =>
    run(`deleted:${ids.join(',')}`, async () => {
      try {
        const result = await api.restoreDeleted(board.id, ids)
        setSelected(new Set())
        setStatus({ text: restoreSummary(result), tone: 'info' })
        void loadDeleted()
        void showRestored(result.restored)
      } catch (e) {
        setStatus({ text: message(e, 'That could not be restored.'), tone: 'error' })
      }
    })

  /** Selects and shows what came back once sync has delivered it (it arrives like any remote edit). */
  const showRestored = async (ids: string[]) => {
    if (!ids.length) return
    const end = Date.now() + APPEAR_TIMEOUT_MS
    const has = (id: string) => editor.getShape(id as TLShapeId) !== undefined
    while (restoredOnBoard(ids, has).length < ids.length && Date.now() < end)
      await new Promise((r) => setTimeout(r, 50))
    const here = restoredOnBoard(ids, has) as TLShapeId[]
    const first = here[0]
    if (!first) return
    const pageId = editor.getAncestorPageId(first)
    if (pageId && pageId !== editor.getCurrentPageId()) editor.setCurrentPage(pageId)
    editor.select(...here.filter((id) => editor.getAncestorPageId(id) === editor.getCurrentPageId()))
    // Bring it into view without zooming in on a single note: keep the current zoom (at most 100%)
    // unless what came back is bigger than the screen.
    const bounds = editor.getSelectionPageBounds()
    if (bounds)
      editor.zoomToBounds(bounds, {
        targetZoom: Math.min(1, editor.getZoomLevel()),
        animation: { duration: 300 },
      })
  }

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // ---- view ---------------------------------------------------------------------------------------

  if (kind === 'guest') return null
  const now = new Date()
  return (
    <div className="dr-history" data-testid="history-panel">
      {status && (
        <div
          className={`dr-history__status dr-history__status--${status.tone}`}
          role={status.tone === 'error' ? 'alert' : 'status'}
          data-testid={status.tone === 'error' ? 'history-error' : 'history-status'}
        >
          <p>{status.text}</p>
          {status.openBoardId && (
            <a
              className="dr-btn dr-btn--primary dr-history__open"
              href={`/b/${status.openBoardId}`}
              onClick={linkClick(`/b/${status.openBoardId}`)}
              data-testid="history-open-board"
              aria-label={status.openTitle ? `Open “${status.openTitle}”` : 'Open the new board'}
            >
              Open board
            </a>
          )}
        </div>
      )}
      {loadError && (
        <p className="dr-history__load-error" role="alert">
          {loadError}{' '}
          <button
            type="button"
            className="dr-btn dr-btn--ghost"
            onClick={() => {
              setLoadError(null)
              void loadSnapshots()
              void loadDeleted()
            }}
          >
            Retry
          </button>
        </p>
      )}

      <section className="dr-history__section" aria-labelledby="dr-history-checkpoints">
        <h3 id="dr-history-checkpoints">Checkpoints</h3>
        <p className="dr-history__hint">
          A checkpoint keeps this board as it is now. Restoring one makes a new board that only you can see;
          this board is not changed.
        </p>
        {perms.canEdit && (
          <form
            className="dr-history__save"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <label className="dr-history__label" htmlFor="dr-history-name">
              Checkpoint name
            </label>
            <div className="dr-history__save-row">
              <input
                id="dr-history-name"
                className="dr-input"
                data-testid="checkpoint-name"
                value={name}
                maxLength={120}
                placeholder={placeholder}
                onChange={(e) => setName(e.target.value)}
              />
              <button
                type="submit"
                className="dr-btn dr-btn--primary"
                data-testid="checkpoint-save"
                disabled={busy !== null}
                aria-busy={busy === 'save'}
              >
                {busy === 'save' ? 'Saving…' : 'Save checkpoint'}
              </button>
            </div>
          </form>
        )}
        {copy.restoreAsNew === 'off' && !!snapshots?.length && (
          <p className="dr-history__off" id="dr-history-restore-off" data-testid="history-restore-off">
            {EXPORT_OFF_TEXT}
          </p>
        )}
        <CheckpointList
          checkpoints={snapshots}
          perms={checkpointPerms}
          canRestore={copy.restoreAsNew !== 'hidden'}
          restoreOff={copy.restoreAsNew === 'off'}
          now={now}
          actions={{
            busy,
            onPreview: (c) => setPreviewing(c),
            onRestore: (c) => void restoreAsNew(c),
            onDelete: (c) => void deleteCheckpoint(c),
          }}
        />
        {previewing && (
          <CheckpointPreview
            checkpoint={previewing}
            api={api}
            liveEditor={editor}
            canRestore={copy.restoreAsNew === 'on'}
            restoring={busy === `restore:${previewing.id}`}
            onRestore={() => {
              const c = previewing
              setPreviewing(null)
              void restoreAsNew(c)
            }}
            onClose={() => setPreviewing(null)}
          />
        )}
      </section>

      {canSeeDeleted && (
        <section className="dr-history__section" aria-labelledby="dr-history-deleted">
          <h3 id="dr-history-deleted">Recently deleted</h3>
          <p className="dr-history__hint">
            Objects deleted on this board, newest first. Restoring puts them back where they were and
            reconnects their connectors.
          </p>
          {deleted === null ? (
            <p className="dr-history__empty">Loading…</p>
          ) : deleted.entries.length === 0 ? (
            <p className="dr-history__empty">Nothing deleted recently.</p>
          ) : (
            <>
              {perms.canEdit && selected.size > 0 && (
                <button
                  type="button"
                  className="dr-btn dr-btn--primary dr-history__bulk"
                  data-testid="deleted-restore-selected"
                  disabled={busy !== null}
                  onClick={() => void restoreDeleted([...selected])}
                >
                  Restore {pluralize(selected.size, 'selected object')}
                </button>
              )}
              <ul className="dr-history__list" aria-label="Recently deleted objects">
                {deleted.entries.map((entry) => (
                  <DeletedRow
                    key={entry.shapeId}
                    entry={entry}
                    now={now}
                    canRestore={perms.canEdit}
                    busy={busy}
                    selected={selected.has(entry.shapeId)}
                    onToggle={() => toggle(entry.shapeId)}
                    onRestore={() => void restoreDeleted([entry.shapeId])}
                  />
                ))}
              </ul>
              {deleted.total > deleted.entries.length && (
                <p className="dr-history__empty">
                  Showing the newest {deleted.entries.length} of {deleted.total}.
                </p>
              )}
            </>
          )}
        </section>
      )}

      <section className="dr-history__section" aria-labelledby="dr-history-copy">
        <h3 id="dr-history-copy">Copy and export</h3>
        {copy.exportOff && (
          <p className="dr-history__off" id="dr-history-copy-off" data-testid="history-export-off">
            {EXPORT_OFF_TEXT}
          </p>
        )}
        {copy.duplicate !== 'hidden' && (
          <div className="dr-history__actions">
            <button
              type="button"
              className="dr-btn"
              data-testid="history-duplicate"
              disabled={busy !== null || copy.duplicate === 'off'}
              aria-describedby={copy.duplicate === 'off' ? 'dr-history-copy-off' : undefined}
              aria-busy={busy === 'duplicate'}
              onClick={() => void duplicate()}
            >
              {busy === 'duplicate' ? 'Duplicating…' : 'Duplicate board'}
            </button>
            {perms.canKeepSharing && copy.duplicate === 'on' && (
              <label className="dr-history__check">
                <input
                  type="checkbox"
                  data-testid="history-keep-sharing"
                  checked={keepSharing}
                  onChange={(e) => setKeepSharing(e.target.checked)}
                />
                Keep sharing settings (people and workspace access; links are never copied)
              </label>
            )}
          </div>
        )}
        <div className="dr-history__actions">
          <button
            type="button"
            className="dr-btn"
            data-testid="export-json"
            disabled={busy !== null || copy.exportJson === 'off'}
            aria-describedby={copy.exportJson === 'off' ? 'dr-history-copy-off' : undefined}
            aria-busy={busy === 'export'}
            onClick={() => void exportJson()}
          >
            {busy === 'export' ? 'Exporting…' : 'Export .json'}
          </button>
          <span className="dr-history__hint">
            A portable copy of this board that can be imported into Lobby.
          </span>
        </div>
      </section>
    </div>
  )
}

function DeletedRow({
  entry,
  now,
  canRestore,
  busy,
  selected,
  onToggle,
  onRestore,
}: {
  entry: DeletedShapeEntry
  now: Date
  canRestore: boolean
  busy: string | null
  selected: boolean
  onToggle(): void
  onRestore(): void
}) {
  const title = deletedTitle(entry)
  const detail = deletedDetail(entry)
  const checkboxId = `dr-deleted-${entry.shapeId}`
  return (
    <li className="dr-history__row" data-testid="deleted-row" data-shape-id={entry.shapeId}>
      {canRestore && (
        <input
          id={checkboxId}
          type="checkbox"
          className="dr-history__select"
          data-testid="deleted-select"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select “${title}”`}
        />
      )}
      <div className="dr-history__row-text">
        <span className="dr-history__row-title">{title}</span>
        <span className="dr-history__row-meta">
          {[
            detail,
            `deleted by ${entry.deletedBy.name || 'someone'}`,
            formatRelativeTime(entry.deletedAt, now),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      {canRestore && (
        <button
          type="button"
          className="dr-btn"
          data-testid="deleted-restore"
          disabled={busy !== null}
          aria-label={`Restore “${title}”`}
          onClick={onRestore}
        >
          Restore
        </button>
      )}
    </li>
  )
}
