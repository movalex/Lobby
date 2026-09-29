// O2's helpers for its spike B check specs (b2-*, b3-*, b4-client-*, b5-r3-*). Built only on the frozen
// harness contract (../support/types.ts, `harness` from ../support/harness.ts), the frozen facade
// (`window.lobbyCanvas`, apps/web/src/canvas/test-facade.types.ts) and O2's own debug handle on the spike
// board page (`window.__lobbyBoard`: the engine core, the lease client, the input layer, undo).
//
// Every check: separate Chromium processes signed in as different dev users (harness.launchBrowser),
// one board, and after every repetition every map (tombstones included) hashes equal to the test
// snapshot and the invariant checker finds nothing (converge()).
import { expect, type Page } from '@playwright/test'
import type { Bounds, CanvasElement, ItemKind, ScenePoint } from '../../../apps/web/src/canvas/port.ts'
import type { PushRecord, SaveStatus } from '../../../apps/web/src/canvas/sync/types.ts'
import type { LeaseStateView, LobbyCanvasFacade } from '../../../apps/web/src/canvas/test-facade.types.ts'
import type { Op } from '../../../packages/canvas-schema/src/protocol.ts'
import { harness } from '../support/harness.ts'
import type { BrowserProcess, SpikeBStack } from '../support/types.ts'

export const REPS = (name: string, fallback: number) =>
  Number(process.env[`SPIKE_${name}_REPS`] ?? process.env.SPIKE_REPS ?? fallback)

// ---- the facade, typed, through page.evaluate --------------------------------------------------------

type FacadeFn = keyof LobbyCanvasFacade

async function call<K extends FacadeFn>(
  page: Page,
  fn: K,
  ...args: Parameters<LobbyCanvasFacade[K]>
): Promise<Awaited<ReturnType<LobbyCanvasFacade[K]>>> {
  return page.evaluate(
    async ({ fn, args }) => {
      const f = window.lobbyCanvas
      if (!f) throw new Error('no window.lobbyCanvas (O3 facade not installed)')
      return await (f[fn as keyof typeof f] as (...a: unknown[]) => unknown)(...args)
    },
    { fn: fn as string, args: args as unknown[] },
  ) as never
}

/** The facade verbs of one page. */
export function lc(page: Page) {
  return {
    create: (kind: ItemKind, props: Record<string, unknown>) =>
      call(page, 'create', kind, props) as Promise<string>,
    update: (id: string, patch: Record<string, unknown>) => call(page, 'update', id, patch),
    delete: (id: string) => call(page, 'delete', id),
    get: (id: string) => call(page, 'get', id) as Promise<CanvasElement | null>,
    items: () => call(page, 'items') as Promise<CanvasElement[]>,
    select: (ids: string[]) => call(page, 'select', ids),
    selection: () => call(page, 'selection') as Promise<string[]>,
    setTool: (t: string) => call(page, 'setTool', t) as Promise<boolean>,
    tool: () => call(page, 'tool') as Promise<string | null>,
    bounds: (id: string) => call(page, 'bounds', id) as Promise<Bounds | null>,
    sceneToScreen: (p: ScenePoint) => call(page, 'sceneToScreen', p) as Promise<ScenePoint>,
    editingId: () => call(page, 'editingId') as Promise<string | null>,
    leaseState: () => call(page, 'leaseState') as Promise<LeaseStateView>,
    saveState: () => call(page, 'saveState') as Promise<SaveStatus>,
    hash: () => call(page, 'hash') as Promise<string>,
    pushedOps: () => call(page, 'pushedOps') as Promise<PushRecord[]>,
    zoomToFit: () => call(page, 'zoomToFit'),
  }
}

/** O2's debug handle: one expression over `window.__lobbyBoard` (session, core, port, api, lease, input, undo). */
export function board<T, A = null>(
  page: Page,
  // biome-ignore lint/suspicious/noExplicitAny: the page-side handle is typed in apps/web
  fn: (b: any, arg: A) => T | Promise<T>,
  arg?: A,
): Promise<T> {
  const expr = `(async () => {
    const b = window.__lobbyBoard
    if (!b) throw new Error('no window.__lobbyBoard')
    return await (${fn.toString()})(b, ${JSON.stringify(arg ?? null)})
  })()`
  return page.evaluate(expr) as Promise<T>
}

