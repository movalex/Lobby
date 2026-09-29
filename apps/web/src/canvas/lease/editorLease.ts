// Every way Excalidraw's text editor opens goes through the lease (docs/EXCALIDRAW-MIGRATION.md §2.9.2).
//
// Two ways in:
//  1. Lobby-initiated (P1 Enter, P2 type-to-edit, P3 double-click, P4 double-tap, Lobby's T tool):
//     `requestEdit` sends lease.acquire and buffers keys. On the grant it selects the target and
//     dispatches a synthetic Enter on Excalidraw's container (the allowlist lets events in `synthetic`
//     through). Excalidraw's own Enter branch (dist/dev/index.js:44152-44185) then calls
//     startTextEditing, which opens the editor on the note's label or creates the label (:44636-44690).
//     When the textarea has the focus (Excalidraw focuses it in a setTimeout, bindBlurEvent :25545-25561),
//     Lobby moves the caret to the end (Lobby's Enter semantics, A11Y-12: Excalidraw selects all) and
//     replays the buffered keys.
//  2. The guard (P5 and any path not yet known). ANY editor Excalidraw has open that is not the editor of
//     a granted Lobby lease is unrequested, whatever the session's phase. Its textarea is read-only from
//     the task it appeared in (a MutationObserver locks it; beforeinput, paste and drop into it are
//     prevented by CanvasInput), and:
//       - Lobby idle: it is re-queued as its own lease request (the plan's P5 guard): acquire, buffer;
//         grant: read-only off, replay at the caret Excalidraw placed; deny: it closes with the text
//         unchanged;
//       - another request or editor in flight (pending, opening or open): it is closed at once, text
//         unchanged.
//     Only one textarea can ever be writable: the one the session owns, in phase 'open', lease not lost.
//     `decideEngineChange` (./openRule.ts, pure) keeps Lobby's session in agreement with Excalidraw's
//     editingTextElement, and a session's lease is released only after its editor is gone, that is after
//     Excalidraw's handleSubmit wrote the label (index.js:25463-25503, onSubmit 49869).
//
// Corrected after the second verifier (spike A, fix round 2):
//  - New element (§2.9.2, open item 7): only the FIRST open of an element this session just created opens
//    at once (LeaseClient.takeCreated: one-shot, expires, refused when another session is known to hold
//    the lease), and the acquire still goes out in parallel. A deny closes the editor with the text it
//    opened with and offers what was typed. After that first open the element is like any other; the
//    guard never trusts "created here".
//  - Cancel then re-open within one round trip gets a fresh request (LeaseClient); `onState` drives the
//    visible pending affordance, so 'pending' is never a silent key sink.
//  - Selecting another element while a Lobby request is pending cancels it. The plan's buffer rule
//    (§2.3.3, §2.9.2) has no re-targeting, so the buffered keys are discarded, with a short notice.
//  - A granted Enter on an unlabelled container whose centre is covered by another text: Excalidraw's
//    startTextEditing would edit that text (getTextElementAtPosition, :44579-44582). Lobby creates the
//    container's own (empty, bound) label first, so the Enter opens it; and a granted open whose editor is
//    on another element is given up, never made writable.
//  - The label deleted, unbound or replaced remotely while its editor is open, and a lease lost to another
//    session (§2.9.3): Excalidraw's submit would write the textarea into it (it un-deletes the label and
//    re-binds it, 25482-25526 and 49806-49845). Such an editor is closed WITHOUT the submit (see
//    `closeWithoutSubmit`), and its text is offered (onNotice: the plan's "Copy my text"). A lost lease
//    makes the editor read-only at once; it stays open with the banner until the user leaves it, and then
//    closes without a write. No release is sent for a lease this session no longer holds.

import { getLineHeight } from '@excalidraw/common'
import { newElementWith, newTextElement } from '@excalidraw/element'
import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import type { ExcalidrawElement, ExcalidrawTextContainer } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { flushSync } from 'react-dom'
import type { LeaseClient, LeaseEvent, LeaseOutcome } from './client.ts'
import { bufferText, decideEngineChange, denyNewClose, type EditPhase, refreshOnGrant } from './openRule.ts'
import type { LeaseHolder } from './protocol.ts'
import { type BufferedKey, replayKeys } from './replay.ts'

export type { EditPhase }
export type EditOrigin = 'lobby' | 'guard' | 'new'

export interface EditTrace {
  type: string
  at: number
  [key: string]: unknown
}

/** What Lobby tells the user (host-lab renders these; the product shows a toast or the §2.9.3 banner). */
export interface EditNotice {
  kind:
    | 'deny'
    | 'cancelled-selection'
    | 'target-gone'
    | 'label-gone'
    | 'lost'
    | 'wrong-element'
    | 'new-denied'
    /** a pending editor left by a click away or a blur, with keys typed (spike B, L4) */
    | 'left-pending'
    /** a granted open that never became an editor, with keys typed (spike B, L4) */
    | 'open-failed'
  leaseId: string
  message: string
  /** Text the user typed that was NOT saved (the plan's "Copy my text"); null when there is none. */
  text: string | null
  holder?: string
}

/** The session as the UI shows it: the pending affordance, the lost-lease banner. */
export interface EditState {
  phase: EditPhase
  leaseId: string | null
  origin: EditOrigin | null
  /** Keys typed while pending (they will be replayed on the grant). */
  buffered: number
  /** The lease went to someone else while the editor was open (§2.9.3). */
  lost: LeaseHolder | null
}

