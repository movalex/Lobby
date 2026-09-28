// Dock panel "Private notes": the active private brainstorm (prompt, live counts), "My private notes"
// (write, edit, delete your own; nobody else sees them), and, for the person who started it or a
// board owner, Reveal / Place notes / Cancel. Everyone who can view the board sees the prompt and the
// counts; only editors write notes (they go onto the canvas).

import {
  codePointLength,
  PRIVATE_NOTE_MAX_CHARS,
  PRIVATE_NOTES_PER_PERSON_MAX,
  type PrivateNote,
  type PrivateNoteColor,
} from '@draftroom/contracts'
import { useId, useRef, useState } from 'react'
import { useValue } from 'tldraw'
import { NOTE_PALETTE } from '../../canvas-ux/palette.ts'
import type { FeatureContext } from '../../types.ts'
import { canEditBoard, useIsFacilitator } from '../hooks.ts'
import { zoomToSession } from './canvas.ts'
import { composerAfterAnswer, composerOnSubmit } from './composer.ts'
import { describeCounts, usePrivateNotes } from './hooks.ts'
import type { ActionResult, PrivateNotesStore } from './store.ts'

const swatch = (name: string) => NOTE_PALETTE.find((s) => s.name === name) ?? NOTE_PALETTE[0]

function useColorMode(ctx: FeatureContext): 'light' | 'dark' {
  return useValue('dr-pn-color-mode', () => ctx.editor.getColorMode(), [ctx.editor])
}

export function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <rect x="5" y="10.5" width="14" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}

export function PrivateNotesIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M4 4h12l4 4v12H4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <rect x="8.5" y="12.5" width="7" height="5" rx="1" fill="currentColor" />
      <path d="M10 12.5v-1.3a2 2 0 0 1 4 0v1.3" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

function ColorPicker({
  ctx,
  value,
  onChange,
  label,
}: {
  ctx: FeatureContext
  value: PrivateNoteColor
  onChange(c: PrivateNoteColor): void
  label: string
}) {
  const mode = useColorMode(ctx)
  const name = useId()
  return (
    <fieldset className="dr-pn-colors" data-testid="pn-colors">
      <legend className="dr-sr-only">{label}</legend>
      {NOTE_PALETTE.map((s) => (
        <label key={s.name} className="dr-pn-color" title={s.label}>
          <input
            type="radio"
            name={name}
            className="dr-sr-only"
            data-testid="pn-color"
            data-color={s.name}
            checked={value === s.name}
            onChange={() => onChange(s.name as PrivateNoteColor)}
          />
          <span className="dr-pn-color__chip" style={{ background: s[mode].fill, color: s[mode].text }}>
            <span aria-hidden="true">Aa</span>
          </span>
          <span className="dr-sr-only">{s.label}</span>
        </label>
      ))}
    </fieldset>
  )
}