// ---- setup ------------------------------------------------------------------------------------------

export interface Room {
  readonly stack: SpikeBStack
  readonly boardId: string
  readonly browsers: BrowserProcess[]
  readonly by: Readonly<Record<string, BrowserProcess>>
  close(): Promise<void>
}

/**
 * A stack, one browser process per name (a distinct dev user each), a board owned by the first and
 * shared with the others at `role` (default editor), opened in every browser.
 */
export async function room(
  names: string[],
  o: {
    roles?: Record<string, 'editor' | 'commenter' | 'viewer'>
    touch?: string[]
    viewport?: Record<string, { width: number; height: number }>
    /** another room's stack (one stack per port base): this room's close() then leaves it running */
    stack?: SpikeBStack
  } = {},
): Promise<Room> {
  const stack = o.stack ?? (await harness.startStack())
  const browsers: BrowserProcess[] = []
  for (const name of names)
    browsers.push(
      await harness.launchBrowser(stack, harness.devUser(name), {
        name,
        touch: o.touch?.includes(name),
        viewport: o.viewport?.[name],
      }),
    )
  const [owner, ...rest] = browsers as [BrowserProcess, ...BrowserProcess[]]
  const { boardId } = await stack.createBoard({
    owner: owner.user,
    members: rest.map((b) => ({ user: b.user, role: o.roles?.[b.name] ?? 'editor' })),
    title: `O2 ${names.join('')}`,
  })
  for (const b of browsers) await b.openBoard(boardId)
  const by = Object.fromEntries(browsers.map((b) => [b.name, b]))
  return {
    stack,
    boardId,
    browsers,
    by,
    close: async () => {
      for (const b of browsers) await b.close().catch(() => {})
      if (!o.stack) await stack.stop()
    },
  }
}

// ---- waits ------------------------------------------------------------------------------------------

export async function waitSaved(page: Page, timeout = 30_000): Promise<void> {
  await expect.poll(async () => (await lc(page).saveState()).state, { timeout }).toBe('saved')
}

export async function allSaved(bs: readonly BrowserProcess[], timeout = 30_000): Promise<void> {
  for (const b of bs) await waitSaved(b.page, timeout)
}

/** Resolves when `id` is in every browser's map (optionally with `pred` true on it). */
export async function everywhere(
  bs: readonly BrowserProcess[],
  id: string,
  pred?: (el: CanvasElement) => boolean,
  timeout = 15_000,
): Promise<void> {
  for (const b of bs)
    await expect
      .poll(
        async () => {
          const el = await lc(b.page).get(id)
          return !!el && (!pred || pred(el))
        },
        { timeout },
      )
      .toBe(true)
}

/** Every map (tombstones included) equals the test snapshot, and the invariants hold. */
export async function converge(r: Room, bs: readonly BrowserProcess[] = r.browsers, horizonAtStart?: number) {
  await allSaved(bs)
  const report = await harness.converged(r.stack, r.boardId, bs, { horizonAtStart, timeoutMs: 20_000 })
  const inv = harness.checkInvariants(report.snapshot)
  expect(report.horizonMoved, 'no compaction inside the check window').toBe(false)
  if (!report.ok) {
    // say which elements and fields differ (ids, field names and geometry numbers; test data only)
    const diffs: Record<string, unknown> = {}
    for (const b of bs)
      if (report.hashes[b.name] !== report.snapshot.hash)
        diffs[b.name] = await divergence(
          b.page,
          report.snapshot.elements as unknown as Record<string, unknown>[],
        )
    expect(
      report.ok,
      `hashes ${JSON.stringify(report.hashes)} vs ${report.snapshot.hash}; ${JSON.stringify(diffs)}`,
    ).toBe(true)
  }
  expect(inv.violations, 'invariants').toEqual([])
  return report
}