export interface EditorLeaseOptions {
  api: ExcalidrawImperativeAPI
  wrapper: HTMLElement
  lease: LeaseClient
  /** Events Lobby dispatches itself; the allowlist lets them through. */
  synthetic: WeakSet<Event>
  onDeny?: (leaseId: string, holderName: string) => void
  onNotice?: (notice: EditNotice) => void
  /** Every change of phase, lease, buffer or loss (the pending affordance, §2.9.5). */
  onState?: (state: EditState) => void
  trace?: (t: EditTrace) => void
  /** How long a granted open may take before it is given up (ms). */
  openTimeoutMs?: number
  /**
   * The sync engine's view: the element is on the server (`EngineCore.confirmed`). Spike A's pages have no
   * server and leave it out. Used on a New-element deny (L3): a label the server holds is never submitted
   * empty (which would delete it); the engine resets it from `confirmed` instead.
   */
  isConfirmed?: (id: string) => boolean
}

interface Session {
  token: number
  phase: Exclude<EditPhase, 'idle'>
  origin: EditOrigin
  leaseId: string
  /** The element selected before the synthetic Enter (the container, or the free text). */
  selectId: string
  buffer: BufferedKey[]
  caretEnd: boolean
  reason: string
  /**
   * The textarea this session owns: the guard's (claimed when it was seen) or the one Lobby's synthetic
   * Enter opened. The only textarea that may be writable, and only in phase 'open'.
   */
  textarea: HTMLTextAreaElement | null
  /** What was selected when a Lobby request started: a NEW selection of another element cancels it. */
  selectedAtStart: ReadonlySet<string>
  /** The lease went to another session while the editor was open (§2.9.3). */
  lost: LeaseHolder | null
}

const TEXTAREA = 'textarea.excalidraw-wysiwyg'
const TEXT_CONTAINERS = new Set(['rectangle', 'stickynote', 'ellipse', 'diamond'])

type Editing = { id: string; containerId?: string | null }
type Selection = Readonly<Record<string, boolean>>

const selectedIds = (sel: Selection | undefined): string[] =>
  sel ? Object.keys(sel).filter((k) => sel[k]) : []

/** (x, y) inside an element's (rotated) box, grown by `slack`. */
function boxContains(el: ExcalidrawElement, x: number, y: number, slack: number): boolean {
  const cx = el.x + el.width / 2
  const cy = el.y + el.height / 2
  const a = -(el.angle ?? 0)
  const dx = x - cx
  const dy = y - cy
  const lx = dx * Math.cos(a) - dy * Math.sin(a) + cx
  const ly = dx * Math.sin(a) + dy * Math.cos(a) + cy
  const minX = Math.min(el.x, el.x + el.width) - slack
  const maxX = Math.max(el.x, el.x + el.width) + slack
  const minY = Math.min(el.y, el.y + el.height) - slack
  const maxY = Math.max(el.y, el.y + el.height) + slack
  return lx >= minX && lx <= maxX && ly >= minY && ly <= maxY
}

export class EditorLease {
  private session: Session | null = null
  private token = 0
  private readonly o: EditorLeaseOptions
  /** Textareas Lobby is closing (a synthetic Escape is queued). */
  private readonly closing = new WeakSet<HTMLTextAreaElement>()
  /** A locked textarea's value when it was locked (input that leaks past every lock is reverted). */
  private readonly lockedValue = new WeakMap<HTMLTextAreaElement, string>()
  /** Each textarea's value when Lobby first saw it (what "nothing typed" means). */
  private readonly openedValue = new WeakMap<HTMLTextAreaElement, string>()
  /** The text element each textarea edits (Excalidraw's editingTextElement when it was first seen). */
  private readonly labelOf = new WeakMap<HTMLTextAreaElement, string>()
  /** Textareas whose close must skip Excalidraw's submit (lost lease). */
  private readonly noSubmit = new WeakSet<HTMLTextAreaElement>()
  private lastState = ''
  private readonly offLease: () => void

  constructor(opts: EditorLeaseOptions) {
    this.o = opts
    this.offLease = opts.lease.on((ev) => this.onLeaseEvent(ev))
  }

  get phase(): EditPhase {
    return this.session?.phase ?? 'idle'
  }

  get leaseId(): string | null {
    return this.session?.leaseId ?? null
  }

  get origin(): EditOrigin | null {
    return this.session?.origin ?? null
  }

  /** The lease was lost while the session's editor is open (read-only, banner). */
  get lost(): LeaseHolder | null {
    return this.session?.lost ?? null
  }

  state(): EditState {
    const s = this.session
    return {
      phase: s?.phase ?? 'idle',
      leaseId: s?.leaseId ?? null,
      origin: s?.origin ?? null,
      buffered: s?.buffer.length ?? 0,
      lost: s?.lost ?? null,
    }
  }

  /** The editor state as the key allowlist sees it (for keys NOT aimed at a textarea). */
  keyState(): 'none' | 'pending' | 'granted' {
    const p = this.phase
    return p === 'idle' ? 'none' : p === 'open' ? 'granted' : 'pending'
  }

  /** The editor state for a key aimed at `ta`: 'foreign' unless the session owns that textarea. */
  keyStateFor(ta: HTMLTextAreaElement): 'pending' | 'granted' | 'foreign' {
    const s = this.session
    if (!s || s.textarea !== ta || s.lost || this.noSubmit.has(ta)) return 'foreign'
    return s.phase === 'open' ? 'granted' : 'pending'
  }

