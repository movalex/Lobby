// OWNER: WS1 (wave W, doc cards; docs/WAVE-W-CONTRACTS.md §2). The lease client of a text editor that is NOT
// Excalidraw's: the doc card's side panel (features/doc-cards/DocEditor.tsx), a plain textarea in the dock. It holds
// the card's text lease through the board's one LeaseClient (./client.ts) exactly as the in-place editor does
// (./editorLease.ts), and is the guard's second entry (canvas/input/dblclick.ts PANEL_TEXT_EDITORS, AGENTS.md: no text
// editor is ever writable unless its element is that of a lease this tab holds):
//
//  - read-only until the server grants the lease (`isWritable`: phase 'open' AND `lease.isHeld(card)` AND an editable
//    role AND the card live and unlocked AND the in-place editor not on it), whatever the panel's own state says;
//  - renewed through presence `editing` (the board session reads `panelEditing(lease)` with its own editor's lease,
//    canvas/board/session.ts), so the people on the board see "Name is editing" on the card and its lease never
//    lapses while the panel is open;
//  - pushes the words, their layout and the card's growth through the holder path `text.replace` uses: a `transact`
//    of the label's `text`/`originalText` (+ its laid-out size) and the card's size, laid out with Excalidraw's own
//    `redrawTextBoundingBox` (as canvas/board/text.ts `layoutReplacement`), at most every TYPING_PUSH_MS (the
//    in-place editor's typing pace); the engine pushes a text write only while this tab holds the lease (engine.ts
//    pushableGroups). The card's growth goes as its `height` (the shape group, re-snapping its bound arrows in the
//    same commit), not as the conditional `fit` op: the engine sends `fit` only while Excalidraw's own editor is open
//    on the label (its editingTextElement), and a resize by someone else meanwhile is kept (only `height` is written,
//    and the next write lays the words out at the card's current width);
//  - one undo step per edit session: the session's first write is a step, every later one joins it
//    (`joinPrevious`), unless something else of this tab became a step meanwhile (then the next write starts a new
//    one, never folding into someone's move);
//  - the lease lost (another session holds it now): read-only at once, the unsaved words are offered, and nothing is
//    written; a card deleted meanwhile: the same;
//  - released on close (after the last write; the engine holds a release back until its words are pushed), except
//    when the in-place editor took the card over (`inPlaceChanged`: its session holds the lease from then on and
//    releases it when it closes).
//
// No request leaves Lobby's origins and nothing of the words is logged.
import { TYPING_PUSH_MS } from '@draftroom/canvas-schema/limits'
import * as ElementLib from '@excalidraw/element'
import type { CanvasElement, LobbyCanvas, LobbyTx } from '../api/lobby-canvas.ts'
import type { LeaseClient, LeaseEvent } from './client.ts'
import type { EditPhase } from './openRule.ts'
import type { LeaseHolder } from './protocol.ts'

// biome-ignore lint/suspicious/noExplicitAny: Excalidraw's element helpers, typed loosely on purpose (as board/text.ts)
const X = ElementLib as any

/**
 * - `closed`: no card
 * - `reading`: a card shown read-only by choice (a viewer, the face's Open on someone else's card)
 * - `pending`: the lease is asked for; read-only
 * - `open`: granted: the one writable state
 * - `denied`: someone else holds the lease (`holder`)
 * - `lost`: the lease went to someone else, or the card went, while open: read-only, `unsaved` offered
 * - `handed-over`: the in-place editor opened on the card: the panel writes nothing more
 */
export type PanelPhase = 'closed' | 'reading' | 'pending' | 'open' | 'denied' | 'lost' | 'handed-over'

export interface PanelEditorState {
  readonly phase: PanelPhase
  readonly cardId: string | null
  /** the words the panel shows (its own while open, the card's otherwise) */
  readonly text: string
  /** who else holds the lease (denied, lost, or reading while someone types) */
  readonly holder: LeaseHolder | null
  /** what was typed and not saved (lost, deleted), for "Copy my text"; null when nothing */
  readonly unsaved: string | null
  /** typed words not written to the board yet (the next TYPING_PUSH_MS tick writes them) */
  readonly pending: boolean
  /** why the panel cannot edit right now, in words, or null */
  readonly reason: string | null
}

