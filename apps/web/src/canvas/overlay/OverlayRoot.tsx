/**
 * The one DOM layer above the canvas (docs/EXCALIDRAW-MIGRATION.md §2.3.1 `canvas/overlay/`): cursors and
 * name tags, "X is typing" badges, and every overlay layer features register (`registries.overlays`: pins,
 * vote badges, card chips), each positioned in viewport coordinates through `CanvasPort.sceneToScreen`.
 * It never takes pointer events (a layer that needs them sets its own `pointer-events`).
 *
 * Re-rendered on viewport changes, element changes, presence and lease changes, and registry changes.
 */
import { useEffect, useReducer } from 'react'
import type { CanvasPort } from '../port.ts'
import type { PresenceHub } from '../presence/hub.ts'
import type { CanvasRegistries } from '../registries.ts'

export interface OverlayRootProps {
  readonly port: CanvasPort
  readonly registries: CanvasRegistries
  readonly presence: PresenceHub | null
  /** this tab's session id (its own lease is not badged) */
  readonly sid: string | null
  /** "hide cursors" (a workshop setting) */
  readonly hideCursors?: boolean
}

function useRerender(subscribe: (bump: () => void) => () => void, deps: readonly unknown[]): void {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => subscribe(bump), deps)
}

export function OverlayRoot({ port, registries, presence, sid, hideCursors }: OverlayRootProps) {
  useRerender(
    (bump) => {
      const offs = [
        port.on('viewportChanged', bump),
        port.on('changed', bump),
        registries.subscribe(bump),
        presence ? presence.subscribe(bump) : () => {},
      ]
      return () => {
        for (const o of offs) o()
      }
    },
    [port, registries, presence],
  )
  const layers = [...registries.overlays.list()].sort((a, b) => a.order - b.order)
  return (
    <div
      data-testid="lobby-overlay"
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 5 }}
    >
      <TypingBadges port={port} sid={sid} />
      {!hideCursors && presence ? <Cursors port={port} presence={presence} /> : null}
      {layers.map((l) => (
        <l.component key={l.id} port={port} />
      ))}
    </div>
  )
}

/** "Alice is typing…" on every element whose lease another session holds (§2.9.5). */
function TypingBadges({ port, sid }: { port: CanvasPort; sid: string | null }) {
  const holders = port.engine?.leaseHolders()
  if (!holders) return null
  const out = []
  for (const [id, h] of holders) {
    if (h.sid === sid) continue
    const b = port.bounds(id)
    if (!b) continue
    const p = port.sceneToScreen({ x: b.x, y: b.y })
    out.push(
      <div
        key={id}
        data-testid="typing-badge"
        data-lease={id}
        data-holder={h.name}
        style={{
          position: 'absolute',
          left: p.x,
          top: Math.max(0, p.y - 22),
          padding: '1px 6px',
          borderRadius: 4,
          background: '#1f2937',
          color: '#fff',
          font: '12px system-ui, sans-serif',
          whiteSpace: 'nowrap',
        }}
      >
        {h.name} is typing…
      </div>,
    )
  }
  return <>{out}</>
}

/** Remote cursors with name tags, in Lobby's colours (§2.7 "Drawing"). */
function Cursors({ port, presence }: { port: CanvasPort; presence: PresenceHub }) {
  return (
    <>
      {presence.peers().map((p) => {
        if (!p.pointer) return null
        const s = port.sceneToScreen(p.pointer)
        return (
          <div
            key={p.sid}
            data-testid="cursor"
            data-sid={p.sid}
            data-name={p.name}
            style={{ position: 'absolute', left: s.x, top: s.y, transform: 'translate(-2px, -2px)' }}
          >
            <svg width="14" height="18" viewBox="0 0 14 18" aria-hidden="true">
              <path
                d="M1 1 L1 15 L5 11 L8 17 L10 16 L7 10 L13 10 Z"
                fill={p.color}
                stroke="#fff"
                strokeWidth="1"
              />
            </svg>
            <span
              style={{
                position: 'absolute',
                left: 12,
                top: 12,
                padding: '0 5px',
                borderRadius: 3,
                background: p.color,
                color: '#fff',
                font: '11px system-ui, sans-serif',
                whiteSpace: 'nowrap',
              }}
            >
              {p.name}
              {p.guest ? ' (guest)' : ''}
            </span>
          </div>
        )
      })}
    </>
  )
}
