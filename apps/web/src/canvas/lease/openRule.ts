// The editor-open rule (docs/EXCALIDRAW-MIGRATION.md §2.9.2, the guard), pure so it runs in Node tests.
// ./editorLease.ts feeds it on every engine change and on every event aimed at a text editor.
//
// ANY editor Excalidraw has open that is not the editor of a granted Lobby lease is unrequested,
// whatever the phase of Lobby's session: it is read-only at once, then closed unchanged when another
// request or editor is in flight, or re-queued as its own lease request when Lobby is idle. Lobby's
// session always follows Excalidraw's editingTextElement, and a session ends (its lease is released)
// only once its editor is gone, i.e. after Excalidraw's submit wrote the label.

export type EditPhase = 'idle' | 'pending' | 'opening' | 'open'

/** What `decideEngineChange` looks at: Lobby's session and Excalidraw's editor. */
export interface EngineView {
  session: null | {
    phase: Exclude<EditPhase, 'idle'>
    /** The session has claimed a textarea. */
    hasEditor: boolean
    /** ...and that textarea is still in the document (Excalidraw's cleanup removes it on submit). */
    editorAlive: boolean
    /** Excalidraw's newest textarea is the session's. */
    ownsCurrent: boolean
    leaseId: string
  }
  /** The lease id of Excalidraw's editingTextElement (its container for a label), or null. */
  editing: string | null
  /** An Excalidraw textarea is in the document. */
  editorPresent: boolean
}

export type EngineDecision =
  /** Lobby and Excalidraw agree. */
  | { kind: 'none' }
  /** Lobby's own open (its synthetic Enter): the newest textarea is the session's. */
  | { kind: 'adopt' }
  /** Unrequested while another request or editor is in flight: closed at once, text unchanged. */
  | { kind: 'close-current' }
  /** Unrequested while Lobby is idle: read-only, its own lease request (the P5 guard). */
  | { kind: 'guard' }
  /** The session's editor is gone (written by Excalidraw's submit): end it, then guard the new editor. */
  | { kind: 'end-then-guard' }
  /** The session's editor closed: release (after its final write) or cancel. */
  | { kind: 'end' }
  /**
   * Excalidraw no longer edits the session's element but its textarea is still in the document (a second
   * editor orphaned it): submit it through Escape (the label is written), then end.
   */
  | { kind: 'close-own-then-end' }

export function decideEngineChange(v: EngineView): EngineDecision {
  const s = v.session
  if (v.editing === null) {
    if (!s) return { kind: 'none' }
    // 'opening': Lobby's synthetic Enter ran and Excalidraw has not reported its editor yet.
    if (s.editorAlive) return s.phase === 'opening' ? { kind: 'none' } : { kind: 'close-own-then-end' }
    // A Lobby-initiated request still pending has no editor: nothing to follow.
    return s.hasEditor ? { kind: 'end' } : { kind: 'none' }
  }
  // Excalidraw names an element but has no textarea: it is between states. Its submit removes the
  // textarea (handleSubmit -> cleanup, index.js:25487, 25543) before onSubmit clears editingTextElement
  // (49870-49900), and the label write in between can render. Nothing can be typed; its next change
  // decides. (Found by the regression spec: acting here ended A's session and re-guarded A.)
  if (!v.editorPresent) return { kind: 'none' }
  if (!s) return { kind: 'guard' }
  if (s.hasEditor && !s.editorAlive) return { kind: 'end-then-guard' }
  if (s.leaseId === v.editing) {
    if (s.ownsCurrent) return { kind: 'none' }
    if (s.phase === 'opening' && !s.hasEditor) return { kind: 'adopt' }
  }
  // Another element, or this element's lease not granted (a Lobby request still pending): not granted.
  return { kind: 'close-current' }
}