/** What the adapter needs of the board session (canvas/board/session.ts provides it). */
export interface PanelLeaseHost {
  readonly lease: Pick<
    LeaseClient,
    'acquire' | 'release' | 'isHeld' | 'on' | 'heldByOther' | 'holderOf' | 'me'
  >
  /** the lease id of the in-place editor's session (EditorLease) while it is not idle, else null */
  inPlaceLease(): string | null
  /** presence `editing` changed (`panelEditing`): re-send it now */
  refreshPresence(): void
  /** typed words outside the scene: the board must not say Saved meanwhile */
  holdSaved(on: boolean): void
}

/** What the adapter does to the board (the real one: `canvasWriter`; tests pass their own). */
export interface PanelBoard {
  /** the card's words (its bound label's `originalText`), or null when the card or its label is not there */
  words(cardId: string): string | null
  /** this tab may edit the card: an editing role, the card live, unlocked */
  editable(cardId: string): boolean
  /** the card is on the board (not deleted) */
  live(cardId: string): boolean
  /** writes `text` into the card's label, laid out, in one transact; `join`: fold into the previous step */
  write(cardId: string, text: string, join: boolean): void
  /** ids of the card and its label (what this adapter's own writes touch) */
  ownIds(cardId: string): readonly string[]
  /** a version stamp of `ids` as the scene has them now (a change of anything else of this tab ends a join) */
  stamp(ids: readonly string[]): string
  /** listens to the board's change stream; returns the unsubscribe */
  onChange(listener: (c: { source: string; ids: readonly string[] }) => void): () => void
}

export interface PanelEditorOptions {
  readonly host: PanelLeaseHost
  readonly board: PanelBoard
  /** the card's words are capped here (contracts DOC_CARD_LIMITS.maxChars) */
  readonly maxChars: number
  readonly pushMs?: number
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (t: unknown) => void
  /** the thing's name in messages ("doc card") */
  readonly thing?: string
}

const CLOSED: PanelEditorState = {
  phase: 'closed',
  cardId: null,
  text: '',
  holder: null,
  unsaved: null,
  pending: false,
  reason: null,
}

export class PanelEditorLease {
  private readonly o: PanelEditorOptions
  private s: PanelEditorState = CLOSED
  private readonly listeners = new Set<(s: PanelEditorState) => void>()
  /** the words written last (or read when the session began): what "unchanged" means */
  private written = ''
  /** words typed and not written yet */
  private pendingText: string | null = null
  private timer: unknown = null
  private lastWriteAt = Number.NEGATIVE_INFINITY
  /** the session wrote a step that later writes may join */
  private joinable = false
  /** the scene stamp of the card and label right after this adapter's own last write */
  private ownStamp = ''
  private writing = false
  private releasing = false
  /** the acquire this session waits for (a stale answer of an earlier one is not ours) */
  private ask = 0
  private readonly offs: (() => void)[] = []
  private readonly thing: string

  constructor(o: PanelEditorOptions) {
    this.o = o
    this.thing = o.thing ?? 'doc card'
    this.offs.push(o.host.lease.on((e) => this.onLease(e)))
    this.offs.push(o.board.onChange((c) => this.onBoardChange(c)))
  }

  dispose(): void {
    this.close()
    for (const f of this.offs.splice(0)) f()
    this.listeners.clear()
  }

  // ---- reading -----------------------------------------------------------------------------------------------

  state(): PanelEditorState {
    return this.s
  }

