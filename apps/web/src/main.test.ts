// K5-2: the soft keyboard and the iOS input zoom.
//  - main.tsx keeps `--dr-kb-inset` on <html> from the visual viewport: innerHeight - visualViewport.height -
//    visualViewport.offsetTop, never below 0 (and 0 while the page is pinch-zoomed), so a phone sheet and the
//    docked comment popover can sit above a keyboard that only shrinks the visual viewport (Safari on iOS).
//  - index.html's viewport meta asks the browser to resize the content for the keyboard where it can
//    (interactive-widget=resizes-content, Chrome on Android) and never forbids zooming (no maximum-scale,
//    no user-scalable=no: people who need to zoom the page keep that).
// Real-device behaviour (an iPhone's keyboard, an Android keyboard) is not run here: see docs/PROGRESS.md.
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

// main.tsx renders the app when a document exists; in Node it only defines the listener. The App's module
// graph is not needed for that.
vi.mock('./App.tsx', () => ({ App: () => null }))

const { installKeyboardInset, keyboardInset } = await import('./main.tsx')

type Listener = () => void

/** A window with a visual viewport whose numbers the test sets, and <html>'s style and attributes. */
function fakeWindow(init: { innerHeight: number; height: number; offsetTop?: number; scale?: number }) {
  const vvListeners = new Map<string, Set<Listener>>()
  const winListeners = new Set<Listener>()
  const props = new Map<string, string>()
  const attrs = new Set<string>()
  const vv = {
    height: init.height,
    offsetTop: init.offsetTop ?? 0,
    scale: init.scale ?? 1,
    addEventListener: (type: string, fn: Listener) => {
      if (!vvListeners.has(type)) vvListeners.set(type, new Set())
      vvListeners.get(type)?.add(fn)
    },
    removeEventListener: (type: string, fn: Listener) => vvListeners.get(type)?.delete(fn),
  }
  const win = {
    innerHeight: init.innerHeight,
    visualViewport: vv,
    document: {
      documentElement: {
        style: {
          setProperty: (name: string, value: string) => void props.set(name, value),
        },
        toggleAttribute: (name: string, on?: boolean) => {
          if (on) attrs.add(name)
          else attrs.delete(name)
          return !!on
        },
      },
    },
    addEventListener: (_type: 'resize', fn: Listener) => void winListeners.add(fn),
    removeEventListener: (_type: 'resize', fn: Listener) => void winListeners.delete(fn),
  }
  const fire = (type: 'resize' | 'scroll') => {
    for (const fn of vvListeners.get(type) ?? []) fn()
  }
  return {
    win: win as unknown as Parameters<typeof installKeyboardInset>[0],
    vv,
    set innerHeight(v: number) {
      win.innerHeight = v
    },
    fire,
    fireWindow: () => {
      for (const fn of winListeners) fn()
    },
    inset: () => props.get('--dr-kb-inset'),
    open: () => attrs.has('data-dr-kb'),
    listenerCount: () => [...vvListeners.values()].reduce((n, s) => n + s.size, 0) + winListeners.size,
  }
}

describe('keyboardInset', () => {
  it('is innerHeight - visualViewport.height - offsetTop', () => {
    expect(keyboardInset(844, 844, 0)).toBe(0)
    expect(keyboardInset(844, 508, 0)).toBe(336)
    expect(keyboardInset(844, 508, 36)).toBe(300)
  })

  it('is never below 0 (a visual viewport taller than the layout one, an overscroll)', () => {
    expect(keyboardInset(500, 520, 0)).toBe(0)
    expect(keyboardInset(844, 600, 400)).toBe(0)
  })

  it('is 0 while the page is pinch-zoomed in (not a keyboard), and for numbers that are not numbers', () => {
    expect(keyboardInset(844, 422, 100, 2)).toBe(0)
    expect(keyboardInset(844, Number.NaN, 0)).toBe(0)
  })

  it('rounds to whole pixels', () => {
    expect(keyboardInset(844, 507.6, 0)).toBe(336)
  })
})

describe('installKeyboardInset (main.tsx)', () => {
  it('sets --dr-kb-inset at once, and again when the visual viewport resizes or scrolls', () => {
    const f = fakeWindow({ innerHeight: 844, height: 844 })
    const off = installKeyboardInset(f.win)
    expect(f.inset()).toBe('0px')
    expect(f.open()).toBe(false)

    // Safari: the keyboard shrinks the visual viewport only
    f.vv.height = 508
    f.fire('resize')
    expect(f.inset()).toBe('336px')
    expect(f.open()).toBe(true)

    // the visual viewport scrolled down inside the layout viewport
    f.vv.offsetTop = 36
    f.fire('scroll')
    expect(f.inset()).toBe('300px')

    // the keyboard closes
    f.vv.height = 844
    f.vv.offsetTop = 0
    f.fire('resize')
    expect(f.inset()).toBe('0px')
    expect(f.open()).toBe(false)
    off()
  })

  it('follows a window resize too (Chrome with resizes-content shrinks innerHeight with the keyboard: 0 there)', () => {
    const f = fakeWindow({ innerHeight: 844, height: 844 })
    installKeyboardInset(f.win)
    f.innerHeight = 508
    f.vv.height = 508
    f.fireWindow()
    expect(f.inset()).toBe('0px')
  })

  it('clamps at 0', () => {
    const f = fakeWindow({ innerHeight: 600, height: 640, offsetTop: 0 })
    installKeyboardInset(f.win)
    expect(f.inset()).toBe('0px')
  })

  it('without a visual viewport (an old browser) it does nothing', () => {
    const f = fakeWindow({ innerHeight: 844, height: 844 })
    const win = { ...(f.win as object), visualViewport: undefined } as unknown as Parameters<
      typeof installKeyboardInset
    >[0]
    const off = installKeyboardInset(win)
    expect(f.inset()).toBeUndefined()
    off()
  })

  it('the uninstaller removes every listener', () => {
    const f = fakeWindow({ innerHeight: 844, height: 844 })
    const off = installKeyboardInset(f.win)
    expect(f.listenerCount()).toBe(3)
    off()
    expect(f.listenerCount()).toBe(0)
  })
})

describe('index.html viewport meta', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const meta = html.match(/<meta\s+name="viewport"\s+content="([^"]*)"/)?.[1] ?? ''

  it('asks the browser to resize the content for the soft keyboard', () => {
    expect(meta).toContain('interactive-widget=resizes-content')
    expect(meta).toContain('width=device-width')
    expect(meta).toContain('viewport-fit=cover')
  })

  it('never forbids zooming the page', () => {
    expect(meta).not.toMatch(/maximum-scale/)
    expect(meta).not.toMatch(/user-scalable/)
  })
})
