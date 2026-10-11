// OWNER: 3f (workshops; wave N, WS3). Emoji reactions on sticky notes (N3-1 to N3-3), the canvas overlay on the
// Excalidraw page (the PlusOnes pattern, ./PlusOnes.tsx): a compact row under each note that has reactions, one
// chip per emoji with its count, in the order of REACTION_CODES (contracts workshops.ts), and the ways to add one.
//
//  - The row is a DOM overlay in overlay pixels (`canvas.sceneToOverlay`). It is drawn only for the notes in view
//    that have reactions (read through `canvas.index.withLobbyKeyPrefix('react:')`, never a walk of the scene), plus
//    the note under the pointer or selected for people who can react, so a 10k-element board pays for the notes
//    that carry reactions and no more. A selected note's row moves above it: the selection bar sits under the
//    selection and would cover it.
//  - Reacting is offered where ./note-reactions.ts `reactionsOffered` says so (the room names REACTIONS_REV and
//    the canvas is not read-only); a viewer, a commenter, or any tab in a room below 13 sees the stored row
//    read-only, with no picker. A hold (REACTIONS_UI, ./note-reactions.ts) hides the whole feature.
//  - Entry points: the row's add button (a picker on hover, on keyboard focus or on a click), the selection bar's
//    React button, the context menu's "React…", and the palette command `reactions.react`. All of them open the one
//    picker (./note-reactions.ts `pickerOf`), a small popover by the thing that opened it; on a phone it is a sheet
//    with 44 px buttons, since a finger has no hover. A pick is ./note-reactions.ts `react`: a skipUndo transact of
//    the person's own key, never an undo step.
//  - Who reacted shows on hover or focus of an emoji (names from the roster by uid; "Someone" for one it does not
//    know; no names while "Hide note authors" is on). Each emoji is a button with `aria-pressed` for your own
//    reaction and an `aria-label` like "3 people reacted 👍, including you".
//  - A reaction that is added (by anyone, on a note in view) bursts once above its emoji (./Reactions.tsx
//    BurstFace); people who prefer reduced motion get one still copy.
// The layer takes no pointer events itself; the row's buttons and the picker do. Hidden while presenting.

import { REACTION_KEY_PREFIX } from '@draftroom/canvas-schema/reactions'
import {
  REACTION_CODE_EMOJI,
  REACTION_CODE_LABELS,
  REACTION_CODES,
  type ReactionCode,
} from '@draftroom/contracts'
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  CanvasFeatureContext,
  CommandSpec,
  LobbyCanvas,
  MenuEntrySpec,
  SelectionBarItemSpec,
} from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { useMediaQuery } from '../../../ui/useMedia.ts'
import { announcerFor } from '../../a11y/ported/announcer.ts'
import { BURST_MS } from '../reactions.ts'
import { elementLabel } from './elements.ts'
import {
  canClearReactions,
  clear,
  closeReactionPicker,
  isReactionTarget,
  nameResolver,
  openReactionPicker,
  type PickerAnchor,
  type PickerState,
  pickerOf,
  REACTIONS_COMMAND_ID,
  REACTIONS_NOT_YET_TEXT,
  REACTIONS_SELECTION_ITEM_ID,
  react,
  reactionArgs,
  reactionChipsOf,
  reactionKeysOf,
  reactionLabel,
  reactionsOffered,
  reactionsOn,
  reactionsRoom,
  reactionsUi,
  reactionTargets,
  reactorNamesHidden,
  whoReacted,
} from './note-reactions.ts'
import { usePresentingHere } from './presenting.ts'
import { BurstFace, REDUCED_MOTION_QUERY } from './Reactions.tsx'
import './workshops-ported.css'

type Ctx = CanvasFeatureContext

/** Notes narrower than this on screen get no row (it would be wider than the note and cover its neighbours). */
export const MIN_NOTE_PX = 72
/** The most rows drawn at once (a zoomed-out view of a board where very many notes carry reactions). */
export const MAX_ROWS = 200
/** A row's height and its gap to the note, overlay px. */
const ROW_H = 24
const GAP = 4
/** The row may run past a narrow note up to this wide (wider than the note: it wraps instead of growing). */
const MIN_ROW_W = 150
/** A phone: the dock's own breakpoint (a11y PhoneSheet, canvas-tools.css). */
export const PHONE_QUERY = '(max-width: 600px)'
/** How long the row of a note the pointer just left stays, so the pointer can cross the gap onto it. */
const LINGER_MS = 400
/** Hover intent: the picker opens this long after the pointer rests on the row, and closes this long after it leaves. */
const OPEN_MS = 150
const CLOSE_MS = 250
/** A newly added reaction bursts for this long (the Facilitate reactions' burst). */
const BURSTS_MAX = 8
/** Added reactions seen in this long after the layer mounts are the board arriving, not people reacting. */
const BASELINE_MS = 1500

