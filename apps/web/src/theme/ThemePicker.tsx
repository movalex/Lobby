import { useId } from 'react'
import type { ThemePreference } from './theme.ts'
import { useTheme } from './useTheme.ts'
import './theme.css'

const OPTIONS: readonly { value: ThemePreference; label: string; icon: string }[] = [
  // monitor
  { value: 'system', label: 'System', icon: 'M4 5h16v11H4zM9 20h6M12 16v4' },
  // sun
  {
    value: 'light',
    label: 'Light',
    icon: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4',
  },
  // moon
  { value: 'dark', label: 'Dark', icon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z' },
]

/** System / Light / Dark for this browser; applies to the app and the board canvas at once. */
export function ThemePicker() {
  const { preference, colorMode, setPreference } = useTheme()
  const name = useId()
  const hintId = useId()
  return (
    <fieldset
      className="dr-theme"
      data-testid="theme-picker"
      data-preference={preference}
      data-color-mode={colorMode}
      aria-describedby={hintId}
    >
      <legend className="dr-theme__legend">Theme</legend>
      <div className="dr-theme__options">
        {OPTIONS.map((o) => (
          <label key={o.value} className="dr-theme__option" data-testid="theme-option" data-value={o.value}>
            <input
              type="radio"
              className="dr-theme__radio"
              name={name}
              value={o.value}
              checked={preference === o.value}
              onChange={() => setPreference(o.value)}
            />
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
              <path
                d={o.icon}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      <p className="dr-theme__hint" id={hintId}>
        {preference === 'system'
          ? `Matches your device (${colorMode} right now).`
          : 'Applies to the app and the board canvas.'}
      </p>
    </fieldset>
  )
}
