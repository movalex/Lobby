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
//  2. The guard (P5 and any path not yet known): an open that did not follow a grant. Seen on
//     onChange (`appState.editingTextElement`) or on a key aimed at the textarea. The textarea is made
//     read-only at once, keys are buffered and lease.acquire goes out. Grant: read-only off, replay at
//     the caret Excalidraw placed. Deny: a synthetic Escape closes the editor with the text unchanged.
//
// A note or text this session just created follows the "New element" row: the editor opens at once
// and the acquire goes out in parallel.

import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { flushSync } from 'react-dom'
import type { LeaseClient, LeaseOutcome } from './client.ts'
import { type BufferedKey, replayKeys } from './replay.ts'

export type EditPhase = 'idle' | 'pending' | 'opening' | 'open'
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
}

const TEXTAREA = 'textarea.excalidraw-wysiwyg'

export class EditorLease {
  private session: Session | null = null
  private token = 0
  private readonly o: EditorLeaseOptions

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

  /** The editor state as the key allowlist sees it. */
  keyState(): 'none' | 'pending' | 'granted' {
    const p = this.phase
    return p === 'idle' ? 'none' : p === 'open' ? 'granted' : 'pending'
  }

  textarea(): HTMLTextAreaElement | null {
    return this.o.wrapper.querySelector<HTMLTextAreaElement>(TEXTAREA)
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

  /** The guard: an editor Excalidraw opened without a grant. */
  guardOpen(editing: { id: string; containerId?: string | null }, via: string): void {
    if (this.session) return
    const leaseId = editing.containerId ?? editing.id
    if (this.o.lease.isHeld(leaseId) || this.o.lease.isCreatedHere(leaseId)) {
      const s = this.start('guard', leaseId, leaseId, `held:${via}`, false)
      s.phase = 'open'
      this.trace('open', { leaseId, via, alreadyHeld: true })
      return
    }
    const ta = this.textarea()
    if (ta) ta.readOnly = true
    const s = this.start('guard', leaseId, leaseId, `guard:${via}`, false)
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
    this.o.lease.release(s.leaseId) // pending -> cancelled; already granted -> released
    const editorShown = s.origin === 'guard' || s.phase === 'opening'
    this.session = null
    if (editorShown) this.closeEditor()
  }

  /** Feed every onChange: detects unrequested opens and closes. */
  onEngineChange(editing: { id: string; containerId?: string | null } | null): void {
    const s = this.session
    if (editing && !s) {
      this.guardOpen(editing, 'onChange')
      return
    }
    if (!editing && s) {
      if (s.phase === 'open') {
        this.trace('closed', { leaseId: s.leaseId })
        this.o.lease.release(s.leaseId)
        this.session = null
      } else if (s.phase === 'pending' && s.origin === 'guard') {
        // The read-only editor closed (blur, click outside) before the answer.
        this.trace('closed-while-pending', { leaseId: s.leaseId })
        this.o.lease.release(s.leaseId)
        this.session = null
      }
    }
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
      const editorShown = s.origin !== 'lobby' || s.phase === 'opening'
      this.session = null
      if (editorShown) this.closeEditor()
      this.o.onDeny?.(s.leaseId, outcome.holder.name)
      return
    }
    this.trace('grant', { leaseId: s.leaseId, origin: s.origin, buffered: s.buffer.length })
    if (s.origin === 'lobby') {
      this.openViaEnter(s)
      return
    }
    if (s.origin === 'guard' && s.phase === 'pending') {
      const ta = this.textarea()
      if (ta) ta.readOnly = false
      this.finishOpen(s, ta)
    }
    // 'new': the editor is already open or opening; nothing else to do.
  }

  /** Selects the target and lets Excalidraw open its editor with a synthetic Enter. */
  private openViaEnter(s: Session): void {
    s.phase = 'opening'
    const { api, wrapper, synthetic } = this.o
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
    this.trace('synthetic-enter', { selectId: s.selectId, textarea: !!this.textarea() })
    const deadline = performance.now() + (this.o.openTimeoutMs ?? 1500)
    const wait = () => {
      if (this.session !== s) return
      const ta = this.textarea()
      if (ta && ta.ownerDocument.activeElement === ta) {
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

  private finishOpen(s: Session, ta: HTMLTextAreaElement | null): void {
    const keys = s.buffer.splice(0)
    let fallbacks = 0
    if (ta) {
      if (s.caretEnd) ta.setSelectionRange(ta.value.length, ta.value.length)
      fallbacks = replayKeys(ta, keys)
    }
    s.phase = 'open'
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
    if (this.textarea()) this.closeEditor()
  }

  /** Closes Excalidraw's editor through its own Escape path (text unchanged when nothing was typed). */
  private closeEditor(): void {
    const ta = this.textarea()
    if (!ta) return
    const esc = new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    this.o.synthetic.add(esc)
    ta.dispatchEvent(esc)
    this.trace('synthetic-escape', {})
  }

  private trace(type: string, data: Record<string, unknown>): void {
    this.o.trace?.({ type, at: performance.now(), ...data })
  }
}
