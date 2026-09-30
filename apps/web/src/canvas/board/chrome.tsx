/**
 * The Excalidraw board page's chrome around the canvas (docs/EXCALIDRAW-CONTRACTS.md §3): the dock
 * (`panels`), the top bar's feature items (`topBar`), the overlay root (`featureOverlays` in scene and
 * screen layers, C0 `overlays`, remote cursors through `cursorVisible`, "X is typing" badges), the host
 * slots, and the lease banner and pending affordance. Focus mode (`settings.focusMode`, present mode)
 * hides the dock, the top bar, the host slots and every overlay layer that does not say `show`.
 *
 * Every feature component is rendered inside `CanvasFeatureContextProvider` and gets the context.
 */
import type { RosterEntry } from '@draftroom/canvas-schema/protocol'
import { type CSSProperties, type ReactNode, useMemo, useSyncExternalStore } from 'react'
import { FeatureDockView, TopBarOverflowRow } from '../../features/FeatureHostCore.tsx'
import { initialsFor, safeColor } from '../../lib/identity.ts'
import { can } from '../../lib/permissions.ts'
import { useValue } from '../../lib/signals.ts'
import type { CanvasFeatureContext } from '../api/feature.ts'
import { currentPlatform, formatChord } from '../api/keys.ts'
import type { LobbyCanvas } from '../api/lobby-canvas.ts'
import type { FeatureOverlaySpec, FeatureRegistries, HostSlotName } from '../api/registries.ts'
import type { EditNotice, EditState } from '../lease/editorLease.ts'
import type { LobbyBoardSession } from './session.ts'

// ---- the dock ---------------------------------------------------------------------------------------------

export function CanvasDock({ ctx }: { ctx: CanvasFeatureContext }) {
  const r = ctx.registries
  const panels = r
    .sorted(r.panels)
    .filter((p) => (p.visible ? p.visible(ctx) : true))
    .map((p) => ({
      id: p.id,
      label: p.label,
      icon: <p.icon />,
      ...(p.shortcutHint ? { shortcutHint: formatChord(p.shortcutHint, currentPlatform()) } : {}),
      render: (close: () => void) => <p.component ctx={ctx} close={close} />,
    }))
  return (
    <FeatureDockView
      panels={panels}
      activePanel={ctx.activePanel}
      openPanel={ctx.openPanel}
      isEditingText={() => ctx.canvas.editingId() !== null}
      renderAddNote={(closeRail) => <AddNoteButton ctx={ctx} onPress={closeRail} />}
    />
  )
}

/**
 * A11Y-07: "Add a sticky note" at the end of the rail, for people who can edit: a keyboard-only way to
 * put the first note on a blank board, in the middle of the view, with its editor open (through the
 * lease, like every other open).
 */
function AddNoteButton({ ctx, onPress }: { ctx: CanvasFeatureContext; onPress(): void }) {
  const canvas = ctx.canvas
  const readonly = useValue('lobby-add-note-readonly', () => canvas.readOnly(), [canvas])
  if (readonly || !can(ctx.role, 'edit', ctx.board.status)) return null
  return (
    <button
      type="button"
      className="dr-dock__tab"
      data-testid="dock-add-note"
      aria-label="Add a sticky note"
      title="Add a sticky note in the middle of the view (or press N, then click)"
      onClick={() => {
        onPress()
        canvas.focus({ preventScroll: true })
        const v = canvas.viewport.get()
        const size = 200
        const id = canvas.transact('add note', (tx) =>
          tx.create('note', { x: v.x + v.width / 2 - size / 2, y: v.y + v.height / 2 - size / 2, size }),
        )
        void canvas.text.edit(id, { via: 'api', caret: 'end' })
      }}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path
          d="M5 4h10l4 4v12H5z M15 4v4h4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path d="M12 11v6M9 14h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <span className="dr-dock__label" aria-hidden="true">
        Add a sticky note
      </span>
    </button>
  )
}

