import { describe, expect, it } from 'vitest'
import { type ColorSchemeStore, syncColorScheme } from './color-scheme-sync.ts'
import { createThemeController, type ThemeEnvironment, type ThemePreference } from './theme.ts'

function theme(stored: string | null) {
  const env: ThemeEnvironment = {
    read: () => stored,
    write: (v) => {
      stored = v
    },
    systemDark: () => false,
    onSystemChange: () => () => {},
    onStoredChange: () => () => {},
    apply: () => {},
  }
  return { controller: createThemeController(env), stored: () => stored }
}

/** Stands in for tldraw's user-preference signal (tldraw-sync.ts): synchronous watchers. */
function fakeTldraw(initial: ThemePreference | undefined) {
  let value = initial
  const watchers = new Set<(v: ThemePreference | undefined) => void>()
  const sets: ThemePreference[] = []
  const store: ColorSchemeStore = {
    get: () => value,
    set: (v) => {
      sets.push(v)
      value = v
      for (const w of [...watchers]) w(v)
    },
    watch: (fn) => {
      watchers.add(fn)
      fn(value)
      return () => watchers.delete(fn)
    },
  }
  return {
    store,
    sets,
    value: () => value,
    /** tldraw's own switch (toggle-dark-mode writes 'light' or 'dark'). */
    toggle(v: ThemePreference) {
      value = v
      for (const w of [...watchers]) w(v)
    },
    watchers: () => watchers.size,
  }
}

describe('syncColorScheme (app theme <-> tldraw colorScheme)', () => {
  it("pushes the app's choice when the board opens, even over an older tldraw value", () => {
    const t = theme('dark')
    const tl = fakeTldraw('light')
    syncColorScheme(t.controller, tl.store)
    expect(tl.value()).toBe('dark')
    expect(t.controller.getPreference()).toBe('dark')
  })

  it('an unset tldraw value (first visit) takes ours, System included', () => {
    const t = theme(null)
    const tl = fakeTldraw(undefined)
    syncColorScheme(t.controller, tl.store)
    expect(tl.value()).toBe('system')
    expect(t.stored()).toBe(null) // nothing picked, nothing stored
  })

  it('keeps a dark mode chosen in tldraw before the app had a theme (nothing picked in the app yet)', () => {
    const t = theme(null)
    const tl = fakeTldraw('dark')
    syncColorScheme(t.controller, tl.store)
    expect(t.controller.getState()).toEqual({ preference: 'dark', colorMode: 'dark' })
    expect(t.stored()).toBe('dark')
    expect(tl.sets).toEqual([])
    // ...but once something is picked in the app, the app's choice wins at the next start
    const t2 = theme('system')
    const tl2 = fakeTldraw('dark')
    syncColorScheme(t2.controller, tl2.store)
    expect(tl2.value()).toBe('system')
    expect(t2.controller.getPreference()).toBe('system')
  })

  it('a choice in the account menu reaches the canvas; an equal one writes nothing', () => {
    const t = theme('light')
    const tl = fakeTldraw('light')
    syncColorScheme(t.controller, tl.store)
    expect(tl.sets).toEqual([])
    t.controller.setPreference('dark')
    expect(tl.value()).toBe('dark')
    t.controller.setPreference('system')
    expect(tl.sets).toEqual(['dark', 'system'])
  })

  it("tldraw's own toggle (Ctrl/Cmd+/) becomes the app's stored choice", () => {
    const t = theme('system')
    const tl = fakeTldraw('system')
    syncColorScheme(t.controller, tl.store)
    tl.toggle('dark')
    expect(t.controller.getState()).toEqual({ preference: 'dark', colorMode: 'dark' })
    expect(t.stored()).toBe('dark')
    expect(tl.sets).toEqual([]) // no echo back into tldraw
  })

  it('uninstall stops both directions', () => {
    const t = theme('light')
    const tl = fakeTldraw('light')
    const off = syncColorScheme(t.controller, tl.store)
    off()
    expect(tl.watchers()).toBe(0)
    t.controller.setPreference('dark')
    expect(tl.value()).toBe('light')
    tl.toggle('system')
    expect(t.controller.getPreference()).toBe('dark')
  })
})
