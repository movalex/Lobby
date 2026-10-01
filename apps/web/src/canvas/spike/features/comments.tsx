// The comment tool for spike B (docs/EXCALIDRAW-MIGRATION.md §4.3; check R2): a click (or a tap) places a
// pin, anchored to the object under it (`shape:<id>`, u, v in its box: the pin follows it) or to the board
// point, and a one-line composer; Enter creates the thread through the api (`POST /api/boards/:bid/
// threads`). Commenters may use it (`readOnlyAllowed`); nothing is written to the canvas. Pins are drawn in
// the overlay. Threads and the comments panel are out of spike B's scope (§8.1).
import type { CommentAnchor, CommentThread, ListThreadsResponse } from '@draftroom/contracts'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CanvasPort, ScenePoint } from '../../port.ts'
import type { OverlayLayerProps, PointerToolSpec } from '../../registries.ts'
import { onScreen, usePortTick, useSubscription } from './hooks.ts'
import { commentAnchorFor, voteTargetOf } from './model.ts'
import type { FeatureRuntime } from './runtime.ts'

export const COMMENT_TOOL = 'comment'
export const COMMENT_CUSTOM_TYPE = 'lobby-comment'

type Listener = () => void

export class CommentsStore {
  private readonly rt: FeatureRuntime
  threads: CommentThread[] = []
  /** a pin being placed (the composer is open) */
  draft: { anchor: CommentAnchor; at: ScenePoint } | null = null
  private readonly listeners = new Set<Listener>()
  private offs: (() => void)[] = []

  constructor(rt: FeatureRuntime) {
    this.rt = rt
  }
  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  private emit() {
    for (const l of [...this.listeners]) l()
  }

  start(): void {
    void this.refresh()
    this.offs.push(this.rt.onEvent('comments.thread', () => void this.refresh()))
    this.offs.push(this.rt.onEvent('comments.deleted', () => void this.refresh()))
  }
  stop(): void {
    for (const off of this.offs.splice(0)) off()
  }

  async refresh(): Promise<void> {
    if (!this.rt.boardId) return
    try {
      const r = await this.rt.request<ListThreadsResponse>(
        'GET',
        `/api/boards/${encodeURIComponent(this.rt.boardId)}/threads`,
      )
      this.threads = r.threads
      this.emit()
    } catch {
      // the pins stay as they were
    }
  }

  /** Opens the composer for a pin at `point` on `hitId` (or on the board). */
  place(point: ScenePoint, hitId: string | null): void {
    const target = voteTargetOf(hitId ? (this.rt.port.get(hitId) ?? null) : null, (id) =>
      this.rt.port.get(id),
    )
    this.draft = { anchor: commentAnchorFor(point, target) as CommentAnchor, at: point }
    this.emit()
  }
  cancel(): void {
    this.draft = null
    this.emit()
  }

  /** Creates the thread of the open draft with `body`. */
  async submit(body: string): Promise<CommentThread | null> {
    const d = this.draft
    if (!d || !this.rt.boardId || !body.trim()) return null
    try {
      const r = await this.rt.request<{ thread: CommentThread }>(
        'POST',
        `/api/boards/${encodeURIComponent(this.rt.boardId)}/threads`,
        { anchor: d.anchor, body },
      )
      this.draft = null
      this.threads = [...this.threads.filter((t) => t.id !== r.thread.id), r.thread]
      this.emit()
      return r.thread
    } catch (e) {
      this.rt.toast(`Couldn't comment: ${(e as Error).message}`)
      return null
    }
  }
}

export function commentTool(store: CommentsStore): PointerToolSpec {
  return {
    id: COMMENT_TOOL,
    customType: COMMENT_CUSTOM_TYPE,
    readOnlyAllowed: true,
    cursor: 'crosshair',
    onPointerDown(point, hit) {
      store.place(point, hit?.id ?? null)
    },
  }
}

