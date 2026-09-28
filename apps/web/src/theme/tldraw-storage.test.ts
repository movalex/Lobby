import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createThemeController, type ThemeEnvironment } from './theme.ts'
import {
  keepTldrawStorageInStep,
  storedTldrawScheme,
  TLDRAW_PREFS_KEY,
  TLDRAW_PREFS_VERSION,
  withTldrawScheme,
} from './tldraw-storage.ts'

// The format written here is tldraw's own: pin it to the installed source, so an upgrade that changes
// the key, the version or the colorScheme values fails this test instead of silently doing nothing.
describe('tldraw 5.4.2 user-preference storage (parsed from node_modules)', () => {
  const tldrawDir = realpathSync(fileURLToPath(new URL('../../node_modules/tldraw', import.meta.url)))
  const src = readFileSync(join(tldrawDir, '../@tldraw/editor/src/lib/config/TLUserPreferences.ts'), 'utf8')

  it('keeps its preferences under the key and version written here', () => {
    expect(src).toContain(`const USER_DATA_KEY = '${TLDRAW_PREFS_KEY}'`)
    const versions = /const Versions = \{([\s\S]*?)\} as const/.exec(src)?.[1] ?? ''
    const numbers = [...versions.matchAll(/:\s*(\d+)/g)].map((m) => Number(m[1]))
    expect(numbers.length).toBeGreaterThan(5)
    expect(Math.max(...numbers)).toBe(TLDRAW_PREFS_VERSION)
    expect(src).toContain('const CURRENT_VERSION = Math.max(...Object.values(Versions))')
  })

  it('stores { version, user } and accepts a user with only an id and a colorScheme', () => {
    expect(src).toMatch(/version: CURRENT_VERSION,\s*user: globalUserPreferences\.get\(\)/)
    expect(src).toContain("colorScheme: T.literalEnum('light', 'dark', 'system').optional(),")
    expect(src).toContain('id: T.string,')
    // every other field is optional
    const fields =
      /userTypeValidator[\s\S]*?T\.object<TLUserPreferences>\(\{([\s\S]*?)\}\)/.exec(src)?.[1] ?? ''
    const required = fields
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\w+:/.test(l) && !l.includes('.optional()'))
    expect(required).toEqual(['id: T.string,'])
  })
})

describe('withTldrawScheme / storedTldrawScheme', () => {
  const id = () => 'new-id'
  it('creates a minimal valid entry when tldraw has stored nothing yet', () => {
    const out = withTldrawScheme(null, 'dark', id)
    expect(JSON.parse(out as string)).toEqual({ version: 13, user: { id: 'new-id', colorScheme: 'dark' } })
    expect(storedTldrawScheme(out)).toBe('dark')
  })
  it('changes only colorScheme and keeps everything else tldraw stored', () => {
    const stored = JSON.stringify({
      version: 13,
      user: { id: 'u1', color: '#FF802B', isSnapMode: true, colorScheme: 'light', locale: 'en' },
    })
    expect(JSON.parse(withTldrawScheme(stored, 'system', id) as string)).toEqual({
      version: 13,
      user: { id: 'u1', color: '#FF802B', isSnapMode: true, colorScheme: 'system', locale: 'en' },
    })
    expect(withTldrawScheme(stored, 'light', id)).toBeNull() // already right: no write
  })
  it('keeps an older version number (tldraw migrates it) and leaves unparseable data alone', () => {
    const old = JSON.stringify({ version: 6, user: { id: 'u1', isDarkMode: true } })
    expect(JSON.parse(withTldrawScheme(old, 'dark', id) as string).version).toBe(6)
    for (const bad of [
      '{',
      '[]',
      '"x"',
      '{"version":13}',
      '{"version":"13","user":{"id":"x"}}',
      '{"version":1,"user":{}}',
    ]) {
      expect(withTldrawScheme(bad, 'dark', id)).toBeNull()
      expect(storedTldrawScheme(bad)).toBeUndefined()
    }
    expect(storedTldrawScheme(JSON.stringify({ version: 13, user: { id: 'x', colorScheme: 'sepia' } }))).toBe(
      undefined,
    )
  })
})

function setup(opts: { ours?: string | null; tldraw?: string | null }) {
  const store = new Map<string, string>()
  if (opts.ours) store.set('draftroom:theme', opts.ours)
  if (opts.tldraw) store.set(TLDRAW_PREFS_KEY, opts.tldraw)
  const env: ThemeEnvironment = {
    read: () => store.get('draftroom:theme') ?? null,
    write: (v) => store.set('draftroom:theme', v),
    systemDark: () => true,
    onSystemChange: () => () => {},
    onStoredChange: () => () => {},
    apply: () => {},
  }
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  }
  const theme = createThemeController(env)
  return { theme, storage, store, tldraw: () => storedTldrawScheme(store.get(TLDRAW_PREFS_KEY) ?? null) }
}

describe('keepTldrawStorageInStep (startup bundle, before any tldraw code runs)', () => {
  const id = () => 'id'
  it('first visit on a dark OS: tldraw is told "system", so the canvas starts dark', () => {
    const s = setup({})
    keepTldrawStorageInStep(s.theme, s.storage, id)
    expect(s.tldraw()).toBe('system')
    expect(s.theme.getColorMode()).toBe('dark')
    expect(s.store.has('draftroom:theme')).toBe(false) // nothing was picked
  })
  it("the app's stored choice overwrites tldraw's, and every later change is written through", () => {
    const s = setup({
      ours: 'light',
      tldraw: JSON.stringify({ version: 13, user: { id: 'u', colorScheme: 'dark' } }),
    })
    const off = keepTldrawStorageInStep(s.theme, s.storage, id)
    expect(s.tldraw()).toBe('light')
    s.theme.setPreference('dark')
    expect(s.tldraw()).toBe('dark')
    off()
    s.theme.setPreference('system')
    expect(s.tldraw()).toBe('dark')
  })
  it('nothing picked in the app, but a dark mode picked in tldraw earlier: that becomes the choice', () => {
    const s = setup({ tldraw: JSON.stringify({ version: 13, user: { id: 'u', colorScheme: 'dark' } }) })
    keepTldrawStorageInStep(s.theme, s.storage, id)
    expect(s.theme.getState()).toEqual({ preference: 'dark', colorMode: 'dark' })
    expect(s.store.get('draftroom:theme')).toBe('dark')
  })
  it('survives storage that throws', () => {
    const s = setup({})
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
    }
    expect(() => keepTldrawStorageInStep(s.theme, throwing, id)).not.toThrow()
    expect(() => s.theme.setPreference('dark')).not.toThrow()
    expect(() => keepTldrawStorageInStep(s.theme, null, id)).not.toThrow()
  })
})
