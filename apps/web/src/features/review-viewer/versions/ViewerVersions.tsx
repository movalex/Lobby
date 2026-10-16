// OWNER: WS2 (wave S). The viewer's `header` entry `ws2.versions` (order 10): which version the viewer shows ("v2 of
// 3"), "Compare" (the shown version against the one before it), and in compare mode the two versions compared (A, B)
// and "Done comparing". Every change reopens the viewer on the new request (viewer-state.ts openReviewViewer). Shown
// only when the deliverable has more than one version on this board.
import type { ListAssetVersionsResponse } from '@draftroom/contracts'
import { useId } from 'react'
import { useValue } from '../../../lib/signals.ts'
import type { ViewerSlotProps } from '../slots.ts'
import { openReviewViewer, type ReviewViewerOpen } from '../viewer-state.ts'
import { defaultPair } from './model.ts'
import { versionStoreOf } from './store.ts'

export function ViewerVersions({ ctx, request }: ViewerSlotProps) {
  const list = useValue(versionStoreOf(ctx).list(request.assetId))
  if (!list || list.versions.length < 2) return null
  const reopen = (patch: Partial<ReviewViewerOpen>) =>
    openReviewViewer(ctx.registries, {
      elementId: request.elementId,
      assetId: request.assetId,
      versionId: request.versionId,
      mode: request.mode,
      compareWith: request.compareWith,
      ...patch,
    })
  if (request.mode === 'compare') {
    return (
      <div className="lobby-rv-versions" data-testid="viewer-versions">
        <VersionPicker
          list={list}
          label="A"
          testId="compare-pick-a"
          value={request.compareWith ?? ''}
          onChange={(v) => reopen({ compareWith: v })}
        />
        <VersionPicker
          list={list}
          label="B"
          testId="compare-pick-b"
          value={request.versionId}
          onChange={(v) => reopen({ versionId: v })}
        />
        <button
          type="button"
          className="dr-btn"
          data-testid="compare-done"
          onClick={() => reopen({ mode: 'view', compareWith: null })}
        >
          Done comparing
        </button>
      </div>
    )
  }
  const pair = defaultPair(list, request.versionId)
  return (
    <div className="lobby-rv-versions" data-testid="viewer-versions">
      <VersionPicker
        list={list}
        label="Version"
        testId="viewer-version"
        value={request.versionId}
        onChange={(v) => reopen({ versionId: v })}
      />
      {pair && (
        <button
          type="button"
          className="dr-btn"
          data-testid="viewer-compare"
          onClick={() => reopen({ mode: 'compare', versionId: pair.b, compareWith: pair.a })}
        >
          Compare
        </button>
      )}
    </div>
  )
}

function VersionPicker({
  list,
  label,
  value,
  testId,
  onChange,
}: {
  list: ListAssetVersionsResponse
  label: string
  value: string
  testId: string
  onChange(versionId: string): void
}) {
  const id = useId()
  const n = list.versions.length
  return (
    <span className="lobby-rv-versions__pick">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="dr-input"
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {!list.versions.some((v) => v.versionId === value) && <option value={value}>Pick a version</option>}
        {list.versions.map((v) => (
          <option key={v.versionId} value={v.versionId}>
            v{v.n} of {n}
          </option>
        ))}
      </select>
    </span>
  )
}