// ---- the stored reactions, per note -----------------------------------------------------------------------------

/** A note's row as the layer keeps it: code, count, whether it is mine. */
type ChipData = readonly [code: ReactionCode, count: number, mine: 0 | 1]

interface StoredNote {
  readonly id: string
  readonly chips: readonly ChipData[]
}

interface Placed {
  readonly id: string
  /** top-left of the row, overlay px */
  readonly x: number
  readonly y: number
  /** the note's width on screen */
  readonly w: number
  readonly label: string
  readonly chips: readonly ChipData[]
  /** the note is the (only) selection: its row is above it */
  readonly selected: boolean
}

/** The note the text editor is open in (its label's container), or null. */
function editingNoteOf(canvas: LobbyCanvas): string | null {
  const id = canvas.editingId()
  if (!id) return null
  return canvas.get(id)?.containerId ?? id
}

const stop = (e: { stopPropagation(): void }) => e.stopPropagation()

function AddReactionIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <circle cx="11" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <path
        d="M7.6 14.2c.8 1.1 1.9 1.7 3.4 1.7s2.6-.6 3.4-1.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <circle cx="8.6" cy="10.4" r="1.15" fill="currentColor" />
      <circle cx="13.4" cy="10.4" r="1.15" fill="currentColor" />
      <path
        d="M19 3v5M16.5 5.5h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** The anchor of an element in overlay px (the canvas container's top-left is the origin), for the picker. */
export function anchorOfElement(canvas: LobbyCanvas, el: Element): PickerAnchor {
  const c = canvas.container()?.getBoundingClientRect() ?? { left: 0, top: 0 }
  const r = el.getBoundingClientRect()
  const bar = el.closest('[data-testid="selection-bar"]')?.getBoundingClientRect() ?? r
  return {
    x: r.left + r.width / 2 - c.left,
    top: Math.min(r.top, bar.top) - c.top,
    bottom: Math.max(r.bottom, bar.bottom) - c.top,
  }
}

/** Where a scene point is, as a picker anchor (a context menu's). */
const anchorAtScene = (canvas: LobbyCanvas, p: { x: number; y: number }): PickerAnchor => {
  const o = canvas.sceneToOverlay(p)
  return { x: o.x, top: o.y, bottom: o.y }
}

/** Where a note is, as a picker anchor (under its middle), or null when it is not on screen. */
function anchorAtNote(canvas: LobbyCanvas, id: string): PickerAnchor | null {
  const b = canvas.bounds(id)
  if (!b) return null
  const v = canvas.viewport.screenRect()
  const tl = canvas.sceneToOverlay({ x: b.x, y: b.y })
  const br = canvas.sceneToOverlay({ x: b.x + b.width, y: b.y + b.height })
  if (br.x < 0 || br.y < 0 || tl.x > v.width || tl.y > v.height) return null
  return { x: (tl.x + br.x) / 2, top: tl.y, bottom: br.y }
}

// ---- the layer ----------------------------------------------------------------------------------------------------

/** `workshops-reactions` (scene): the rows, the picker and a live region. */
export function NoteReactionsLayer({ ctx }: { ctx: Ctx }) {
  if (!reactionsUi()) return null
  return <Layer ctx={ctx} />
}

interface Burst {
  readonly key: number
  readonly id: string
  readonly code: ReactionCode
  readonly at: number
  readonly spread: number
}
let burstKeys = 0