/** How a page's engine map differs from the snapshot: per element id, the differing fields (both values). */
export async function divergence(
  page: Page,
  snapshot: readonly Record<string, unknown>[],
): Promise<Record<string, Record<string, [unknown, unknown]>>> {
  const mine = await board(page, (b) =>
    [...(b.core.elements() as Map<string, Record<string, unknown>>).values()].map((e) =>
      JSON.parse(JSON.stringify(e)),
    ),
  )
  const by = new Map(mine.map((e: Record<string, unknown>) => [e.id as string, e]))
  const out: Record<string, Record<string, [unknown, unknown]>> = {}
  const ids = new Set([...by.keys(), ...snapshot.map((e) => e.id as string)])
  for (const id of ids) {
    const a = by.get(id) ?? {}
    const s = snapshot.find((e) => e.id === id) ?? {}
    for (const k of new Set([...Object.keys(a), ...Object.keys(s)])) {
      if (k === 'status') continue
      if (JSON.stringify(a[k]) !== JSON.stringify(s[k])) {
        out[id] ??= {}
        ;(out[id] as Record<string, [unknown, unknown]>)[k] = [a[k], s[k]]
      }
    }
  }
  // the core's bookkeeping for the diverging ids (a debugging aid: private fields, read at runtime)
  const state = await board(
    page,
    (b, ids: string[]) => {
      const c = b.core
      return Object.fromEntries(
        ids.map((id) => [
          id,
          {
            type: c.current?.get(id)?.type,
            tracked: c.tracked?.get(id)
              ? { ...c.tracked.get(id), dirty: [...c.tracked.get(id).dirty] }
              : null,
            inflight: c.inflight?.some((p: { sent: Map<string, unknown> }) => p.sent.has(id)) ?? null,
            held: c.held?.get(id) ?? null,
            known: c.known?.get(id) ?? null,
            editingLabel: c.editingLabel ?? null,
          },
        ]),
      )
    },
    Object.keys(out),
  )
  for (const [id, s] of Object.entries(state)) (out[id] as Record<string, unknown>).__core = [s, null]
  return out
}

/** A client (viewport) point at the centre of an element. */
export async function centre(page: Page, id: string): Promise<{ x: number; y: number }> {
  const b = await lc(page).bounds(id)
  if (!b) throw new Error(`no bounds for ${id}`)
  return lc(page).sceneToScreen({ x: b.x + b.width / 2, y: b.y + b.height / 2 })
}

/** A client point at scene `p`. */
export const screenOf = (page: Page, p: ScenePoint) => lc(page).sceneToScreen(p)

/** Every toast the page showed so far, in order (the session's log: the screen keeps only the last few). */
export const toasts = (page: Page) =>
  board(page, (b) => (b.session.toastLog as { text: string }[]).map((t) => t.text) as string[])

/** Ops a page pushed since `from` (a pushedOps length) that write `id`. */
export async function opsFor(page: Page, id: string, from = 0): Promise<Op[]> {
  const log = await lc(page).pushedOps()
  return log
    .slice(from)
    .flatMap((p) => [...p.ops])
    .filter((o) => (o.k === 'c' ? o.el.id : o.id) === id)
}

export const pushCount = async (page: Page) => (await lc(page).pushedOps()).length

/** A note (with its label when `text` is given), created by `page`, seen by `bs`, saved. */
export async function note(
  page: Page,
  bs: readonly BrowserProcess[],
  at: { x: number; y: number },
  text?: string,
): Promise<{ id: string; label: string | null }> {
  const id = await lc(page).create('note', { x: at.x, y: at.y, ...(text !== undefined ? { text } : {}) })
  await everywhere(bs, id)
  await allSaved(bs)
  const el = await lc(page).get(id)
  const label =
    (el?.boundElements as { id: string; type: string }[] | null | undefined)?.find((b) => b.type === 'text')
      ?.id ?? null
  return { id, label }
}

/** The label text of a note in a page's map. */
export async function labelText(page: Page, labelId: string | null): Promise<string | null> {
  if (!labelId) return null
  const el = (await lc(page).get(labelId)) as (CanvasElement & { originalText?: string }) | null
  return el?.originalText ?? null
}

/** The editor state (EditorLease) of a page. */
export const editorState = (page: Page) =>
  board(page, (b) => ({
    phase: b.input.editorLease?.phase ?? 'idle',
    leaseId: b.input.editorLease?.leaseId ?? null,
    origin: b.input.editorLease?.origin ?? null,
    textareas: document.querySelectorAll('textarea.excalidraw-wysiwyg').length,
    readOnly: document.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg')?.readOnly ?? null,
    value: document.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg')?.value ?? null,
  }))

