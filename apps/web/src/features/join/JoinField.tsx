// OWNER: WS3 (wave V). The field a join code is typed into: on the /j/ page (a code that did not work) and as "Have a
// code?" on the sign-in page. It reads the code as the api does (contracts normalizeJoinCode: any case, dashes and
// spaces, I/L as 1, O as 0) and opens /j/<CODE>, which asks the api.
import { type FormEvent, useId, useState } from 'react'
import { navigate } from '../../lib/routing.ts'
import { joinPathOf } from './model.ts'
import { useJoinCodesOn } from './switch.ts'
import './join.css'

export function JoinCodeField({
  label,
  testId = 'join-code-field',
  autoFocus = false,
}: {
  label: string
  testId?: string
  autoFocus?: boolean
}) {
  const id = useId()
  const errorId = useId()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const path = joinPathOf(value)
    if (!path) {
      setError('A join code has 8 letters and digits, like ABCD-2345.')
      return
    }
    setError(null)
    navigate(path)
  }
  return (
    <form className="dr-join-field-form" onSubmit={submit} data-testid={testId} noValidate>
      <label htmlFor={id} className="dr-join-have__label">
        {label}
      </label>
      <div className="dr-join-field">
        <input
          id={id}
          className="dr-input dr-join-field__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="ABCD-2345"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          inputMode="text"
          maxLength={32}
          // biome-ignore lint/a11y/noAutofocus: the /j/ page's field is the only thing to do there
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          data-testid={`${testId}-input`}
        />
        <button type="submit" className="dr-btn dr-btn--primary" data-testid={`${testId}-submit`}>
          Join
        </button>
      </div>
      {error && (
        <p id={errorId} className="dr-field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

/** "Have a code?" on the sign-in page: only while join codes are on (the web switch and the api's). */
export function HaveACode() {
  const on = useJoinCodesOn()
  if (!on) return null
  return (
    <div className="dr-join-have" data-testid="have-a-code">
      <JoinCodeField label="Have a code?" testId="have-a-code-field" />
    </div>
  )
}
