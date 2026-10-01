/**
 * `LobbyCanvas.presence` (docs/EXCALIDRAW-CONTRACTS.md §2.1; plan §2.7): the remote cursors features and
 * the board page's cursor layer read, from the engine core's `presence`, `welcome` and `roster` messages.
 *
 * The spike's `PresenceHub` (canvas/presence/hub.ts) sends this tab's presence and applies drag previews;
 * it keeps the peers' frames private and without their `view`. This store keeps the whole frame per peer
 * (pointer, view, selection, idle, editing) and joins it with the roster for identity, so `follow` (3c)
 * and "bring everyone to me" have the peer's visible rectangle. Identity always comes from the roster
 * (the server's ticket-derived names and colours), never from the frame.
 *
 * - `presence` frames replace a peer's state; `off` removes peers past the recipient's cursor cap;
 * - a `welcome` starts afresh (the server sends every peer again);
 * - a roster `leave` removes the peer.
 *
 * Pure (Node-tested): it takes the core's event stream and roster through a narrow interface.
 */
import type { PeerPresence, RosterEntry, ServerMessage } from '@draftroom/canvas-schema/protocol'
import type { RemoteCursor } from '../api/lobby-canvas.ts'

export interface PeerSource {
  on(listener: (e: { kind: string; message?: ServerMessage }) => void): () => void
  roster(): ReadonlyMap<string, RosterEntry>
  readonly sid: string | null
}

const NEUTRAL = '#6b7280'

export class PeerStore {
  private readonly frames = new Map<string, PeerPresence>()
  private readonly listeners = new Set<() => void>()
  private cache: RemoteCursor[] | null = null
  private readonly off: () => void
  private readonly src: PeerSource

  constructor(src: PeerSource) {
    this.src = src
    this.off = src.on((e) => {
      if (e.kind !== 'message' || !e.message) return
      const m = e.message
      if (m.type === 'presence') {
        for (const p of m.peers) this.frames.set(p.sid, p)
        for (const sid of m.off ?? []) this.frames.delete(sid)
        this.changed()
      } else if (m.type === 'welcome') {
        this.frames.clear()
        this.changed()
      } else if (m.type === 'roster') {
        for (const ev of m.events) if (ev.k === 'leave') this.frames.delete(ev.sid)
        this.changed()
      }
    })
  }

  dispose(): void {
    this.off()
    this.listeners.clear()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Every other session that streams presence to this tab (at most the server's cursor cap). */
  peers(): readonly RemoteCursor[] {
    if (this.cache) return this.cache
    const roster = this.src.roster()
    const me = this.src.sid
    const out: RemoteCursor[] = []
    for (const [sid, p] of this.frames) {
      if (sid === me) continue
      const r = roster.get(sid)
      out.push({
        sid,
        uid: r?.uid ?? sid.split(':')[0] ?? sid,
        name: r?.name ?? 'Someone',
        color: r?.color ?? NEUTRAL,
        guest: r?.guest ?? false,
        point: p.pointer ? { x: p.pointer.x, y: p.pointer.y } : null,
        view: p.view ? { x: p.view.x, y: p.view.y, width: p.view.w, height: p.view.h } : null,
        selection: p.sel === null ? null : Array.isArray(p.sel) ? [...p.sel] : [],
        idle: p.idle,
        editing: p.editing,
      })
    }
    out.sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0))
    this.cache = out
    return out
  }

  peer(sid: string): RemoteCursor | null {
    return this.peers().find((p) => p.sid === sid) ?? null
  }

  /** The roster changed a name or colour: the cursors re-read identity. */
  rosterChanged(): void {
    this.changed()
  }

  private scheduled = false

  /** Listeners hear of a change after the core applied the message (it reports messages before). */
  private changed(): void {
    this.cache = null
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.cache = null
      for (const l of [...this.listeners]) l()
    })
  }
}