  subscribe(listener: (s: PanelEditorState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * May text land in the panel now? The ONE writable state is `open` with the lease held by this tab, an editing
   * role, the card live and unlocked, and the in-place editor not on it. Asked before every write and by the
   * textarea's guard (DocEditor's beforeinput, paste and drop handlers, and its readOnly attribute).
   */
  isWritable(): boolean {
    const id = this.s.cardId
    if (!id || this.s.phase !== 'open') return false
    if (!this.o.host.lease.isHeld(id)) return false
    if (this.o.host.inPlaceLease() === id) return false
    return this.o.board.editable(id) && this.o.board.words(id) !== null
  }

  /**
   * The lease id presence must name while this panel asks for or holds a card's lease (it renews it), else null.
   * A panel that can no longer edit the card (it was locked, the role dropped to viewer: `board.editable` false)
   * names nothing, so the lease stops being renewed, and it turns read-only and gives the lease back (on the next
   * microtask: presence is reading this right now).
   */
  editingLease(): string | null {
    const { phase, cardId } = this.s
    if (!cardId || (phase !== 'pending' && phase !== 'open')) return null
    if (this.o.board.live(cardId) && !this.o.board.editable(cardId)) {
      queueMicrotask(() => this.demoteIfReadOnly())
      return null
    }
    return cardId
  }

  /**
   * The card cannot be edited by this tab any more while the panel asks for or holds its lease: the panel turns
   * read-only (`reading`, what was typed and not written offered as `unsaved`), writes nothing, and gives the lease
   * back (unless the in-place editor holds it). A deleted card is `lose`'s case, not this.
   */
  private demoteIfReadOnly(): void {
    const { cardId: id, phase } = this.s
    if (!id || (phase !== 'pending' && phase !== 'open')) return
    if (!this.o.board.live(id) || this.o.board.editable(id)) return
    this.clearTimer()
    const typed = this.pendingText
    this.pendingText = null
    this.ask++
    const release = this.o.host.inPlaceLease() !== id && (phase === 'open' || this.o.host.lease.isHeld(id))
    this.set({
      phase: 'reading',
      pending: false,
      unsaved: typed,
      text: this.o.board.words(id) ?? this.s.text,
      reason: this.cannotEdit(id),
    })
    this.o.host.holdSaved(false)
    this.o.host.refreshPresence()
    if (release) {
      this.releasing = true
      try {
        this.o.host.lease.release(id)
      } finally {
        this.releasing = false
      }
    }
  }

  /**
   * The board is about to undo or redo (the board session calls this through `panelBeforeHistory` before its
   * undo controller steps): typing not written yet is written now, as the undo controller treats any change not
   * recorded yet (its `step` runs a boundary first: "anything not recorded yet is its own step first"). It joins the
   * session's step (or starts one), so the undo that follows takes it out with the rest, and a redo puts it back,
   * instead of the pending push writing the whole textarea over the undo ~500 ms later.
   */
  beforeHistory(): void {
    if (this.s.phase === 'open' && this.pendingText !== null) this.flush()
  }

  // ---- opening and closing -------------------------------------------------------------------------------------

  /**
   * Shows `cardId` in the panel; `edit`: ask for its lease (read-only until granted). A card already open stays as
   * it is (asking again only from read-only). Another card is closed first (its words written, its lease released).
   */
  open(cardId: string, opts: { edit: boolean }): void {
    if (this.s.cardId && this.s.cardId !== cardId) this.close()
    if (this.s.cardId === cardId && this.s.phase !== 'closed') {
      if (opts.edit && (this.s.phase === 'reading' || this.s.phase === 'denied')) this.requestEdit()
      return
    }
    const words = this.o.board.words(cardId) ?? ''
    this.written = words
    this.pendingText = null
    this.joinable = false
    this.set({ ...CLOSED, phase: 'reading', cardId, text: words, holder: this.otherHolder(cardId) })
    if (opts.edit) this.requestEdit()
  }

  /** Asks for the lease of the card shown (the panel's Edit, or `open` with `edit`). */
  requestEdit(): void {
    const id = this.s.cardId
    if (!id) return
    if (this.s.phase === 'open' || this.s.phase === 'pending') return
    if (!this.o.board.editable(id) || !this.o.board.live(id)) {
      this.set({ phase: 'reading', reason: this.cannotEdit(id) })
      return
    }
    if (this.o.host.inPlaceLease() === id) {
      this.set({ phase: 'reading', reason: `This ${this.thing} is open for typing on the board.` })
      return
    }
    const ask = ++this.ask
    this.written = this.o.board.words(id) ?? ''
    this.set({ phase: 'pending', text: this.written, holder: null, unsaved: null, reason: null })
    this.o.host.refreshPresence()
    void this.o.host.lease.acquire(id).then((out) => {
      if (ask !== this.ask || this.s.cardId !== id || this.s.phase !== 'pending') {
        // a stale answer: a grant nobody waits for any more is given straight back (never while another of this
        // tab's editors relies on it, nor while this panel asks for or holds the same card again)
        const wanted = this.s.cardId === id && (this.s.phase === 'pending' || this.s.phase === 'open')
        if (out.granted && !wanted && this.o.host.inPlaceLease() !== id) this.o.host.lease.release(id)
        return
      }
      if (!out.granted) {
        const holder = 'holder' in out ? out.holder : null
        this.set({
          phase: holder ? 'denied' : 'reading',
          holder,
          reason: holder ? `${holder.name} is editing this ${this.thing}.` : null,
        })
        this.o.host.refreshPresence()
        return
      }
      // the card changed while the request was out (someone's last words before they let go): show the stored words
      this.written = this.o.board.words(id) ?? ''
      this.set({ phase: 'open', text: this.written, holder: null, reason: null })
      // locked, or the role dropped, while the request was out: read-only, and the grant goes straight back
      if (this.o.board.live(id) && !this.o.board.editable(id)) {
        this.demoteIfReadOnly()
        return
      }
      this.o.host.refreshPresence()
    })
  }

  /**
   * Closes the panel: the words typed are written first (only while writable), then the lease goes back, unless the
   * in-place editor holds it now or it was lost. Nothing is written in any other state.
   */
  close(): void {
    const { cardId: id, phase } = this.s
    if (!id) return
    if (phase === 'open' && this.isWritable()) this.flush()
    this.clearTimer()
    this.pendingText = null
    this.ask++
    const release = (phase === 'open' || phase === 'pending') && this.o.host.inPlaceLease() !== id
    this.set(CLOSED)
    this.o.host.holdSaved(false)
    this.o.host.refreshPresence()
    if (release) {
      this.releasing = true
      try {
        this.o.host.lease.release(id)
      } finally {
        this.releasing = false
      }
    }
  }

  // ---- typing --------------------------------------------------------------------------------------------------

  /**
   * The textarea's new value. Refused (false: the caller puts the shown words back) unless writable. Kept to
   * `maxChars`. Written at once when the last write is TYPING_PUSH_MS old, else on that tick.
   */
  input(value: string): boolean {
    if (!this.isWritable()) return false
    const text = value.length > this.o.maxChars ? value.slice(0, this.o.maxChars) : value
    this.pendingText = text === this.written ? null : text
    this.set({ text, pending: this.pendingText !== null })
    this.o.host.holdSaved(this.pendingText !== null)
    if (this.pendingText === null) {
      this.clearTimer()
      return true
    }
    this.schedule()
    return true
  }

  /** Writes the typed words now (a close, a hand-over, the page going away). */
  flush(): void {
    this.clearTimer()
    const id = this.s.cardId
    const text = this.pendingText
    if (!id || text === null) return
    if (!this.isWritable()) return
    this.pendingText = null
    this.writing = true
    try {
      this.o.board.write(id, text, this.joinable)
    } finally {
      this.writing = false
    }
    this.written = text
    this.joinable = true
    this.ownStamp = this.o.board.stamp(this.o.board.ownIds(id))
    this.lastWriteAt = this.now()
    this.set({ pending: false })
    this.o.host.holdSaved(false)
  }

  private schedule(): void {
    if (this.timer !== null) return
    const wait = Math.max(0, this.lastWriteAt + (this.o.pushMs ?? TYPING_PUSH_MS) - this.now())
    this.timer = (this.o.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
      this.timer = null
      this.flush()
    }, wait)
  }