function Layer({ ctx }: { ctx: Ctx }) {
  const { canvas } = ctx
  const me = ctx.me.user.id
  const presenting = usePresentingHere(canvas)
  const offered = useValue('dr-wk-react-offered', () => reactionsOffered(canvas), [canvas])
  const hideNames = useValue('dr-wk-react-anon', () => reactorNamesHidden(canvas), [canvas])
  const owner = useValue('dr-wk-react-owner', () => canClearReactions(ctx), [ctx])
  const reduced = useMediaQuery(REDUCED_MOTION_QUERY)
  const phone = useMediaQuery(PHONE_QUERY)
  const picker = useValue(pickerOf(canvas))

  // Every note with reactions, once per document change (the camera does not move this).
  const stored = useValue('dr-wk-react-stored', () => {
    const out: StoredNote[] = []
    for (const el of canvas.index.withLobbyKeyPrefix(REACTION_KEY_PREFIX)) {
      if (!isReactionTarget(el)) continue
      const chips = reactionChipsOf(el, me)
      if (chips.length)
        out.push({ id: el.id, chips: chips.map((c) => [c.code, c.count, c.mine ? 1 : 0] as const) })
    }
    return JSON.stringify(out)
  }, [canvas, me])
  const storedNotes = useMemo(() => JSON.parse(stored) as StoredNote[], [stored])

  // The notes that get a row without reactions: the one selected and the one under the pointer (people who react).
  const hoveredId = useValue('dr-wk-react-hovered', () => {
    if (!offered || canvas.tool() !== 'select') return ''
    const id = canvas.hovered()
    return id && isReactionTarget(canvas.get(id)) ? id : ''
  }, [canvas, offered])
  const selectedId = useValue('dr-wk-react-selected', () => {
    const sel = canvas.selection
    if (sel.length !== 1) return ''
    const id = sel[0] as string
    return isReactionTarget(canvas.get(id)) ? id : ''
  }, [canvas])

  // The pointer crosses a gap between the note and its row: the row of the note it just left stays a moment.
  const [linger, setLinger] = useState('')
  const lingerTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdLinger = useCallback((id: string) => {
    if (lingerTimer.current) clearTimeout(lingerTimer.current)
    lingerTimer.current = null
    setLinger(id)
  }, [])
  const releaseLinger = useCallback(() => {
    if (lingerTimer.current) clearTimeout(lingerTimer.current)
    lingerTimer.current = setTimeout(() => setLinger(''), LINGER_MS)
  }, [])
  useEffect(() => {
    if (hoveredId) holdLinger(hoveredId)
    else if (linger) releaseLinger()
  }, [hoveredId, linger, holdLinger, releaseLinger])
  useEffect(
    () => () => {
      if (lingerTimer.current) clearTimeout(lingerTimer.current)
    },
    [],
  )

  const pickerIds = picker ? picker.ids.join(' ') : ''
  const placedJson = useValue('dr-wk-react-placed', () => {
    if (presenting) return '[]'
    const view = canvas.viewport.screenRect()
    const editing = editingNoteOf(canvas)
    const byId = new Map(storedNotes.map((n) => [n.id, n.chips]))
    const ids = new Set(storedNotes.map((n) => n.id))
    if (offered) {
      if (hoveredId) ids.add(hoveredId)
      if (linger) ids.add(linger)
      if (selectedId) ids.add(selectedId)
    } else if (selectedId && byId.has(selectedId)) ids.add(selectedId)
    for (const id of pickerIds ? pickerIds.split(' ') : []) ids.add(id)
    const out: Placed[] = []
    for (const id of ids) {
      if (out.length >= MAX_ROWS) break
      const el = canvas.get(id)
      if (!isReactionTarget(el) || id === editing || canvas.isHidden(id)) continue
      const chips = byId.get(id) ?? []
      if (chips.length === 0 && !offered) continue
      const b = canvas.bounds(id)
      if (!b) continue
      const tl = canvas.sceneToOverlay({ x: b.x, y: b.y })
      const br = canvas.sceneToOverlay({ x: b.x + b.width, y: b.y + b.height })
      const w = br.x - tl.x
      if (w < MIN_NOTE_PX) continue
      const selected = id === selectedId
      const y = selected ? tl.y - GAP : br.y + GAP
      if (tl.x > view.width || br.x < 0 || y - (selected ? ROW_H : 0) > view.height || y + ROW_H < 0) continue
      out.push({
        id,
        x: Math.round(tl.x),
        y: Math.round(y),
        w: Math.round(w),
        label: elementLabel(el, (i) => canvas.get(i)).slice(0, 60),
        chips,
        selected,
      })
    }
    return JSON.stringify(out)
  }, [canvas, storedNotes, offered, hoveredId, linger, selectedId, pickerIds, presenting])
  const rows = useMemo(() => JSON.parse(placedJson) as Placed[], [placedJson])

  // ---- bursts: a reaction added (by anyone) to a note in view
  const [bursts, setBursts] = useState<Burst[]>([])
  const before = useRef<Map<string, number> | null>(null)
  const mountedAt = useRef(Date.now())
  useEffect(() => {
    const now = new Map<string, number>()
    for (const n of storedNotes) for (const [code, count] of n.chips) now.set(`${n.id}|${code}`, count)
    const prev = before.current
    before.current = now
    if (!prev || Date.now() - mountedAt.current < BASELINE_MS) return
    const added: Burst[] = []
    for (const [k, count] of now) {
      if (count <= (prev.get(k) ?? 0)) continue
      const [id, code] = k.split('|') as [string, ReactionCode]
      added.push({ key: ++burstKeys, id, code, at: Date.now(), spread: Math.random() })
    }
    if (added.length)
      setBursts((list) => [...list.filter((b) => Date.now() - b.at < BURST_MS), ...added].slice(-BURSTS_MAX))
  }, [storedNotes])
  useEffect(() => {
    const first = bursts[0]
    if (!first) return
    const t = setTimeout(
      () => setBursts((list) => list.filter((b) => Date.now() - b.at < BURST_MS)),
      Math.max(0, first.at + BURST_MS - Date.now()) + 20,
    )
    return () => clearTimeout(t)
  }, [bursts])

  // ---- the picker: hover intent, focus, a click, and the other ways in (they set the shared state)
  const intent = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearIntent = () => {
    if (intent.current) clearTimeout(intent.current)
    intent.current = null
  }
  useEffect(() => clearIntent, [])
  const closePicker = useCallback(() => {
    clearIntent()
    closeReactionPicker(canvas)
  }, [canvas])
  const openFor = useCallback(
    (id: string, anchorEl: Element, via: 'hover' | 'focus' | 'click') => {
      openReactionPicker(canvas, [id], { anchor: anchorOfElement(canvas, anchorEl), via })
    },
    [canvas],
  )
  const hoverOpen = useCallback(
    (id: string, anchorEl: Element) => {
      clearIntent()
      if (pickerOf(canvas).get()?.via === 'click') return
      intent.current = setTimeout(() => openFor(id, anchorEl, 'hover'), OPEN_MS)
    },
    [canvas, openFor],
  )
  const hoverLeave = useCallback(() => {
    clearIntent()
    if (pickerOf(canvas).get()?.via !== 'hover') return
    intent.current = setTimeout(() => closeReactionPicker(canvas), CLOSE_MS)
  }, [canvas])
  const hoverStay = useCallback(() => clearIntent(), [])

  // the picker goes when the thing it was for is gone: the camera moved, the notes left, reacting is off
  const pickerShownAt = useRef<{ seq: number; view: string } | null>(null)
  const view = useValue('dr-wk-react-view', () => {
    const v = canvas.viewport.get()
    return `${Math.round(v.x)},${Math.round(v.y)},${v.zoom.toFixed(3)}`
  }, [canvas])
  useEffect(() => {
    if (!picker) {
      pickerShownAt.current = null
      return
    }
    // a picker that replaces another (hover, then a click) starts from the camera as it is now
    const at = pickerShownAt.current
    if (!at || at.seq !== picker.seq) pickerShownAt.current = { seq: picker.seq, view }
    else if (at.view !== view) closePicker()
  }, [picker, view, closePicker])
  const alive = useValue(
    'dr-wk-nr-picker-alive',
    () => (picker ? reactionTargets(canvas, picker.ids).length : 0),
    [canvas, picker],
  )
  useEffect(() => {
    if (picker && (!offered || alive === 0)) closePicker()
  }, [picker, offered, alive, closePicker])

  // what was done is said through the board's own announcer (its polite region), never a live region of this layer
  const told = useCallback((text: string) => announcerFor(canvas).sayPolitely(text), [canvas])
  const onToggle = useCallback(
    (ids: readonly string[], code: ReactionCode, viaKeyboard: boolean) => {
      const mineAll = ids.every((id) => canvas.get(id)?.customData?.lobby?.[`react:${code}:${me}`] === true)
      const r = react(ctx, ids, code)
      if (r.ok && r.changed) {
        const emoji = REACTION_CODE_EMOJI[code]
        told(`${mineAll ? 'Removed your' : 'Added your'} ${emoji} ${REACTION_CODE_LABELS[code]} reaction.`)
      }
      // a pointer click hands the keyboard back to the board (typing edits the note again)
      if (!viaKeyboard) canvas.focus({ preventScroll: true })
    },
    [canvas, ctx, me, told],
  )

  // a click outside the picker closes one that was opened on purpose
  useEffect(() => {
    if (picker?.via !== 'click') return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (t?.closest('[data-reaction-surface]')) return
      // the selection bar's React button toggles it itself
      if (t?.closest('[data-testid="selection-reactions"]')) return
      closePicker()
    }
    const doc = canvas.container()?.ownerDocument ?? document
    doc.addEventListener('pointerdown', onDown, true)
    return () => doc.removeEventListener('pointerdown', onDown, true)
  }, [picker, canvas, closePicker])

  if (rows.length === 0 && !picker) return null
  return (
    <div className="dr-wk-nr-layer" data-testid="note-reactions-layer">
      {rows.map((r) => (
        <ReactionRow
          key={r.id}
          ctx={ctx}
          row={r}
          offered={offered}
          hideNames={hideNames}
          pickerOpen={!!picker && picker.ids.length === 1 && picker.ids[0] === r.id}
          bursts={bursts.filter((b) => b.id === r.id)}
          reduced={reduced}
          onToggle={onToggle}
          onHoverOpen={hoverOpen}
          onHoverLeave={hoverLeave}
          onFocusOpen={(id, el) => openFor(id, el, 'focus')}
          onClickOpen={(id, el) => {
            clearIntent()
            if (pickerOf(canvas).get()?.via === 'click' && pickerOf(canvas).get()?.ids[0] === id)
              closePicker()
            else openFor(id, el, 'click')
          }}
          onBlurRow={() => {
            if (pickerOf(canvas).get()?.via === 'focus') closePicker()
          }}
          onEnterRow={holdLinger}
          onLeaveRow={releaseLinger}
        />
      ))}
      {picker && (
        <ReactionPicker
          key={picker.seq}
          ctx={ctx}
          state={picker}
          phone={phone}
          owner={owner}
          onPick={(code, viaKeyboard) => {
            const ids = picker.ids
            closePicker()
            onToggle(ids, code, viaKeyboard)
          }}
          onClear={() => {
            const ids = picker.ids
            closePicker()
            const r = clear(ctx, ids)
            if (r.ok && r.changed) told('Cleared the reactions.')
            canvas.focus({ preventScroll: true })
          }}
          onClose={(restore) => {
            closePicker()
            if (restore) canvas.focus({ preventScroll: true })
          }}
          onEnter={hoverStay}
          onLeave={hoverLeave}
        />
      )}
    </div>
  )
}

