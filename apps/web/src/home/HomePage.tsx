import { type FormEvent, useId, useState } from 'react'
import { Wordmark } from '../brand/Wordmark.tsx'
import { boardIdFromInput, type DevIdentity, newBoardId } from '../lib/identity.ts'
import { boardPath, navigate } from '../lib/routing.ts'

/** Carries the dev identity along so moving between pages does not ask again. */
export const identityQuery = (identity: DevIdentity | null) =>
  identity
    ? `?user=${encodeURIComponent(identity.userId)}${identity.role === 'viewer' ? '&role=viewer' : ''}`
    : ''

export function HomePage({ identity }: { identity: DevIdentity | null }) {
  const inputId = useId()
  const errorId = useId()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const open = (e: FormEvent) => {
    e.preventDefault()
    const id = boardIdFromInput(value)
    if (!id) {
      setError(
        'Board ids are 3–64 characters: lowercase letters, digits, "-" or "_", starting with a letter or digit.',
      )
      return
    }
    navigate(`${boardPath(id)}${identityQuery(identity)}`)
  }

  return (
    <main className="dr-home">
      <div className="dr-home__inner">
        <Wordmark size="lg" />
        <p className="dr-home__tagline">
          A shared canvas for sketching, planning and reviewing work together.
        </p>
        <section className="dr-card dr-home__card" aria-label="Start">
          <button
            type="button"
            className="dr-btn dr-btn--primary dr-btn--lg"
            data-testid="new-board"
            onClick={() => navigate(`${boardPath(newBoardId())}${identityQuery(identity)}`)}
          >
            New board
          </button>
          <div className="dr-divider">
            <span>or</span>
          </div>
          <form className="dr-open" onSubmit={open} noValidate>
            <label htmlFor={inputId}>Open a board</label>
            <div className="dr-row">
              <input
                id={inputId}
                className="dr-input"
                data-testid="open-board-input"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value)
                  setError(null)
                }}
                placeholder="Board id or link, e.g. b-3k9x0q2m7a"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
              />
              <button type="submit" className="dr-btn" data-testid="open-board">
                Open
              </button>
            </div>
            {error && (
              <p id={errorId} className="dr-field-error" data-testid="open-board-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </section>
        <p className="dr-home__foot">
          {identity ? (
            <span className="dr-devbadge dr-devbadge--static" data-testid="dev-identity-badge">
              <span className="dr-devbadge__tag">DEV</span>
              <span>{identity.userId}</span>
              {identity.role === 'viewer' && <span className="dr-devbadge__role">viewer</span>}
            </span>
          ) : (
            'You will pick a development identity when you open a board.'
          )}
        </p>
      </div>
    </main>
  )
}