// ---- the top bar's feature items --------------------------------------------------------------------------

export function topBarItems(
  ctx: CanvasFeatureContext | null,
  mode: 'all' | 'pinned' | 'overflow',
): ReactNode {
  if (!ctx) return null
  const r = ctx.registries
  const items = r.sorted(r.topBar)
  if (mode === 'all') return items.map((i) => <i.component key={i.id} ctx={ctx} />)
  if (mode === 'pinned') return items.filter((i) => i.pinned).map((i) => <i.component key={i.id} ctx={ctx} />)
  return items
    .filter((i) => !i.pinned)
    .map((i) => (
      <TopBarOverflowRow key={i.id} featureId={i.id} caption={i.overflowCaption}>
        <i.component ctx={ctx} />
      </TopBarOverflowRow>
    ))
}

/** Whether a feature puts its own people list in the top bar (3c's people): the page's list steps aside. */
export const featureHasPeople = (r: FeatureRegistries) => r.topBar.list().some((i) => i.id === 'people')

/**
 * Who is on the board, from the roster (one avatar per person: a user with two tabs is one), this user
 * left out. The board page's own list until the ported people feature (3c) contributes its top-bar item.
 */
export function BoardPeople({
  roster,
  selfUserId,
  max,
}: {
  roster: readonly RosterEntry[]
  selfUserId: string
  max: number
}) {
  const people = useMemo(() => {
    const byUid = new Map<string, RosterEntry>()
    for (const r of roster) if (r.uid !== selfUserId && !byUid.has(r.uid)) byUid.set(r.uid, r)
    return [...byUid.values()].sort((a, b) => a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid))
  }, [roster, selfUserId])
  if (!people.length) return null
  const shown = people.slice(0, max)
  const more = people.length - shown.length
  return (
    <ul className="dr-presence" data-testid="presence-list" aria-label="People on this board">
      {shown.map((p) => (
        <li
          key={p.uid}
          className="dr-avatar"
          data-testid="presence-user"
          data-user-id={p.uid}
          data-guest={p.guest || undefined}
          title={p.name}
          style={{ background: safeColor(p.color, p.uid) }}
        >
          <span aria-hidden="true">{initialsFor(p.name)}</span>
          <span className="dr-sr-only">{p.name}</span>
        </li>
      ))}
      {more > 0 && (
        <li className="dr-avatar dr-avatar--more" data-testid="presence-more" title={`${more} more`}>
          +{more}
        </li>
      )}
    </ul>
  )
}

// ---- the overlay root ---------------------------------------------------------------------------------------

const layerStyle = (spec: FeatureOverlaySpec): CSSProperties => ({
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  zIndex: spec.order,
})

/** One feature overlay layer: `pointer: 'auto'` layers let their own top-level elements take clicks. */
function FeatureLayer({ spec, ctx }: { spec: FeatureOverlaySpec; ctx: CanvasFeatureContext }) {
  const pointer = spec.pointer ?? (spec.layer === 'scene' ? 'none' : 'auto')
  return (
    <div
      data-lobby-overlay={spec.id}
      data-lobby-layer={spec.layer}
      data-pointer={pointer}
      className="lobby-overlay-layer"
      style={layerStyle(spec)}
    >
      <spec.component ctx={ctx} />
    </div>
  )
}

