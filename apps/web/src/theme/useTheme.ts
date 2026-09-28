import { useEffect, useSyncExternalStore } from 'react'
import { getTheme, type ThemePreference, type ThemeState } from './theme.ts'

/** The current theme choice and the mode it resolves to, re-rendering on every change. */
export function useTheme(): ThemeState & { setPreference(preference: ThemePreference): void } {
  const theme = getTheme()
  const state = useSyncExternalStore(theme.subscribe, theme.getState)
  return { ...state, setPreference: theme.setPreference }
}

// One sync for the page however many components ask for it (the board renders the account menu in the
// top bar and, on phones, in the "⋯" menu).
let users = 0
let loading = false
let uninstall: (() => void) | null = null

/**
 * While mounted with `enabled`, tldraw's colour scheme follows the app theme (and the other way round).
 * The bridge is imported on demand: it needs tldraw, which only the board chunk loads, so the dashboard
 * and sign-in never download it.
 */
export function useTldrawThemeSync(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    users += 1
    if (!uninstall && !loading) {
      loading = true
      import('./tldraw-sync.ts').then(
        ({ syncTldrawColorScheme }) => {
          loading = false
          if (users > 0 && !uninstall) uninstall = syncTldrawColorScheme(getTheme())
        },
        () => {
          loading = false // offline chunk load: the canvas keeps tldraw's stored scheme
        },
      )
    }
    return () => {
      users -= 1
      if (users === 0 && uninstall) {
        uninstall()
        uninstall = null
      }
    }
  }, [enabled])
}
