// The features' UI slots (registries.ts `toolbar`, `sheet`, `timer`; O2's board page renders them): the
// tool buttons (select, vote, comment), +1 and a tag field for the selection, the facilitator's vote and
// timer controls, and SVG export; on a phone (≤ 600 px, B12) the same actions live in a bottom sheet.
// Everything with a text field or a button is portalled to <body>, outside the board wrapper, so its keys
// and pointers are never canvas input (CanvasInput's capture-phase allowlist sees only the board).
import { type CSSProperties, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SlotProps } from '../../registries.ts'
import { COMMENT_TOOL } from './comments.tsx'
import { usePortTick, useSubscription } from './hooks.ts'
import type { FeatureRuntime } from './runtime.ts'
import { plusOne, tagElements } from './tags.tsx'
import { VOTE_TOOL } from './votes.tsx'
import { formatCountdown, type WorkshopStore } from './workshop.ts'

export const PHONE_MAX_WIDTH = 600

function usePhone(): boolean {
  const q = `(max-width: ${PHONE_MAX_WIDTH}px)`
  const [phone, setPhone] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const m = matchMedia(q)
    const on = () => setPhone(m.matches)
    m.addEventListener('change', on)
    on()
    return () => m.removeEventListener('change', on)
  }, [q])
  return phone
}

const btn = (active = false): CSSProperties => ({
  minHeight: 36,
  minWidth: 44,
  padding: '0 10px',
  borderRadius: 8,
  border: `1px solid ${active ? '#4465e9' : '#ccd'}`,
  background: active ? '#e8edff' : '#fff',
  color: '#1d1d24',
  font: '600 13px system-ui, sans-serif',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
})

export interface FeatureUi {
  rt: FeatureRuntime
  workshop: WorkshopStore
  exportSvg: () => Promise<{ text: string }>
}