  private clearTimer(): void {
    if (this.timer === null) return
    ;(this.o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer)
    this.timer = null
  }

  private now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now()
  }

  // ---- the in-place editor and the lease -----------------------------------------------------------------------

  /**
   * The in-place editor's session changed (EditorLease's state, from the board session). It opening on this card
   * takes the card over: the typed words are written now, and the panel writes nothing more and releases nothing
   * (that session holds the lease and releases it when its editor closes).
   */
  inPlaceChanged(phase: EditPhase, leaseId: string | null): void {
    const id = this.s.cardId
    if (!id || phase === 'idle' || leaseId !== id) return
    if (this.s.phase !== 'open' && this.s.phase !== 'pending') return
    if (this.s.phase === 'open') {
      // the write must still count as this tab's: the in-place session is on the very lease
      const text = this.pendingText
      this.clearTimer()
      if (text !== null && this.o.host.lease.isHeld(id) && this.o.board.editable(id)) {
        this.pendingText = null
        this.writing = true
        try {
          this.o.board.write(id, text, this.joinable)
        } finally {
          this.writing = false
        }
        this.written = text
      }
    }
    this.ask++
    this.pendingText = null
    this.set({
      phase: 'handed-over',
      pending: false,
      text: this.written,
      reason: `This ${this.thing} is open for typing on the board.`,
    })
    this.o.host.holdSaved(false)
    this.o.host.refreshPresence()
  }

  private onLease(e: LeaseEvent): void {
    const id = this.s.cardId
    if (!id || e.id !== id) return
    if (e.kind === 'lost' || (e.kind === 'release' && !this.releasing && this.s.phase === 'open')) {
      if (this.s.phase !== 'open' && this.s.phase !== 'pending') return
      // another of this tab's editors gave it back (the in-place one closing): the same as lost, minus the holder
      this.lose(e.kind === 'lost' ? e.holder : null)
      return
    }
    if (e.kind === 'holder' && (this.s.phase === 'reading' || this.s.phase === 'denied')) {
      const holder = this.otherHolder(id)
      this.set({
        holder,
        phase: holder ? this.s.phase : 'reading',
        reason: holder ? `${holder.name} is editing this ${this.thing}.` : null,
        text: this.o.board.words(id) ?? this.s.text,
      })
    }
  }

  private lose(holder: LeaseHolder | null): void {
    this.clearTimer()
    const typed = this.pendingText ?? (this.s.text !== this.written ? this.s.text : null)
    this.pendingText = null
    this.ask++
    const id = this.s.cardId as string
    this.set({
      phase: 'lost',
      holder,
      pending: false,
      unsaved: typed,
      reason: holder
        ? `Not saved — ${holder.name} is editing this ${this.thing} now.`
        : this.o.board.live(id)
          ? `This ${this.thing} is not open for editing any more.`
          : `This ${this.thing} was deleted.`,
    })
    this.o.host.holdSaved(false)
    this.o.host.refreshPresence()
  }

  private onBoardChange(c: { source: string; ids: readonly string[] }): void {
    const id = this.s.cardId
    if (!id || this.writing) return
    const own = this.o.board.ownIds(id)
    const touchesOwn = c.ids.some((x) => own.includes(x))
    // anything else of this tab recorded as a step (a move, an undo): the next write starts its own step
    if (c.source !== 'remote') {
      if (!touchesOwn || c.source === 'history') this.joinable = false
      else if (this.o.board.stamp(own) !== this.ownStamp) this.joinable = false
    }
    if (!touchesOwn) return
    if (!this.o.board.live(id) && (this.s.phase === 'open' || this.s.phase === 'pending')) {
      this.lose(null)
      return
    }
    // locked while the panel asks for or holds the lease: read-only, the lease given back (editingLease covers a
    // role change, which is no element change)
    if (
      (this.s.phase === 'open' || this.s.phase === 'pending') &&
      this.o.board.live(id) &&
      !this.o.board.editable(id)
    ) {
      this.demoteIfReadOnly()
      return
    }
    const stored = this.o.board.words(id)
    if (stored === null) return
    if (this.s.phase === 'open') {
      // the board changed the words under the panel (an undo or a redo, a server fix: never this panel's own write,
      // `writing` above): the board wins, as Lobby's undo does. Typing not written yet would otherwise be pushed ~500 ms
      // later as the whole textarea and write over the undo; it is dropped (the board session flushes it before an
      // undo through `panelBeforeHistory`, so an undo takes it out with the session's step and a redo puts it back;
      // this is the guarantee for any other write), and the textarea shows the board's words.
      if (stored !== this.written) {
        this.clearTimer()
        const dropped = this.pendingText !== null
        this.pendingText = null
        this.written = stored
        this.set({ text: stored, pending: false })
        if (dropped) this.o.host.holdSaved(false)
      }
      return
    }
    if (this.s.phase !== 'lost' && this.s.phase !== 'handed-over' && stored !== this.s.text)
      this.set({ text: stored })
  }

  private otherHolder(id: string): LeaseHolder | null {
    return this.o.host.lease.heldByOther(id)
  }

  private cannotEdit(id: string): string {
    if (!this.o.board.live(id)) return `This ${this.thing} was deleted.`
    return `You can read this ${this.thing} but not edit it.`
  }

  private set(patch: Partial<PanelEditorState>): void {
    this.s = { ...this.s, ...patch }
    for (const l of [...this.listeners]) l(this.s)
  }
}