  /** May text land in `ta`? Only in the session's own textarea, once granted and open, lease not lost. */
  isWritable(ta: EventTarget | null): boolean {
    const s = this.session
    return !!s && s.phase === 'open' && !s.lost && !!ta && s.textarea === ta && !this.noSubmit.has(s.textarea)
  }

  /**
   * Must `ta` close without Excalidraw's submit? Its label is gone or replaced, its lease was lost, or
   * (spike B, the lease verifier's L1) it is not the writable editor of a granted lease: a guard-caught or
   * still-opening editor holds the copy Excalidraw made when it opened (index.js:25247), never refreshed,
   * and its submit (deny, Escape, a click away, a blur) would write that old copy over the holder's newer
   * text. Only the granted editor's own text is ever submitted.
   */
  mustNotSubmit(ta: HTMLTextAreaElement): boolean {
    if (!ta.isConnected) return false
    if (this.noSubmit.has(ta)) return true
    if (!this.isWritable(ta)) return true
    const label = this.labelOf.get(ta)
    return !!label && this.labelGone(label) !== null
  }

  /** Every Excalidraw text editor in the wrapper, oldest first. */
  textareas(): HTMLTextAreaElement[] {
    return Array.from(this.o.wrapper.querySelectorAll<HTMLTextAreaElement>(TEXTAREA))
  }

  /** The session's textarea, else Excalidraw's newest one. */
  textarea(): HTMLTextAreaElement | null {
    const own = this.session?.textarea
    if (own?.isConnected) return own
    return this.currentTextarea()
  }

  private currentTextarea(): HTMLTextAreaElement | null {
    const all = this.textareas()
    return all[all.length - 1] ?? null
  }

  /**
   * Locks every textarea the moment Excalidraw appends it (a MutationObserver callback runs in the same
   * task, before any input event can reach it). Returns the detach.
   */
  watch(): () => void {
    const mo = new MutationObserver(() => {
      for (const ta of this.textareas()) this.lock(ta)
    })
    mo.observe(this.o.wrapper, { childList: true, subtree: true })
    return () => {
      mo.disconnect()
      this.offLease()
    }
  }

  private lock(ta: HTMLTextAreaElement): void {
    if (!this.openedValue.has(ta)) this.openedValue.set(ta, ta.value)
    if (this.isWritable(ta)) return
    // The value when it became read-only (a writable textarea being locked keeps what was typed).
    if (!ta.readOnly || !this.lockedValue.has(ta)) this.lockedValue.set(ta, ta.value)
    ta.readOnly = true
  }

  private lockAll(): void {
    for (const ta of this.textareas()) this.lock(ta)
  }

  /** Input reached a textarea that is not writable (no known path does): put its text back. */
  revert(ta: HTMLTextAreaElement): void {
    const v = this.lockedValue.get(ta)
    if (v !== undefined && ta.value !== v) ta.value = v
    this.lock(ta)
  }

  /** P1-P4 and Lobby's T tool: ask for the lease on `targetId`'s lease id, then open. */
  requestEdit(
    targetId: string,
    opts: { reason: string; caretEnd?: boolean; firstKey?: BufferedKey },
  ): boolean {
    if (this.session) return false
    const el = this.o.api.getSceneElementsIncludingDeleted().find((e) => e.id === targetId)
    if (!el || el.isDeleted) return false
    const containerId = el.type === 'text' ? (el as { containerId?: string | null }).containerId : null
    const selectId = containerId ?? el.id
    // New element (§2.9.2): only the FIRST open of an element this session JUST created, and never when
    // another session is known to hold its lease (open item 7). One-shot: taken here.
    const created = this.o.lease.takeCreated(selectId)
    const s = this.start('lobby', selectId, selectId, opts.reason, opts.caretEnd ?? true)
    if (opts.firstKey) s.buffer.push(opts.firstKey)
    if (created) {
      // The grant is certain: open now, acquire in parallel (the acquire is never skipped).
      s.origin = 'new'
      this.acquire(s)
      this.openViaEnter(s)
      return true
    }
    this.acquire(s)
    this.emitState()
    return true
  }

  /** The guard with Lobby idle: an editor Excalidraw opened without a grant (the P5 rule). */
  private guardOpen(editing: Editing, via: string, ta: HTMLTextAreaElement | null): void {
    if (this.session) return
    const leaseId = editing.containerId ?? editing.id
    // "Created here" covers Lobby's own first open only; any open ends it. The guard always asks.
    this.o.lease.forgetCreated(leaseId)
    if (ta) this.labelOf.set(ta, editing.id)
    if (this.o.lease.isHeld(leaseId)) {
      const s = this.start('guard', leaseId, leaseId, `held:${via}`, false)
      s.textarea = ta
      s.phase = 'open'
      if (ta) ta.readOnly = false
      this.trace('open', { leaseId, via, alreadyHeld: true })
      this.emitState()
      return
    }
    const s = this.start('guard', leaseId, leaseId, `guard:${via}`, false)
    s.textarea = ta
    if (ta) this.lock(ta)
    this.trace('guard', { leaseId, via, readOnly: ta?.readOnly === true, value: ta?.value ?? null })
    this.acquire(s)
    this.emitState()
  }

  /** A key typed while the lease is pending (or the editor is still opening). */
  bufferKey(key: BufferedKey): void {
    const s = this.session
    if (!s || s.phase === 'open') return
    s.buffer.push(key)
    this.trace('buffer', { key: key.key, n: s.buffer.length })
    this.emitState()
  }