/** Where a pin draws: its object's (u, v), or its board point. Null when its object is gone or hidden. */
export function pinPoint(
  port: CanvasPort,
  anchor: CommentAnchor,
  isHidden: (id: string) => boolean,
): ScenePoint | null {
  if (anchor.kind === 'point') return { x: anchor.x, y: anchor.y }
  const id = anchor.shapeId.slice('shape:'.length)
  if (isHidden(id)) return null
  const b = port.bounds(id)
  if (!b) return null
  const u = 'u' in anchor ? anchor.u : 0.5
  const v = 'v' in anchor ? anchor.v : 0.5
  return { x: b.x + b.width * u, y: b.y + b.height * v }
}

function Composer({ store, at }: { store: CommentsStore; at: { x: number; y: number } }) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <form
      data-lobby-comment-composer=""
      style={{
        position: 'fixed',
        left: Math.max(
          8,
          Math.min(at.x + 12, (typeof window === 'undefined' ? 800 : window.innerWidth) - 260),
        ),
        top: at.y + 12,
        zIndex: 20,
        display: 'flex',
        gap: 4,
        padding: 6,
        background: '#fff',
        border: '1px solid #ccd',
        borderRadius: 8,
        boxShadow: '0 2px 10px rgba(0,0,0,.15)',
        width: 248,
        maxWidth: 'calc(100vw - 16px)',
        boxSizing: 'border-box',
      }}
      onSubmit={(e) => {
        e.preventDefault()
        void store.submit(text)
      }}
      onKeyDown={(e) => {
        // the composer is not the canvas: its keys never reach Lobby's allowlist or Excalidraw
        e.stopPropagation()
        if (e.key === 'Escape') store.cancel()
      }}
    >
      <input
        ref={ref}
        data-lobby-comment-input=""
        aria-label="Comment"
        value={text}
        maxLength={5000}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add a comment"
        style={{ flex: 1, minWidth: 0, font: '13px system-ui, sans-serif' }}
      />
      <button type="submit" data-lobby-comment-send="" disabled={!text.trim()}>
        Post
      </button>
    </form>
  )
}

export function makeCommentPins(rt: FeatureRuntime, store: CommentsStore) {
  return function CommentPins({ port }: OverlayLayerProps) {
    usePortTick(port, ['changed', 'viewportChanged'])
    useSubscription(store.subscribe)
    const isHidden = (id: string) => rt.registries.hidden.isHidden(id)
    const pins = []
    for (const t of store.threads) {
      const p = pinPoint(port, t.anchor, isHidden)
      const at = p && onScreen(port, p.x, p.y)
      if (!at) continue
      pins.push(
        <div
          key={t.id}
          data-lobby-comment-pin={t.id}
          data-anchor={t.anchor.kind === 'point' ? 'point' : t.anchor.shapeId}
          title={t.comments[0]?.body ?? ''}
          style={{
            position: 'fixed',
            left: at.x - 10,
            top: at.y - 24,
            width: 20,
            height: 20,
            borderRadius: '10px 10px 10px 2px',
            background: t.status === 'resolved' ? '#9fa8b2' : '#f1ac4b',
            border: '2px solid #fff',
            boxShadow: '0 1px 4px rgba(0,0,0,.3)',
            pointerEvents: 'none',
            zIndex: 7,
          }}
        />,
      )
    }
    const d = store.draft
    const draftAt = d ? port.sceneToScreen(d.at) : null
    return (
      <>
        {pins}
        {d && draftAt ? (
          <>
            <div
              data-lobby-comment-pin="draft"
              style={{
                position: 'fixed',
                left: draftAt.x - 10,
                top: draftAt.y - 24,
                width: 20,
                height: 20,
                borderRadius: '10px 10px 10px 2px',
                background: '#4465e9',
                border: '2px solid #fff',
                pointerEvents: 'none',
                zIndex: 7,
              }}
            />
            {/* outside the board wrapper: its keys and pointers are never canvas input (CanvasInput's allowlist) */}
            {createPortal(<Composer store={store} at={draftAt} />, document.body)}
          </>
        ) : null}
      </>
    )
  }
}