// ---- the board this adapter writes to (Excalidraw's layout, the canvas's transact) -------------------------------

/** The live bound label of `card` (a text element whose containerId is the card), or null. */
function labelOf(canvas: Pick<LobbyCanvas, 'get'>, card: CanvasElement): CanvasElement | null {
  const ref = (
    (card as { boundElements?: readonly { id: string; type: string }[] | null }).boundElements ?? []
  ).find((b) => b.type === 'text')
  const label = ref ? canvas.get(ref.id) : undefined
  if (!label || label.isDeleted || label.type !== 'text') return null
  return (label as { containerId?: string | null }).containerId === card.id ? label : null
}

const LABEL_FIELDS = ['text', 'originalText', 'x', 'y', 'width', 'height', 'fontSize', 'autoResize'] as const
const FIT_FIELDS = ['x', 'y', 'width', 'height'] as const

function newLabelId(cardId: string): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return `${cardId.slice(0, 20)}.t${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`
}

/**
 * The writes that put `text` into `cardId`'s label, laid out as Excalidraw's editor lays them out
 * (`redrawTextBoundingBox` on copies: the label re-wraps at the card's width, the card grows to fit), as id → patch;
 * a card without a live label gets a new one (`create`). Falls back to the words alone when the layout refuses the
 * copies (the room still checks and fits them).
 */