  /** Escape while pending: nothing opens (or the guard's read-only editor closes unchanged). */
  cancel(): void {
    const s = this.session
    if (!s || s.phase === 'open') return
    this.trace('cancel', { leaseId: s.leaseId, phase: s.phase })
    this.setSession(null)
    this.o.lease.release(s.leaseId) // pending -> cancelled; already granted -> released
    this.closeTextarea(s.textarea, 'cancel')
  }

  /** The user leaves an editor whose lease was lost (Escape, the banner's close): no write. */
  dismissLost(): void {
    const s = this.session
    if (!s?.lost) return
    this.trace('dismiss-lost', { leaseId: s.leaseId })
    this.closeOwnWithoutSubmit(s, 'lost-dismissed')
  }

  /**
   * An editor Lobby must not let Excalidraw submit is being left (its blur, caught in the capture phase
   * before Excalidraw's `editable.onblur = handleSubmit`): close it without a write.
   */
  leaveWithoutSubmit(ta: HTMLTextAreaElement, via: string): void {
    const s = this.session
    if (s && s.textarea === ta) {
      // L4 (spike B): keys typed into a pending editor that is left by a click away or a blur are not
      // saved; say so and offer them, as the selection-change cancel does (Escape is an explicit cancel).
      if (s.phase !== 'open' && !s.lost && via !== 'escape') {
        const typed = this.bufferedText(s)
        if (typed) {
          this.notice({
            kind: 'left-pending',
            leaseId: s.leaseId,
            message: 'The note did not open, so what you typed was not saved.',
            text: typed,
          })
        }
      }
      this.closeOwnWithoutSubmit(s, via)
      return
    }
    this.closeWithoutSubmit(ta, via)
  }

  /** Feed every onChange (and every event aimed at a textarea): applies the editor-open rule. */
  onEngineChange(editing: Editing | null, via = 'onChange', selection?: Selection): void {
    this.lockAll()
    const current = this.currentTextarea()
    if (editing && current && !this.labelOf.has(current)) this.labelOf.set(current, editing.id)
    if (this.checkSession(selection)) return
    const s = this.session
    const d = decideEngineChange({
      editing: editing ? (editing.containerId ?? editing.id) : null,
      editorPresent: current !== null,
      session: s
        ? {
            phase: s.phase,
            hasEditor: s.textarea !== null,
            editorAlive: s.textarea?.isConnected === true,
            ownsCurrent: !!current && s.textarea === current,
            leaseId: s.leaseId,
          }
        : null,
    })
    switch (d.kind) {
      case 'none':
        return
      case 'adopt':
        if (s && current) {
          s.textarea = current
          this.lock(current)
          this.trace('adopt', { leaseId: s.leaseId })
        }
        return
      case 'guard':
        if (editing) this.guardOpen(editing, via, current)
        return
      case 'end-then-guard':
        if (s) this.endSession(s)
        if (editing) this.guardOpen(editing, via, current)
        return
      case 'end':
        if (s) this.endSession(s)
        return
      case 'close-own-then-end':
        if (s) {
          const own = s.textarea
          this.trace('close-orphaned', { leaseId: s.leaseId })
          this.closeTextarea(own, 'orphaned', () => {
            if (this.session === s && !own?.isConnected) this.endSession(s)
          })
        }
        return
      case 'close-current':
        this.trace('unrequested', {
          leaseId: editing ? (editing.containerId ?? editing.id) : null,
          via,
          sessionLease: s?.leaseId ?? null,
          sessionPhase: s?.phase ?? 'idle',
          readOnly: current?.readOnly === true,
        })
        this.closeTextarea(current, 'unrequested')
        return
    }
  }

  /**
   * The session checks that come before the open rule: a remote delete or re-create of the edited label
   * (close without the submit), a NEW selection of another element while a Lobby request is pending
   * (cancel), the target deleted while pending (cancel). True when the session was ended here.
   */
  private checkSession(selection?: Selection): boolean {
    const s = this.session
    if (!s) return false
    const ta = s.textarea
    if (ta?.isConnected && !this.closing.has(ta)) {
      const label = this.labelOf.get(ta)
      const gone = label ? this.labelGone(label) : null
      if (gone) {
        this.trace('label-gone', { leaseId: s.leaseId, label, gone, phase: s.phase })
        const typed = this.typedText(s, ta)
        this.notice({
          kind: 'label-gone',
          leaseId: s.leaseId,
          message:
            gone === 'deleted'
              ? 'This note was deleted while you were typing. Your text was not saved.'
              : 'This note was changed by someone else while you were typing. Your text was not saved.',
          text: typed,
        })
        this.closeOwnWithoutSubmit(s, `label-${gone}`)
        return true
      }
    }
    if (s.phase !== 'pending' || s.origin !== 'lobby') return false
    const target = this.element(s.selectId)
    if (!target || target.isDeleted) {
      this.trace('target-gone', { leaseId: s.leaseId })
      this.cancelWithNotice(s, {
        kind: 'target-gone',
        message: 'This note was deleted before it opened.',
      })
      return true
    }
    const sel = selection ?? this.o.api.getAppState().selectedElementIds
    const other = selectedIds(sel).find((id) => {
      if (id === s.selectId || s.selectedAtStart.has(id)) return false
      const el = this.element(id)
      return !(el?.type === 'text' && (el as { containerId?: string | null }).containerId === s.selectId)
    })
    if (other !== undefined) {
      this.trace('cancel-selection', { leaseId: s.leaseId, selected: other, buffered: s.buffer.length })
      this.cancelWithNotice(s, {
        kind: 'cancelled-selection',
        message:
          s.buffer.length > 0
            ? 'You selected something else, so the note did not open and what you typed was discarded.'
            : 'You selected something else, so the note did not open.',
      })
      return true
    }
    return false
  }

