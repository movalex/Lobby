/**
 * O2's spike board page at /b/:boardId (docs/EXCALIDRAW-MIGRATION.md §8.1 "Web", §8.6.3): the Excalidraw
 * host with real dev sign-in (the app's session; canvas/board/route.tsx mounts this page only behind
 * the dev-auth guard, inside RequireSession) and real tickets, Lobby's top
 * bar and Saved indicator, "X is typing", cursors, the UI slots of `registries.ts` (`toolbar`, `sheet`,
 * `timer`, filled by O5), and one `installAll` call (./session.ts).
 *
 * Test ids for the specs: `spike-board` (data-phase, data-role), `save-state` (data-state, data-pending),
 * `typing-badge`, `cursor`, `toast`, `lease-notice` with `lease-copy`, `lease-status` (the pending
 * affordance), `board-people`.
 */
import type { TicketResponse } from '@draftroom/contracts'
import { type CSSProperties, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { api } from '../../../api/client.ts'
import { ExcalidrawHost, type HostWiring } from '../../engine/ExcalidrawHost.tsx'
import { OverlayRoot } from '../../overlay/OverlayRoot.tsx'
import type { SlotName } from '../../registries.ts'
import type { SaveStatus } from '../../sync/types.ts'
import { BoardSession } from './session.ts'

type Boot =
  | { kind: 'loading' }
  | { kind: 'ready'; ticket: TicketResponse }
  | { kind: 'error'; message: string }

export default function SpikeBoardPage({ boardId }: { boardId: string }) {
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' })
  useEffect(() => {
    const ac = new AbortController()
    api.boardTicket(boardId, ac.signal).then(
      (ticket) => setBoot({ kind: 'ready', ticket }),
      (e: unknown) => {
        if (ac.signal.aborted) return
        const kind = (e as { kind?: string }).kind
        setBoot({
          kind: 'error',
          message:
            kind === 'forbidden' || kind === 'not-found'
              ? "You don't have access to this board."
              : kind === 'unauthorized'
                ? 'Please sign in again.'
                : 'The board could not be opened.',
        })
      },
    )
    return () => ac.abort()
  }, [boardId])
  if (boot.kind === 'loading')
    return (
      <main data-testid="spike-board-loading" style={screen}>
        Opening board…
      </main>
    )
  if (boot.kind === 'error')
    return (
      <main data-testid="spike-board-error" style={screen}>
        {boot.message}
      </main>
    )
  return <BoardView key={boardId} boardId={boardId} first={boot.ticket} />
}

const screen = { padding: 24, fontFamily: 'system-ui, sans-serif' } as const

function BoardView({ boardId, first }: { boardId: string; first: TicketResponse }) {
  const [session] = useState(() => new BoardSession({ boardId, first }))
  useEffect(() => () => session.dispose(), [session])
  const snap = useSyncExternalStore(
    (l) => session.subscribe(l),
    () => session.snapshot,
  )
  const wiring = useMemo<readonly HostWiring[]>(() => [session.attach], [session])
  const [, rerender] = useState(0)
  useEffect(() => session.registries.subscribe(() => rerender((n) => n + 1)), [session])

  if (snap.phase === 'no-access')
    return (
      <main data-testid="spike-board-no-access" style={screen}>
        You no longer have access to this board.
      </main>
    )
  if (snap.phase === 'signed-out')
    return (
      <main data-testid="spike-board-signed-out" style={screen}>
        Please sign in again.
      </main>
    )
  if (snap.phase === 'closed')
    return (
      <main data-testid="spike-board-closed" data-reason={snap.closeReason ?? ''} style={screen}>
        {snap.closeReason === 'CLIENT_TOO_OLD'
          ? 'Lobby was updated. Reload the page.'
          : 'The board connection closed.'}
      </main>
    )

  return (
    <div
      data-testid="spike-board"
      data-phase={snap.phase}
      data-role={snap.role}
      style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}
    >
      <TopBar boardId={boardId} save={snap.save} people={snap.people} />
      <div style={{ position: 'relative', flex: 1 }}>
        <ExcalidrawHost role={snap.role} theme="light" wiring={wiring} onPaste={onPaste} />
        {session.port ? (
          <OverlayRoot
            port={session.port}
            registries={session.registries}
            presence={session.presenceHub}
            sid={session.sid}
          />
        ) : null}
        {session.port ? <Slots session={session} /> : null}
      </div>
      <PendingAffordance
        phase={snap.edit?.phase ?? 'idle'}
        buffered={snap.edit?.buffered ?? 0}
        lost={snap.edit?.lost?.name ?? null}
      />
      <Toasts toasts={snap.toasts} />
      {snap.notice ? (
        <div
          data-testid="lease-notice"
          data-kind={snap.notice.kind}
          role="alert"
          style={{
            position: 'fixed',
            top: 56,
            left: '50%',
            transform: 'translateX(-50%)',
            maxWidth: 'min(560px, calc(100vw - 32px))',
            padding: '8px 12px',
            borderRadius: 8,
            background: '#7c2d12',
            color: '#fff',
            font: '13px system-ui, sans-serif',
            zIndex: 20,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
          }}
        >
          <span>{snap.notice.message}</span>
          {snap.notice.text ? (
            <button
              type="button"
              data-testid="lease-copy"
              onClick={() => void navigator.clipboard?.writeText(snap.notice?.text ?? '').catch(() => {})}
            >
              Copy my text
            </button>
          ) : null}
          <button type="button" data-testid="lease-dismiss" onClick={() => session.dismissNotice()}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** Excalidraw's own paste path never takes files (its base64 copies, §2.10.1): Lobby's upload path (O5) does. */
const onPaste = (data: { files?: Record<string, unknown> }) =>
  !data.files || Object.keys(data.files).length === 0

export function saveLabel(s: SaveStatus): string {
  switch (s.state) {
    case 'saved':
      return 'Saved'
    case 'saving':
      return 'Saving…'
    case 'offline':
      return `Offline — ${s.offlineChanges} change${s.offlineChanges === 1 ? '' : 's'} on this device`
    case 'retrying':
      return "Can't save right now — retrying"
    case 'not-saved':
      return `Change not saved${s.lastReject ? ` (${s.lastReject.code})` : ''}`
  }
}

function TopBar({ boardId, save, people }: { boardId: string; save: SaveStatus; people: number }) {
  return (
    <header
      data-testid="board-top-bar"
      style={{
        height: 44,
        flex: '0 0 44px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 12px',
        borderBottom: '1px solid #e5e7eb',
        background: '#fff',
        font: '13px system-ui, sans-serif',
        zIndex: 10,
      }}
    >
      <strong>Lobby</strong>
      <span data-testid="board-id" style={{ color: '#6b7280' }}>
        {boardId}
      </span>
      <span style={{ flex: 1 }} />
      <span data-testid="board-people">{people} here</span>
      <span
        data-testid="save-state"
        data-state={save.state}
        data-pending={save.pending}
        role="status"
        aria-live="polite"
        style={{
          color: save.state === 'saved' ? '#15803d' : save.state === 'not-saved' ? '#b91c1c' : '#374151',
        }}
      >
        {saveLabel(save)}
      </span>
    </header>
  )
}

/** The pending affordance (§2.9.5): "Opening the note…" while a lease request is out; the lost-lease banner. */
function PendingAffordance({
  phase,
  buffered,
  lost,
}: {
  phase: string
  buffered: number
  lost: string | null
}) {
  const show = phase === 'pending' || phase === 'opening' || !!lost
  return (
    <div
      data-testid="lease-status"
      data-phase={phase}
      data-lost={lost ? '1' : ''}
      role="status"
      style={{
        position: 'fixed',
        bottom: 16,
        left: 16,
        padding: '6px 10px',
        borderRadius: 6,
        background: '#1f2937',
        color: '#fff',
        font: '13px system-ui, sans-serif',
        zIndex: 20,
        display: show ? 'block' : 'none',
      }}
    >
      {lost
        ? `Not saved — ${lost} is editing this note now`
        : buffered > 0
          ? `Opening the note… (${buffered} typed, Esc cancels)`
          : 'Opening the note… (Esc cancels)'}
    </div>
  )
}

function Toasts({ toasts }: { toasts: readonly { id: number; text: string }[] }) {
  return (
    <div style={{ position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 30 }}>
      {toasts.map((t) => (
        <div
          key={t.id}
          data-testid="toast"
          role="status"
          style={{
            marginTop: 6,
            padding: '6px 12px',
            borderRadius: 6,
            background: '#111827',
            color: '#fff',
            font: '13px system-ui, sans-serif',
          }}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}

const SLOT_STYLE: Record<SlotName, CSSProperties> = {
  toolbar: { position: 'absolute', left: '50%', bottom: 16, transform: 'translateX(-50%)', zIndex: 10 },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 11 },
  timer: { position: 'absolute', right: 16, top: 12, zIndex: 10 },
}

/** The UI slots O5 fills (the vote tool button, the phone sheet, the timer). */
function Slots({ session }: { session: BoardSession }) {
  const port = session.port
  if (!port) return null
  return (
    <>
      {(['toolbar', 'sheet', 'timer'] as const).map((slot) => {
        const entries = session.registries.slots.list(slot)
        if (!entries.length) return null
        return (
          <div key={slot} data-testid={`slot-${slot}`} style={SLOT_STYLE[slot]}>
            {entries.map((e) => (
              <e.component key={e.id} port={port} />
            ))}
          </div>
        )
      })}
    </>
  )
}
