// Typed Node-side access to a page's `window.lobbyCanvas` (the frozen §6.3 facade, O3's
// apps/web/src/canvas/test-facade.ts) and to `window.__lobbyHarness` (O3's side channel on the same
// install: the session, every element with tombstones, the camera, the change log and the paint watch).
// Specs may call `page.evaluate(() => window.lobbyCanvas!.…)` directly; these wrappers save the
// boilerplate and keep the calls typed.
import type { Page } from '@playwright/test'
import type {
  Bounds,
  CanvasElement,
  ItemKind,
  ScenePoint,
  ScreenPoint,
  Viewport,
} from '../../../apps/web/src/canvas/port.ts'
import type { PushRecord, SaveStatus, SceneElement } from '../../../apps/web/src/canvas/sync/types.ts'
import type {
  FacadeSession,
  LobbyHarnessHooks,
  WatchResult,
  WatchSpec,
} from '../../../apps/web/src/canvas/test-facade.ts'
import type { LeaseStateView, LobbyCanvasFacade } from '../../../apps/web/src/canvas/test-facade.types.ts'

declare global {
  interface Window {
    __lobbyHarness?: LobbyHarnessHooks
  }
}

export type { FacadeSession, LeaseStateView, LobbyCanvasFacade, WatchResult, WatchSpec }

/** The facade verbs as async Node calls on one page (the page must have opened the board). */
export function canvasOf(page: Page) {
  return {
    items: () => page.evaluate(() => (window.lobbyCanvas as LobbyCanvasFacade).items()),
    get: (id: string) => page.evaluate((id) => (window.lobbyCanvas as LobbyCanvasFacade).get(id), id),
    create: (kind: ItemKind, props: Record<string, unknown>) =>
      page.evaluate(({ kind, props }) => (window.lobbyCanvas as LobbyCanvasFacade).create(kind, props), {
        kind,
        props,
      }),
    update: (id: string, patch: Record<string, unknown>) =>
      page.evaluate(({ id, patch }) => (window.lobbyCanvas as LobbyCanvasFacade).update(id, patch), {
        id,
        patch,
      }),
    delete: (id: string) => page.evaluate((id) => (window.lobbyCanvas as LobbyCanvasFacade).delete(id), id),
    select: (ids: string[]) =>
      page.evaluate((ids) => (window.lobbyCanvas as LobbyCanvasFacade).select(ids), ids),
    selection: () => page.evaluate(() => (window.lobbyCanvas as LobbyCanvasFacade).selection()),
    tool: () => page.evaluate(() => (window.lobbyCanvas as LobbyCanvasFacade).tool()),
    setTool: (tool: string) =>
      page.evaluate((tool) => (window.lobbyCanvas as LobbyCanvasFacade).setTool(tool), tool),
    sceneToScreen: (p: ScenePoint): Promise<ScreenPoint> =>
      page.evaluate((p) => (window.lobbyCanvas as LobbyCanvasFacade).sceneToScreen(p), p),
    bounds: (id: string): Promise<Bounds | null> =>
      page.evaluate((id) => (window.lobbyCanvas as LobbyCanvasFacade).bounds(id), id),
    zoomToFit: () => page.evaluate(() => (window.lobbyCanvas as LobbyCanvasFacade).zoomToFit()),
    editingId: () => page.evaluate(() => (window.lobbyCanvas as LobbyCanvasFacade).editingId()),
    leaseHolder: (id: string) =>
      page.evaluate((id) => (window.lobbyCanvas as LobbyCanvasFacade).leaseHolder(id), id),
    collaborators: () => page.evaluate(() => (window.lobbyCanvas as LobbyCanvasFacade).collaborators()),
    saveState: (): Promise<SaveStatus> =>
      page.evaluate(() => (window.lobbyCanvas as LobbyCanvasFacade).saveState()),
    hash: () => page.evaluate(() => (window.lobbyCanvas as LobbyCanvasFacade).hash()),
    pushedOps: (): Promise<PushRecord[]> =>
      page.evaluate(() => (window.lobbyCanvas as LobbyCanvasFacade).pushedOps()),
    leaseState: (): Promise<LeaseStateView> =>
      page.evaluate(() => (window.lobbyCanvas as LobbyCanvasFacade).leaseState()),

    // ---- O3's side channel ----
    session: (): Promise<FacadeSession> =>
      page.evaluate(() => (window.__lobbyHarness as LobbyHarnessHooks).session()),
    allElements: (): Promise<SceneElement[]> =>
      page.evaluate(() => (window.__lobbyHarness as LobbyHarnessHooks).allElements()),
    viewport: (): Promise<Viewport> =>
      page.evaluate(() => (window.__lobbyHarness as LobbyHarnessHooks).viewport()),
    setViewport: (v: Partial<Pick<Viewport, 'x' | 'y' | 'zoom'>>) =>
      page.evaluate((v) => (window.__lobbyHarness as LobbyHarnessHooks).setViewport(v), v),
    fit: (ids?: string[]) =>
      page.evaluate((ids) => (window.__lobbyHarness as LobbyHarnessHooks).fit(ids), ids),
    watch: (spec: WatchSpec, timeoutMs?: number): Promise<WatchResult> =>
      page.evaluate(
        ({ spec, timeoutMs }) => (window.__lobbyHarness as LobbyHarnessHooks).watch(spec, timeoutMs),
        { spec, timeoutMs },
      ),
    measures: (clear = false) =>
      page.evaluate((clear) => (window.__lobbyHarness as LobbyHarnessHooks).measures(clear), clear),
  }
}

export type CanvasClient = ReturnType<typeof canvasOf>

/** Waits until this tab shows "Saved" (§2.5.7): nothing dirty, in flight or queued. */
export async function waitSaved(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    () => (window.lobbyCanvas as LobbyCanvasFacade | undefined)?.saveState().state === 'saved',
    undefined,
    { timeout, polling: 50 },
  )
}

/** Waits until `get(id)` satisfies `predicate` on the page (evaluated in the page; JSON-safe arg). */
export async function waitElement(
  page: Page,
  id: string,
  predicate: (el: CanvasElement | null, arg: unknown) => boolean,
  arg?: unknown,
  timeout = 30_000,
): Promise<void> {
  await page.waitForFunction(
    ({ id, src, arg }) => {
      const f = new Function(`return (${src})`)() as (el: unknown, arg: unknown) => boolean
      return f((window.lobbyCanvas as LobbyCanvasFacade | undefined)?.get(id) ?? null, arg)
    },
    { id, src: predicate.toString(), arg },
    { timeout, polling: 50 },
  )
}