/** The actions, as a row (toolbar) or a column (the phone sheet). */
function Actions({ ui, column, onDone }: { ui: FeatureUi; column: boolean; onDone?: () => void }) {
  const { rt, workshop } = ui
  const port = rt.port
  usePortTick(port, ['selectionChanged', 'changed'])
  useSubscription(workshop.subscribe)
  const [tag, setTag] = useState('')
  const tool = port.tool()
  const vote = workshop.openVote
  const sel = port.selection
  const editor = rt.canEdit()
  const done = () => onDone?.()
  const style: CSSProperties = column
    ? { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch' }
    : { display: 'flex', flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }
  return (
    <div data-lobby-actions={column ? 'sheet' : 'toolbar'} style={style}>
      <button
        type="button"
        data-lobby-tool="select"
        style={btn(tool === 'select')}
        onClick={() => {
          port.setTool('select')
          done()
        }}
      >
        Select
      </button>
      <button
        type="button"
        data-lobby-tool={VOTE_TOOL}
        disabled={!vote}
        aria-pressed={tool === VOTE_TOOL}
        style={btn(tool === VOTE_TOOL)}
        onClick={() => {
          port.setTool(VOTE_TOOL)
          done()
        }}
      >
        Vote{vote ? ` (${vote.myRemaining} left)` : ''}
      </button>
      <button
        type="button"
        data-lobby-tool={COMMENT_TOOL}
        aria-pressed={tool === COMMENT_TOOL}
        disabled={rt.me()?.role === 'viewer'}
        style={btn(tool === COMMENT_TOOL)}
        onClick={() => {
          port.setTool(COMMENT_TOOL)
          done()
        }}
      >
        Comment
      </button>
      {editor ? (
        <>
          <button
            type="button"
            data-lobby-action="plus-one"
            disabled={sel.length !== 1 || !!vote}
            title={vote ? '+1 is off while a vote runs' : '+1 the selected note'}
            style={btn()}
            onClick={() => {
              const id = sel[0]
              if (id) plusOne(rt, id, undefined, !!vote)
            }}
          >
            +1
          </button>
          <form
            style={{ display: 'flex', gap: 4 }}
            onSubmit={(e) => {
              e.preventDefault()
              const r = tagElements(rt, sel, tag)
              if (r.ok) setTag('')
              else rt.toast(r.error)
            }}
          >
            <input
              data-lobby-tag-input=""
              aria-label="Tag the selection"
              placeholder="#tag"
              value={tag}
              disabled={!sel.length}
              onChange={(e) => setTag(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              style={{
                width: column ? '100%' : 96,
                minHeight: 34,
                boxSizing: 'border-box',
                font: '13px system-ui',
              }}
            />
          </form>
        </>
      ) : null}
      {rt.canFacilitate() ? (
        vote ? (
          <button
            type="button"
            data-lobby-action="vote-end"
            style={btn()}
            onClick={() => void workshop.closeVote()}
          >
            End vote
          </button>
        ) : (
          <button
            type="button"
            data-lobby-action="vote-start"
            style={btn()}
            onClick={() => void workshop.startVote()}
          >
            Start vote
          </button>
        )
      ) : null}
      {rt.canFacilitate() ? (
        workshop.remainingMs() === null ? (
          <button
            type="button"
            data-lobby-action="timer-start"
            style={btn()}
            onClick={() => void workshop.timerAction({ action: 'start', durationMs: 5 * 60_000 })}
          >
            Timer 5:00
          </button>
        ) : (
          <button
            type="button"
            data-lobby-action="timer-stop"
            style={btn()}
            onClick={() => void workshop.timerAction({ action: 'stop' })}
          >
            Stop timer
          </button>
        )
      ) : null}
      <button
        type="button"
        data-lobby-action="export-svg"
        style={btn()}
        onClick={() => {
          void ui.exportSvg().then(
            ({ text }) => {
              const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
              const a = document.createElement('a')
              a.href = url
              a.download = 'board.svg'
              a.click()
              setTimeout(() => URL.revokeObjectURL(url), 10_000)
            },
            (e: Error) => rt.toast(`Export failed: ${e.message}`),
          )
        }}
      >
        Export SVG
      </button>
    </div>
  )
}

export function makeToolbar(ui: FeatureUi) {
  return function FeaturesToolbar(_: SlotProps) {
    const phone = usePhone()
    if (phone) return null
    return createPortal(
      <div
        data-lobby-features-toolbar=""
        style={{
          position: 'fixed',
          left: '50%',
          bottom: 16,
          transform: 'translateX(-50%)',
          zIndex: 40,
          padding: 6,
          background: 'rgba(255,255,255,.96)',
          border: '1px solid #dde',
          borderRadius: 12,
          boxShadow: '0 2px 12px rgba(0,0,0,.12)',
          maxWidth: 'calc(100vw - 32px)',
        }}
      >
        <Actions ui={ui} column={false} />
      </div>,
      document.body,
    )
  }
}

export function makeSheet(ui: FeatureUi) {
  return function FeaturesSheet(_: SlotProps) {
    const phone = usePhone()
    const [open, setOpen] = useState(false)
    if (!phone) return null
    return createPortal(
      <>
        <button
          type="button"
          data-lobby-sheet-open=""
          aria-expanded={open}
          aria-label="Board actions"
          style={{
            position: 'fixed',
            right: 16,
            bottom: 16,
            zIndex: 41,
            width: 48,
            height: 48,
            borderRadius: 24,
            border: '1px solid #ccd',
            background: '#fff',
            boxShadow: '0 2px 10px rgba(0,0,0,.18)',
            font: '700 20px system-ui',
          }}
          onClick={() => setOpen((o) => !o)}
        >
          ☰
        </button>
        {open ? (
          <div
            data-lobby-sheet=""
            role="dialog"
            aria-label="Board actions"
            style={{
              position: 'fixed',
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 42,
              maxHeight: '60vh',
              overflowY: 'auto',
              padding: '12px 16px 76px',
              boxSizing: 'border-box',
              width: '100%',
              background: '#fff',
              borderRadius: '14px 14px 0 0',
              boxShadow: '0 -2px 16px rgba(0,0,0,.18)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <strong style={{ font: '600 15px system-ui' }}>Board</strong>
              <button type="button" data-lobby-sheet-close="" style={btn()} onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
            <Actions ui={ui} column onDone={() => setOpen(false)} />
          </div>
        ) : null}
      </>,
      document.body,
    )
  }
}

export function makeTimer(ui: FeatureUi) {
  return function FeaturesTimer(_: SlotProps) {
    useSubscription(ui.workshop.subscribe)
    const [, setNow] = useState(0)
    const ms = ui.workshop.remainingMs()
    const running = ms !== null
    useEffect(() => {
      if (!running) return
      const t = setInterval(() => setNow((n) => n + 1), 250)
      return () => clearInterval(t)
    }, [running])
    const phone = usePhone()
    if (ms === null) return null
    return createPortal(
      <div
        data-lobby-timer=""
        data-remaining-ms={Math.round(ms)}
        role="timer"
        style={{
          position: 'fixed',
          top: phone ? 56 : 64,
          right: 16,
          zIndex: 39,
          padding: '4px 10px',
          borderRadius: 10,
          background: ms <= 0 ? '#e03131' : '#1d1d24',
          color: '#fff',
          font: '700 15px/22px system-ui, sans-serif',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatCountdown(ms)}
      </div>,
      document.body,
    )
  }
}

/** The runtime's toast line (vote results, refusals), for every layout. */
export function makeToast(rt: FeatureRuntime) {
  const subscribe = (l: () => void) => rt.onToast(l)
  return function FeaturesToast(_: { port: unknown }) {
    useSubscription(subscribe)
    const text = rt.currentToast()
    if (!text) return null
    return createPortal(
      <div
        data-lobby-feature-toast=""
        role="status"
        style={{
          position: 'fixed',
          left: '50%',
          bottom: 120,
          transform: 'translateX(-50%)',
          zIndex: 45,
          padding: '6px 12px',
          borderRadius: 8,
          background: 'rgba(20,20,24,.9)',
          color: '#fff',
          font: '13px system-ui',
          maxWidth: 'calc(100vw - 32px)',
          pointerEvents: 'none',
        }}
      >
        {text}
      </div>,
      document.body,
    )
  }
}