export function layoutDocWords(
  canvas: Pick<LobbyCanvas, 'get'>,
  cardId: string,
  text: string,
  style: { fontFamily: number; fontSize: number; strokeColor: string },
): { patches: Map<string, Record<string, unknown>>; create: Record<string, unknown> | null } {
  const card = canvas.get(cardId)
  if (!card || card.isDeleted) return { patches: new Map(), create: null }
  const existing = labelOf(canvas, card)
  // biome-ignore lint/suspicious/noExplicitAny: plain copies of engine elements
  const container: any = structuredClone(card)
  // biome-ignore lint/suspicious/noExplicitAny: see above
  let label: any
  let create: Record<string, unknown> | null = null
  if (existing) label = structuredClone(existing)
  else {
    const id = newLabelId(cardId)
    const fields = {
      id,
      x: card.x + 5,
      y: card.y + 5,
      text,
      originalText: text,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      textAlign: 'left',
      verticalAlign: 'top',
      strokeColor: style.strokeColor,
      containerId: cardId,
      autoResize: true,
      ...(card.frameId ? { frameId: card.frameId } : {}),
    }
    try {
      label = X.newTextElement(fields)
    } catch {
      // no text measurement here (a test in Node): the words as they are; the engine lays them out on create
      label = {
        ...fields,
        type: 'text',
        width: card.width - 10,
        height: style.fontSize * 1.25,
        lineHeight: 1.25,
      }
    }
    container.boundElements = [
      ...((container.boundElements ?? []) as { type: string }[]).filter((b) => b.type !== 'text'),
      { id, type: 'text' },
    ]
  }
  const before = structuredClone(label)
  const containerBefore = structuredClone(card)
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const map = new Map<string, any>([
    [container.id, container],
    [label.id, label],
  ])
  const patches = new Map<string, Record<string, unknown>>()
  try {
    const scene = {
      // biome-ignore lint/suspicious/noExplicitAny: see above
      mutateElement: (el: any, u: any, o?: any) => X.mutateElement(el, map, u, o),
      getNonDeletedElementsMap: () => map,
      getElementsMapIncludingDeleted: () => map,
      getNonDeletedElements: () => [...map.values()].filter((e) => !e.isDeleted),
      getElement: (id: string) => map.get(id) ?? null,
      triggerUpdate: () => {},
    }
    X.mutateElement(label, map, { text, originalText: text })
    X.redrawTextBoundingBox(label, container, scene)
  } catch {
    label.text = text
    label.originalText = text
  }
  if (!existing) {
    create = {}
    for (const [k, v] of Object.entries(label as Record<string, unknown>))
      if (!['version', 'versionNonce', 'updated', 'seed', 'index', 'isDeleted', 'boundElements'].includes(k))
        create[k] = v
    create.text = label.text
    create.originalText = text
  } else {
    const patch: Record<string, unknown> = {}
    for (const f of LABEL_FIELDS) if (label[f] !== before[f]) patch[f] = label[f]
    patch.text = label.text
    patch.originalText = text
    patches.set(label.id, patch)
  }
  const cp: Record<string, unknown> = {}
  for (const f of FIT_FIELDS)
    if (container[f] !== (containerBefore as unknown as Record<string, unknown>)[f]) cp[f] = container[f]
  if (!existing) cp.boundElements = container.boundElements
  if (Object.keys(cp).length) patches.set(cardId, cp)
  return { patches, create }
}

