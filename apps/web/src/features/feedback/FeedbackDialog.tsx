// "Send feedback" (wave J5): the dialog. What happened (required), what the person expected (optional), and
// the context block that goes with it, listed in the dialog so the person sees what is sent before sending.
// Plain text only; the api cleans and caps it again. Guests (name-only) send too. Built on the shared modal
// Dialog (native <dialog>: focus trap, Escape, top layer above the board).
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import { formatDateTime } from '../../lib/format.ts'
import { Dialog } from '../../ui/Dialog.tsx'
import { feedbackApi } from './api.ts'
import { APP_BUILD } from './build-info.ts'
import {
  buildContext,
  canSend,
  contextRows,
  countChars,
  FEEDBACK_TEXT_MAX,
  type FeedbackBoard,
  sendErrorMessage,
  toInput,
} from './model.ts'
import './feedback.css'

type Phase = 'editing' | 'sending' | 'sent'

export function FeedbackDialog({
  board,
  onClose,
  send = (input) => feedbackApi().send(input),
}: {
  board: FeedbackBoard | null
  onClose(): void
  /** Replaced by tests. */
  send?: (input: ReturnType<typeof toInput>) => Promise<unknown>
}) {
  const whatId = useId()
  const expectedId = useId()
  const countId = useId()
  const contextId = useId()
  const [text, setText] = useState('')
  const [expected, setExpected] = useState('')
  const [phase, setPhase] = useState<Phase>('editing')
  const [error, setError] = useState<string | null>(null)
  // Read when the dialog opens: what is attached is what the person saw. Nothing here reads a query string.
  const context = useMemo(
    () =>
      buildContext({
        pathname: location.pathname,
        userAgent: navigator.userAgent,
        width: window.innerWidth,
        height: window.innerHeight,
        build: APP_BUILD,
        now: new Date(),
        board,
      }),
    [board],
  )
  const sending = phase === 'sending'
  const closeButton = useRef<HTMLButtonElement>(null)
  // The form is gone once it is sent: the keyboard goes to Close, not to a page body with nothing on it.
  useEffect(() => {
    if (phase === 'sent') closeButton.current?.focus()
  }, [phase])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (sending || !canSend(text, expected)) return
    setPhase('sending')
    setError(null)
    try {
      await send(toInput(text, expected, context))
      setPhase('sent')
    } catch (err) {
      setError(sendErrorMessage(err))
      setPhase('editing')
    }
  }

  if (phase === 'sent')
    return (
      <Dialog title="Thank you" onClose={onClose} testId="feedback-dialog">
        <div className="dr-fb" data-testid="feedback-sent">
          <p role="status">Your feedback was sent. Someone on the Lobby team will read it.</p>
          <div className="dr-dialog__actions">
            <button
              ref={closeButton}
              type="button"
              className="dr-btn dr-btn--primary"
              data-testid="feedback-close"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
      </Dialog>
    )

  return (
    <Dialog
      title="Send feedback"
      description="Tell us what went wrong, or what would make Lobby better. A person on the Lobby team reads every message."
      onClose={onClose}
      testId="feedback-dialog"
    >
      <form className="dr-form dr-fb" onSubmit={(e) => void submit(e)} noValidate>
        <label htmlFor={whatId}>What happened?</label>
        <textarea
          id={whatId}
          className="dr-input dr-input--block dr-fb__area"
          data-testid="feedback-text"
          rows={5}
          maxLength={FEEDBACK_TEXT_MAX}
          required
          aria-describedby={countId}
          autoComplete="off"
          spellCheck
          value={text}
          readOnly={sending}
          onChange={(e) => setText(e.target.value)}
        />
        <p id={countId} className="dr-fb__count dr-muted" data-testid="feedback-count">
          {countChars(text).toLocaleString('en-US')} / {FEEDBACK_TEXT_MAX.toLocaleString('en-US')}
        </p>

        <label htmlFor={expectedId}>
          What did you expect? <span className="dr-muted">(optional)</span>
        </label>
        <textarea
          id={expectedId}
          className="dr-input dr-input--block dr-fb__area"
          data-testid="feedback-expected"
          rows={3}
          maxLength={FEEDBACK_TEXT_MAX}
          autoComplete="off"
          spellCheck
          value={expected}
          readOnly={sending}
          onChange={(e) => setExpected(e.target.value)}
        />

        <section className="dr-fb__context" aria-labelledby={contextId} data-testid="feedback-context">
          <h3 id={contextId} className="dr-fb__context-title">
            Sent with your message
          </h3>
          <dl className="dr-fb__rows">
            {contextRows(context, formatDateTime).map((row) => (
              <div key={row.key} className="dr-fb__row" data-testid={`feedback-context-${row.key}`}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        {error && (
          <p className="dr-field-error" role="alert" data-testid="feedback-error">
            {error}
          </p>
        )}
        <div className="dr-dialog__actions">
          <button type="button" className="dr-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="dr-btn dr-btn--primary"
            data-testid="feedback-submit"
            disabled={sending || !canSend(text, expected)}
            aria-busy={sending || undefined}
          >
            {sending ? 'Sending…' : 'Send feedback'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
