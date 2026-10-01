// The first view's `?template=` on the new canvas (PRE-06; LEAD-2): the dashboard's parameter and the tab's
// "inserted" marker are consumed only once the insert went in. A first open whose insert fails keeps both,
// so the next open (or the notice's retry) inserts the template; before, the board stayed empty for good.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../../canvas/api/index.ts'
import { templateInsertedKey } from '../../start-view.ts'
import { applyStartView } from './start-view.ts'
import { insertTemplate } from './template-insert.ts'

vi.mock('./template-insert.ts', () => ({ insertTemplate: vi.fn() }))

const BOARD = 'b-3k9x0q2m7a'
const USER = 'usr_alice'

/** A page: the address bar, history and both storages, as the start view reads them. */
function fakePage(href: string) {
  const session = new Map<string, string>()
  const local = new Map<string, string>()
  const storage = (m: Map<string, string>) => ({
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  })
  const page = {
    href,
    session,
    window: {
      location: {
        get href() {
          return page.href
        },
      },
      history: {
        state: null,
        replaceState: (_s: unknown, _t: string, to: string) => {
          page.href = new URL(to, href).href
        },
      },
    },
  }
  vi.stubGlobal('window', page.window)
  vi.stubGlobal('sessionStorage', storage(session))
  vi.stubGlobal('localStorage', storage(local))
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0))
  vi.stubGlobal('cancelAnimationFrame', (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  return page
}

/** An empty board's canvas, only what applyStartView touches. */
function fakeCanvas(): LobbyCanvas {
  const view = { x: 0, y: 0, width: 1000, height: 600, zoom: 1 }
  const canvas = {
    items: () => [],
    get: () => null,
    bounds: () => null,
    boundsOf: () => null,
    isHidden: () => false,
    readOnly: () => false,
    selection: [] as string[],
    select: () => {},
    on: () => () => {},
    doc: { get: () => null },
    viewport: {
      get: () => ({ ...view }),
      set: () => {},
      zoomTo: () => {},
      limits: () => ({ min: 0.1, max: 30 }),
    },
  }
  return canvas as unknown as LobbyCanvas
}

const insert = vi.mocked(insertTemplate)
const ok = { ok: true as const, ids: ['a'], bounds: { x: 0, y: 0, width: 10, height: 10 } }
const failed = { ok: false as const, reason: 'failed' as const }

describe('?template= on the new canvas', () => {
  beforeEach(() => insert.mockReset())
  afterEach(() => vi.unstubAllGlobals())

  it('an insert that fails keeps the param and the marker, and the failure offers a retry that consumes them once it succeeds', async () => {
    const page = fakePage(`http://lobby.test/b/${BOARD}?template=retrospective`)
    const canvas = fakeCanvas()
    insert.mockResolvedValueOnce(failed).mockResolvedValueOnce(ok)
    let retry: (() => Promise<boolean>) | null = null
    const did = await applyStartView({ canvas } as CanvasFeatureContext, {
      boardId: BOARD,
      userId: USER,
      canEdit: true,
      onTemplateFailed: (r) => {
        retry = r
      },
    })
    expect(did).toBe('template:retrospective')
    expect(insert).toHaveBeenCalledTimes(1)
    // nothing consumed: the next open of this address inserts it, and the tab is not marked
    expect(new URL(page.href).searchParams.get('template')).toBe('retrospective')
    expect(page.session.get(templateInsertedKey(BOARD))).toBeUndefined()
    expect(retry).not.toBeNull()
    // the notice's retry: this time it goes in, and only then are the param and the marker consumed
    expect(await (retry as unknown as () => Promise<boolean>)()).toBe(true)
    expect(insert).toHaveBeenCalledTimes(2)
    expect(new URL(page.href).searchParams.has('template')).toBe(false)
    expect(page.session.get(templateInsertedKey(BOARD))).toBe('1')
  })

  it('an insert that goes in on the first open consumes the param and marks the tab', async () => {
    const page = fakePage(`http://lobby.test/b/${BOARD}?template=retrospective&el=x1`)
    insert.mockResolvedValueOnce(ok)
    const failures: unknown[] = []
    const did = await applyStartView({ canvas: fakeCanvas() } as CanvasFeatureContext, {
      boardId: BOARD,
      userId: USER,
      canEdit: true,
      onTemplateFailed: (r) => failures.push(r),
    })
    expect(did).toBe('template:retrospective')
    expect(failures).toEqual([])
    expect(new URL(page.href).search).toBe('')
    expect(page.session.get(templateInsertedKey(BOARD))).toBe('1')
  })

  it('when the template is not to be inserted (a viewer), the param is dropped at once and nothing is marked', async () => {
    const page = fakePage(`http://lobby.test/b/${BOARD}?template=retrospective`)
    const did = await applyStartView({ canvas: fakeCanvas() } as CanvasFeatureContext, {
      boardId: BOARD,
      userId: USER,
      canEdit: false,
    })
    expect(did).toBe('none')
    expect(insert).not.toHaveBeenCalled()
    expect(new URL(page.href).search).toBe('')
    expect(page.session.get(templateInsertedKey(BOARD))).toBeUndefined()
  })
})
