// Keeps tldraw's own colour scheme (the canvas, its menus and panels) equal to the app's theme choice.
// Only ever loaded from the board page (useTldrawThemeSync.ts imports it dynamically), because it pulls
// in tldraw.
//
// tldraw 5.4.2 (verified in node_modules/@tldraw/editor/src/lib/config): an editor without a `user`
// prop (BoardPage passes none) reads the page-wide user preferences, `getUserPreferences()` /
// `setUserPreferences()`, a signal kept in localStorage ("TLDRAW_USER_DATA_v3") and shared across tabs.
// Their `colorScheme` is 'light' | 'dark' | 'system', which is exactly our preference ('system' makes
// tldraw follow prefers-color-scheme itself, as our chrome does). `editor.user.getIsDarkMode()` and
// the container's `tl-theme__dark` class follow it reactively, so a change applies without a remount.
//
// Both directions: tldraw's own switch (the `toggle-dark-mode` action, Ctrl/Cmd+/, which writes
// 'light' or 'dark') becomes our choice, so the app chrome follows the canvas too.

import { getUserPreferences, react, setUserPreferences } from 'tldraw'
import { type ColorSchemeStore, syncColorScheme } from './color-scheme-sync.ts'
import type { ThemeController } from './theme.ts'

/** tldraw's page-wide user preferences, seen as a colour-scheme store. */
const tldrawColorScheme: ColorSchemeStore = {
  get: () => getUserPreferences().colorScheme,
  set: (scheme) => setUserPreferences({ ...getUserPreferences(), colorScheme: scheme }),
  watch: (fn) => react('draftroom: tldraw colour scheme', () => fn(getUserPreferences().colorScheme)),
}

export function syncTldrawColorScheme(theme: ThemeController): () => void {
  return syncColorScheme(theme, tldrawColorScheme)
}