function NoteEditor({
  ctx,
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
  testPrefix,
}: {
  ctx: FeatureContext
  initial: { text: string; color: PrivateNoteColor }
  submitLabel: string
  busy: boolean
  onSubmit(v: { text: string; color: PrivateNoteColor }): Promise<boolean>
  onCancel?(): void
  testPrefix: 'pn-compose' | 'pn-edit'
}) {
  const [text, setText] = useState(initial.text)
  const [color, setColor] = useState<PrivateNoteColor>(initial.color)
  const id = useId()
  const box = useRef<HTMLTextAreaElement>(null)
  // `busy` arrives with the next render: two presses before it (a double Ctrl+Enter) must not send twice.
  const sending = useRef(false)
  const length = codePointLength(text.trim())
  const tooLong = length > PRIVATE_NOTE_MAX_CHARS
  const ok = length > 0 && !tooLong && !busy
  // Composing (no Cancel): the box empties as the note is sent and keeps the keyboard, so the next
  // idea can be typed while this one saves; the answer never erases it (composer.ts, round-2 F6).
  const composing = !onCancel
  const submit = async () => {
    if (!ok || sending.current) return
    sending.current = true
    const submitted = text
    if (composing) {
      setText(composerOnSubmit(submitted))
      box.current?.focus()
    }
    let saved = false
    try {
      saved = await onSubmit({ text: submitted, color })
    } finally {
      sending.current = false
      if (composing) setText((current) => composerAfterAnswer({ current, submitted, ok: saved }))
    }
  }
  return (
    <div className="dr-pn-editor">
      <label htmlFor={`${id}-text`} className={onCancel ? 'dr-sr-only' : 'dr-pn-label'}>
        {onCancel ? 'Edit your note' : 'Write a note only you can see'}
      </label>
      <textarea
        ref={box}
        id={`${id}-text`}
        className="dr-pn-textarea"
        data-testid={`${testPrefix}-text`}
        rows={3}
        value={text}
        aria-invalid={tooLong}
        aria-describedby={`${id}-count`}
        placeholder={onCancel ? undefined : 'One idea per note'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Keep the board's shortcuts out of the text box.
          e.stopPropagation()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void submit()
          }
          if (e.key === 'Escape' && onCancel) {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      <div className="dr-pn-editor__row">
        <span id={`${id}-count`} className={`dr-pn-count${tooLong ? ' dr-pn-count--over' : ''}`}>
          {length} / {PRIVATE_NOTE_MAX_CHARS}
          <span className="dr-sr-only"> characters. Ctrl or Command + Enter to save.</span>
        </span>
      </div>
      <ColorPicker ctx={ctx} value={color} onChange={setColor} label="Note color" />
      <div className="dr-pn-editor__actions">
        {onCancel && (
          <button type="button" className="dr-btn dr-btn--sm dr-btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className="dr-btn dr-btn--sm dr-btn--primary"
          data-testid={testPrefix === 'pn-compose' ? 'pn-add' : 'pn-note-save'}
          disabled={!ok}
          aria-busy={busy || undefined}
          onClick={() => void submit()}
        >
          {busy && composing ? 'Adding…' : submitLabel}
        </button>
      </div>
    </div>
  )
}

function MyNote({
  ctx,
  store,
  note,
  editable,
  onResult,
}: {
  ctx: FeatureContext
  store: PrivateNotesStore
  note: PrivateNote
  editable: boolean
  onResult(r: ActionResult): boolean
}) {
  const mode = useColorMode(ctx)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)
  const s = swatch(note.color)
  return (
    <li className="dr-pn-note" data-testid="pn-note" data-note-id={note.id}>
      {editing ? (
        <NoteEditor
          ctx={ctx}
          initial={{ text: note.text, color: note.color }}
          submitLabel="Save"
          busy={busy}
          testPrefix="pn-edit"
          onCancel={() => setEditing(false)}
          onSubmit={async (v) => {
            setBusy(true)
            const r = await store.updateNote(note.id, { text: v.text, color: v.color })
            setBusy(false)
            const ok = onResult(r)
            if (ok) setEditing(false)
            return ok
          }}
        />
      ) : (
        <>
          <p
            className="dr-pn-note__text"
            data-testid="pn-note-text"
            style={{ background: s?.[mode].fill, color: s?.[mode].text }}
          >
            {note.text}
          </p>
          {editable && (
            <div className="dr-pn-note__actions">
              <button
                type="button"
                className="dr-linkbtn"
                data-testid="pn-note-edit"
                aria-label={`Edit note: ${note.text.slice(0, 40)}`}
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
              <button
                type="button"
                className="dr-linkbtn dr-pn-danger"
                data-testid="pn-note-delete"
                aria-label={`Delete note: ${note.text.slice(0, 40)}`}
                disabled={busy}
                onClick={async () => {
                  if (deleting.current) return // a double click: the first one is on its way
                  deleting.current = true
                  setBusy(true)
                  try {
                    onResult(await store.deleteNote(note.id))
                  } finally {
                    deleting.current = false
                    setBusy(false)
                  }
                }}
              >
                Delete
              </button>
            </div>
          )}
        </>
      )}
    </li>
  )
}

export function PrivateNotesPanel({ ctx }: { ctx: FeatureContext; close(): void }) {
  const { store, snap } = usePrivateNotes(ctx)
  // Editors and owners write notes (they end up on the canvas), guest editors too; only editors with
  // an account start a brainstorm (final review R3). The API enforces both.
  const canWrite = canEditBoard(ctx)
  const facilitator = useIsFacilitator(ctx)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const lastColor = useRef<PrivateNoteColor>('black')
  const session = snap.session
  const onResult = (r: ActionResult) => {
    setError(r.ok ? null : (r.error ?? 'That did not work.'))
    return r.ok
  }

  if (!session) {
    return (
      <div className="dr-pn" data-testid="pn-panel" data-state="none">
        <div className="dr-pn-empty">
          <p>
            <strong>Private brainstorm</strong>: everyone writes sticky notes on their own, without seeing
            anyone else's. When you reveal them, they all go onto the board at once.
          </p>
          {facilitator ? (
            <button
              type="button"
              className="dr-btn dr-btn--primary dr-btn--sm"
              data-testid="pn-start-panel"
              onClick={() => store.setSetupOpen(true)}
            >
              Start a private brainstorm…
            </button>
          ) : (
            <p className="dr-muted" data-testid="pn-start-hint">
              {canWrite
                ? "The facilitator starts one. You'll be asked to write your notes then."
                : 'An editor or owner can start one.'}
            </p>
          )}
        </div>
      </div>
    )
  }

  const open = session.status === 'open'
  const full = snap.myNotes.length >= PRIVATE_NOTES_PER_PERSON_MAX
  return (
    <div className="dr-pn" data-testid="pn-panel" data-state={session.status}>
      <section className="dr-pn-head" aria-label="Private brainstorm">
        <p className="dr-pn-eyebrow">
          <LockIcon />
          <span>Private brainstorm</span>
          <span className="dr-pn-tag" data-testid="pn-mode">
            {session.anonymous ? 'Anonymous' : 'Names shown'}
          </span>
        </p>
        <h3 className="dr-pn-prompt" data-testid="pn-prompt">
          {session.prompt}
        </h3>
        <p className="dr-pn-counts" data-testid="pn-counts" aria-live="polite">
          {describeCounts(snap.counts)}
        </p>
        <button
          type="button"
          className="dr-linkbtn dr-pn-show"
          onClick={() => zoomToSession(ctx.editor, session.id, session.frameId)}
        >
          Show where the notes go
        </button>
      </section>

      {open && canWrite && (
        <section className="dr-pn-section" aria-label="My private notes">
          <h3>My private notes</h3>
          <p className="dr-pn-hint">
            Only you can see these until they are revealed.
            {session.anonymous
              ? ' Your name is never shown with them.'
              : ' They are revealed under your name.'}
          </p>
          {full ? (
            <p className="dr-muted">You've written as many notes as one person can here.</p>
          ) : (
            <NoteEditor
              ctx={ctx}
              initial={{ text: '', color: lastColor.current }}
              submitLabel="Add note"
              busy={adding}
              testPrefix="pn-compose"
              onSubmit={async (v) => {
                setAdding(true)
                lastColor.current = v.color
                const r = await store.addNote({ text: v.text, color: v.color })
                setAdding(false)
                return onResult(r)
              }}
            />
          )}
        </section>
      )}

      {snap.myNotes.length > 0 && (
        <section className="dr-pn-section" aria-label="Your notes">
          {!(open && canWrite) && <h3>My private notes</h3>}
          <ul className="dr-pn-list" data-testid="pn-my-notes">
            {snap.myNotes.map((n) => (
              <MyNote
                key={n.id}
                ctx={ctx}
                store={store}
                note={n}
                editable={open && canWrite}
                onResult={onResult}
              />
            ))}
          </ul>
        </section>
      )}

      {open && !canWrite && (
        <p className="dr-pn-hint" data-testid="pn-viewer-hint">
          Editors are writing private notes. You'll see them when they're revealed onto the board.
        </p>
      )}

      {session.status === 'revealed' && (
        <p className="dr-pn-status" role="status" data-testid="pn-placing">
          {snap.busy === 'reveal'
            ? 'Putting the notes on the board…'
            : snap.canReveal
              ? "Revealed, but the notes aren't on the board yet. Place them when you're ready."
              : 'Revealed. The notes appear on the board once they are placed.'}
        </p>
      )}

      {snap.canReveal && (
        <section className="dr-pn-facil" aria-label="Reveal">
          {snap.starterLeft && (
            <p className="dr-pn-hint" data-testid="pn-starter-left">
              The person who started this brainstorm can no longer edit this board, so you can reveal or
              cancel it.
            </p>
          )}
          {open ? (
            <>
              <p className="dr-pn-hint">
                Revealing puts every note on the board inside the frame, at once, for everyone.
              </p>
              <button
                type="button"
                className="dr-btn dr-btn--primary dr-btn--sm dr-pn-wide"
                data-testid="pn-reveal"
                disabled={snap.busy !== null}
                onClick={async () => onResult(await store.reveal())}
              >
                {snap.busy === 'reveal'
                  ? 'Revealing…'
                  : snap.counts.notes === 0
                    ? 'Reveal'
                    : `Reveal ${snap.counts.notes} note${snap.counts.notes === 1 ? '' : 's'}`}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="dr-btn dr-btn--primary dr-btn--sm dr-pn-wide"
              data-testid="pn-place"
              disabled={snap.busy !== null}
              onClick={async () => onResult(await store.reveal())}
            >
              Place notes
            </button>
          )}
          {confirmCancel ? (
            <fieldset className="dr-pn-confirm">
              <legend>Cancel and discard every note? Nobody will see them.</legend>
              <div className="dr-pn-editor__actions">
                <button type="button" className="dr-btn dr-btn--sm" onClick={() => setConfirmCancel(false)}>
                  Keep going
                </button>
                <button
                  type="button"
                  className="dr-btn dr-btn--sm dr-pn-danger-btn"
                  data-testid="pn-cancel-confirm"
                  disabled={snap.busy !== null}
                  onClick={async () => {
                    setConfirmCancel(false)
                    onResult(await store.cancel())
                  }}
                >
                  Discard notes
                </button>
              </div>
            </fieldset>
          ) : (
            <button
              type="button"
              className="dr-btn dr-btn--sm dr-btn--ghost dr-pn-wide"
              data-testid="pn-cancel"
              disabled={snap.busy !== null}
              onClick={() => setConfirmCancel(true)}
            >
              Cancel brainstorm
            </button>
          )}
        </section>
      )}

      {error && (
        <p className="dr-field-error" role="alert" data-testid="pn-error">
          {error}
        </p>
      )}
    </div>
  )
}