  /** An event aimed at `ta` (key, beforeinput, composition): apply the rule before it acts. */
  checkTextarea(ta: HTMLTextAreaElement, via: string): void {
    this.onEngineChange(this.o.api.getAppState().editingTextElement, via)
    if (this.session?.textarea === ta) return
    this.lock(ta)
    // A textarea Excalidraw no longer edits (orphaned): close it too.
    if (ta !== this.currentTextarea() || !this.o.api.getAppState().editingTextElement) {
      this.closeTextarea(ta, 'orphaned')
    }
  }

  private cancelWithNotice(s: Session, n: { kind: EditNotice['kind']; message: string }): void {
    const text = this.bufferedText(s) ?? ''
    this.setSession(null)
    this.o.lease.release(s.leaseId) // pending -> cancelled (a late grant is released at once)
    this.closeTextarea(s.textarea, n.kind)
    this.notice({ kind: n.kind, leaseId: s.leaseId, message: n.message, text: text || null })
  }

  private endSession(s: Session): void {
    if (this.session !== s) return
    this.setSession(null)
    const what =
      s.phase === 'open' ? 'closed' : s.phase === 'opening' ? 'closed-while-opening' : 'closed-while-pending'
    this.trace(what, { leaseId: s.leaseId, lost: s.lost?.name ?? null })
    // Held -> released (the editor is gone: its text is written). Pending -> cancelled. Lost -> nothing
    // is sent: the client no longer holds it (LeaseClient.release).
    this.o.lease.release(s.leaseId)
  }

  private start(origin: EditOrigin, leaseId: string, selectId: string, reason: string, caretEnd: boolean) {
    const s: Session = {
      token: ++this.token,
      phase: 'pending',
      origin,
      leaseId,
      selectId,
      buffer: [],
      caretEnd,
      reason,
      textarea: null,
      selectedAtStart: new Set(selectedIds(this.o.api.getAppState().selectedElementIds)),
      lost: null,
    }
    this.session = s
    return s
  }

  private setSession(s: Session | null): void {
    this.session = s
    this.emitState()
  }

  private emitState(): void {
    const st = this.state()
    const key = JSON.stringify([st.phase, st.leaseId, st.origin, st.buffered, st.lost?.sid ?? null])
    if (key === this.lastState) return
    this.lastState = key
    this.o.onState?.(st)
  }

  private acquire(s: Session): void {
    this.trace('acquire', { leaseId: s.leaseId, reason: s.reason, origin: s.origin })
    void this.o.lease.acquire(s.leaseId).then((outcome) => this.onOutcome(s, outcome))
  }

  private onOutcome(s: Session, outcome: LeaseOutcome): void {
    if (this.session !== s) {
      // Stale (cancelled, closed): a late grant is not ours to keep, unless a newer session holds it.
      if (outcome.granted && this.session?.leaseId !== outcome.id) this.o.lease.release(outcome.id)
      return
    }
    if (!outcome.granted) {
      if ('cancelled' in outcome) return
      this.trace('deny', { leaseId: s.leaseId, holder: outcome.holder.name, origin: s.origin })
      if (s.origin === 'new') {
        this.denyNew(s, outcome.holder.name)
        return
      }
      this.setSession(null)
      this.closeTextarea(s.textarea, 'deny')
      this.o.onDeny?.(s.leaseId, outcome.holder.name)
      this.notice({
        kind: 'deny',
        leaseId: s.leaseId,
        message: `${outcome.holder.name} is typing in this note`,
        text: null,
        holder: outcome.holder.name,
      })
      return
    }
    this.trace('grant', { leaseId: s.leaseId, origin: s.origin, buffered: s.buffer.length })
    if (s.origin === 'lobby') {
      const target = this.element(s.selectId)
      if (!target || target.isDeleted) {
        this.giveUp(s, 'target-gone', 'This note was deleted before it opened.')
        return
      }
      this.openViaEnter(s)
      return
    }
    if (s.origin === 'guard' && s.phase === 'pending') {
      const ta = s.textarea
      if (!ta?.isConnected) {
        this.endSession(s) // the read-only editor closed before the answer
        return
      }
      this.finishOpen(s, ta)
    }
    // 'new': the editor is already open or opening; the grant confirms it.
    this.emitState()
  }

  /**
   * A just-created element whose lease another session holds after all (the server's answer): the editor
   * opened at once, so close it with the text it opened with (a label this open created is empty and is
   * dropped by Excalidraw's own submit) and offer what was typed.
   */
  private denyNew(s: Session, holder: string): void {
    const ta = s.textarea
    const typed = ta ? this.typedText(s, ta) : null
    this.setSession(null)
    if (ta?.isConnected) {
      this.noSubmit.add(ta)
      this.closing.add(ta)
      ta.readOnly = true
      const opened = this.openedValue.get(ta) ?? ''
      const labelId = this.labelOf.get(ta) ?? this.o.api.getAppState().editingTextElement?.id ?? null
      const label = labelId ? this.element(labelId) : undefined
      // L3 (spike B): someone else's text in the label is never overwritten by the text this editor
      // opened with (an empty one deleted the label while the holder typed in it).
      const how = denyNewClose({
        labelText: label && !label.isDeleted ? (label as { originalText?: string }).originalText : undefined,
        editorValue: ta.value,
        labelConfirmed: !!labelId && (this.o.isConfirmed?.(labelId) ?? false),
      })
      this.trace('new-denied-close', { leaseId: s.leaseId, how })
      queueMicrotask(() => {
        if (how === 'close-without-submit') {
          this.closeWithoutSubmit(ta, 'new-denied')
          return
        }
        ta.value = opened
        this.escape(ta, 'new-denied')
      })
    }
    this.notice({
      kind: 'new-denied',
      leaseId: s.leaseId,
      message: `Not saved — ${holder} is editing this note now`,
      text: typed,
      holder,
    })
    this.o.onDeny?.(s.leaseId, holder)
  }