export async function waitEditor(
  page: Page,
  pred: (e: Awaited<ReturnType<typeof editorState>>) => boolean,
  timeout = 10_000,
): Promise<Awaited<ReturnType<typeof editorState>>> {
  let last: Awaited<ReturnType<typeof editorState>> | null = null
  await expect
    .poll(
      async () => {
        last = await editorState(page)
        return pred(last)
      },
      { timeout },
    )
    .toBe(true)
  return last as unknown as Awaited<ReturnType<typeof editorState>>
}

/** Focuses the canvas (as a click on it would) so keys go to the board. */
export const focusCanvas = (page: Page) =>
  page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())

/** Opens the editor on a note through P1 (select, Enter) and waits for it to be writable. */
export async function openEditor(page: Page, noteId: string): Promise<void> {
  await lc(page).select([noteId])
  await focusCanvas(page)
  await page.keyboard.press('Enter')
  await waitEditor(page, (e) => e.phase === 'open' && e.leaseId === noteId && e.readOnly === false)
}

/** Closes the editor (Escape) and waits until the session is idle and Saved. */
export async function closeEditor(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await waitEditor(page, (e) => e.phase === 'idle' && e.textareas === 0)
  await waitSaved(page)
}

/** Wall-clock milliseconds, shared by every process on the machine. */
export const wall = () => Date.now()

/** Fits the page's view to these elements (Lobby's own fit), so pointer input lands on them. */
export async function show(page: Page, ids: string[]): Promise<void> {
  await board(page, (b, a) => b.port.viewport.fit(a), ids)
  await page.waitForTimeout(50)
}

// ---- the editor-open paths (L2, L9, L11) -----------------------------------------------------------

/** Every way the text editor opens on a note (§2.9.2): P1 Enter, P3 double-click body and label (P3b), P2
 * type-to-edit, P5 a second click on a selected note's label, P4 a touch double-tap, the text tool, and a
 * double-click on an arrow (its label). */
export type EditPath =
  | 'enter'
  | 'dbl-body'
  | 'dbl-label'
  | 'type'
  | 'p5'
  | 'double-tap'
  | 'text-tool'
  | 'arrow-dbl'
export const EDIT_PATHS: EditPath[] = [
  'enter',
  'dbl-body',
  'dbl-label',
  'type',
  'p5',
  'double-tap',
  'text-tool',
  'arrow-dbl',
]

/** Uses `path` on `target` (or on `arrowId` for 'arrow-dbl') in `page`, then types `keys` at once. */
export async function tryPath(
  page: Page,
  path: EditPath,
  target: { id: string; label: string | null },
  arrowId: string,
  keys = 'zz',
): Promise<void> {
  const b = page
  await show(b, [target.id])
  const bb = await lc(b).bounds(target.id)
  const body = await screenOf(b, { x: (bb?.x ?? 0) + 18, y: (bb?.y ?? 0) + 18 })
  const lab = target.label ? await centre(b, target.label) : await centre(b, target.id)
  switch (path) {
    case 'enter':
      await lc(b).select([target.id])
      await focusCanvas(b)
      await b.keyboard.press('Enter')
      break
    case 'dbl-body':
      await b.mouse.dblclick(body.x, body.y)
      break
    case 'dbl-label':
      await lc(b).select([])
      await b.mouse.dblclick(lab.x, lab.y)
      break
    case 'type':
      await lc(b).select([target.id])
      await focusCanvas(b)
      await b.keyboard.press('q')
      break
    case 'p5':
      await b.mouse.click(body.x, body.y)
      await b.waitForTimeout(600)
      await b.mouse.click(lab.x, lab.y)
      break
    case 'double-tap':
      await b.touchscreen.tap(lab.x, lab.y)
      await b.waitForTimeout(60)
      await b.touchscreen.tap(lab.x, lab.y)
      break
    case 'text-tool':
      await lc(b).setTool('text')
      await b.mouse.click(lab.x, lab.y)
      await lc(b).setTool('select')
      break
    case 'arrow-dbl': {
      await show(b, [arrowId])
      const a = await centre(b, arrowId)
      await lc(b).select([])
      await b.mouse.dblclick(a.x, a.y)
      break
    }
  }
  if (keys) await b.keyboard.type(keys)
}
