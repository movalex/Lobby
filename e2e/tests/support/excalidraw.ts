// Helpers for the cross-cutting PORTED specs (e2e/excalidraw/*.spec.ts: collab lifecycle, network
// interruption, conflicts, permissions, durability, the browser half of the negative security suite), on
// top of the frozen facade helpers of ./canvas.ts (docs/EXCALIDRAW-CONTRACTS.md §9). Owner: 2E.
//
//  - The server's view: the test snapshot (live elements AND tombstones; the sync server of an Excalidraw
//    stack runs with DRAFTROOM_TEST_HOOKS=1, see ./stack.ts EXCALIDRAW_SYNC_ENV), its convergence hash, and
//    the fail-commit and lease-grant hooks.
//  - Network loss: the page's board socket goes through a relay (spike B's `routeWebSocket` relay) that can
//    cut it and hold its reconnects; `goOffline` also takes the context offline (the api too, as a real
//    network drop), `goOnline` restores both.
//  - Forged frames: a raw WebSocket in the page with the page's own ticket (spike B's forge socket), so the
//    server's refusal is tested with no client code in the way (§6.3).
//  - Reads: an element's text or null (`labelText`), the welcome's session (`sessionInfo`), the Saved
//    state, pushes, chosen facts of an element.
//  - Keys: undo and redo through the real keyboard on the focused canvas.
//
// The relay and the forge socket are imported from e2e/spike-b/support while spike B runs; they are carried
// forward into this folder when spike B closes (plan §7.2, 2E), with no change to these signatures.
import { type Browser, expect, type Locator, type Page } from '@playwright/test'
import { hashElements } from '../../../packages/canvas-schema/src/hash.ts'
import {
  type LeaseHookRequest,
  TEST_HOOK_PATHS,
  TestSnapshot,
} from '../../../packages/canvas-schema/src/protocol.ts'
import { forgeSession, forgeSocket, freshHello, type O3ForgeSocket } from '../../spike-b/support/forge.ts'
import { attachRelay, cut, relayStats, restore } from '../../spike-b/support/relay.ts'
import { signInContext } from './api.ts'
import {
  type CanvasElement,
  type CanvasSession,
  canvasCall,
  hash,
  itemText,
  saveState,
  waitForCanvas,
} from './canvas.ts'
import { SYNC_URL } from './ports.ts'
import type { Stack } from './stack.ts'
import type { TestUser } from './users.ts'

export { forgeSession, forgeSocket, freshHello, type O3ForgeSocket as ForgeSocket, relayStats }

// ---- the server's view (test hooks) -------------------------------------------------------------------

export interface ServerSnapshot extends TestSnapshot {
  /** canvas-schema hash.ts over every element (tombstones included): what each tab's `hash()` must equal */
  readonly hash: string
}

function requireExcalidraw(stack: Stack): void {
  if (stack.engine !== 'excalidraw')
    throw new Error(
      'the test hooks exist only on an Excalidraw stack (run with e2e/excalidraw/playwright.config.ts)',
    )
}