// ---- a note's row -------------------------------------------------------------------------------------------------

interface RowProps {
  ctx: Ctx
  row: Placed
  offered: boolean
  hideNames: boolean
  pickerOpen: boolean
  bursts: readonly Burst[]
  reduced: boolean
  onToggle(ids: readonly string[], code: ReactionCode, viaKeyboard: boolean): void
  onHoverOpen(id: string, anchorEl: Element): void
  onHoverLeave(): void
  onFocusOpen(id: string, anchorEl: Element): void
  onClickOpen(id: string, anchorEl: Element): void
  onBlurRow(): void
  onEnterRow(id: string): void
  onLeaveRow(): void
}

const ReactionRow = memo(function ReactionRow(p: RowProps) {
  const { ctx, row, offered } = p
  const { canvas } = ctx
  const me = ctx.me.user.id
  const tipId = useId()
  const [hot, setHot] = useState<ReactionCode | null>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const label = row.label || 'this note'
  const fresh = new Map(p.bursts.map((b) => [b.code, b]))

  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of buttons (a fieldset is a form group)
    <div
      className="dr-wk-nr"
      role="group"
      aria-label={`Reactions on ${label}`}
      data-testid="note-reactions"
      data-note-id={row.id}
      data-shape-id={`shape:${row.id}`}
      data-readonly={offered ? undefined : 'true'}
      data-selected={row.selected ? 'true' : undefined}
      data-reaction-surface=""
      style={{
        transform: `translate(${row.x}px, ${row.y}px)${row.selected ? ' translateY(-100%)' : ''}`,
        maxWidth: Math.max(row.w, MIN_ROW_W),
      }}
      onPointerDown={stop}
      onPointerEnter={(e) => {
        p.onEnterRow(row.id)
        if (offered && e.pointerType === 'mouse' && addRef.current) p.onHoverOpen(row.id, addRef.current)
      }}
      onPointerLeave={() => {
        p.onLeaveRow()
        p.onHoverLeave()
      }}
      onBlur={(e) => {
        const next = e.relatedTarget as Element | null
        if (!next?.closest('[data-reaction-surface]')) {
          setHot(null)
          p.onBlurRow()
        }
      }}
    >
      {row.chips.map(([code, count, mine]) => {
        const chip = { count, emoji: REACTION_CODE_EMOJI[code], mine: mine === 1 }
        const burst = fresh.get(code)
        return (
          <span className="dr-wk-nr__wrap" key={code}>
            <button
              type="button"
              className="dr-wk-nr__chip"
              data-testid="note-reaction"
              data-code={code}
              data-count={count}
              data-mine={chip.mine ? 'true' : 'false'}
              aria-pressed={offered ? chip.mine : undefined}
              aria-disabled={offered ? undefined : 'true'}
              aria-label={reactionLabel(chip)}
              aria-describedby={hot === code ? tipId : undefined}
              onPointerEnter={() => setHot(code)}
              onPointerLeave={() => setHot((h) => (h === code ? null : h))}
              onFocus={() => setHot(code)}
              onBlur={() => setHot((h) => (h === code ? null : h))}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setHot(null)
                  canvas.focus({ preventScroll: true })
                  e.stopPropagation()
                }
              }}
              onClick={(e) => {
                if (offered) p.onToggle([row.id], code, e.detail === 0)
              }}
            >
              <span className="dr-wk-nr__emoji" aria-hidden="true">
                {chip.emoji}
              </span>
              <span className="dr-wk-nr__n" aria-hidden="true">
                {count}
              </span>
            </button>
            {burst && (
              <span
                key={burst.key}
                className="dr-wk-burst dr-wk-nr__burst"
                data-testid="note-reaction-burst"
                aria-hidden="true"
              >
                <BurstFace emoji={chip.emoji} reduced={p.reduced} spread={burst.spread} />
              </span>
            )}
            {hot === code && (
              <Names
                id={tipId}
                ctx={ctx}
                code={code}
                count={count}
                mine={chip.mine}
                noteId={row.id}
                me={me}
                hide={p.hideNames}
              />
            )}
          </span>
        )
      })}
      {offered && (
        <button
          ref={addRef}
          type="button"
          className="dr-wk-nr__add"
          data-testid="note-reaction-add"
          aria-label={`Add a reaction to ${label}`}
          aria-haspopup="true"
          aria-expanded={p.pickerOpen}
          onClick={() => addRef.current && p.onClickOpen(row.id, addRef.current)}
          onFocus={(e) => {
            // the keyboard arriving here opens the picker; the picker handing the keyboard back (a pick, Escape) does not
            if (e.relatedTarget instanceof Element && e.relatedTarget.closest('[data-reaction-surface]'))
              return
            if (e.currentTarget.matches(':focus-visible') && addRef.current)
              p.onFocusOpen(row.id, addRef.current)
          }}
        >
          <AddReactionIcon />
        </button>
      )}
    </div>
  )
})

