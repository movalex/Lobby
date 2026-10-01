import { useSyncExternalStore } from 'react'
import { getTheme, type ThemePreference, type ThemeState } from './theme.ts'

/** The current theme choice and the mode it resolves to, re-rendering on every change. */
export function useTheme(): ThemeState & { setPreference(preference: ThemePreference): void } {
  const theme = getTheme()
  const state = useSyncExternalStore(theme.subscribe, theme.getState)
  return { ...state, setPreference: theme.setPreference }
}
