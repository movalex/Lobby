// OWNER: WS5 (wave W, W5-5). What Lobby keeps and for how long: read-only facts from the api (its code, its
// environment, or the docs for the sync server's backups). There is no control here, and nothing on this page deletes
// anything for good (the owner's decision: retention that deletes is a later, separate decision).
import { useCallback } from 'react'
import type { AdminApi } from './api.ts'
import { SOURCE_LABELS } from './model.ts'
import { LoadFailed, Loading, useAdminResource } from './shared.tsx'

export function RetentionTab({ api, onDenied }: { api: AdminApi; onDenied(): void }) {
  const res = useAdminResource(
    useCallback((signal: AbortSignal) => api.retention(signal), [api]),
    onDenied,
  )
  if (res.status === 'loading') return <Loading label="Loading retention…" />
  if (res.status === 'error') return <LoadFailed message={res.error.message} onRetry={res.reload} />
  return (
    <div className="dr-admin__stack">
      <p className="dr-admin__note dr-muted">
        These are fixed for every workspace on this server. Nothing on this page deletes anything.
      </p>
      <dl className="dr-admin__facts" data-testid="admin-retention">
        {res.data.facts.map((f) => (
          <div key={f.id} className="dr-admin__fact" data-testid="admin-retention-fact" data-fact-id={f.id}>
            <dt>{f.label}</dt>
            <dd>
              <span>{f.value}</span>
              <span className="dr-admin__source dr-muted">{SOURCE_LABELS[f.source]}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