  /** Selects the target and lets Excalidraw open its editor with a synthetic Enter. */
  private openViaEnter(s: Session): void {
    s.phase = 'opening'
    this.emitState()
    const { api, wrapper, synthetic } = this.o
    // Excalidraw keeps ONE submit handler: a second editor would orphan any editor still open. None
    // should be (the rule closes unrequested ones at once); close any left over first, unchanged.
    for (const ta of this.textareas()) {
      if (this.mustNotSubmit(ta)) this.closeWithoutSubmit(ta, 'before-open')
      else this.escape(ta, 'before-open')
    }
    this.ensureOwnLabel(s)
    const before = new Set(this.textareas())
    // Excalidraw's Enter branch reads this.state synchronously; flush the selection first.
    flushSync(() => {
      api.updateScene({
        appState: { selectedElementIds: { [s.selectId]: true }, selectedGroupIds: {}, editingGroupId: null },
      })
    })
    const container = wrapper.querySelector<HTMLElement>('.excalidraw')
    if (!container) {
      this.giveUp(s, 'no-container')
      return
    }
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    })
    synthetic.add(enter)
    container.dispatchEvent(enter)
    // Excalidraw appends its textarea synchronously (index.js:25633): claim it now, before any onChange.
    const opened = this.textareas().find((t) => !before.has(t)) ?? null
    if (opened) {
      s.textarea = opened
      this.lock(opened)
    }
    this.trace('synthetic-enter', { selectId: s.selectId, textarea: !!opened })
    const deadline = performance.now() + (this.o.openTimeoutMs ?? 1500)
    const wait = () => {
      if (this.session !== s) return
      const ta = s.textarea
      if (ta?.isConnected && ta.ownerDocument.activeElement === ta) {
        // A granted open whose editor is on another element (not the lease's) is never made writable.
        const editing = api.getAppState().editingTextElement
        const label = editing ?? null
        const lease = label ? (label.containerId ?? label.id) : null
        if (lease !== null && lease !== s.leaseId) {
          this.giveUp(s, 'wrong-element', 'The note did not open. Please try again.')
          return
        }
        if (label && !this.labelOf.has(ta)) this.labelOf.set(ta, label.id)
        this.finishOpen(s, ta)
        return
      }
      if (performance.now() > deadline) {
        this.giveUp(s, ta ? 'no-focus' : 'no-editor')
        return
      }
      setTimeout(wait, 8)
    }
    setTimeout(wait, 0)
  }

  /**
   * An unlabelled text container whose centre is covered by another text element (any z-order; the box
   * grown by Excalidraw's hit slack): Excalidraw's Enter would edit that text (startTextEditing takes
   * getTextElementAtPosition(centre), index.js:44579-44582). Lobby binds the container's own empty label
   * first, as startTextEditing would create it (:44643-44683), so getSelectedTextElement(container)
   * finds it (49928-49944). An empty label is dropped by Excalidraw's own submit if nothing is typed.
   */
  private ensureOwnLabel(s: Session): void {
    const api = this.o.api
    const els = api.getSceneElementsIncludingDeleted()
    const c = els.find((e) => e.id === s.selectId)
    if (!c || c.isDeleted || !TEXT_CONTAINERS.has(c.type)) return
    const bound = (c.boundElements ?? []).find((b) => b.type === 'text')
    if (bound && els.some((e) => e.id === bound.id && !e.isDeleted)) return
    const cx = c.x + c.width / 2
    const cy = c.y + c.height / 2
    const slack = 10 / (api.getAppState().zoom.value || 1)
    const cover = els.find((e) => !e.isDeleted && e.type === 'text' && boxContains(e, cx, cy, slack))
    if (!cover) return
    const st = api.getAppState()
    const fontFamily = st.currentItemFontFamily
    const sticky = c.type === 'stickynote'
    const label = newTextElement({
      x: cx,
      y: cy,
      text: '',
      fontSize: st.currentItemFontSize,
      baseFontSize: sticky ? st.currentItemFontSize : null,
      fontFamily,
      lineHeight: getLineHeight(fontFamily),
      textAlign: 'center',
      verticalAlign: 'middle',
      containerId: c.id as ExcalidrawTextContainer['id'],
      strokeColor: sticky ? c.strokeColor : st.currentItemStrokeColor,
      backgroundColor: st.currentItemBackgroundColor,
      fillStyle: st.currentItemFillStyle,
      strokeStyle: st.currentItemStrokeStyle,
      roughness: st.currentItemRoughness,
      opacity: st.currentItemOpacity,
      groupIds: c.groupIds,
      angle: c.angle,
      frameId: c.frameId,
    })
    const next: ExcalidrawElement[] = []
    for (const e of els) {
      if (e.id !== c.id) {
        next.push(e)
        continue
      }
      next.push(
        newElementWith(e, {
          boundElements: [
            ...(e.boundElements ?? []).filter((b) => b.type !== 'text'),
            { type: 'text', id: label.id },
          ],
        }),
        label,
      )
    }
    api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER })
    this.trace('own-label', { leaseId: s.leaseId, label: label.id, covering: cover.id })
  }

  private finishOpen(s: Session, ta: HTMLTextAreaElement): void {
    if (s.lost || (s.origin !== 'new' && !this.o.lease.isHeld(s.leaseId))) {
      // The lease went elsewhere between the grant and the focus: never writable.
      this.giveUp(
        s,
        'lost-before-open',
        `Not saved — ${s.lost?.name ?? 'someone else'} is editing this note now`,
      )
      return
    }
    const keys = s.buffer.splice(0)
    // L2 (spike B): the editor still holds the copy Excalidraw made when it opened; the label may have
    // changed since (the previous holder's last keystrokes). Show the stored text before it is writable.
    // A New element's editor was writable from the start: its text is the user's own.
    let refreshed = false
    if (s.origin !== 'new') {
      const labelId = this.labelOf.get(ta) ?? this.o.api.getAppState().editingTextElement?.id ?? null
      const label = labelId ? this.element(labelId) : undefined
      const fresh = refreshOnGrant(
        ta,
        label && !label.isDeleted ? (label as { originalText?: string }).originalText : undefined,
      )
      if (fresh) {
        ta.value = fresh.value
        ta.setSelectionRange(fresh.selectionStart, fresh.selectionEnd)
        this.openedValue.set(ta, fresh.value)
        this.lockedValue.set(ta, fresh.value)
        this.trace('refresh-on-grant', { leaseId: s.leaseId, label: labelId })
        refreshed = true
      }
    }
    // Writable from here on: the session owns it and the lease is granted (or the element is new).
    s.textarea = ta
    s.phase = 'open'
    ta.readOnly = false
    // The refreshed editor is still sized for the old text (Excalidraw sizes it in updateWysiwygStyle on
    // its own input): one input event with the same text lets Excalidraw lay it out again (it writes the
    // label's unchanged text, under the lease this session now holds).
    if (refreshed) ta.dispatchEvent(new Event('input', { bubbles: true }))
    if (s.caretEnd) ta.setSelectionRange(ta.value.length, ta.value.length)
    const fallbacks = replayKeys(ta, keys)
    this.trace('open', {
      leaseId: s.leaseId,
      origin: s.origin,
      replayed: keys.map((k) => k.key).join('␟'),
      replayedCount: keys.length,
      fallbacks,
      label: this.o.api.getAppState().editingTextElement?.id ?? null,
    })
    this.emitState()
  }

  private giveUp(s: Session, why: string, message?: string): void {
    this.trace('open-failed', { leaseId: s.leaseId, why })
    const text = this.bufferedText(s) ?? ''
    this.setSession(null)
    this.o.lease.release(s.leaseId)
    this.closeTextarea(s.textarea ?? this.currentTextarea(), 'give-up')
    if (message) {
      this.notice({
        kind: why === 'target-gone' ? 'target-gone' : why === 'wrong-element' ? 'wrong-element' : 'lost',
        leaseId: s.leaseId,
        message,
        text: text || null,
      })
    } else if (text) {
      // L4 (spike B): 'no-editor' / 'no-focus' / 'no-container' dropped the typed keys with no word.
      this.notice({
        kind: 'open-failed',
        leaseId: s.leaseId,
        message: 'The note did not open, so what you typed was not saved.',
        text,
      })
    }
  }

  // --- the lease lost while open (§2.9.3) --------------------------------------------------------------

  private onLeaseEvent(ev: LeaseEvent): void {
    const s = this.session
    if (!s || s.leaseId !== ev.id || s.phase === 'pending' || s.lost) return
    // Lost: this session held the lease and the server now names someone else (§2.9.3). And for a New
    // element still waiting for its grant, a broadcast naming another session: the New element rule
    // never overrides a live lease (open item 7), so its editor stops taking text at once too.
    const otherHolder =
      ev.kind === 'holder' && ev.holder && ev.holder.sid !== this.o.lease.me.sid ? ev.holder : null
    const provisional = s.origin === 'new' && !this.o.lease.isHeld(s.leaseId)
    if (ev.kind !== 'lost' && !(otherHolder && provisional)) return
    s.lost = (ev.kind === 'lost' ? ev.holder : otherHolder) ?? { sid: '', uid: '', name: 'Someone else' }
    const ta = s.textarea
    if (ta) {
      this.noSubmit.add(ta)
      this.lock(ta) // read-only at once: nothing typed after the loss lands
    }
    this.trace('lost', { leaseId: s.leaseId, holder: s.lost.name, phase: s.phase })
    this.notice({
      kind: 'lost',
      leaseId: s.leaseId,
      message: `Not saved — ${s.lost.name} is editing this note now`,
      text: ta ? this.typedText(s, ta) : null,
      holder: s.lost.name,
    })
    this.emitState()
  }

  // --- closing -------------------------------------------------------------------------------------------

  /** Why a label can no longer take Excalidraw's submit: deleted (or its container), or unbound. */
  private labelGone(labelId: string): 'deleted' | 'replaced' | null {
    const els = this.o.api.getSceneElementsIncludingDeleted()
    const label = els.find((e) => e.id === labelId)
    if (!label || label.isDeleted) return 'deleted'
    const containerId = (label as { containerId?: string | null }).containerId
    if (!containerId) return null
    const c = els.find((e) => e.id === containerId)
    if (!c || c.isDeleted) return 'deleted'
    return (c.boundElements ?? []).some((b) => b.id === labelId) ? null : 'replaced'
  }

  private element(id: string): ExcalidrawElement | undefined {
    return this.o.api.getSceneElementsIncludingDeleted().find((e) => e.id === id)
  }

  /** The keys buffered while pending, as text (null: none). */
  private bufferedText(s: Session): string | null {
    const text = bufferText(s.buffer)
    return text.length > 0 ? text : null
  }

  /** What the user typed into the session's editor (null: nothing beyond what it opened with). */
  private typedText(s: Session, ta: HTMLTextAreaElement): string | null {
    const buffered = s.buffer
      .map((k) => (k.key.length === 1 ? k.key : k.key === 'Enter' ? '\n' : ''))
      .join('')
    const opened = this.openedValue.get(ta)
    const value = ta.value + buffered
    if (opened !== undefined && value === opened) return null
    return value.length > 0 ? value : null
  }

  /** Ends `s` and closes its editor without Excalidraw's submit (deferred: this may run in a commit). */
  private closeOwnWithoutSubmit(s: Session, why: string): void {
    const ta = s.textarea
    if (ta) {
      this.noSubmit.add(ta)
      this.lock(ta)
    }
    this.setSession(null)
    this.trace('close-without-submit', {
      leaseId: s.leaseId,
      why,
      phase: s.phase,
      lost: s.lost?.name ?? null,
    })
    // Release after the editor is gone. Nothing was written, so there is no final push to wait for; a
    // lost lease sends nothing (not held).
    const after = () => this.o.lease.release(s.leaseId)
    if (!ta) {
      after()
      return
    }
    this.closing.add(ta)
    queueMicrotask(() => {
      this.closeWithoutSubmit(ta, why)
      after()
    })
  }

  /**
   * Closes one Excalidraw editor WITHOUT its submit. Excalidraw has no public close, and its only close
   * (the textarea's handleSubmit, index.js:25482-25526) writes the textarea into the label: it un-deletes a
   * deleted label (isDeleted = !text.trim(), 49872), re-binds an unbound one, or writes a stale text over a
   * newer one. handleSubmit runs its cleanup (listeners, the textarea) and then returns WITHOUT writing
   * when the label is not in the scene (`if (!updateElement) return`, 25487-25493). So for the one
   * synchronous call Lobby takes the label out of the scene, lets the Escape run the cleanup, and puts the
   * label back unchanged (same object, same version), clearing editingTextElement (onSubmit, which would
   * have, did not run). Both scene updates are captureUpdate NEVER: no history entry, and no element
   * version changes. A label that holds no text and is not deleted (one this open created) is instead
   * submitted empty, so Excalidraw drops it as it always does.
   */
  private closeWithoutSubmit(ta: HTMLTextAreaElement, why: string): void {
    if (!ta.isConnected) return
    const api = this.o.api
    const labelId = this.labelOf.get(ta) ?? api.getAppState().editingTextElement?.id ?? null
    const all = api.getSceneElementsIncludingDeleted()
    const i = labelId ? all.findIndex((e) => e.id === labelId) : -1
    const label = i >= 0 ? all[i] : undefined
    const stored = (label as { originalText?: string } | undefined)?.originalText ?? null
    if (label && !label.isDeleted && stored === '' && this.labelGone(label.id) === null) {
      ta.value = ''
      this.escape(ta, `${why}:empty`)
      return
    }
    if (label)
      api.updateScene({ elements: all.filter((_, j) => j !== i), captureUpdate: CaptureUpdateAction.NEVER })
    this.escape(ta, `${why}:no-submit`)
    const now = api.getSceneElementsIncludingDeleted()
    if (label) {
      const prev = i > 0 ? all[i - 1]?.id : undefined
      const at = prev === undefined ? 0 : now.findIndex((e) => e.id === prev) + 1
      const next = [...now.slice(0, at), label, ...now.slice(at)]
      api.updateScene({
        elements: next,
        appState: { editingTextElement: null },
        captureUpdate: CaptureUpdateAction.NEVER,
      })
    } else {
      api.updateScene({ appState: { editingTextElement: null } })
    }
    this.o.wrapper.querySelector<HTMLElement>('.excalidraw')?.focus()
  }

  /**
   * Closes one Excalidraw editor through its own Escape path (index.js:25384: handleSubmit; the text is
   * unchanged when nothing was typed), or without the submit when its label is gone or its lease lost.
   * Queued as a microtask: this may run inside Excalidraw's onChange (a React commit), where its submit's
   * flushSync must not run.
   */
  private closeTextarea(ta: HTMLTextAreaElement | null, why: string, after?: () => void): void {
    if (!ta || this.closing.has(ta)) {
      after?.()
      return
    }
    this.closing.add(ta)
    if (!this.isWritable(ta)) this.lock(ta)
    queueMicrotask(() => {
      if (this.mustNotSubmit(ta)) this.closeWithoutSubmit(ta, why)
      else this.escape(ta, why)
      after?.()
    })
  }

  private escape(ta: HTMLTextAreaElement, why: string): void {
    if (!ta.isConnected) return
    this.closing.add(ta)
    const esc = new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    this.o.synthetic.add(esc)
    ta.dispatchEvent(esc)
    this.trace('synthetic-escape', { why })
  }

  private notice(n: EditNotice): void {
    this.trace('notice', { kind: n.kind, leaseId: n.leaseId, text: n.text })
    this.o.onNotice?.(n)
  }

  private trace(type: string, data: Record<string, unknown>): void {
    this.o.trace?.({ type, at: performance.now(), ...data })
  }
}
