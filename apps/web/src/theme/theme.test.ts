import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createThemeController,
  parseThemePreference,
  resolveColorMode,
  THEME_COLOR,
  THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  type ThemeEnvironment,
  type ThemePreference,
  type ThemeState,
} from './theme.ts'

function fakeEnv(opts: { stored?: string | null; systemDark?: boolean } = {}) {
  let stored = opts.stored ?? null
  let dark = opts.systemDark ?? false
  const systemListeners = new Set<(d: boolean) => void>()
  const storedListeners = new Set<(v: string | null) => void>()
  const applied: ThemeState[] = []
  const env: ThemeEnvironment = {
    read: () => stored,
    write: (v) => {
      stored = v
    },
    systemDark: () => dark,
    onSystemChange: (fn) => {
      systemListeners.add(fn)
      return () => systemListeners.delete(fn)
    },
    onStoredChange: (fn) => {
      storedListeners.add(fn)
      return () => storedListeners.delete(fn)
    },
    apply: (s) => applied.push(s),
  }
  return {
    env,
    applied,
    stored: () => stored,
    setSystemDark(d: boolean) {
      dark = d
      for (const fn of systemListeners) fn(d)
    },
    otherTabStores(v: string | null) {
      stored = v
      for (const fn of storedListeners) fn(v)
    },
    listenerCount: () => systemListeners.size + storedListeners.size,
  }
}

describe('theme preference', () => {
  it('defaults to System for anything that is not a known choice', () => {
    for (const v of [null, undefined, '', 'Dark', 'auto', 1, '{"x":1}'])
      expect(parseThemePreference(v)).toBe('system')
    for (const v of THEME_PREFERENCES) expect(parseThemePreference(v)).toBe(v)
  })
  it('resolves System from the OS setting, and Light/Dark regardless of it', () => {
    expect(resolveColorMode('system', true)).toBe('dark')
    expect(resolveColorMode('system', false)).toBe('light')
    for (const os of [true, false]) {
      expect(resolveColorMode('light', os)).toBe('light')
      expect(resolveColorMode('dark', os)).toBe('dark')
    }
  })
})

describe('theme controller', () => {
  it('starts from the stored choice and applies it once', () => {
    const f = fakeEnv({ stored: 'dark', systemDark: false })
    const theme = createThemeController(f.env)
    expect(theme.getState()).toEqual({ preference: 'dark', colorMode: 'dark' })
    expect(f.applied).toEqual([{ preference: 'dark', colorMode: 'dark' }])
  })

  it('a choice is stored, applied and announced; the same state keeps the same snapshot object', () => {
    const f = fakeEnv({ systemDark: true })
    const theme = createThemeController(f.env)
    let calls = 0
    theme.subscribe(() => calls++)
    const before = theme.getState()
    expect(before).toEqual({ preference: 'system', colorMode: 'dark' })
    expect(theme.getState()).toBe(before)

    theme.setPreference('light')
    expect(f.stored()).toBe('light')
    expect(theme.getState()).toEqual({ preference: 'light', colorMode: 'light' })
    expect(f.applied.at(-1)).toEqual({ preference: 'light', colorMode: 'light' })
    expect(calls).toBe(1)

    theme.setPreference('light') // no change: nothing re-applied or announced
    expect(calls).toBe(1)
    expect(f.applied).toHaveLength(2)
  })

  it('System follows the OS live; Light and Dark ignore it', () => {
    const f = fakeEnv({ stored: 'system', systemDark: false })
    const theme = createThemeController(f.env)
    let calls = 0
    theme.subscribe(() => calls++)
    f.setSystemDark(true)
    expect(theme.getColorMode()).toBe('dark')
    expect(calls).toBe(1)
    theme.setPreference('light')
    f.setSystemDark(false)
    f.setSystemDark(true)
    expect(theme.getColorMode()).toBe('light')
    expect(calls).toBe(2)
    // back to System: the OS setting seen while on Light counts
    theme.setPreference('system')
    expect(theme.getColorMode()).toBe('dark')
  })

  it('a choice made in another tab applies here without being written back', () => {
    const f = fakeEnv({ stored: 'light' })
    const theme = createThemeController(f.env)
    f.otherTabStores('dark')
    expect(theme.getState()).toEqual({ preference: 'dark', colorMode: 'dark' })
    f.otherTabStores(null) // cleared site data: back to the default
    expect(theme.getPreference()).toBe('system')
    expect(f.stored()).toBe(null)
  })

  it('dispose removes its listeners', () => {
    const f = fakeEnv()
    const theme = createThemeController(f.env)
    expect(f.listenerCount()).toBe(2)
    theme.dispose()
    expect(f.listenerCount()).toBe(0)
  })
})

