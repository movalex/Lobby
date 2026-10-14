// Helpers for the dashboard + sharing suite (dashboard-share.spec.ts): people who sign in on their
// own browser context, dashboard card/menu locators, Share dialog locators, and typed reads of the
// dashboard-share API (stars, sharing state, invitations, access requests, notifications) used to
// prove what the SERVER stored rather than what one tab shows, plus extra web builds served from the
// web origin for the separate-sync-origin (platform) tests.
import { spawn } from 'node:child_process'
import { existsSync, rmSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { type Api, ApiError, type BoardVisibility, displayName, type Me, signInContext } from './api.ts'
import { read } from './board.ts'
import { WEB_URL } from './ports.ts'
import { REPO_ROOT } from './stack.ts'

export const ORIGIN = { origin: WEB_URL }

/** A handle nobody else in this stack has used: its first sign-in creates a fresh user. */
export function freshHandle(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`
}

export interface Person {
  readonly handle: string
  readonly name: string
  readonly me: Me
  readonly context: BrowserContext
  readonly page: Page
}

/**
 * A new browser context signed in (dev login endpoint) as `handle`, on a blank page. `email` (domain
 * access) signs in with that address; give an outside address only to a freshHandle() (support/api.ts).
 * An outside account has no personal workspace: never call personalWorkspace() on its `me`.
 */
export async function signedInContext(
  browser: Browser,
  handle: string,
  opts: { name?: string; email?: string; viewport?: { width: number; height: number } } = {},
): Promise<Person> {
  const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1360, height: 860 } })
  const name = opts.name ?? displayName(handle)
  const me = await signInContext(context, handle, name, opts.email === undefined ? {} : { email: opts.email })
  const page = await context.newPage()
  return { handle, name, me, context, page }
}

/** The personal workspace a user got on first sign-in ("<Name>'s workspace", role owner). */
export function personalWorkspace(me: Me): string {
  const ws = me.workspaces.find((w) => w.role === 'owner' && w.name.endsWith("'s workspace"))
  if (!ws) throw new Error(`no personal workspace in ${JSON.stringify(me.workspaces)}`)
  return ws.id
}

// ---- dashboard -----------------------------------------------------------------------------------

/** A board's card inside one list (the Starred grid and the main grid can both show it). */
export const cardIn = (list: Locator, boardId: string) =>
  list.locator(`[data-testid="board-card"][data-board-id="${boardId}"]`)
export const mainGrid = (page: Page) => page.getByTestId('board-grid')
export const starredGrid = (page: Page) => page.getByTestId('starred-grid')
export const mainCard = (page: Page, boardId: string) => cardIn(mainGrid(page), boardId)

export async function openDashboard(page: Page, workspaceId: string, section = '') {
  await page.goto(`/w/${workspaceId}${section ? `/${section}` : ''}`)
  await expect(page.getByTestId('dashboard')).toHaveAttribute('data-workspace-id', workspaceId)
}

/** The action ids of a card's menu, in order (opens and closes the menu). */
export async function menuActions(card: Locator): Promise<(string | null)[]> {
  await card.getByTestId('board-card-menu').click()
  const items = card.locator('[role="menuitem"]')
  await expect(items.first()).toBeVisible()
  const actions = await items.evaluateAll((els) => els.map((e) => e.getAttribute('data-action')))
  await card.page().keyboard.press('Escape')
  await expect(items).toHaveCount(0)
  return actions
}

export async function chooseFromMenu(card: Locator, action: string) {
  await card.getByTestId('board-card-menu').click()
  await card.locator(`[role="menuitem"][data-action="${action}"]`).click()
}

// ---- board / Share dialog ---------------------------------------------------------------------------

export const shareDialog = (page: Page) => page.getByTestId('share-dialog')
export const memberRow = (page: Page, userId: string) =>
  shareDialog(page).locator(`[data-testid="member-row"][data-user-id="${userId}"]`)
export const requestRow = (page: Page, userId: string) =>
  shareDialog(page).locator(`[data-testid="access-request-row"][data-user-id="${userId}"]`)

/**
 * P-022: the people who can still be given access are the invite field's own list (a click on the empty field opens
 * it); there is no second "pick someone from the workspace" row. Returns the listbox.
 */
export async function openPeopleList(page: Page): Promise<Locator> {
  const dialog = shareDialog(page)
  const input = dialog.getByTestId('share-invite-input')
  await input.fill('')
  await input.click()
  const list = dialog.getByTestId('share-invite-suggestions')
  await expect(list).toBeVisible()
  return list
}

/** One person in the invite field's list. */
export const listedPerson = (list: Locator, userId: string) =>
  list.locator(`[data-testid="share-invite-suggestion"][data-user-id="${userId}"]`)

export async function openShareFromButton(page: Page) {
  await page.getByTestId('share-button').click()
  await expect(shareDialog(page)).toBeVisible()
}

/**
 * DANA-03: the workshop link, invite by email and one-time invite links sit under the collapsed "More
 * ways to share" (it opens by itself when a workshop link is running). Opens it if it is closed.
 */
export async function openMoreWaysToShare(page: Page) {
  const more = shareDialog(page).getByTestId('share-more')
  // Once the links have loaded, it no longer opens by itself (a click now cannot race that).
  await expect(more).toHaveAttribute('data-loaded', 'true')
  if ((await more.getAttribute('open')) === null) await more.getByTestId('share-more-toggle').click()
  await expect(more).toHaveAttribute('open', '')
}

export async function closeShare(page: Page) {
  await page.keyboard.press('Escape')
  await expect(shareDialog(page)).toHaveCount(0)
}

/** The shape records of one type on the current page, as the tab holds them. */
export const shapesOfType = (page: Page, type: string) =>
  read(page, (ed, t) => ed.getCurrentPageShapes().filter((s) => s.type === t), type)

export const frameNames = async (page: Page) =>
  (await shapesOfType(page, 'frame')).map((f) => String(f.props.name)).sort()

export const shapeCount = (page: Page) => read(page, (ed) => ed.getCurrentPageShapes().length)

/** Every URL the main frame navigated to (full loads and history API changes). */
export function recordNavigations(page: Page): string[] {
  const urls: string[] = []
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) urls.push(frame.url())
  })
  return urls
}

/**
 * The badge's expiry text for an ISO date, computed in the page (same clock and time zone as the
 * app): "Oct 10" this year, "Oct 10, 2027" otherwise.
 */
export function shortDateInPage(page: Page, iso: string): Promise<string> {
  return page.evaluate((value) => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const d = new Date(value)
    const md = `${months[d.getMonth()]} ${d.getDate()}`
    return d.getFullYear() === new Date().getFullYear() ? md : `${md}, ${d.getFullYear()}`
  }, iso)
}

// ---- server-side reads (dashboard-share API) -------------------------------------------------------

async function json<T>(api: Api, method: string, path: string, data?: unknown): Promise<T> {
  const res = await api.fetch(method, path, data)
  if (res.status() >= 300) throw new ApiError(method, path, res.status(), await res.text())
  return (res.status() === 204 ? undefined : await res.json()) as T
}

export interface ServerBoard {
  id: string
  title: string
  visibility: BoardVisibility
  status: string
  projectId: string | null
  createdBy: string
  role: string
  starred?: boolean
}

export const starredIds = async (api: Api, workspaceId: string) =>
  (
    await json<{ boards: ServerBoard[] }>(api, 'GET', `/api/workspaces/${workspaceId}/boards/starred`)
  ).boards.map((b) => b.id)

export const boardList = async (api: Api, workspaceId: string) =>
  (await json<{ boards: ServerBoard[] }>(api, 'GET', `/api/workspaces/${workspaceId}/boards`)).boards

export const boardDetail = (api: Api, boardId: string) =>
  json<{ board: ServerBoard; role: string }>(api, 'GET', `/api/boards/${boardId}`)

export interface ShareStateBody {
  visibility: BoardVisibility
  links: { role: 'viewer' | 'commenter'; expiresAt: string }[]
  directCount: number
  pendingRequests: number | null
}
export const shareState = (api: Api, boardId: string) =>
  json<ShareStateBody>(api, 'GET', `/api/boards/${boardId}/sharing`)

export interface PendingInvitationBody {
  id: string
  kind: 'invite' | 'review'
  role: string
  expiresAt: string
  uses: number
  maxUses: number | null
  url: string | null
  /** Domain access: the address a single-use invitation is locked to (manager-only list). */
  email?: string | null
}
export const invitations = async (api: Api, boardId: string) =>
  (await json<{ invitations: PendingInvitationBody[] }>(api, 'GET', `/api/boards/${boardId}/invitations`))
    .invitations

export interface AccessRequestBody {
  id: string
  user: { id: string }
  roleRequested: string
  message: string | null
  status: string
}
export const accessRequests = async (api: Api, boardId: string) =>
  (await json<{ requests: AccessRequestBody[] }>(api, 'GET', `/api/boards/${boardId}/access-requests`))
    .requests

export interface NotificationBody {
  id: string
  kind: string
  boardId: string
  actor: { id: string } | null
}
export const notifications = async (api: Api) =>
  (await json<{ notifications: NotificationBody[] }>(api, 'GET', '/api/me/notifications')).notifications

export const removeMember = (api: Api, boardId: string, userId: string) =>
  json<unknown>(api, 'DELETE', `/api/boards/${boardId}/members/${userId}`)

export const setVisibility = (api: Api, boardId: string, visibility: BoardVisibility) =>
  json<unknown>(api, 'PATCH', `/api/boards/${boardId}`, { visibility })

/** The invitation token at the end of an /invite/<token> URL. */
export function inviteToken(url: string): string {
  const m = /\/invite\/([A-Za-z0-9_-]{43})$/.exec(url)
  if (!m?.[1]) throw new Error(`not an invite link: ${url}`)
  return m[1]
}

// ---- platform: web builds with a separate sync origin ---------------------------------------------

/**
 * Builds the web app into apps/web/<outDir> with extra build-time env (e.g. VITE_DRAFTROOM_SYNC_ORIGIN).
 * VITE_DRAFTROOM_DEV_AUTH=1 like the suite's own build, so window.editor exists. Returns the folder.
 */
export async function buildWeb(outDir: string, env: Record<string, string>): Promise<string> {
  const dir = join(REPO_ROOT, 'apps/web', outDir)
  rmSync(dir, { recursive: true, force: true })
  if (!/^[\w./-]+$/.test(outDir)) throw new Error(`unexpected build folder name: ${outDir}`)
  // One command line through the shell: pnpm is a .cmd shim on Windows, which Node only runs that way.
  const child = spawn(`pnpm --filter @draftroom/web exec vite build --outDir ${outDir}`, {
    cwd: REPO_ROOT,
    env: { ...process.env, VITE_DRAFTROOM_DEV_AUTH: '1', ...env },
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  child.stdout?.on('data', (d) => {
    output += String(d)
  })
  child.stderr?.on('data', (d) => {
    output += String(d)
  })
  const code = await new Promise<number | null>((resolveExit) => child.once('exit', resolveExit))
  if (code !== 0 || !existsSync(join(dir, 'index.html')))
    throw new Error(`web build into ${outDir} failed (exit ${code}):\n${output.slice(-3000)}`)
  return dir
}

/**
 * Serves `dir` as the page origin (WEB_URL) for one browser context, like a static host that proxies
 * only /api and /files to the API: those two continue to the suite's preview (and on to the api),
 * /connect is not proxied (404), everything else is a file from `dir` or the SPA's index.html.
 * WebSockets are not HTTP requests and never pass through here.
 */
export async function serveBuild(context: BrowserContext, dir: string) {
  const root = resolve(dir)
  await allowLoopbackSockets(context, WEB_URL)
  await context.route(`${WEB_URL}/**`, async (route) => {
    const { pathname } = new URL(route.request().url())
    if (pathname.startsWith('/api/') || pathname.startsWith('/files/')) return route.fallback()
    if (pathname === '/connect' || pathname.startsWith('/connect/'))
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not proxied here' })
    const file = resolve(root, `.${decodeURIComponent(pathname)}`)
    const inside = file.startsWith(`${root}${sep}`)
    if (inside && existsSync(file) && statSync(file).isFile()) return route.fulfill({ path: file })
    return route.fulfill({ path: join(root, 'index.html') })
  })
}

/**
 * Chromium's Local Network Access checks treat a document that a test route fulfilled as public, so a
 * socket from it to 127.0.0.1 is blocked in the browser before it reaches any server. Deployed, the web
 * and sync origins are both public and the check does not apply; granting the permission here lets
 * the sync server, not the browser, decide.
 */
export async function allowLoopbackSockets(context: BrowserContext, origin: string) {
  await context.grantPermissions(['local-network-access'], { origin })
}

/** Every WebSocket URL a page opens, with the ticket redacted. */
export function recordSockets(page: Page): string[] {
  const urls: string[] = []
  page.on('websocket', (ws) => urls.push(ws.url().replace(/ticket=[^&]+/, 'ticket=REDACTED')))
  return urls
}

/** One toast by its text (several can be up at once; each stays a few seconds). */
export const toast = (page: Page, text: string, testId = 'dashboard-toast') =>
  page.getByTestId(testId).filter({ hasText: text })
