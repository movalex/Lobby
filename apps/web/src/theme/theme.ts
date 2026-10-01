// The app's colour theme (PRF-12, PRI-19): the person picks System, Light or Dark in the account menu;
// the choice is a per-browser convenience kept in localStorage (never sent to the server). "System"
// follows the operating system's dark-mode setting, live.
//
// The first paint is already right: the inline script in apps/web/index.html resolves the same stored
// value before any stylesheet or bundle loads and sets html[data-theme] (styles.css switches every
// --dr-* token on it). This module takes over afterwards: it reacts to the OS setting and to other tabs,
// and applies a new choice at once. The canvas follows the same choice (canvas/engine/theme.ts).
//
// No tldraw import here: this module is part of the dashboard/sign-in bundle, and tldraw (~2 MB) must
// stay in the lazily loaded board chunk.

export type ThemePreference = 'system' | 'light' | 'dark'
export type ColorMode = 'light' | 'dark'

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']
/** Keep in sync with the inline script in apps/web/index.html (theme.test.ts runs that script). */
export const THEME_STORAGE_KEY = 'draftroom:theme'
export const DARK_QUERY = '(prefers-color-scheme: dark)'
/** `<meta name="theme-color">` (the browser's own bar on phones): the navy top in light, the dark page. */
export const THEME_COLOR: Record<ColorMode, string> = { light: '#1f3a5f', dark: '#14161b' }

/** Anything stored that is not one of the three choices means "System" (the default). */
export function parseThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

export function resolveColorMode(preference: ThemePreference, systemDark: boolean): ColorMode {
  if (preference === 'system') return systemDark ? 'dark' : 'light'
  return preference
}

export interface ThemeState {
  readonly preference: ThemePreference
  readonly colorMode: ColorMode
}

/** Everything the controller touches in the browser, injectable for tests. */
export interface ThemeEnvironment {
  /** The stored raw value (null when missing or when storage is unavailable). */
  read(): string | null
  write(value: ThemePreference): void
  systemDark(): boolean
  /** OS dark-mode changes. */
  onSystemChange(listener: (dark: boolean) => void): () => void
  /** Another tab stored a new value (null when it was removed). */
  onStoredChange(listener: (value: string | null) => void): () => void
  apply(state: ThemeState): void
}

export interface ThemeController {
  /** A stable object per state (safe as a useSyncExternalStore snapshot). */
  getState(): ThemeState
  getPreference(): ThemePreference
  getColorMode(): ColorMode
  /** False until a choice is stored in this browser ("System" by default, never picked). */
  hasStoredChoice(): boolean
  setPreference(preference: ThemePreference): void
  subscribe(listener: () => void): () => void
  dispose(): void
}

export function createThemeController(env: ThemeEnvironment): ThemeController {
  let systemDark = env.systemDark()
  let state = stateFor(parseThemePreference(env.read()), systemDark)
  const listeners = new Set<() => void>()
  env.apply(state)

  function stateFor(preference: ThemePreference, dark: boolean): ThemeState {
    return { preference, colorMode: resolveColorMode(preference, dark) }
  }
  function update(preference: ThemePreference) {
    const next = stateFor(preference, systemDark)
    if (next.preference === state.preference && next.colorMode === state.colorMode) return
    state = next
    env.apply(state)
    for (const listener of [...listeners]) listener()
  }

  const offSystem = env.onSystemChange((dark) => {
    systemDark = dark
    update(state.preference)
  })
  const offStored = env.onStoredChange((value) => update(parseThemePreference(value)))

  return {
    getState: () => state,
    getPreference: () => state.preference,
    getColorMode: () => state.colorMode,
    hasStoredChoice: () => (THEME_PREFERENCES as readonly unknown[]).includes(env.read()),
    setPreference(preference) {
      env.write(preference)
      update(preference)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      offSystem()
      offStored()
      listeners.clear()
    },
  }
}

/** The real browser: localStorage (guarded: it can be missing or throw), matchMedia, <html>. */
export function browserThemeEnvironment(): ThemeEnvironment {
  const media = typeof matchMedia === 'function' ? matchMedia(DARK_QUERY) : null
  return {
    read() {
      try {
        return localStorage.getItem(THEME_STORAGE_KEY)
      } catch {
        return null
      }
    },
    write(value) {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, value)
      } catch {
        // not persisted: the choice lasts for this page only
      }
    },
    systemDark: () => media?.matches ?? false,
    onSystemChange(listener) {
      if (!media) return () => {}
      const onChange = (e: MediaQueryListEvent) => listener(e.matches)
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    },
    onStoredChange(listener) {
      const onStorage = (e: StorageEvent) => {
        // key === null: the other tab cleared all site storage
        if (e.key === THEME_STORAGE_KEY || e.key === null) listener(e.key === null ? null : e.newValue)
      }
      addEventListener('storage', onStorage)
      return () => removeEventListener('storage', onStorage)
    },
    apply: applyToDocument,
  }
}

/** The same attributes the index.html script sets before the first paint. */
export function applyToDocument({ preference, colorMode }: ThemeState) {
  const root = document.documentElement
  root.setAttribute('data-theme', colorMode)
  root.setAttribute('data-theme-pref', preference)
  root.style.colorScheme = colorMode
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[colorMode])
}

let shared: ThemeController | null = null

/** The page's one controller (created on first use; there is no document in unit tests). */
export function getTheme(): ThemeController {
  shared ??= createThemeController(browserThemeEnvironment())
  return shared
}
