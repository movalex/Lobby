// Two-way sync between the app's theme choice and another colour-scheme store (tldraw's, see
// tldraw-sync.ts). Kept free of tldraw so it can be unit tested.

import type { ThemeController, ThemePreference } from './theme.ts'

export interface ColorSchemeStore {
  get(): ThemePreference | undefined
  set(scheme: ThemePreference): void
  /** Runs `fn` now and whenever the stored scheme changes; returns the unsubscribe. */
  watch(fn: (scheme: ThemePreference | undefined) => void): () => void
}

/**
 * When the sync starts, ours wins (the other store's value may predate a change made elsewhere, e.g.
 * on the dashboard, where the canvas is not loaded), with one exception: nobody has picked a theme in
 * this browser yet, but the other store holds an explicit Light or Dark. Before the app had a theme,
 * tldraw's Ctrl/Cmd+/ was the only dark mode, and that earlier choice is kept. After the start, a change
 * on either side is copied to the other. Returns the uninstall.
 */
export function syncColorScheme(theme: ThemeController, store: ColorSchemeStore): () => void {
  const push = () => {
    const preference = theme.getPreference()
    if (store.get() !== preference) store.set(preference)
  }
  const theirs = store.get()
  if (!theme.hasStoredChoice() && (theirs === 'light' || theirs === 'dark')) theme.setPreference(theirs)
  else push()
  const offOurs = theme.subscribe(push)
  const offTheirs = store.watch((scheme) => {
    if (scheme !== undefined && scheme !== theme.getPreference()) theme.setPreference(scheme)
  })
  return () => {
    offOurs()
    offTheirs()
  }
}