/** The list of who reacted with one emoji (hover or focus on it). */
function Names(props: {
  id: string
  ctx: Ctx
  code: ReactionCode
  count: number
  mine: boolean
  noteId: string
  me: string
  hide: boolean
}) {
  const { ctx, code } = props
  const { canvas } = ctx
  const text = useValue('dr-wk-react-who', () => {
    const chip = reactionChipsOf(canvas.get(props.noteId), props.me).find((c) => c.code === code)
    if (!chip) return ''
    const nameOf = nameResolver(canvas, ctx.me.user)
    return whoReacted(chip, props.me, nameOf, props.hide)
  }, [canvas, code, props.noteId, props.me, props.hide, ctx.me.user])
  return (
    <span id={props.id} role="tooltip" className="dr-wk-nr__tip" data-testid="note-reaction-names">
      <strong>{REACTION_CODE_LABELS[code]}</strong> {text}
    </span>
  )
}

// ---- the picker -----------------------------------------------------------------------------------------------------

const PICKER_W = 244
const PICKER_H = 44
const PICKER_CLEAR_H = 36
const PICKER_GAP = 6
const EDGE = 8

export function ReactionPicker({
  ctx,
  state,
  phone,
  owner,
  onPick,
  onClear,
  onClose,
  onEnter,
  onLeave,
}: {
  ctx: Ctx
  state: PickerState
  phone: boolean
  owner: boolean
  onPick(code: ReactionCode, viaKeyboard: boolean): void
  onClear(): void
  onClose(restoreFocus: boolean): void
  onEnter(): void
  onLeave(): void
}) {
  const { canvas } = ctx
  const me = ctx.me.user.id
  const ref = useRef<HTMLDivElement>(null)
  const opener = useRef<Element | null>(null)
  const heading = useId()
  const ids = state.ids
  // what each emoji does: pressed when every note of the pick already has my reaction
  const pressed = useValue('dr-wk-react-pressed', () => {
    const out: string[] = []
    for (const code of REACTION_CODES)
      if (ids.every((id) => canvas.get(id)?.customData?.lobby?.[`react:${code}:${me}`] === true))
        out.push(code)
    return out.join(' ')
  }, [canvas, ids, me])
  const anyReactions = useValue(
    'dr-wk-react-any',
    () => ids.some((id) => reactionKeysOf(canvas.get(id)).length > 0),
    [canvas, ids],
  )
  const label = useValue(
    'dr-wk-nr-picker-label',
    () =>
      ids.length === 1
        ? `React to ${elementLabel(canvas.get(ids[0] as string), (i) => canvas.get(i)).slice(0, 60)}`
        : `React to ${ids.length} notes`,
    [canvas, ids],
  )
  const withClear = owner && anyReactions
  const size = canvas.container()?.getBoundingClientRect() ?? { width: 800, height: 600 }
  const h = PICKER_H + (withClear ? PICKER_CLEAR_H : 0)

  // opened on purpose (a click, the selection bar, a menu, the palette): the keyboard goes in, and comes back
  useLayoutEffect(() => {
    if (state.via !== 'click') return
    opener.current = (ref.current?.ownerDocument ?? document).activeElement
    ref.current?.querySelector<HTMLButtonElement>('button[data-code]')?.focus({ preventScroll: true })
  }, [state.via])

  let style: React.CSSProperties
  if (phone) style = {}
  else {
    const a = state.anchor ??
      anchorAtNote(canvas, ids[0] as string) ?? {
        x: size.width / 2,
        top: size.height / 2,
        bottom: size.height / 2,
      }
    const left = Math.min(Math.max(a.x - PICKER_W / 2, EDGE), Math.max(EDGE, size.width - PICKER_W - EDGE))
    const below = a.bottom + PICKER_GAP
    const top = below + h + EDGE <= size.height ? below : Math.max(EDGE, a.top - PICKER_GAP - h)
    style = { left: Math.round(left), top: Math.round(top) }
  }

  /** The keyboard goes back to what opened the picker (the add button, the bar's button), else to the board. */
  const restore = () => {
    const back = opener.current as HTMLElement | null
    const doc = back?.ownerDocument
    if (back?.isConnected && back !== doc?.body && back !== doc?.documentElement)
      back.focus({ preventScroll: true })
    else canvas.focus({ preventScroll: true })
  }

  const keys = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose(false)
      restore()
      return
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button[data-code]') ?? [])]
      const at = list.indexOf(document.activeElement as HTMLButtonElement)
      const next = list[(at + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length]
      next?.focus()
      e.preventDefault()
    }
    e.stopPropagation() // no board shortcuts from inside the picker
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of buttons (a fieldset is a form group)
    <div
      ref={ref}
      className={phone ? 'dr-wk-nr-picker dr-wk-nr-picker--sheet' : 'dr-wk-nr-picker'}
      role="group"
      aria-labelledby={heading}
      data-testid="reaction-picker"
      data-via={state.via}
      data-reaction-surface=""
      style={style}
      onPointerDown={stop}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onKeyDown={keys}
      onBlur={(e) => {
        const next = e.relatedTarget as Element | null
        if (state.via === 'focus' && !next?.closest('[data-reaction-surface]')) onClose(false)
      }}
    >
      <span id={heading} className="dr-sr-only">
        {label}
      </span>
      {phone && (
        <div className="dr-wk-nr-picker__head" aria-hidden="true">
          {label}
        </div>
      )}
      <div className="dr-wk-nr-picker__row">
        {REACTION_CODES.map((code) => {
          const on = pressed.split(' ').includes(code)
          return (
            <button
              key={code}
              type="button"
              className="dr-wk-nr-picker__emoji"
              data-testid="note-reaction-option"
              data-code={code}
              aria-pressed={on}
              aria-label={REACTION_CODE_LABELS[code]}
              title={REACTION_CODE_LABELS[code]}
              onClick={(e) => {
                const keyboard = e.detail === 0
                onPick(code, keyboard)
                // a keyboard pick keeps the keyboard where it was (the pointer's hands it to the board)
                if (keyboard) restore()
              }}
            >
              <span aria-hidden="true">{REACTION_CODE_EMOJI[code]}</span>
            </button>
          )
        })}
      </div>
      {withClear && (
        <button
          type="button"
          className="dr-wk-nr-picker__clear"
          data-testid="note-reactions-clear"
          onClick={onClear}
        >
          Clear reactions
        </button>
      )}
      {phone && (
        <button
          type="button"
          className="dr-wk-nr-picker__close"
          data-testid="reaction-picker-close"
          onClick={() => onClose(true)}
        >
          Close
        </button>
      )}
    </div>
  )
}

