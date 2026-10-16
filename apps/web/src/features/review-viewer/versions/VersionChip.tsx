// OWNER: WS2 (wave S, versions of a deliverable; docs/WAVE-S-CONTRACTS.md §3). The "v3" chip on a file card or an
// image whose deliverable has more than one version on this board, and the version list it opens:
//   - each row: "v2", the file name, who uploaded it (a guest as "Name (guest)"), when, its size, its comments and
//     the review status it got; the card's version is marked "Shown";
//   - "Compare" opens the review viewer comparing that version with the shown one (the compare slot, ./compare);
//   - for whoever may edit the element: "Make current" (the same write as Replace media, to that older version: no
//     upload, no new version) and "Upload new version" (Replace media with X-Lobby-Supersedes).
// Drawn by the media feature's scene layer (file-card/ported/CardLayer.tsx) with the versions switch on, for the
// elements in view only (a list is asked for when its element first comes into view, then cached for the page and
// refreshed by ./store.ts). Keys pressed in the list stop at it: the board's shortcuts never see them.
import type { AssetVersionEntry, ListAssetVersionsResponse } from '@draftroom/contracts'
import { type CSSProperties, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { waitForTerminalMeta } from '../../../assets/meta-store.ts'
import type { CanvasElement, CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { canReplace, pointAtVersion, startReplace } from '../../../file-card/ported/edit-media.tsx'
import { mediaMetaStore } from '../../../file-card/ported/meta.ts'
import { type FileFacts, factsOf, fileItemKind } from '../../../file-card/ported/model.ts'
import { useValue } from '../../../lib/signals.ts'
import { reviewFlags } from '../../review/flags.ts'
import { openReviewViewer } from '../viewer-state.ts'
import { chipText, entryDetail, entryFacts } from './model.ts'
import { versionStoreOf } from './store.ts'
import './register.ts'
import './versions.css'

/** Elements this far outside the view (in scene units, at zoom 1) still get their chip (and their list asked). */
const VIEW_MARGIN = 200

interface ChipTarget {
  readonly id: string
  readonly facts: FileFacts
  readonly x: number
  readonly y: number
}

/** The cards and images in view that may carry a chip (never a placed PDF page: it is a rendering of its card). */
function chipTargets(canvas: LobbyCanvas): ChipTarget[] {
  const v = canvas.viewport.get()
  const m = VIEW_MARGIN / Math.max(0.1, v.zoom)
  const index = (canvas as Partial<LobbyCanvas>).index
  const items: readonly CanvasElement[] = index
    ? (index.withLobbyKey('file') as CanvasElement[])
    : canvas.items()
  const out: ChipTarget[] = []
  for (const el of items) {
    if (el.isDeleted || canvas.isHidden(el.id)) continue
    const kind = fileItemKind(el)
    if (kind !== 'card' && kind !== 'image') continue
    if (el.x > v.x + v.width + m || el.y > v.y + v.height + m) continue
    if (el.x + el.width < v.x - m || el.y + el.height < v.y - m) continue
    const facts = factsOf(el)
    if (facts) out.push({ id: el.id, facts, x: el.x, y: el.y })
  }
  return out
}

/** The chips of the media feature's scene layer (nothing while the versions switch is off). */
export function VersionChips({ ctx }: { ctx: CanvasFeatureContext }) {
  const on = reviewFlags().versions
  const targets = useValue('versions-chip-targets', () => (on ? chipTargets(ctx.canvas) : []), [ctx, on])
  const [open, setOpen] = useState<{ id: string; at: { x: number; y: number } } | null>(null)
  if (!on) return null
  return (
    <>
      {targets.map((t) => (
        <Chip key={t.id} ctx={ctx} target={t} onOpen={(at) => setOpen({ id: t.id, at })} />
      ))}
      {open && <VersionListHost ctx={ctx} id={open.id} at={open.at} onClose={() => setOpen(null)} />}
    </>
  )
}

function Chip({
  ctx,
  target,
  onOpen,
}: {
  ctx: CanvasFeatureContext
  target: ChipTarget
  onOpen(at: { x: number; y: number }): void
}) {
  const store = versionStoreOf(ctx)
  const list = useValue(store.list(target.facts.assetId))
  useEffect(() => store.ensure(target.facts.assetId, target.facts.versionId), [store, target])
  // where: the element's top-left corner, in overlay pixels (the camera moves it; the chip keeps its size)
  useValue('versions-chip-view', () => ctx.canvas.viewport.get(), [ctx])
  const text = chipText(list, target.facts.versionId)
  if (!text) return null
  const p = ctx.canvas.sceneToOverlay({ x: target.x, y: target.y })
  const style: CSSProperties = { position: 'absolute', left: p.x + 6, top: p.y + 6 }
  return (
    <button
      type="button"
      className="lobby-version-chip dr-interactive"
      data-testid="version-chip"
      data-lobby-version-chip={target.id}
      aria-label={`${text} of ${list?.versions.length} — versions of ${target.facts.name || 'this file'}`}
      aria-haspopup="dialog"
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        onOpen({ x: r.left, y: r.bottom + 4 })
      }}
    >
      {text}
    </button>
  )
}

// ---- the version list ------------------------------------------------------------------------------------------