/** The real board: the card's label through the LobbyCanvas (reads, one transact per write, the change stream). */
export function canvasWriter(
  canvas: LobbyCanvas,
  o: {
    readonly style: { fontFamily: number; fontSize: number; strokeColor: string }
    /** the undo step's label */
    readonly label: string
  },
): PanelBoard {
  const live = (id: string) => {
    const el = canvas.get(id)
    return !!el && !el.isDeleted
  }
  return {
    live,
    words(cardId) {
      const card = canvas.get(cardId)
      if (!card || card.isDeleted) return null
      const label = labelOf(canvas, card)
      if (!label) return ''
      return String((label as { originalText?: unknown }).originalText ?? '')
    },
    editable: (cardId) => live(cardId) && !canvas.readOnly() && !canvas.isLocked(cardId),
    ownIds(cardId) {
      const card = canvas.get(cardId)
      const label = card ? labelOf(canvas, card) : null
      return label ? [cardId, label.id] : [cardId]
    },
    stamp: (ids) => ids.map((id) => `${id}:${canvas.get(id)?.version ?? '-'}`).join(','),
    write(cardId, text, join) {
      const { patches, create } = layoutDocWords(canvas, cardId, text, o.style)
      if (!patches.size && !create) return
      canvas.transact(
        o.label,
        (tx: LobbyTx) => {
          if (create) tx.create('text', create)
          for (const [id, patch] of patches) tx.update(id, patch)
        },
        join ? { joinPrevious: true } : undefined,
      )
    },
    onChange: (listener) =>
      canvas.on('change', (c) =>
        listener({ source: c.source, ids: [...c.created, ...c.updated, ...c.deleted] }),
      ),
  }
}

// ---- the board session's seam --------------------------------------------------------------------------------

interface HostEntry {
  readonly host: PanelLeaseHost
  readonly canvas: LobbyCanvas
  editor: PanelEditorLease | null
}

const byCanvas = new WeakMap<object, HostEntry>()
const byLease = new WeakMap<object, HostEntry>()

/**
 * The board session provides its lease client and presence to the panels of `canvas` (canvas/board/session.ts
 * `attach`). Returns the detach, which closes an open panel (its words written, its lease released).
 */
export function attachPanelLeaseHost(canvas: LobbyCanvas, host: PanelLeaseHost): () => void {
  const entry: HostEntry = { host, canvas, editor: null }
  byCanvas.set(canvas, entry)
  byLease.set(host.lease, entry)
  // the page going away (a reload, a closed tab, a phone switching apps): typed words are written before the
  // session persists its queue (capture: before the session's own pagehide listener on window)
  const flush = () => entry.editor?.flush()
  const onHidden = () => {
    if (document.visibilityState === 'hidden') flush()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush, true)
    document.addEventListener('visibilitychange', onHidden, true)
  }
  return () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', flush, true)
      document.removeEventListener('visibilitychange', onHidden, true)
    }
    entry.editor?.dispose()
    entry.editor = null
    if (byCanvas.get(canvas) === entry) byCanvas.delete(canvas)
    if (byLease.get(host.lease) === entry) byLease.delete(host.lease)
  }
}

/**
 * The panel editor of `canvas` (one per board page), made on first use with `make`'s options, or null on a canvas
 * with no board session (a bare port, a test's canvas): no lease, so no panel can ever write.
 */
export function panelEditorOf(
  canvas: LobbyCanvas,
  make: () => Omit<PanelEditorOptions, 'host' | 'board'> & { board: PanelBoard },
): PanelEditorLease | null {
  const entry = byCanvas.get(canvas)
  if (!entry) return null
  if (!entry.editor) {
    const o = make()
    entry.editor = new PanelEditorLease({ ...o, host: entry.host })
  }
  return entry.editor
}

/** The lease id a panel of this board session asks for or holds (presence `editing` renews it), else null. */
export function panelEditing(lease: object): string | null {
  return byLease.get(lease)?.editor?.editingLease() ?? null
}

/**
 * The board session is about to undo or redo (`runUndo`, before its undo controller steps): a panel's typing not
 * written yet is written first, so the undo takes it out instead of being written over (`beforeHistory`).
 */
export function panelBeforeHistory(lease: object): void {
  byLease.get(lease)?.editor?.beforeHistory()
}

/** The board session's in-place editor changed state (EditorLease onState): a panel on that card hands over. */
export function panelInPlaceChanged(lease: object, phase: EditPhase, leaseId: string | null): void {
  byLease.get(lease)?.editor?.inPlaceChanged(phase, leaseId)
}
