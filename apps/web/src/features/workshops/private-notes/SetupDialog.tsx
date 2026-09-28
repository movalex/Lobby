// Start a private brainstorm (editors and owners): a prompt, where the notes go (the selected frame,
// or a new "Private ideas" frame in view) and whether names are shown when they are revealed.

import {
  PRIVATE_FRAME_DEFAULT_NAME,
  PRIVATE_PROMPT_MAX_CHARS,
  type PrivateTarget,
} from '@draftroom/contracts'
import { type FormEvent, useId, useMemo, useRef, useState } from 'react'
import type { TLShapeId } from 'tldraw'
import { Dialog } from '../../../ui/Dialog.tsx'
import type { FeatureContext } from '../../types.ts'
import { createPrivateFrame, frameName, selectedFrame, targetForFrame } from './canvas.ts'
import { PRIVATE_PANEL_ID } from './hooks.ts'
import type { PrivateNotesStore } from './store.ts'

export function SetupDialog({
  ctx,
  store,
  onClose,
}: {
  ctx: FeatureContext
  store: PrivateNotesStore
  onClose(): void
}) {
  const { editor } = ctx
  const frame = useMemo(() => selectedFrame(editor), [editor])
  const [prompt, setPrompt] = useState('')
  const [where, setWhere] = useState<'selected' | 'new'>(frame ? 'selected' : 'new')
  const [anonymous, setAnonymous] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // `busy` arrives with the next render: a double Enter must not make a second frame and request.
  const sending = useRef(false)
  const id = useId()
  const trimmed = prompt.replace(/\s+/g, ' ').trim()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!trimmed || busy || sending.current) return
    sending.current = true
    setBusy(true)
    setError(null)
    let target: PrivateTarget | null = null
    let created: string | null = null
    if (where === 'selected' && frame) target = targetForFrame(editor, frame)
    if (!target) {
      target = createPrivateFrame(editor)
      created = target.frameId
    }
    const r = await store.start({ prompt: trimmed, anonymous, target })
    sending.current = false
    setBusy(false)
    if (!r.ok) {
      // Nothing started: take the frame made for it away again.
      if (created && editor.getShape(created as TLShapeId)) editor.deleteShape(created as TLShapeId)
      setError(r.error ?? 'The brainstorm could not be started.')
      return
    }
    onClose()
    ctx.openPanel(PRIVATE_PANEL_ID)
  }

  return (
    <Dialog
      title="Start a private brainstorm"
      description="Everyone writes on their own. Nobody sees anyone else's notes, you included, until you reveal them onto the board."
      onClose={onClose}
      testId="pn-setup-dialog"
    >
      <form className="dr-form dr-pn-form" onSubmit={(e) => void submit(e)}>
        <label htmlFor={`${id}-prompt`}>Prompt</label>
        <input
          id={`${id}-prompt`}
          className="dr-input dr-input--block"
          data-testid="pn-prompt-input"
          maxLength={PRIVATE_PROMPT_MAX_CHARS}
          placeholder="What should we try next quarter?"
          value={prompt}
          required
          onChange={(e) => setPrompt(e.target.value)}
        />

        <fieldset className="dr-pn-fieldset">
          <legend>Put the notes in</legend>
          <label className="dr-pn-radio">
            <input
              type="radio"
              name={`${id}-where`}
              data-testid="pn-target-selected"
              checked={where === 'selected'}
              disabled={!frame}
              onChange={() => setWhere('selected')}
            />
            <span>
              {frame ? (
                <>The selected frame, “{frameName(frame)}”</>
              ) : (
                <>The selected frame (select a frame first)</>
              )}
            </span>
          </label>
          <label className="dr-pn-radio">
            <input
              type="radio"
              name={`${id}-where`}
              data-testid="pn-target-new"
              checked={where === 'new'}
              onChange={() => setWhere('new')}
            />
            <span>A new frame, “{PRIVATE_FRAME_DEFAULT_NAME}”, in view</span>
          </label>
        </fieldset>

        <label className="dr-pn-check">
          <input
            type="checkbox"
            data-testid="pn-anonymous"
            checked={anonymous}
            aria-describedby={`${id}-anon-hint`}
            onChange={(e) => setAnonymous(e.target.checked)}
          />
          Anonymous
        </label>
        <p id={`${id}-anon-hint`} className="dr-pn-hint">
          {anonymous
            ? 'Revealed notes name nobody, and who wrote which is deleted once they are on the board. Colours stay as people chose them.'
            : 'Revealed notes are grouped by author and show their names.'}
        </p>

        {error && (
          <p className="dr-field-error" role="alert" data-testid="pn-setup-error">
            {error}
          </p>
        )}
        <div className="dr-dialog__actions">
          <button type="button" className="dr-btn dr-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="dr-btn dr-btn--primary"
            data-testid="pn-setup-submit"
            disabled={!trimmed || busy}
          >
            {busy ? 'Starting…' : 'Start brainstorm'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
