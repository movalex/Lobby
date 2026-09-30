// OWNER: 3f. Start a private brainstorm (facilitators) on the Excalidraw page (the tldraw board's
// private-notes/SetupDialog.tsx): a prompt, where the notes go (the selected frame, or a new "Private
// ideas" frame in free space near the view) and whether names are shown when they are revealed.
//
// A new frame is made once the session has started (its `privateFrame` key names the session, ./canvas.ts),
// so a start that fails leaves nothing on the board.
import {
  PRIVATE_FRAME_DEFAULT_NAME,
  PRIVATE_PROMPT_MAX_CHARS,
  type PrivateTarget,
} from '@draftroom/contracts'
import { type FormEvent, useId, useMemo, useRef, useState } from 'react'
import type { CanvasFeatureContext } from '../../../../canvas/api/index.ts'
import { Dialog } from '../../../../ui/Dialog.tsx'
import { PRIVATE_PANEL_ID } from '../../private-notes/hooks.ts'
import type { PrivateNotesStore } from '../../private-notes/store.ts'
import { isPresentingHere } from '../presenting.ts'
import {
  afterLayout,
  createPrivateFrame,
  frameName,
  type PlannedFrame,
  planPrivateFrame,
  selectedFrame,
  showFrame,
  targetForFrame,
} from './canvas.ts'

type Ctx = CanvasFeatureContext

export function SetupDialog({
  ctx,
  store,
  onClose,
}: {
  ctx: Ctx
  store: PrivateNotesStore
  onClose(): void
}) {
  const { canvas } = ctx
  const frame = useMemo(() => selectedFrame(canvas), [canvas])
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
    let planned: PlannedFrame | null = null
    if (where === 'selected' && frame) target = targetForFrame(canvas, frame)
    if (!target) {
      planned = planPrivateFrame(canvas)
      target = planned.target
    }
    const r = await store.start({ prompt: trimmed, anonymous, target })
    sending.current = false
    setBusy(false)
    if (!r.ok) {
      // Nothing started, and nothing was made for it.
      setError(r.error ?? 'The brainstorm could not be started.')
      return
    }
    const session = store.getSnapshot().session
    if (planned && session?.frameId === planned.target.frameId)
      createPrivateFrame(canvas, planned, session.id, ctx.me.user.id)
    onClose()
    ctx.openPanel(PRIVATE_PANEL_ID)
    // The new frame is in free space beside what was in view (DANA2-02): bring it on screen once the
    // panel has taken its width (the canvas gets narrower as it opens).
    if (planned) {
      const frameRef = planned.target.frameId
      afterLayout(canvas, () => void showFrame(canvas, frameRef, isPresentingHere(canvas)))
    }
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
            ? 'Revealed notes name nobody, and who wrote which is deleted once they are on the board. Colors stay as people chose them.'
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
