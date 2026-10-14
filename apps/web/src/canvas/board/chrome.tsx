/**
 * The Excalidraw board page's chrome around the canvas (docs/EXCALIDRAW-CONTRACTS.md §3): the dock
 * (`panels`), the top bar's feature items (`topBar`), the overlay root (`featureOverlays` in scene and
 * screen layers, C0 `overlays`, remote cursors through `cursorVisible`, "X is typing" badges), the host
 * slots, other people's selections in their colours (W5-28), a marker on the canvas's edge for each person who is
 * off screen (W5-32), the hover and editing outlines in Lobby's accent (W5-38, W5-55: ./outlines.ts), and the
 * lease banner and pending affordance.
 * Focus mode (`settings.focusMode`, present mode) hides the dock, the top bar, the host slots, the
 * remote selections, the edge markers and every overlay layer that does not say `show`.
 *
 * Every feature component is rendered inside `CanvasFeatureContextProvider` and gets the context, and inside a
 * FeatureGuard (H1, M1-2): a feature that throws renders nothing and never blanks the board.
 */
import type { RosterEntry } from '@draftroom/canvas-schema/protocol'
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { frameAt } from '../../features/canvas-ux/ported/notes.ts'
import { FeatureBoundary, FeatureDockView, TopBarOverflowRow } from '../../features/FeatureHostCore.tsx'
import { cursorExternalSuffix, useBoardOutside } from '../../features/people/outside.ts'
import { initialsFor, safeColor } from '../../lib/identity.ts'
import { obstacleRects, rectsIntersect } from '../../lib/overlay-obstacles.ts'
import { can } from '../../lib/permissions.ts'
import { useValue } from '../../lib/signals.ts'
import type { CanvasFeatureContext } from '../api/feature.ts'
import { union } from '../api/geometry.ts'
import { currentPlatform, formatChord } from '../api/keys.ts'
import type { LobbyCanvas } from '../api/lobby-canvas.ts'
import type { FeatureOverlaySpec, FeatureRegistries, HostSlotName } from '../api/registries.ts'
import type { EditNotice, EditState } from '../lease/editorLease.ts'
import { useLongPress } from '../overlay/long-press.ts'
import {
  TopCentreContext,
  TopCentreStack,
  useTopCentre,
  useTopCentreRevision,
} from '../overlay/top-centre.tsx'
import { type CompassChip, compass } from '../presence/compass.ts'
import { arrowPaths } from '../presence/drag-arrows.ts'
import { type AvoidRect, type CoverNode, EDGE_CHIP_RADIUS, floatingCovers } from './edge-markers.ts'
import { editingOutline, hoverOutline, type OutlineBox } from './outlines.ts'
import type { LobbyBoardSession } from './session.ts'

// ---- the feature guard (H1, wave M M1-2) ----------------------------------------------------------------------

/**
 * A FeatureBoundary (../../features/FeatureHostCore.tsx) that gives a crashed contribution another try when the
 * board or the selection changes. Only the guard re-renders on a selection change (its children are the same
 * element), so what it wraps renders exactly as often as before.
 */
