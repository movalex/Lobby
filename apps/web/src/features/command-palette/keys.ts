// OWNER: W3 (wave L, L3-2). Ctrl/Cmd+K off the board (the dashboard): the platform's command key (Cmd on
// macOS, Ctrl elsewhere: a Mac's Ctrl+K in a text field is its kill-line), no Shift, Alt or AltGr, not while
// composing, and the K by the layout's character, as the board's claim reads it (canvas/input/keymap.ts
// waveLKeyClaimOf: Dvorak's K character is on code KeyV; a non-Latin layout's K key, code KeyK, counts).
// Pure and dependency-free, so the dashboard's first bundle stays as it is.

export interface PaletteKeyLike {
  readonly key: string
  readonly code?: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly isComposing?: boolean
  readonly altGraph?: boolean
}

export const isMacPlatform = (): boolean => {
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator
  return /Mac|iPhone|iPad|iPod/.test(nav?.platform ?? nav?.userAgent ?? '')
}

/** Whether `e` is Ctrl/Cmd+K (see the header). */
export function isPaletteKey(e: PaletteKeyLike, mac: boolean = isMacPlatform()): boolean {
  if (e.isComposing || e.altGraph || e.altKey || e.shiftKey) return false
  if (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return false
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase() === 'k'
  return /^\p{L}$/u.test(e.key) && e.code === 'KeyK'
}

/** The fields `isPaletteKey` reads, from a DOM event (AltGr from getModifierState). */
export const paletteKeyOf = (e: KeyboardEvent): PaletteKeyLike => ({
  key: e.key,
  code: e.code,
  ctrlKey: e.ctrlKey,
  metaKey: e.metaKey,
  altKey: e.altKey,
  shiftKey: e.shiftKey,
  isComposing: e.isComposing,
  altGraph: typeof e.getModifierState === 'function' && e.getModifierState('AltGraph'),
})