export function OverlayRoot({
  ctx,
  session,
  focusMode,
}: {
  ctx: CanvasFeatureContext
  session: LobbyBoardSession
  focusMode: boolean
}) {
  const r = ctx.registries
  const shown = r.sorted(r.featureOverlays).filter((o) => !focusMode || o.focusMode === 'show')
  const port = session.port
  const c0 = port ? [...r.overlays.list()].sort((a, b) => a.order - b.order) : []
  return (
    <div
      data-testid="lobby-overlay"
      data-focus-mode={focusMode || undefined}
      // clip, not hidden: a hidden box can still be scrolled, and focusing or clicking something past its edge
      // (a phone's toolbar, a panel) scrolled every layer sideways (found at the wave-3 integration)
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'clip', zIndex: 5 }}
    >
      <div data-lobby-layer="scene" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <TypingBadges canvas={ctx.canvas} />
        {shown
          .filter((o) => o.layer === 'scene')
          .map((o) => (
            <FeatureLayer key={o.id} spec={o} ctx={ctx} />
          ))}
        {port && !focusMode ? c0.map((l) => <l.component key={l.id} port={port} />) : null}
        <Cursors canvas={ctx.canvas} registries={r} />
      </div>
      <div data-lobby-layer="screen" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {shown
          .filter((o) => o.layer === 'screen')
          .map((o) => (
            <FeatureLayer key={o.id} spec={o} ctx={ctx} />
          ))}
      </div>
    </div>
  )
}

/** "Alice is typing…" on every element whose lease another session holds (§2.9.5). */
function TypingBadges({ canvas }: { canvas: LobbyCanvas }) {
  const badges = useValue('lobby-typing-badges', () => {
    const holders = canvas.engine?.leaseHolders()
    const me = canvas.engine?.welcome?.sid ?? null
    canvas.collaborators() // tracks lease and roster changes
    if (!holders) return []
    const out: { id: string; name: string; x: number; y: number }[] = []
    for (const [id, h] of holders) {
      if (h.sid === me) continue
      const b = canvas.bounds(id)
      if (!b) continue
      const p = canvas.sceneToOverlay({ x: b.x, y: b.y })
      out.push({ id, name: h.name, x: p.x, y: p.y })
    }
    return out
  }, [canvas])
  return (
    <>
      {badges.map((b) => (
        <div
          key={b.id}
          className="lobby-typing-badge"
          data-testid="typing-badge"
          data-lease={b.id}
          data-holder={b.name}
          style={{ position: 'absolute', left: b.x, top: Math.max(0, b.y - 22) }}
        >
          {b.name} is typing…
        </div>
      ))}
    </>
  )
}

/** Remote cursors with name tags (§2.7), filtered by `cursorVisible` (present mode, "hide cursors"). */
function Cursors({ canvas, registries }: { canvas: LobbyCanvas; registries: FeatureRegistries }) {
  // a new cursor filter (a registry change) recomputes the list
  const version = useRegistries(registries)
  const cursors = useValue(
    'lobby-cursors',
    () =>
      canvas.presence
        .peers()
        .filter((p) => p.point && registries.cursorVisible.call(p.sid))
        .map((p) => ({ ...p, at: canvas.sceneToOverlay(p.point as { x: number; y: number }) })),
    [canvas, registries, version],
  )
  return (
    <>
      {cursors.map((p) => (
        <div
          key={p.sid}
          className="lobby-cursor"
          data-testid="cursor"
          data-sid={p.sid}
          data-uid={p.uid}
          data-name={p.name}
          style={{ position: 'absolute', left: p.at.x, top: p.at.y, transform: 'translate(-2px, -2px)' }}
        >
          <svg width="14" height="18" viewBox="0 0 14 18" aria-hidden="true">
            <path
              d="M1 1 L1 15 L5 11 L8 17 L10 16 L7 10 L13 10 Z"
              fill={safeColor(p.color, p.uid)}
              stroke="#fff"
              strokeWidth="1"
            />
          </svg>
          <span className="lobby-cursor__name" style={{ background: safeColor(p.color, p.uid) }}>
            {p.name}
          </span>
        </div>
      ))}
    </>
  )
}

// ---- host slots ------------------------------------------------------------------------------------------------

/**
 * Where each host slot sits over the canvas (the tldraw component of the same job sat there). The board
 * menu's and the navigation panel's corners are in board.css (`.lobby-slot--mainMenu`, `--navigation`):
 * narrow layouts move them, as the tldraw page's layout did (R13: the board menu beside the dock's fold
 * button on a phone, not under it; the navigation panel above a toolbar that is as wide as the canvas).
 */
