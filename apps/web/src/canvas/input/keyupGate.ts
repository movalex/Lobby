// The document keyup gate (spike B, the keys verifier's K1; docs/research/excalidraw/spike-b/
// OPEN-FROM-SPIKE-A.md).
//
// Excalidraw listens for keyup on the DOCUMENT (addEventListeners, @excalidraw/excalidraw dist/dev
// index.js:49348, bubble phase, passive), and its handler (App.onKeyUp, :44237-44335) acts whatever the
// target: on an arrow keyup it re-binds every selected bound arrow (mutateElement always bumps the version
// for an object value, so each keyup is a real write the sync engine would push), and a Space keyup clears
// the selection while one of Lobby's custom tools is active. Lobby's wrapper only stopped keyups whose
// keydown it had blocked, so a keyup from any other input on the page, or from the body, reached
// Excalidraw; and a blocked keydown with an empty `code` never had its keyup stopped (the set was keyed by
// code).
//
// The rule now is default-deny: a keyup reaches Excalidraw's document listener only when its keydown was
// DELEGATED to Excalidraw's canvas handling by Lobby's allowlist (not a key typed into the text editor,
// whose textarea has no keyup handler of its own). The gate is a document listener in the same (bubble)
// phase, registered BEFORE Excalidraw's (listeners of one node and phase run in registration order;
// CanvasInput.ts installs it when its module is evaluated, before any <Excalidraw> can mount, and
// Excalidraw's later re-registrations land behind it), and it calls stopImmediatePropagation on every
// other keyup. The event's target and every ancestor below the document (React's root included) have
// already seen it by then, so nothing else on the page loses a keyup.

/** What the gate reads from a keyup (a DOM KeyboardEvent in the browser, a plain object in tests). */
export interface KeyupLike {
  readonly key: string
  readonly code?: string
}

/** One board's side of the gate (CanvasInput): whether this keyup belongs to a key it delegated. */
export interface KeyupGateClient {
  allowsKeyup(e: KeyupLike & Event): boolean
}

/** A key's identity across its keydown and keyup: the physical `code`, or the key when there is no code. */
export function keyIdOf(e: KeyupLike): string {
  return e.code ? e.code : `key:${String(e.key ?? '').toLowerCase()}`
}

/** Pure: whether one keyup may reach Excalidraw, given the keys delegated so far (consumed on pass). */
export function keyupVerdict(
  e: KeyupLike,
  delegated: Set<string>,
  opts: { allowlistOff?: boolean; synthetic?: boolean } = {},
): 'pass' | 'stop' {
  if (opts.allowlistOff || opts.synthetic) return 'pass'
  return delegated.delete(keyIdOf(e)) ? 'pass' : 'stop'
}

const clients = new WeakMap<EventTarget, Set<KeyupGateClient>>()

/** Installs the gate on `doc` once (idempotent). Must run before Excalidraw mounts in that document. */
export function installKeyupGate(doc: EventTarget): void {
  if (clients.has(doc)) return
  const set = new Set<KeyupGateClient>()
  clients.set(doc, set)
  doc.addEventListener(
    'keyup',
    (e) => {
      if (set.size === 0) return // no board in this document
      for (const c of set) if (c.allowsKeyup(e as KeyupLike & Event)) return
      e.stopImmediatePropagation()
    },
    false,
  )
}

/** A board attached to `doc` takes part in the gate until the returned function runs. */
export function registerKeyupClient(doc: EventTarget, client: KeyupGateClient): () => void {
  installKeyupGate(doc)
  const set = clients.get(doc) as Set<KeyupGateClient>
  set.add(client)
  return () => {
    set.delete(client)
  }
}
