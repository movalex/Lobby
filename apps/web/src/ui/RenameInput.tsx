import { type KeyboardEvent, useState } from 'react'

/** Inline rename: Enter or leaving the field saves, Escape cancels. An unchanged or empty title cancels. */
export function RenameInput({
  initial,
  label,
  testId,
  maxLength = 120,
  className = 'dr-input dr-input--inline',
  onSubmit,
  onCancel,
}: {
  initial: string
  label: string
  testId: string
  maxLength?: number
  className?: string
  onSubmit(value: string): void
  onCancel(): void
}) {
  const [value, setValue] = useState(initial)
  const [finished, setFinished] = useState(false)
  const finish = (save: boolean) => {
    if (finished) return
    setFinished(true)
    const next = value.trim()
    if (save && next && next !== initial) onSubmit(next)
    else onCancel()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      finish(false)
    }
  }
  return (
    <input
      className={className}
      data-testid={testId}
      aria-label={label}
      value={value}
      maxLength={maxLength}
      // biome-ignore lint/a11y/noAutofocus: the user just asked to rename this; focus belongs here
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
    />
  )
}