export function FeatureGuard({
  ctx,
  id,
  children,
}: {
  ctx: CanvasFeatureContext
  id: string
  children: ReactNode
}) {
  const key = useValue('lobby-feature-guard', () => `${ctx.board.id}|${ctx.canvas.selection.join(' ')}`, [
    ctx,
  ])
  return (
    <FeatureBoundary featureId={id} resetKey={key}>
      {children}
    </FeatureBoundary>
  )
}

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
      render: (close: () => void) => (
        <FeatureGuard ctx={ctx} id={`panel:${p.id}`}>
          <p.component ctx={ctx} close={close} />
        </FeatureGuard>
      ),
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
        // P-011: the next note's size (the note tool's Size; 200 px until one is picked)
        const size = canvas.styles.next().noteSize ?? 200
        const centre = { x: v.x + v.width / 2, y: v.y + v.height / 2 }
        // W5-01: inside the unlocked frame at the view's centre, in the same step
        const frame = frameAt(canvas, centre, { unlockedOnly: true })
        const id = canvas.transact('add note', (tx) => {
          const n = tx.create('note', { x: centre.x - size / 2, y: centre.y - size / 2, size })
          if (frame) tx.setFrame([n], frame.id)
          return n
        })
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
  const guarded = (i: (typeof items)[number]) => (
    <FeatureGuard key={i.id} ctx={ctx} id={`topBar:${i.id}`}>
      <i.component ctx={ctx} />
    </FeatureGuard>
  )
  if (mode === 'all') return items.map(guarded)
  if (mode === 'pinned') return items.filter((i) => i.pinned).map(guarded)
  return items
    .filter((i) => !i.pinned)
    .map((i) => (
      <TopBarOverflowRow key={i.id} featureId={i.id} caption={i.overflowCaption}>
        {guarded(i)}
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
      <FeatureGuard ctx={ctx} id={`overlay:${spec.id}`}>
        <spec.component ctx={ctx} />
      </FeatureGuard>
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
  const rootRef = useRef<HTMLDivElement>(null)
  // M2-1: the one top-centre stack (../overlay/top-centre.tsx): its node goes to the layers that put boxes in it
  const [stack, setStack] = useState<HTMLElement | null>(null)
  useTopCentre(stack, r)
  const c0 = port ? [...r.overlays.list()].sort((a, b) => a.order - b.order) : []
  return (
    <TopCentreContext.Provider value={stack}>
      <div
        ref={rootRef}
        data-testid="lobby-overlay"
        data-focus-mode={focusMode || undefined}
        // clip, not hidden: a hidden box can still be scrolled, and focusing or clicking something past its edge
        // (a phone's toolbar, a panel) scrolled every layer sideways (found at the wave-3 integration)
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'clip', zIndex: 5 }}
      >
        <div data-lobby-layer="scene" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <CanvasOutlines canvas={ctx.canvas} focusMode={focusMode} />
          <TypingBadges canvas={ctx.canvas} />
          {shown
            .filter((o) => o.layer === 'scene')
            .map((o) => (
              <FeatureLayer key={o.id} spec={o} ctx={ctx} />
            ))}
          {port && !focusMode
            ? c0.map((l) => (
                <FeatureGuard key={l.id} ctx={ctx} id={`c0overlay:${l.id}`}>
                  <l.component port={port} />
                </FeatureGuard>
              ))
            : null}
          <DragArrows canvas={ctx.canvas} session={session} />
          <RemoteSelections canvas={ctx.canvas} registries={r} session={session} focusMode={focusMode} />
          <Cursors canvas={ctx.canvas} registries={r} boardId={ctx.board.id} />
        </div>
        <div data-lobby-layer="screen" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          {shown
            .filter((o) => o.layer === 'screen')
            .map((o) => (
              <FeatureLayer key={o.id} spec={o} ctx={ctx} />
            ))}
          <TopCentreStack attach={setStack} />
          <EdgeMarkers canvas={ctx.canvas} registries={r} focusMode={focusMode} overlay={rootRef} />
        </div>
      </div>
    </TopCentreContext.Provider>
  )
}

/**
 * W5-38 and W5-55 (./outlines.ts): the element under the pointer, and the one this tab is typing into, outlined in
 * Lobby's accent (board.css). Under every other layer; never takes a click. Kept in focus mode for the editing
 * outline only (a presenter may still type).
 */
function CanvasOutlines({ canvas, focusMode }: { canvas: LobbyCanvas; focusMode: boolean }) {
  const hover = useValue('lobby-hover-outline', () => (focusMode ? null : hoverOutline(canvas)), [
    canvas,
    focusMode,
  ])
  const editing = useValue('lobby-editing-outline', () => editingOutline(canvas), [canvas])
  if (!hover && !editing) return null
  return (
    <div className="lobby-outlines" aria-hidden="true">
      {hover && hover.id !== editing?.id ? <Outline box={hover} kind="hover" /> : null}
      {editing ? <Outline box={editing} kind="editing" /> : null}
    </div>
  )
}

function Outline({ box, kind }: { box: OutlineBox; kind: 'hover' | 'editing' }) {
  return (
    <div
      className={`lobby-outline lobby-outline--${kind}`}
      data-testid={`${kind}-outline`}
      data-id={box.id}
      style={{
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        transform: box.angle ? `rotate(${box.angle}rad)` : undefined,
      }}
    />
  )
}

/**
 * D1 (W5-08): the bound arrows another person's drag re-routes, drawn where they go now (copies made with
 * Excalidraw's own binding code and drawn with its shape generator, ../presence/drag-arrows.ts), while the
 * engine draws the real ones invisible. Nothing here is ever written.
 */
