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
//  2. The guard (P5 and any path not yet known). The rule, corrected after the independent verifier
//     opened a writable editor on note B while Lobby's request for note A was pending:
//
//     ANY editor Excalidraw has open that is not the editor of a granted Lobby lease is unrequested,
//     whatever the session's phase. Its textarea is read-only from the task it appeared in (a
//     MutationObserver locks it; beforeinput, paste and drop into it are prevented by CanvasInput), and:
//       - Lobby idle: it is re-queued as its own lease request (the plan's P5 guard): acquire, buffer;
//         grant: read-only off, replay at the caret Excalidraw placed; deny: a synthetic Escape closes it
//         with the text unchanged;
//       - another request or editor in flight (pending, opening or open): it is closed at once with a
//         synthetic Escape, text unchanged. Keys typed afterwards go to the pending request, as before.
//
//     Only one textarea can ever be writable: the one the session owns, in phase 'open'.
//     `decideEngineChange` (./openRule.ts, pure) keeps Lobby's session in agreement with Excalidraw's
//     editingTextElement, and a session's lease is released only after its editor is gone, that is after
//     Excalidraw's handleSubmit wrote the label (index.js:25463-25503, onSubmit 49869).
//
// A note or text this session just created follows the "New element" row: the editor opens at once
// and the acquire goes out in parallel.

import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { flushSync } from 'react-dom'
import type { LeaseClient, LeaseOutcome } from './client.ts'
import { decideEngineChange, type EditPhase } from './openRule.ts'
import { type BufferedKey, replayKeys } from './replay.ts'

export type { EditPhase }
export type EditOrigin = 'lobby' | 'guard' | 'new'

export interface EditTrace {
  type: string
  at: number
  [key: string]: unknown
}

export interface EditorLeaseOptions {
  api: ExcalidrawImperativeAPI
  wrapper: HTMLElement
  lease: LeaseClient
  /** Events Lobby dispatches itself; the allowlist lets them through. */
  synthetic: WeakSet<Event>
  onDeny?: (leaseId: string, holderName: string) => void
  trace?: (t: EditTrace) => void
  /** How long a granted open may take before it is given up (ms). */
  openTimeoutMs?: number
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
}

const TEXTAREA = 'textarea.excalidraw-wysiwyg'

type Editing = { id: string; containerId?: string | null }

export class EditorLease {
  private session: Session | null = null
  private token = 0
  private readonly o: EditorLeaseOptions
  /** Textareas Lobby is closing (a synthetic Escape is queued). */
  private readonly closing = new WeakSet<HTMLTextAreaElement>()
  /** A locked textarea's value when it was locked (input that leaks past every lock is reverted). */
  private readonly lockedValue = new WeakMap<HTMLTextAreaElement, string>()