// ---- the other ways in (the registries) ---------------------------------------------------------------------------------

/** The selection bar's React button: opens the picker under it for the selected notes. */
export function ReactionsBarButton({ ctx, selection }: { ctx: Ctx; selection: readonly string[] }) {
  const open = useValue('dr-wk-react-bar-open', () => {
    const s = pickerOf(ctx.canvas).get()
    return !!s && s.via === 'click'
  }, [ctx])
  return (
    <button
      type="button"
      className="dr-cux-selbar__btn"
      data-testid="selection-reactions"
      aria-label="React with an emoji"
      aria-haspopup="true"
      aria-expanded={open}
      title="React with an emoji"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        const state = pickerOf(ctx.canvas).get()
        if (state?.via === 'click') return closeReactionPicker(ctx.canvas)
        openReactionPicker(ctx.canvas, selection, {
          anchor: anchorOfElement(ctx.canvas, e.currentTarget),
          via: 'click',
        })
      }}
    >
      <AddReactionIcon />
    </button>
  )
}

/** The notes among a selection (what the ways in act on). */
const notesOf = (ctx: Ctx, ids: readonly string[]) => reactionTargets(ctx.canvas, ids)

export const SELECTION_BAR_ITEM: SelectionBarItemSpec = {
  id: REACTIONS_SELECTION_ITEM_ID,
  order: 65,
  visible: (ctx, selection) => reactionsOn(ctx.canvas) && notesOf(ctx, selection).length > 0,
  component: ReactionsBarButton,
}