function VersionListHost({
  ctx,
  id,
  at,
  onClose,
}: {
  ctx: CanvasFeatureContext
  id: string
  at: { x: number; y: number }
  onClose(): void
}) {
  const el = useValue('versions-list-element', () => {
    const e = ctx.canvas.get(id)
    return e && !e.isDeleted ? e : null
  }, [ctx, id])
  const facts = el ? factsOf(el) : null
  useEffect(() => {
    if (!facts) onClose()
  }, [facts, onClose])
  if (!el || !facts) return null
  return createPortal(
    <VersionList ctx={ctx} el={el} facts={facts} at={at} onClose={onClose} />,
    document.body,
  )
}

function VersionList({
  ctx,
  el,
  facts,
  at,
  onClose,
}: {
  ctx: CanvasFeatureContext
  el: CanvasElement
  facts: FileFacts
  at: { x: number; y: number }
  onClose(): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const list = useValue(versionStoreOf(ctx).list(facts.assetId))
  const editable = useValue('versions-list-editable', () => !!canReplace(ctx, [el.id]), [ctx, el.id])
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    root.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
    const keydown = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && !root.contains(e.target)) onClose()
    }
    root.addEventListener('keydown', keydown)
    window.addEventListener('pointerdown', outside, true)
    return () => {
      root.removeEventListener('keydown', keydown)
      window.removeEventListener('pointerdown', outside, true)
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [onClose])

  const left = Math.max(8, Math.min(at.x, window.innerWidth - 336))
  const top = Math.max(8, Math.min(at.y, window.innerHeight - 120))
  const makeCurrent = async (v: AssetVersionEntry) => {
    setBusy(v.versionId)
    const ok = await makeVersionCurrent(ctx, el.id, facts, v)
    setBusy(null)
    if (ok) onClose()
  }
  return (
    <div
      ref={ref}
      className="lobby-versions"
      role="dialog"
      aria-labelledby={titleId}
      data-testid="version-list"
      style={{ left, top, maxHeight: `calc(100vh - ${top + 8}px)` }}
    >
      <h3 id={titleId} className="lobby-versions__title">
        Versions of {facts.name || 'this file'}
      </h3>
      {!list ? (
        <p className="dr-muted">Loading versions…</p>
      ) : (
        <ol className="lobby-versions__rows">
          {[...list.versions].reverse().map((v) => (
            <VersionRow
              key={v.versionId}
              v={v}
              list={list}
              shown={v.versionId === facts.versionId}
              editable={editable}
              busy={busy === v.versionId}
              onCompare={() => {
                onClose()
                openReviewViewer(ctx.registries, {
                  elementId: el.id,
                  assetId: facts.assetId,
                  versionId: facts.versionId,
                  mode: 'compare',
                  compareWith: v.versionId,
                })
              }}
              onMakeCurrent={() => void makeCurrent(v)}
            />
          ))}
        </ol>
      )}
      {editable && (
        <button
          type="button"
          className="dr-btn dr-btn--primary lobby-versions__upload"
          data-testid="version-list-upload"
          onClick={() => {
            onClose()
            startReplace(ctx, [el.id])
          }}
        >
          Upload new version
        </button>
      )}
    </div>
  )
}

function VersionRow({
  v,
  list,
  shown,
  editable,
  busy,
  onCompare,
  onMakeCurrent,
}: {
  v: AssetVersionEntry
  list: ListAssetVersionsResponse
  shown: boolean
  editable: boolean
  busy: boolean
  onCompare(): void
  onMakeCurrent(): void
}) {
  const facts = entryFacts(v)
  return (
    <li
      className="lobby-versions__row"
      data-testid="version-row"
      data-version={v.versionId}
      data-shown={shown || undefined}
    >
      <span className="lobby-versions__n">v{v.n}</span>
      <div className="lobby-versions__text">
        <div className="lobby-versions__name" title={v.name}>
          {v.name}
          {shown && <span className="lobby-versions__shown"> · Shown</span>}
          {v.versionId === list.latestVersionId && !shown && (
            <span className="lobby-versions__shown"> · Newest</span>
          )}
        </div>
        <div className="lobby-versions__detail">{entryDetail(v)}</div>
        {facts && <div className="lobby-versions__detail">{facts}</div>}
      </div>
      {!shown && (
        <div className="lobby-versions__actions">
          <button
            type="button"
            className="dr-btn dr-btn--small"
            data-testid="version-compare"
            onClick={onCompare}
          >
            Compare
          </button>
          {editable && (
            <button
              type="button"
              className="dr-btn dr-btn--small"
              data-testid="version-make-current"
              disabled={busy}
              onClick={onMakeCurrent}
            >
              {busy ? 'Switching…' : 'Make current'}
            </button>
          )}
        </div>
      )}
    </li>
  )
}

/** "Make current": the element shows an older version (one undo step); false (with a notice) when it could not. */
export async function makeVersionCurrent(
  ctx: CanvasFeatureContext,
  id: string,
  facts: FileFacts,
  v: Pick<AssetVersionEntry, 'versionId' | 'n'>,
): Promise<boolean> {
  const snap = await waitForTerminalMeta(mediaMetaStore, ctx.board.id, facts.assetId, v.versionId, 15_000)
  const meta = snap.meta
  const el = ctx.canvas.get(id)
  if (!meta || snap.missing || !el || el.isDeleted || !canReplace(ctx, [id])) {
    ctx.notify({ key: 'version-make-current', text: `v${v.n} could not be shown here.`, tone: 'error' })
    return false
  }
  const w = meta.probe?.width
  const h = meta.probe?.height
  const size = meta.kind === 'image' && w && h ? { w, h } : null
  pointAtVersion(ctx, el, facts.kind, meta, size, 'Make current')
  return true
}
