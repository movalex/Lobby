// Helpers of the wave Q WS3 specs (q3-*.spec.ts): the Elements panel turned on for a page (a dev-auth override, as the
// speed flags are: localStorage lobby.elementsPanel = '1' before the board's features load), and a route double of
// WS2's library api (docs/WAVE-Q-CONTRACTS.md §2.1), in the page, until WS2's routes land: an in-memory library per
// page that answers the contract's shapes (items, folders, marks, /place) and records every request.
import type { BrowserContext, Page, Request, Route } from '@playwright/test'
import { expect, waitForCanvas } from '../tests/support/canvas.ts'
import { API_URL, WEB_URL } from '../tests/support/ports.ts'

export const ELEMENTS_PANEL_KEY = 'lobby.elementsPanel'

/** Every later page load of `context` has the Elements panel (dev-auth builds only, so the e2e build). */
export async function elementsPanelOn(context: Pick<BrowserContext, 'addInitScript'>): Promise<void> {
  await context.addInitScript((key) => {
    try {
      localStorage.setItem(key, '1')
    } catch {
      // no storage: the page runs the shipped value
    }
  }, ELEMENTS_PANEL_KEY)
}

/** Turns the panel on for `page`'s context and reloads the board (the fixture's open has already happened). */
export async function reloadWithElements(page: Page): Promise<void> {
  await elementsPanelOn(page.context())
  await page.reload()
  await waitForCanvas(page)
  await expect(page.getByTestId('dock-tab-elements')).toBeVisible({ timeout: 30_000 })
}

export async function openElements(page: Page): Promise<void> {
  const panel = page.getByTestId('elements-panel')
  if (await panel.isVisible()) return
  await page.getByTestId('dock-tab-elements').click()
  await expect(panel).toBeVisible()
}

export const tab = (page: Page, id: 'icons' | 'shapes' | 'library') =>
  page.locator(`[data-testid="element-tab"][data-tab="${id}"]`)
export const tile = (page: Page, source: 'icon' | 'piece' | 'item', id: string) =>
  page.locator(`[data-testid="element-tile"][data-source="${source}"][data-tile-id="${id}"]`).first()
export const tileIds = (page: Page) =>
  page
    .getByTestId('element-section-results')
    .getByTestId('element-tile')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-tile-id')))

/** Every request of the page that left Lobby's own origins (none may: the e2e network assertion). */
export function foreignRequests(page: Page): string[] {
  const own = new Set([new URL(WEB_URL).origin, new URL(API_URL).origin])
  const foreign: string[] = []
  page.on('request', (r: Request) => {
    const url = new URL(r.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return
    if (!own.has(url.origin)) foreign.push(r.url())
  })
  return foreign
}

// ---- the library double ------------------------------------------------------------------------------------------

type Json = Record<string, unknown>

export interface DoubleItem {
  summary: Json
  elements: Json[]
}

export interface LibraryDouble {
  readonly items: Map<string, DoubleItem>
  readonly folders: Map<string, Json>
  readonly marks: Map<string, { favourite: boolean; usedAt: string | null }>
  /** `METHOD path` of every library request, in order */
  readonly requests: string[]
  /** the bodies of POST …/library/items */
  readonly saves: Json[]
  /** answer this code to the next save (an api refusal) */
  refuseNextSave: { status: number; code: string } | null
}

const alnum = () => {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 20; i++) s += c[Math.floor(Math.random() * c.length)]
  return s
}

const LIST = /\/api\/workspaces\/([^/]+)\/library(?:\/(items|folders|marks|import)(?:\/([^/?]+)(?:\/(restore))?)?)?(?:\?.*)?$/
const PLACE = /\/api\/boards\/([^/]+)\/library\/items\/([^/]+)\/place$/