/** Why the command cannot run now, in the palette's words (null: it can). */
export function reactionsDisabledReason(ctx: Ctx): string | null {
  if (!reactionsRoom(ctx.canvas.room.contractsRev())) return REACTIONS_NOT_YET_TEXT
  if (ctx.canvas.readOnly()) return 'Only people who can edit this board can react'
  if (notesOf(ctx, ctx.canvas.selection).length === 0) return 'Select a sticky note first'
  return null
}

/** 'reactions.react': opens the picker for the selected notes; with `{code}` it reacts at once. */
export const REACTIONS_COMMAND: CommandSpec = {
  id: REACTIONS_COMMAND_ID,
  label: 'React to a note…',
  keywords: ['emoji', 'reaction', 'like', 'thumbs up', 'heart', 'celebrate', 'applause', 'laugh'],
  group: 'Facilitate',
  available: () => reactionsUi(),
  enabled: (ctx) => reactionsOn(ctx.canvas) && notesOf(ctx, ctx.canvas.selection).length > 0,
  disabledReason: reactionsDisabledReason,
  run: (ctx, _source, args) => {
    const ids = notesOf(ctx, ctx.canvas.selection)
    if (ids.length === 0) return
    const given = reactionArgs(args)
    if (given) {
      react(ctx, ids, given.code, true)
      return
    }
    openReactionPicker(ctx.canvas, ids, { anchor: anchorAtNote(ctx.canvas, ids[0] as string), via: 'click' })
  },
}

export const CONTEXT_MENU: readonly MenuEntrySpec[] = [
  {
    id: 'reactions-react',
    group: 'workshop',
    order: 18,
    label: 'React…',
    visible: (ctx, target) => reactionsOn(ctx.canvas) && notesOf(ctx, target.ids).length > 0,
    run: (ctx, target) => {
      const ids = notesOf(ctx, target.ids)
      openReactionPicker(ctx.canvas, ids, {
        anchor: target.point
          ? anchorAtScene(ctx.canvas, target.point)
          : anchorAtNote(ctx.canvas, ids[0] as string),
        via: 'click',
      })
    },
  },
  {
    id: 'reactions-clear',
    group: 'workshop',
    order: 19,
    label: 'Clear reactions',
    visible: (ctx, target) =>
      reactionsUi() &&
      canClearReactions(ctx) &&
      notesOf(ctx, target.ids).some((id) => reactionKeysOf(ctx.canvas.get(id)).length > 0),
    run: (ctx, target) => {
      clear(ctx, notesOf(ctx, target.ids))
    },
  },
]
