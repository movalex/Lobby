import { type FormEvent, useId, useState } from 'react'
import { Wordmark } from '../brand/Wordmark.tsx'
import { colorForUser, DEV_USER_PRESETS, DEV_USER_RE, initialsFor } from '../lib/identity.ts'
import { navigate } from '../lib/routing.ts'

/** Shown on a board link without ?user=. Sets ?user= (and ?role=viewer) and keeps the rest of the URL. */
export function DevIdentityPicker({ boardId }: { boardId: string }) {
  const inputId = useId()
  const viewerId = useId()
  const [custom, setCustom] = useState('')
  const [viewer, setViewer] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choose = (userId: string) => {
    const params = new URLSearchParams(location.search)
    params.set('user', userId)
    if (viewer) params.set('role', 'viewer')
    else params.delete('role')
    navigate(`${location.pathname}?${params}`, { replace: true })
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const id = custom.trim().toLowerCase()
    if (!DEV_USER_RE.test(id)) {
      setError('Use 1–32 lowercase letters, digits or "-".')
      return
    }
    choose(id)
  }

  return (
    <main className="dr-screen dr-screen--page" data-testid="dev-identity-picker">
      <div className="dr-card dr-card--narrow">
        <Wordmark />
        <h1 className="dr-card__title">Who are you on this board?</h1>
        <p className="dr-muted">
          Development identity for <code>{boardId}</code>. There is no sign-in yet: anyone can pick any name,
          so use this only on your own machine.
        </p>
        <fieldset className="dr-presets-fieldset">
          <legend className="dr-sr-only">Preset identities</legend>
          <div className="dr-presets">
            {DEV_USER_PRESETS.map((id) => (
              <button
                key={id}
                type="button"
                className="dr-preset"
                data-testid={`dev-identity-${id}`}
                onClick={() => choose(id)}
              >
                <span
                  className="dr-avatar dr-avatar--static"
                  style={{ background: colorForUser(id) }}
                  aria-hidden="true"
                >
                  {initialsFor(id)}
                </span>
                {id}
              </button>
            ))}
          </div>
        </fieldset>
        <form onSubmit={submit} noValidate>
          <label htmlFor={inputId}>Or a custom id</label>
          <div className="dr-row">
            <input
              id={inputId}
              className="dr-input"
              data-testid="dev-identity-custom"
              value={custom}
              onChange={(e) => {
                setCustom(e.target.value)
                setError(null)
              }}
              placeholder="e.g. dana"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
            />
            <button type="submit" className="dr-btn">
              Join
            </button>
          </div>
          {error && (
            <p className="dr-field-error" role="alert">
              {error}
            </p>
          )}
        </form>
        <label className="dr-check" htmlFor={viewerId}>
          <input
            id={viewerId}
            type="checkbox"
            checked={viewer}
            onChange={(e) => setViewer(e.target.checked)}
          />
          Join as viewer (read-only)
        </label>
      </div>
    </main>
  )
}

export function SignInPlaceholder() {
  return (
    <main className="dr-screen dr-screen--page" data-testid="sign-in-placeholder">
      <div className="dr-card dr-card--narrow">
        <Wordmark />
        <h1 className="dr-card__title">Sign-in arrives in milestone 1</h1>
        <p className="dr-muted">
          This build has no development identities enabled and real accounts do not exist yet, so boards
          cannot be opened here.
        </p>
      </div>
    </main>
  )
}

export function MessageScreen({ title, body }: { title: string; body: string }) {
  return (
    <main className="dr-screen dr-screen--page">
      <div className="dr-card dr-card--narrow">
        <Wordmark />
        <h1 className="dr-card__title">{title}</h1>
        <p className="dr-muted">{body}</p>
        <a
          className="dr-btn"
          href="/"
          onClick={(e) => {
            e.preventDefault()
            navigate(`/${location.search}`)
          }}
        >
          Go to Draftroom home
        </a>
      </div>
    </main>
  )
}