// The first-paint script (public/theme-boot.js, a blocking classic <script src> in index.html's head) runs
// before any bundle: it must reach the same result as the controller for every stored value and OS
// setting, and never throw (storage may be blocked). It is a file, never an inline script: the
// Content-Security-Policy has no inline-script hash (docs/EXCALIDRAW-MIGRATION.md §2.12; cut-over G3).
describe('index.html first-paint script', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const script = readFileSync(new URL('../../public/theme-boot.js', import.meta.url), 'utf8')

  function run(stored: string | null | 'throws', systemDark: boolean | 'no-matchMedia') {
    const attrs: Record<string, string> = {}
    const style: Record<string, string> = {}
    const meta = { content: '#1f3a5f', setAttribute: (_: string, v: string) => (meta.content = v) }
    const document = {
      documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v), style },
      querySelector: (sel: string) => (sel === 'meta[name="theme-color"]' ? meta : null),
    }
    const localStorage = {
      getItem(key: string) {
        if (stored === 'throws') throw new Error('SecurityError')
        return key === THEME_STORAGE_KEY ? stored : null
      },
    }
    const window = {
      matchMedia:
        systemDark === 'no-matchMedia'
          ? undefined
          : (q: string) => ({ matches: q === '(prefers-color-scheme: dark)' && systemDark }),
    }
    new Function('window', 'document', 'localStorage', script as string)(window, document, localStorage)
    return { attrs, colorScheme: style.colorScheme, themeColor: meta.content }
  }

  it('is a same-origin classic script in <head>, before the app bundle; index.html has no inline script', () => {
    expect(script).toBeTruthy()
    // classic (a module is deferred and would run after the first paint), dependency-free
    expect(script).not.toMatch(/^\s*(import|export)\b/m)
    // no inline script anywhere: the CSP's script-src is 'self' with no hash
    expect(html.match(/<script(?![^>]*\bsrc=)[^>]*>/g)).toBeNull()
    const tag = html.indexOf('<script src="/theme-boot.js"></script>')
    expect(tag).toBeGreaterThan(-1)
    expect(tag).toBeLessThan(html.indexOf('</head>'))
    expect(html.indexOf('/src/theme/boot.ts')).toBeGreaterThan(html.indexOf('</head>'))
    expect(html.indexOf('/src/theme/boot.ts')).toBeLessThan(html.indexOf('/src/main.tsx'))
  })

  it('matches the controller for every stored value and OS setting', () => {
    for (const stored of [null, 'system', 'light', 'dark', 'bogus']) {
      for (const os of [true, false]) {
        const pref: ThemePreference = parseThemePreference(stored)
        const mode = resolveColorMode(pref, os)
        expect(run(stored, os)).toEqual({
          attrs: { 'data-theme': mode, 'data-theme-pref': pref },
          colorScheme: mode,
          themeColor: THEME_COLOR[mode],
        })
      }
    }
  })

  it('falls back to light when storage throws and matchMedia is missing', () => {
    expect(run('throws', 'no-matchMedia').attrs).toEqual({
      'data-theme': 'light',
      'data-theme-pref': 'system',
    })
    expect(run('throws', true).attrs['data-theme']).toBe('dark')
  })
})
