// OWNER: WS5 (wave W, W5-2). The storage tab: the workspace's total against its quota, and the boards or the people
// that store the most (the top 50; the same sums as the dashboard's storage line). Read-only: removing files happens on
// the boards.
import type { AdminStorageRow } from '@draftroom/contracts'
import { useCallback, useState } from 'react'
import { formatBytes } from '../../lib/format.ts'
import { boardPath, linkClick } from '../../lib/routing.ts'
import type { AdminApi } from './api.ts'
import { quotaPercent } from './model.ts'
import { LoadFailed, Loading, useAdminResource } from './shared.tsx'

type By = 'board' | 'uploader'

export function StorageTab({ api, onDenied }: { api: AdminApi; onDenied(): void }) {
  const [by, setBy] = useState<By>('board')
  const res = useAdminResource(
    useCallback((signal: AbortSignal) => api.storage(by, signal), [api, by]),
    onDenied,
  )
  return (
    <div className="dr-admin__stack">
      {res.status === 'ready' && <Total data={res.data} />}
      <section aria-labelledby="admin-storage-h">
        <div className="dr-admin__sectionhead">
          <h2 id="admin-storage-h" className="dr-admin__h2">
            What stores the most
          </h2>
          <fieldset className="dr-admin__seg">
            <legend className="dr-sr-only">Group by</legend>
            {(['board', 'uploader'] as const).map((b) => (
              <button
                key={b}
                type="button"
                className="dr-admin__segbtn"
                data-testid={`admin-storage-by-${b}`}
                aria-pressed={by === b}
                onClick={() => setBy(b)}
              >
                {b === 'board' ? 'By board' : 'By person'}
              </button>
            ))}
          </fieldset>
        </div>
        {res.status === 'loading' && <Loading label="Loading storage…" />}
        {res.status === 'error' && <LoadFailed message={res.error.message} onRetry={res.reload} />}
        {res.status === 'ready' && res.data.rows.length === 0 && (
          <p className="dr-admin__empty dr-muted">Nothing is stored in this workspace yet.</p>
        )}
        {res.status === 'ready' && res.data.rows.length > 0 && (
          <ol className="dr-admin__list" data-testid="admin-storage-rows" data-by={by}>
            {res.data.rows.map((r, i) => (
              <StorageRow
                key={r.board?.id ?? r.uploader?.id ?? `other-${i}`}
                row={r}
                total={res.data.total.bytes}
              />
            ))}
          </ol>
        )}
        {res.status === 'ready' && res.data.rows.length >= 50 && (
          <p className="dr-admin__note dr-muted">Showing the 50 that store the most.</p>
        )}
      </section>
    </div>
  )
}

function Total({
  data,
}: {
  data: { total: { versions: number; bytes: number; quotaBytes: number }; fileTextBytes: number }
}) {
  const pct = quotaPercent(data.total.bytes, data.total.quotaBytes)
  return (
    <section className="dr-admin__total" aria-labelledby="admin-total-h" data-testid="admin-storage-total">
      <h2 id="admin-total-h" className="dr-admin__h2">
        Used
      </h2>
      <p className="dr-admin__big">
        <span data-testid="admin-storage-used">{formatBytes(data.total.bytes)}</span>
        <span className="dr-muted">
          {' '}
          of {formatBytes(data.total.quotaBytes)} ({pct}%)
        </span>
      </p>
      {/* the words above say it; the bar only draws it */}
      <div className="dr-admin__meter" aria-hidden="true" data-full={pct >= 90 ? 'true' : undefined}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="dr-admin__meta dr-muted">
        <span>
          {data.total.versions.toLocaleString('en-US')} {data.total.versions === 1 ? 'file' : 'files'} with
          their previews and the boards’ thumbnails
        </span>
        {data.fileTextBytes > 0 && <span>Text kept for file search: {formatBytes(data.fileTextBytes)}</span>}
      </p>
    </section>
  )
}

function StorageRow({ row, total }: { row: AdminStorageRow; total: number }) {
  const share = total > 0 ? Math.max(1, Math.round((row.bytes / total) * 100)) : 0
  const label = row.board
    ? row.board.title || 'Untitled board'
    : row.uploader
      ? row.uploader.name
      : 'Board thumbnails'
  return (
    <li className="dr-admin__row dr-admin__row--storage" data-testid="admin-storage-row">
      <div className="dr-admin__who">
        <span className="dr-admin__name">
          {row.board ? (
            <a href={boardPath(row.board.id)} onClick={linkClick(boardPath(row.board.id))}>
              {label}
            </a>
          ) : (
            label
          )}
        </span>
        <span className="dr-admin__meta dr-muted">
          {row.board || row.uploader ? (
            <span>{row.versions === 1 ? '1 file' : `${row.versions.toLocaleString('en-US')} files`}</span>
          ) : (
            <span>The dashboard pictures of every board</span>
          )}
        </span>
      </div>
      <div className="dr-admin__size">
        <span className="dr-admin__bytes" data-testid="admin-storage-bytes">
          {formatBytes(row.bytes)}
        </span>
        <span className="dr-admin__bar" aria-hidden="true">
          <span style={{ width: `${share}%` }} />
        </span>
      </div>
    </li>
  )
}