  constructor(opts: EditorLeaseOptions) {
    this.o = opts
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

  /** The editor state as the key allowlist sees it (for keys NOT aimed at a textarea). */
  keyState(): 'none' | 'pending' | 'granted' {
    const p = this.phase
    return p === 'idle' ? 'none' : p === 'open' ? 'granted' : 'pending'
  }

  /** The editor state for a key aimed at `ta`: 'foreign' unless the session owns that textarea. */
  keyStateFor(ta: HTMLTextAreaElement): 'pending' | 'granted' | 'foreign' {
    const s = this.session
    if (!s || s.textarea !== ta) return 'foreign'
    return s.phase === 'open' ? 'granted' : 'pending'
  }

  /** May text land in `ta`? Only in the session's own textarea, once granted and open. */
  isWritable(ta: EventTarget | null): boolean {
    const s = this.session
    return !!s && s.phase === 'open' && !!ta && s.textarea === ta
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
    return () => mo.disconnect()
  }

  private lock(ta: HTMLTextAreaElement): void {
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
    const selectId = el.type === 'text' && el.containerId ? el.containerId : el.id
    const s = this.start('lobby', selectId, selectId, opts.reason, opts.caretEnd ?? true)
    if (opts.firstKey) s.buffer.push(opts.firstKey)
    if (this.o.lease.isCreatedHere(selectId)) {
      // New element (§2.9.2): the grant is certain; open now, acquire in parallel.
      s.origin = 'new'
      this.acquire(s)
      this.openViaEnter(s)
      return true
    }
    this.acquire(s)
    return true
  }

  /** The guard with Lobby idle: an editor Excalidraw opened without a grant (the P5 rule). */
  private guardOpen(editing: Editing, via: string, ta: HTMLTextAreaElement | null): void {
    if (this.session) return
    const leaseId = editing.containerId ?? editing.id
    if (this.o.lease.isHeld(leaseId) || this.o.lease.isCreatedHere(leaseId)) {
      const s = this.start('guard', leaseId, leaseId, `held:${via}`, false)
      s.textarea = ta
      s.phase = 'open'
      if (ta) ta.readOnly = false
      this.trace('open', { leaseId, via, alreadyHeld: true })
      return
    }
    const s = this.start('guard', leaseId, leaseId, `guard:${via}`, false)
    s.textarea = ta
    if (ta) this.lock(ta)
    this.trace('guard', { leaseId, via, readOnly: ta?.readOnly === true, value: ta?.value ?? null })
    this.acquire(s)
  }

  /** A key typed while the lease is pending (or the editor is still opening). */
  bufferKey(key: BufferedKey): void {
    const s = this.session
    if (!s || s.phase === 'open') return
    s.buffer.push(key)
    this.trace('buffer', { key: key.key, n: s.buffer.length })
  }

  /** Escape while pending: nothing opens (or the guard's read-only editor closes unchanged). */
  cancel(): void {
    const s = this.session
    if (!s || s.phase === 'open') return
    this.trace('cancel', { leaseId: s.leaseId, phase: s.phase })
    this.session = null
    this.o.lease.release(s.leaseId) // pending -> cancelled; already granted -> released
    this.closeTextarea(s.textarea, 'cancel')
  }

  /** Feed every onChange (and every event aimed at a textarea): applies the editor-open rule. */
  onEngineChange(editing: Editing | null, via = 'onChange'): void {
    this.lockAll()
    const s = this.session
    const current = this.currentTextarea()
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

  private endSession(s: Session): void {
    if (this.session !== s) return
    this.session = null
    const what =
      s.phase === 'open' ? 'closed' : s.phase === 'opening' ? 'closed-while-opening' : 'closed-while-pending'
    this.trace(what, { leaseId: s.leaseId })
    this.o.lease.release(s.leaseId) // held -> released (the editor is gone: its text is written); pending -> cancelled
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
    }
    this.session = s
    return s
  }

  private acquire(s: Session): void {
    this.trace('acquire', { leaseId: s.leaseId, reason: s.reason, origin: s.origin })
    void this.o.lease.acquire(s.leaseId).then((outcome) => this.onOutcome(s, outcome))
  }

  private onOutcome(s: Session, outcome: LeaseOutcome): void {
    if (this.session !== s) {
      // Stale (cancelled, closed): a late grant is not ours to keep.
      if (outcome.granted) this.o.lease.release(outcome.id)
      return
    }
    if (!outcome.granted) {
      if ('cancelled' in outcome) return
      this.trace('deny', { leaseId: s.leaseId, holder: outcome.holder.name })
      this.session = null
      this.closeTextarea(s.textarea, 'deny')
      this.o.onDeny?.(s.leaseId, outcome.holder.name)
      return
    }
    this.trace('grant', { leaseId: s.leaseId, origin: s.origin, buffered: s.buffer.length })
    if (s.origin === 'lobby') {
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
    // 'new': the editor is already open or opening; nothing else to do.
  }

  /** Selects the target and lets Excalidraw open its editor with a synthetic Enter. */
  private openViaEnter(s: Session): void {
    s.phase = 'opening'
    const { api, wrapper, synthetic } = this.o
    // Excalidraw keeps ONE submit handler: a second editor would orphan any editor still open. None
    // should be (the rule closes unrequested ones at once); close any left over first, unchanged.
    for (const ta of this.textareas()) this.escape(ta, 'before-open')
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

  private finishOpen(s: Session, ta: HTMLTextAreaElement): void {
    const keys = s.buffer.splice(0)
    // Writable from here on: the session owns it and the lease is granted (or the element is new).
    s.textarea = ta
    s.phase = 'open'
    ta.readOnly = false
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
  }

  private giveUp(s: Session, why: string): void {
    this.trace('open-failed', { leaseId: s.leaseId, why })
    this.session = null
    this.o.lease.release(s.leaseId)
    this.closeTextarea(s.textarea ?? this.currentTextarea(), 'give-up')
  }

  /**
   * Closes one Excalidraw editor through its own Escape path (index.js:25384: handleSubmit; the text is
   * unchanged when nothing was typed). Queued as a microtask: this may run inside Excalidraw's onChange
   * (a React commit), where its submit's flushSync must not run.
   */
  private closeTextarea(ta: HTMLTextAreaElement | null, why: string, after?: () => void): void {
    if (!ta || this.closing.has(ta)) {
      after?.()
      return
    }
    this.closing.add(ta)
    if (!this.isWritable(ta)) this.lock(ta)
    queueMicrotask(() => {
      this.escape(ta, why)
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

  private trace(type: string, data: Record<string, unknown>): void {
    this.o.trace?.({ type, at: performance.now(), ...data })
  }
}