function DragArrows({ canvas, session }: { canvas: LobbyCanvas; session: LobbyBoardSession }) {
  const hub = session.presenceHub
  const subscribe = useCallback((l: () => void) => hub?.subscribe(l) ?? (() => {}), [hub])
  useSyncExternalStore(subscribe, () => hub?.revision ?? 0)
  const view = useValue('lobby-drag-arrows-view', () => canvas.viewport.get(), [canvas])
  const theme = useValue('lobby-drag-arrows-theme', () => canvas.theme(), [canvas])
  const copies = hub?.arrowPreviews() ?? []
  if (!copies.length) return null
  return (
    <svg
      data-testid="drag-arrow-previews"
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}
    >
      {copies.map((el) => {
        const at = canvas.sceneToOverlay({ x: el.x as number, y: el.y as number })
        const paths = arrowPaths(el, theme)
        return (
          <g
            key={el.id}
            data-arrow-id={el.id}
            opacity={((el as { opacity?: number }).opacity ?? 100) / 100}
            transform={`translate(${at.x} ${at.y}) scale(${view.zoom})`}
          >
            {paths.map((p, i) => (
              <path
                key={i}
                d={p.d}
                stroke={p.stroke}
                strokeWidth={p.strokeWidth}
                fill={p.fill}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          </g>
        )
      })}
    </svg>
  )
}

/** W5-28: at most this many people's selections are drawn (the room streams at most 40 cursors anyway). */
export const MAX_SELECTION_PEERS = 40
/** A person's selection of more elements than this is one outline around all of them. */
export const MAX_OUTLINES_PER_PEER = 24
/** The ids of one person's selection that are read at all (presence carries up to 200). */
const MAX_SELECTION_IDS = 200
/** Screen px between an element's bounds and its outline. */
const OUTLINE_PAD = 4

interface SelectionBox {
  readonly key: string
  readonly sid: string
  readonly uid: string
  readonly name: string
  readonly color: string
  readonly ids: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** the first outline of a person's selection carries their name */
  readonly label: boolean
}

/**
 * W5-28: what other people have selected, an outline per element in the person's colour (one outline
 * around everything for a selection of more than MAX_OUTLINES_PER_PEER), their name on the first, so two
 * people do not grab the same note. From the streamed presence (`presence.peers()[].selection`, ids up to
 * 200), at most MAX_SELECTION_PEERS people. Hidden with their cursor (`cursorVisible`: present mode,
 * "hide cursors") and in focus mode; nothing while a dot vote is open (the room sends `sel: null`). An
 * element someone drags is outlined where their drag preview shows it. Drawn only, never written.
 */
function RemoteSelections({
  canvas,
  registries,
  session,
  focusMode,
}: {
  canvas: LobbyCanvas
  registries: FeatureRegistries
  session: LobbyBoardSession
  focusMode: boolean
}) {
  const version = useRegistries(registries)
  const hub = session.presenceHub
  const subscribe = useCallback((l: () => void) => hub?.subscribe(l) ?? (() => {}), [hub])
  // a remote drag moves the outlines with its preview
  const dragRevision = useSyncExternalStore(subscribe, () => hub?.revision ?? 0)
  const boxes = useValue('lobby-remote-selections', (): SelectionBox[] => {
    if (focusMode) return []
    const zoom = canvas.viewport.get().zoom
    const out: SelectionBox[] = []
    let people = 0
    for (const p of canvas.presence.peers()) {
      if (!p.selection?.length || !registries.cursorVisible.call(p.sid)) continue
      const rects: { x: number; y: number; width: number; height: number; id: string }[] = []
      for (const id of p.selection.slice(0, MAX_SELECTION_IDS)) {
        const el = canvas.get(id)
        if (!el || el.isDeleted || canvas.isHidden(id)) continue
        const b = canvas.bounds(id)
        if (!b) continue
        const off = hub?.dragOffsetOf(id)
        rects.push(off ? { ...b, x: b.x + off.x, y: b.y + off.y, id } : { ...b, id })
      }
      if (!rects.length) continue
      if (++people > MAX_SELECTION_PEERS) break
      const color = safeColor(p.color, p.uid)
      const draw =
        rects.length > MAX_OUTLINES_PER_PEER
          ? [
              {
                ...(union(rects) as NonNullable<ReturnType<typeof union>>),
                id: rects.map((r) => r.id).join(' '),
              },
            ]
          : rects
      draw.forEach((r, i) => {
        const at = canvas.sceneToOverlay({ x: r.x, y: r.y })
        out.push({
          key: `${p.sid}:${i}`,
          sid: p.sid,
          uid: p.uid,
          name: p.name,
          color,
          ids: r.id,
          x: Math.round(at.x - OUTLINE_PAD),
          y: Math.round(at.y - OUTLINE_PAD),
          w: Math.round(r.width * zoom + 2 * OUTLINE_PAD),
          h: Math.round(r.height * zoom + 2 * OUTLINE_PAD),
          label: i === 0,
        })
      })
    }
    return out
  }, [canvas, registries, version, hub, focusMode, dragRevision])
  if (!boxes.length) return null
  return (
    <div className="lobby-remote-selections" data-testid="remote-selections" aria-hidden="true">
      {boxes.map((b) => (
        <div
          key={b.key}
          className="lobby-remote-selection"
          data-testid="remote-selection"
          data-sid={b.sid}
          data-uid={b.uid}
          data-ids={b.ids}
          style={{ left: b.x, top: b.y, width: b.w, height: b.h, borderColor: b.color }}
        >
          {b.label ? (
            <span className="lobby-remote-selection__name" style={{ background: b.color }}>
              {b.name}
            </span>
          ) : null}
        </div>
      ))}
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

/**
 * Remote cursors with name tags (§2.7), filtered by `cursorVisible` (present mode, "hide cursors"). Wave J:
 * an account outside Dark Burn / TPG gets " · External" after its name (the board's outside list,
 * features/people/outside.ts); name-only guests keep their " (guest)".
 * Wave M (M2-1): the cursors are under the board's chrome (they have no z-index of their own: the top-centre stack,
 * the feature layers and the compass chips are above them), and a cursor whose name tag meets a registered bar or
 * stack (lib/overlay-obstacles.ts: the top-centre stack, the selection bar) is hidden while it is there, so it never
 * sits on a button of the bar (it covered the spotlight bar's Hide).
 */
function Cursors({
  canvas,
  registries,
  boardId,
}: {
  canvas: LobbyCanvas
  registries: FeatureRegistries
  boardId: string
}) {
  const { store: outside, snap: outsideSnap } = useBoardOutside(boardId)
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
  // someone the outside list does not know yet may have just joined: it refetches (rate-limited)
  useEffect(() => outside?.noticeUsers(cursors.map((p) => p.uid)), [outside, cursors])
  return (
    <>
      {cursors.map((p) => (
        <CursorChip
          key={p.sid}
          sid={p.sid}
          uid={p.uid}
          name={p.name}
          color={safeColor(p.color, p.uid)}
          x={p.at.x}
          y={p.at.y}
          external={outsideSnap.people.has(p.uid) || undefined}
          suffix={cursorExternalSuffix(outsideSnap, p.uid, p.guest)}
        />
      ))}
    </>
  )
}

/** The kinds of registered chrome a cursor's name tag must not sit on (the panels and toolbars are above the overlay already). */
const CURSOR_AVOIDS = new Set(['bar', 'stack'])

/** The client box of a cursor: its arrow and its name tag together. */
function cursorBox(el: HTMLElement): { x: number; y: number; width: number; height: number } {
  const parts = [el, el.querySelector('.lobby-cursor__name')].filter((n): n is Element => !!n)
  let x1 = Number.POSITIVE_INFINITY
  let y1 = Number.POSITIVE_INFINITY
  let x2 = Number.NEGATIVE_INFINITY
  let y2 = Number.NEGATIVE_INFINITY
  for (const n of parts) {
    const b = n.getBoundingClientRect()
    if (b.width <= 0 && b.height <= 0) continue
    x1 = Math.min(x1, b.left)
    y1 = Math.min(y1, b.top)
    x2 = Math.max(x2, b.right)
    y2 = Math.max(y2, b.bottom)
  }
  return Number.isFinite(x1)
    ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
    : { x: 0, y: 0, width: 0, height: 0 }
}

function CursorChip({
  sid,
  uid,
  name,
  color,
  x,
  y,
  external,
  suffix,
}: {
  sid: string
  uid: string
  name: string
  color: string
  x: number
  y: number
  external: true | undefined
  suffix: string | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [obscured, setObscured] = useState(false)
  // the stack and the bars come and go and move: look again when they do (and after every render of this cursor)
  const stackRevision = useTopCentreRevision()
  useLayoutEffect(() => {
    void stackRevision
    const el = ref.current
    if (!el) return
    const box = cursorBox(el)
    const hit =
      box.width > 0 && obstacleRects().some((o) => CURSOR_AVOIDS.has(o.kind) && rectsIntersect(box, o.rect))
    setObscured((was) => (was === hit ? was : hit))
  })
  return (
    <div
      ref={ref}
      className="lobby-cursor"
      data-testid="cursor"
      data-sid={sid}
      data-uid={uid}
      data-name={name}
      data-external={external}
      data-obscured={obscured || undefined}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: 'translate(-2px, -2px)',
        ...(obscured ? { visibility: 'hidden' as const } : {}),
      }}
    >
      <svg width="14" height="18" viewBox="0 0 14 18" aria-hidden="true">
        <path d="M1 1 L1 15 L5 11 L8 17 L10 16 L7 10 L13 10 Z" fill={color} stroke="#fff" strokeWidth="1" />
      </svg>
      <span className="lobby-cursor__name" style={{ background: color }}>
        {name}
        {suffix && (
          <span className="lobby-cursor__ext" data-testid="cursor-external">
            {suffix}
          </span>
        )}
      </span>
    </div>
  )
}

/** What a marker says about the person it points at (and, L6-2, how many more it stands for). */
interface EdgeMarkerView extends CompassChip {
  readonly uid: string
  readonly name: string
  readonly color: string
  readonly idle: boolean
  /** the other people merged into this chip ("+N") */
  readonly more: number
}

/**
 * What the board's own controls cover in the canvas's top left corner, in overlay px: the board menu (board.css
 * `.lobby-slot--mainMenu`: 12 px in, 38 px wide; on a phone it sits right of the dock's fold button). A chip is
 * never placed under it.
 */
function cornerControls(): AvoidRect[] {
  return [{ x: 0, y: 0, w: mediaMatches('(max-width: 600px)') ? 100 : 56, h: 56 }]
}

/**
 * The host slots that sit over the canvas's edge and cover chips (chrome.tsx SLOT_STYLE, board.css), measured: the
 * style panel (top right, 216 px wide, as high as its tools: open once asked for, P-021, and opaque, above the
 * overlay) and the navigation panel (bottom left; above the
 * toolbar's row on a narrow screen). The board menu and the toolbar are a fixed place (`cornerControls`,
 * `EDGE_MARGINS`).
 */
const EDGE_SLOTS = ['stylePanel', 'navigation'] as const satisfies readonly HostSlotName[]

/**
 * The layer slots: full-size or zero-height strips (SLOT_STYLE) with a box floating somewhere inside, so the
 * slot's own rectangle says nothing. The selection bar (the floating toolbar under the selection, which moves
 * with it and with the camera) and the phone sheet (its "Board actions" button above the toolbar's row, and
 * the open sheet, up to 60% of the screen). What floats inside them is measured (`floatingCovers`): a chip
 * is above them in z-order (board.css, 100) and used to sit on their buttons.
 */
const EDGE_LAYERS = ['selectionBar', 'phoneSheet'] as const satisfies readonly HostSlotName[]

/** How deep inside a layer slot a floating box is looked for (the slot's child, the bar, a popover in it). */
const COVER_DEPTH = 3

/** One element and what is inside it, as `floatingCovers` reads it (client px). */
function coverNode(el: Element, depth: number): CoverNode {
  const cs = getComputedStyle(el)
  const b = el.getBoundingClientRect()
  return {
    x: b.left,
    y: b.top,
    w: b.width,
    h: b.height,
    hidden: cs.display === 'none' || cs.visibility === 'hidden',
    floating: cs.position === 'absolute' || cs.position === 'fixed',
    children: depth > 0 ? [...el.children].map((c) => coverNode(c, depth - 1)) : [],
  }
}

/** What changes where a floating box in a layer slot is, or whether it is there at all. */
const LAYER_MUTATIONS: MutationObserverInit = {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['style', 'class', 'hidden', 'data-compact', 'aria-expanded'],
}

const sameRects = (a: readonly AvoidRect[], b: readonly AvoidRect[]) =>
  a.length === b.length &&
  a.every((r, i) => r.x === b[i]?.x && r.y === b[i]?.y && r.w === b[i]?.w && r.h === b[i]?.h)

/**
 * Where those slots are now, in the overlay's pixels (empty while a slot shows nothing). Measured from the DOM
 * and kept up to date as the slot's content comes and goes and as the canvas is resized, so a chip never sits
 * under a panel that opened after it was placed. `version`: a feature registering a slot re-reads them.
 */
function useCoveredRects(overlay: RefObject<HTMLElement | null>, version: number): AvoidRect[] {
  const [rects, setRects] = useState<AvoidRect[]>([])
  useEffect(() => {
    const el = overlay.current
    const host = el?.parentElement
    if (!el || !host) return
    const watched = new Set<Element>()
    const layers = new Set<Element>()
    let resize: ResizeObserver | null = null
    let mutation: MutationObserver | null = null
    const measure = () => {
      const base = el.getBoundingClientRect()
      const next: AvoidRect[] = []
      for (const name of EDGE_SLOTS) {
        const slot = host.querySelector(`:scope > [data-lobby-slot="${name}"]`)
        if (!slot) continue
        if (!watched.has(slot)) {
          watched.add(slot)
          resize?.observe(slot)
        }
        const b = slot.getBoundingClientRect()
        if (b.width > 0 && b.height > 0)
          next.push({ x: b.left - base.left, y: b.top - base.top, w: b.width, h: b.height })
      }
      // M2-1: the top-centre stack (a chip never sits under the spotlight bar or the coach's chip)
      const stack = el.querySelector('[data-lobby-top-centre]')
      if (stack) {
        const b = stack.getBoundingClientRect()
        if (b.width > 0 && b.height > 0)
          next.push({ x: b.left - base.left, y: b.top - base.top, w: b.width, h: b.height })
      }
      // the floating selection bar and the phone sheet: what is inside the slot, not the slot's own box
      for (const name of EDGE_LAYERS) {
        const slot = host.querySelector(`:scope > [data-lobby-slot="${name}"]`)
        if (!slot) continue
        if (!layers.has(slot)) {
          layers.add(slot)
          mutation?.observe(slot, LAYER_MUTATIONS)
        }
        next.push(
          ...floatingCovers(
            [...slot.children].map((c) => coverNode(c, COVER_DEPTH)),
            {
              x: base.left,
              y: base.top,
            },
          ),
        )
      }
      setRects((prev) => (sameRects(prev, next) ? prev : next))
    }
    if (typeof ResizeObserver !== 'undefined') {
      resize = new ResizeObserver(measure)
      resize.observe(el)
    }
    // a slot's box comes (focus mode off, a feature mounting) and goes with the host's children; a floating
    // box in a layer slot comes, goes and moves with that slot's subtree and styles
    mutation = typeof MutationObserver !== 'undefined' ? new MutationObserver(measure) : null
    mutation?.observe(host, { childList: true })
    measure()
    return () => {
      resize?.disconnect()
      mutation?.disconnect()
    }
  }, [overlay, version])
  return rects
}

/** A media query that matches now (false without media queries: a test, an old browser). */
function mediaMatches(query: string): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia?.(query).matches === true
  } catch {
    return false
  }
}

/**
 * Half a chip's width on the edge, arrow included (board.css `.lobby-edge-marker`): a 44 px touch target
 * (its 22 px radius and the 9 px arrow) for a finger, 24 px for a mouse.
 */
const chipRadius = () => (mediaMatches('(pointer: coarse)') ? 31 : EDGE_CHIP_RADIUS)

const SIDE_WORDS = { left: 'to the left', right: 'to the right', top: 'above', bottom: 'below' } as const

/**
 * W5-32: a coloured chip on the canvas's edge for each person who is off screen (their pointer is outside
 * this view, else their view is), pointing the way. A click goes to them (the camera, one move); Shift-click
 * follows them like the people list's Follow. The nearest ten, spread along the edge so they do not pile up
 * (./edge-markers.ts). Hidden with their cursor (`cursorVisible`: present mode, "hide cursors") and in focus
 * mode; a person the room does not stream to this tab has no place to point at. A chip never sits under the style
 * panel, the navigation panel, the floating selection bar or the phone sheet (its button and the open sheet), or
 * the other controls on the canvas's edge (`useCoveredRects`). Drawn only, never written.
 * Wave L (W6, L6-2, the presence compass, ../presence/compass.ts): people whose chips would land on one another
 * share one chip, the nearest person's with "+N", and at most six chips are drawn; a press held on a chip
 * follows (a touch screen has no Shift-click).
 */
function EdgeMarkers({
  canvas,
  registries,
  focusMode,
  overlay,
}: {
  canvas: LobbyCanvas
  registries: FeatureRegistries
  focusMode: boolean
  /** the overlay root: the slots are its siblings, and what they cover is measured against it */
  overlay: RefObject<HTMLElement | null>
}) {
  const version = useRegistries(registries)
  const stackRevision = useTopCentreRevision()
  const covered = useCoveredRects(overlay, version + stackRevision)
  const markers = useValue('lobby-edge-markers', (): EdgeMarkerView[] => {
    if (focusMode) return []
    const v = canvas.viewport.get()
    const peers = canvas.presence
      .peers()
      .filter((p) => p.streaming !== false && (p.point || p.view) && registries.cursorVisible.call(p.sid))
    if (!peers.length) return []
    const found = compass(
      peers,
      v,
      // the canvas's size on screen, from the camera (which changes with the canvas's size)
      { w: v.width * v.zoom, h: v.height * v.zoom },
      (p) => canvas.sceneToOverlay(p),
      { avoid: [...cornerControls(), ...covered], chipRadius: chipRadius() },
    )
    const bySid = new Map(peers.map((p) => [p.sid, p]))
    return found.flatMap((m) => {
      const p = bySid.get(m.sid)
      return p
        ? [
            {
              ...m,
              uid: p.uid,
              name: p.name,
              color: safeColor(p.color, p.uid),
              idle: p.idle,
              more: m.sids.length - 1,
            },
          ]
        : []
    })
  }, [canvas, registries, version, focusMode, covered])
  const press = useLongPress((sid: string) => canvas.follow.start(sid))
  if (!markers.length) return null
  const go = (m: EdgeMarkerView, follow: boolean) => {
    if (follow) {
      canvas.follow.start(m.sid)
      return
    }
    // a camera that follows someone stays put under a move that does not force it: stop first
    if (canvas.follow.current()) canvas.follow.stop()
    canvas.viewport.centerOn(m.target, { animate: true })
  }
  return (
    <div className="lobby-edge-markers" data-testid="edge-markers">
      {markers.map((m) => (
        <button
          key={m.sid}
          type="button"
          className="lobby-edge-marker"
          data-testid="edge-marker"
          data-sid={m.sid}
          data-uid={m.uid}
          data-side={m.side}
          data-idle={m.idle || undefined}
          data-more={m.more || undefined}
          aria-label={
            m.more
              ? `Go to ${m.name} and ${m.more} more near you, off screen ${SIDE_WORDS[m.side]}`
              : `Go to ${m.name}, off screen ${SIDE_WORDS[m.side]}`
          }
          title={`${m.more ? `${m.name} and ${m.more} more near you are` : `${m.name} is`} off screen ${SIDE_WORDS[m.side]}. Click to go there, Shift-click or press and hold to follow.`}
          style={
            {
              left: Math.round(m.x),
              top: Math.round(m.y),
              '--edge-angle': `${Math.round((m.angle * 180) / Math.PI)}deg`,
              '--edge-color': m.color,
            } as CSSProperties
          }
          {...press.bind(m.sid)}
          onClick={(e) => {
            if (press.takeClick()) return
            go(m, e.shiftKey)
          }}
        >
          <span className="lobby-edge-marker__arrow" aria-hidden="true" />
          <span className="lobby-edge-marker__face" aria-hidden="true">
            {initialsFor(m.name)}
          </span>
          {m.more > 0 ? (
            <span className="lobby-edge-marker__more" data-testid="edge-marker-more" aria-hidden="true">
              +{m.more}
            </span>
          ) : null}
        </button>
      ))}
    </div>
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
            <FeatureGuard ctx={ctx} id={`slot:${name}:${entry.featureId}`}>
              <entry.component ctx={ctx} />
            </FeatureGuard>
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