async function internal(
  stack: Stack,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Response> {
  requireExcalidraw(stack)
  return fetch(`${SYNC_URL}${path}`, {
    method,
    headers: {
      'x-draftroom-internal': stack.internalSecret,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
}

/** The test snapshot of `board` (every live element and tombstone, `(id)` order) and its hash. */
export async function serverSnapshot(stack: Stack, board: string): Promise<ServerSnapshot> {
  const res = await internal(stack, 'GET', TEST_HOOK_PATHS.snapshot(board))
  if (res.status !== 200)
    throw new Error(`test snapshot of ${board}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const snap = TestSnapshot.parse(await res.json())
  return { ...snap, hash: await hashElements(snap.elements) }
}

/** One stored element (tombstones included), or null. */
export async function storedElement(stack: Stack, board: string, id: string): Promise<CanvasElement | null> {
  return ((await serverSnapshot(stack, board)).elements.find((e) => e.id === id) ??
    null) as CanvasElement | null
}

async function hook(stack: Stack, path: string, body: unknown): Promise<void> {
  const res = await internal(stack, 'POST', path, body)
  if (res.status !== 204) throw new Error(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
}

/** The room's next `count` COMMITs throw (D4: UNAVAILABLE, the room reopens, sessions reconnect). */
export const failNextCommits = (stack: Stack, board: string, count: number) =>
  hook(stack, TEST_HOOK_PATHS.failCommit(board), { count })

/** The next lease grants on `board` are delayed, held, released or normal again (B3 L12). */
export const leaseHook = (stack: Stack, board: string, body: LeaseHookRequest) =>
  hook(stack, TEST_HOOK_PATHS.leaseHook(board), body)

/**
 * Waits until every page's convergence hash equals the server's (the test snapshot, tombstones included):
 * the tabs agree with each other AND with what is stored.
 */
export async function expectServerConverged(
  stack: Stack,
  board: string,
  pages: readonly Page[],
  timeout = 20_000,
): Promise<ServerSnapshot> {
  let last: ServerSnapshot | null = null
  await expect
    .poll(
      async () => {
        last = await serverSnapshot(stack, board)
        const hashes = await Promise.all(pages.map((p) => hash(p)))
        const want = last.hash
        return hashes.filter((h) => h !== want).length
      },
      { timeout, message: 'tabs whose element map differs from the stored board' },
    )
    .toBe(0)
  return last as unknown as ServerSnapshot
}

// ---- reads the wave-1 facade will give -----------------------------------------------------------------

/**
 * The plain text of an element (a note's or shape's bound label, a text's own text, a frame's name), or
 * null when it has none or does not exist: ./canvas.ts `itemText` with null for ''.
 */
export async function labelText(page: Page, id: string): Promise<string | null> {
  const t = await itemText(page, id)
  return t === '' ? null : t
}

/** Who this tab is on the board, from its `welcome` (the harness channel; null fields before it). */
export async function sessionInfo(page: Page): Promise<{
  welcomed: boolean
  sid: string | null
  uid: string | null
  role: string | null
  guest: boolean | null
  readonly: boolean | null
}> {
  return page.evaluate(() => {
    const h = (window as unknown as { __lobbyHarness?: { session(): Record<string, unknown> } })
      .__lobbyHarness
    if (!h) throw new Error('window.__lobbyHarness is not installed (not the Excalidraw board page?)')
    return h.session() as never
  })
}

/** Waits for the Saved indicator's state (§2.5.7): saved, saving, offline, retrying, not-saved. */
export async function expectSaveState(page: Page, state: string, timeout = 30_000): Promise<void> {
  await expect.poll(async () => (await saveState(page)).state, { timeout, message: 'save state' }).toBe(state)
}

/** How many pushes this tab has sent (B10's recorder). */
export const pushCount = async (page: Page): Promise<number> => (await canvasCall(page, 'pushedOps')).length

/** Chosen facts of an element on a tab (null when it is not live there). */
export async function factsOf<K extends string>(
  page: Page,
  id: string,
  keys: readonly K[],
): Promise<Record<K, unknown> | null> {
  const el = (await canvasCall(page, 'get', id)) as Record<string, unknown> | null
  if (!el || el.isDeleted) return null
  return Object.fromEntries(keys.map((k) => [k, el[k]])) as Record<K, unknown>
}

// ---- sessions with a socket relay ----------------------------------------------------------------------

/**
 * `openCanvasSession` (./canvas.ts) with the page's board socket routed through the relay, so the test can
 * cut it (`goOffline`) and restore it (`goOnline`). The relay must be attached before the page opens the
 * board, which is why this is its own opener.
 */
export async function openRelayedCanvasSession(
  browser: Browser,
  board: string,
  user: TestUser,
): Promise<CanvasSession> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signInContext(context, user.handle, user.name)
  await attachRelay(page)
  await page.goto(`/b/${board}`)
  await waitForCanvas(page)
  const me = await canvasCall(page, 'me')
  expect(me?.uid, 'the welcome names this user').toBe(user.id)
  return { user: user.handle, name: user.name, id: user.id, context, page }
}

/**
 * A network drop for one tab: its board socket is cut and its reconnects are held (never answered), and
 * its context goes offline (a ticket refresh fails too). Needs `openRelayedCanvasSession`.
 */
export async function goOffline(s: CanvasSession): Promise<void> {
  await s.context.setOffline(true)
  await cut(s.page, { mode: 'hold' })
}

/** The network is back: the context goes online and the held socket is closed, so the page reconnects now. */
export async function goOnline(s: CanvasSession): Promise<void> {
  await s.context.setOffline(false)
  await restore(s.page)
}

// ---- keys and the board page's own UI ------------------------------------------------------------------

/** Gives the canvas the keyboard (the board's keys go to the focused Excalidraw container). */
export async function focusCanvas(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
}

/** Resolves after two animation frames: the engine's onChange for what the page just did has run. */
export const afterFrames = (page: Page): Promise<void> =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))

/**
 * Lobby's undo through the real key (Ctrl/Cmd+Z on the focused canvas), then two frames: an undo is
 * installed in the scene and recorded at the next onChange, so a second press before it would first
 * record the first undo's change as a step of its own (faster than any key repeat).
 */
export async function pressUndo(page: Page): Promise<void> {
  await focusCanvas(page)
  await page.keyboard.press('ControlOrMeta+z')
  await afterFrames(page)
}

/** Lobby's redo through the real key (Ctrl/Cmd+Shift+Z), then two frames (see pressUndo). */
export async function pressRedo(page: Page): Promise<void> {
  await focusCanvas(page)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await afterFrames(page)
}

/** The "you no longer have access" screen (today's app's test id, and the spike board page's). */
export const noAccessScreen = (page: Page): Locator =>
  page.locator('[data-testid="no-access"], [data-testid="spike-board-no-access"]')

/** The toasts on screen now (their texts). */
export const toastTexts = (page: Page): Promise<string[]> => page.getByTestId('toast').allInnerTexts()

/** A peer's cursor as this tab draws it (the overlay's cursor layer). */
export const cursorOf = (page: Page, name: string): Locator =>
  page.locator(`[data-testid="cursor"][data-name="${name.replace(/"/g, '\\"')}"]`)

/** The "X is typing" badge on an element. */
export const typingBadge = (page: Page, leaseId: string): Locator =>
  page.locator(`[data-testid="typing-badge"][data-lease="${leaseId.replace(/"/g, '\\"')}"]`)