/** Installs the double on `page` (both the workspace routes and the board's /place). */
export async function libraryDouble(page: Page, opts: { canEdit?: boolean } = {}): Promise<LibraryDouble> {
  const d: LibraryDouble = {
    items: new Map(),
    folders: new Map(),
    marks: new Map(),
    requests: [],
    saves: [],
    refuseNextSave: null,
  }
  const now = () => new Date().toISOString()
  const json = (route: Route, status: number, body?: unknown) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: body === undefined ? '' : JSON.stringify(body),
    })
  const fail = (route: Route, status: number, code: string) =>
    json(route, status, { error: { code, message: code } })

  await page.route(LIST, async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const m = LIST.exec(url.pathname + url.search)
    if (!m) return route.fallback()
    const [, , kind, id, restore] = m
    const method = req.method()
    d.requests.push(`${method} ${url.pathname}${url.search}`)
    const body = (req.postDataJSON() ?? {}) as Json
    if (!kind && method === 'GET') {
      const scope = url.searchParams.get('scope') ?? 'workspace'
      const folder = url.searchParams.get('folder')
      const deleted = url.searchParams.get('deleted') === '1'
      const items = [...d.items.values()]
        .map((i) => i.summary)
        .filter((s) => s.scope === scope && (deleted ? !!s.deletedAt : !s.deletedAt))
        .filter((s) => !folder || (folder === 'none' ? s.folderId === null : s.folderId === folder))
        .reverse()
      return json(route, 200, { items, nextCursor: null })
    }
    if (kind === 'items') {
      if (!id && method === 'POST') {
        if (d.refuseNextSave) {
          const r = d.refuseNextSave
          d.refuseNextSave = null
          return fail(route, r.status, r.code)
        }
        d.saves.push(body)
        const elements = body.elements as Json[]
        const summary: Json = {
          id: `lbi_${alnum()}`,
          scope: body.scope,
          folderId: body.folderId ?? null,
          name: body.name,
          tags: body.tags ?? [],
          elementCount: elements.length,
          imageCount: elements.filter((e) => e.type === 'image').length,
          width: Math.max(1, ...elements.map((e) => Number(e.x) + Number(e.width))),
          height: Math.max(1, ...elements.map((e) => Number(e.y) + Number(e.height))),
          internalOnly: false,
          revision: 1,
          sourceKind: 'board',
          createdBy: null,
          createdAt: now(),
          updatedAt: now(),
          deletedAt: null,
          canEdit: opts.canEdit ?? true,
        }
        d.items.set(summary.id as string, { summary, elements })
        return json(route, 201, summary)
      }
      const item = id ? d.items.get(id) : undefined
      if (!item) return fail(route, 404, 'NOT_FOUND')
      if (restore && method === 'POST') {
        item.summary = { ...item.summary, deletedAt: null, revision: Number(item.summary.revision) + 1 }
        return json(route, 200, item.summary)
      }
      if (method === 'GET')
        return json(route, 200, {
          ...item.summary,
          elements: item.elements,
          files: [],
          source: { kind: 'board', boardId: 'b-source' },
        })
      if (method === 'PATCH') {
        if (body.revision !== item.summary.revision) return fail(route, 409, 'LIBRARY_STALE_REVISION')
        const { revision: _r, sourceBoardId: _s, ...patch } = body
        item.summary = { ...item.summary, ...patch, revision: Number(item.summary.revision) + 1, updatedAt: now() }
        return json(route, 200, item.summary)
      }
      if (method === 'DELETE') {
        item.summary = { ...item.summary, deletedAt: now() }
        return route.fulfill({ status: 204, body: '' })
      }
    }
    if (kind === 'folders') {
      if (!id && method === 'GET') {
        const scope = url.searchParams.get('scope') ?? 'workspace'
        const folders = [...d.folders.values()].filter((f) => f.scope === scope)
        return json(route, 200, { folders })
      }
      if (!id && method === 'POST') {
        const f: Json = {
          id: `lbf_${alnum()}`,
          scope: body.scope,
          name: body.name,
          position: d.folders.size,
          itemCount: 0,
          canEdit: true,
        }
        d.folders.set(f.id as string, f)
        return json(route, 201, f)
      }
      const f = id ? d.folders.get(id) : undefined
      if (!f) return fail(route, 404, 'NOT_FOUND')
      if (method === 'PATCH') {
        Object.assign(f, body)
        return json(route, 200, f)
      }
      if (method === 'DELETE') {
        d.folders.delete(f.id as string)
        for (const i of d.items.values()) if (i.summary.folderId === f.id) i.summary.folderId = null
        return route.fulfill({ status: 204, body: '' })
      }
    }
    if (kind === 'marks') {
      if (method === 'GET') {
        const all = [...d.marks.entries()].map(([key, v]) => ({ key, ...v }))
        return json(route, 200, {
          favourites: all.filter((m) => m.favourite),
          recents: all.filter((m) => m.usedAt).sort((a, b) => String(b.usedAt).localeCompare(String(a.usedAt))),
        })
      }
      if (method === 'PUT') {
        const key = body.key as string
        const m = d.marks.get(key) ?? { favourite: false, usedAt: null }
        if (typeof body.favourite === 'boolean') m.favourite = body.favourite
        if (body.used) m.usedAt = now()
        d.marks.set(key, m)
        return json(route, 200, { key, ...m })
      }
    }
    return fail(route, 404, 'NOT_FOUND')
  })

  await page.route(PLACE, async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    d.requests.push(`${req.method()} ${url.pathname}`)
    const m = PLACE.exec(url.pathname)
    const item = m?.[2] ? d.items.get(m[2]) : undefined
    if (!item || item.summary.deletedAt) return fail(route, 404, 'NOT_FOUND')
    return json(route, 200, {
      item: { id: item.summary.id, name: item.summary.name, revision: item.summary.revision },
      elements: item.elements,
      files: [],
    })
  })
  return d
}