const SLOT_STYLE: Record<HostSlotName, CSSProperties> = {
  toolbar: { position: 'absolute', left: '50%', bottom: 12, transform: 'translateX(-50%)', zIndex: 20 },
  stylePanel: { position: 'absolute', right: 12, top: 12, zIndex: 20 },
  contextMenu: { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 40 },
  mainMenu: { position: 'absolute', zIndex: 20 },
  shortcutsDialog: { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 45 },
  selectionBar: { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 21 },
  navigation: { position: 'absolute', zIndex: 20 },
  phoneSheet: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 30 },
  liveRegion: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' },
}

const SLOT_ORDER: readonly HostSlotName[] = [
  'toolbar',
  'stylePanel',
  'mainMenu',
  'navigation',
  'selectionBar',
  'phoneSheet',
  'contextMenu',
  'shortcutsDialog',
  'liveRegion',
]

export function HostSlots({ ctx, focusMode }: { ctx: CanvasFeatureContext; focusMode: boolean }) {
  const r = ctx.registries
  return (
    <>
      {SLOT_ORDER.map((name) => {
        const entry = r.hostSlots.get(name)
        if (!entry) return null
        // the live region stays in focus mode (a screen reader still hears the presentation)
        if (focusMode && name !== 'liveRegion') return null
        return (
          <div
            key={name}
            className={`lobby-slot lobby-slot--${name}`}
            data-lobby-slot={name}
            data-feature={entry.featureId}
            style={SLOT_STYLE[name]}
          >
            <entry.component ctx={ctx} />
          </div>
        )
      })}
    </>
  )
}

// ---- the text lease's visible state (§2.9.5) -----------------------------------------------------------------

/** "Opening the note…" while a lease request is out; the lost-lease line. */
export function PendingAffordance({ edit }: { edit: EditState | null }) {
  const phase = edit?.phase ?? 'idle'
  const buffered = edit?.buffered ?? 0
  const lost = edit?.lost?.name ?? null
  const show = phase === 'pending' || phase === 'opening' || !!lost
  return (
    <div
      className="lobby-lease-status"
      data-testid="lease-status"
      data-phase={phase}
      data-lost={lost ? '1' : ''}
      role="status"
      hidden={!show}
    >
      {lost
        ? `Not saved — ${lost} is editing this note now`
        : buffered > 0
          ? `Opening the note… (${buffered} typed, Esc cancels)`
          : 'Opening the note… (Esc cancels)'}
    </div>
  )
}

/** The lease notice ("Copy my text" when typed words were not saved). */
export function LeaseNotice({
  notice,
  onDismiss,
}: {
  notice: (EditNotice & { id: number }) | null
  onDismiss(): void
}) {
  if (!notice) return null
  return (
    <div
      className="dr-banner lobby-lease-notice"
      data-testid="lease-notice"
      data-kind={notice.kind}
      role="alert"
    >
      <span>{notice.message}</span>
      {notice.text ? (
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="lease-copy"
          onClick={() => void navigator.clipboard?.writeText(notice.text ?? '').catch(() => {})}
        >
          Copy my text
        </button>
      ) : null}
      <button type="button" className="dr-btn dr-btn--sm" data-testid="lease-dismiss" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  )
}

/** Re-renders on every registry change (a feature registering in onMount). */
export function useRegistries(r: FeatureRegistries): number {
  return useSyncExternalStore(
    (l) => r.subscribe(l),
    () => registryVersion(r),
  )
}

const versions = new WeakMap<FeatureRegistries, { v: number; off: () => void }>()
function registryVersion(r: FeatureRegistries): number {
  let e = versions.get(r)
  if (!e) {
    const entry = { v: 0, off: () => {} }
    entry.off = r.subscribe(() => {
      entry.v++
    })
    versions.set(r, entry)
    e = entry
  }
  return e.v
}
