// A small typed client for the M1 HTTP API (docs/M1-CONTRACTS.md §5), used for test SETUP (creating
// and sharing boards, checking server state) and for asserting server-side refusals. Everything goes
// through the web origin (the vite preview proxy), exactly like the browser's own requests.
// e2e has no dependency on @draftroom/contracts, so the shapes below are the slice the suites read.
import type { APIRequestContext, APIResponse, BrowserContext } from '@playwright/test'
import { WEB_URL } from './ports.ts'

export type BoardRole = 'owner' | 'editor' | 'commenter' | 'viewer'
export type BoardStatus = 'active' | 'archived' | 'trashed'
export type BoardVisibility = 'private' | 'workspace_view' | 'workspace_edit'

export interface ApiUser {
  id: string
  name: string
  handle: string | null
  color: string
}
export interface Me {
  user: ApiUser
  workspaces: { id: string; name: string; role: 'owner' | 'admin' | 'member' | 'guest' }[]
  /**
   * Domain access (docs/DOMAIN-ACCESS-CONTRACTS.md §7): whether this account may create and hand out
   * access. Optional here: an api from before domain access does not send it.
   */
  access?: {
    creator: boolean
    reason: 'domain' | 'exception' | 'dev' | 'outside' | 'guest' | 'unconfirmed' | 'legacy'
    email: string | null
  }
}

/**
 * Dev sign-in options. `email` (domain access): the address the dev account signs in with, trusted as
 * verified by the dev-guarded route. Without it the account is `<handle>@dev.invalid`, a creator.
 * Every dev login REPLACES the account's dev emails, so an outside address is only ever given to a
 * fresh handle (freshHandle()), never to alice/bob/carol, whose sessions the stack caches.
 */
export interface SignInOptions {
  email?: string
}
export interface ApiBoard {
  id: string
  workspaceId: string
  title: string
  visibility: BoardVisibility
  status: BoardStatus
  role?: BoardRole
}
export interface ApiMember {
  user: ApiUser
  role: BoardRole
  source: 'grant' | 'workspace'
}

/** Display names of the people the suites sign in as. Other handles get their handle as name. */
export const PEOPLE: Record<string, string> = {
  alice: 'Alice Park',
  bob: 'Bob Chen',
  carol: 'Carol Diaz',
  dave: 'Dave Okafor',
  erin: 'Erin Walsh',
}
export const displayName = (handle: string) => PEOPLE[handle] ?? handle

export class ApiError extends Error {
  readonly status: number
  readonly body: string
  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path} -> ${status} ${body.slice(0, 300)}`)
    this.status = status
    this.body = body
  }
}

// The API refuses every mutation whose Origin is not PUBLIC_ORIGIN (CSRF, §4); a browser sends it
// on its own, a Node request context has to be told.
const ORIGIN = { origin: WEB_URL }

/** The slice of the worker-scoped `playwright` fixture used here (its type is playwright-core's module). */
export interface RequestFactory {
  request: { newContext(options: { baseURL: string }): Promise<APIRequestContext> }
}

async function signInWith(
  request: APIRequestContext,
  handle: string,
  name = displayName(handle),
  opts: SignInOptions = {},
) {
  const data = opts.email === undefined ? { handle, name } : { handle, name, email: opts.email }
  const res = await request.post(`${WEB_URL}/api/auth/dev/login`, { headers: ORIGIN, data })
  if (res.status() !== 200) throw new ApiError('POST', '/api/auth/dev/login', res.status(), await res.text())
  return (await res.json()) as Me
}

/**
 * Signs a BROWSER CONTEXT in through the real dev login endpoint: the response's HttpOnly
 * `dr_session` cookie lands in the context's cookie jar, as it would after the sign-in form.
 */
export async function signInContext(
  context: BrowserContext,
  handle: string,
  name?: string,
  opts: SignInOptions = {},
): Promise<Me> {
  return signInWith(context.request, handle, name, opts)
}

/** Requests as one signed-in user (its own cookie jar). */
export class Api {
  readonly request: APIRequestContext
  constructor(request: APIRequestContext) {
    this.request = request
  }

  /** A new request context signed in as `handle` (creates the user on first sign-in). */
  static async signIn(
    playwright: RequestFactory,
    handle: string,
    name?: string,
    opts: SignInOptions = {},
  ): Promise<{ api: Api; me: Me }> {
    const request = await playwright.request.newContext({ baseURL: WEB_URL })
    try {
      return { api: new Api(request), me: await signInWith(request, handle, name, opts) }
    } catch (e) {
      await request.dispose()
      throw e
    }
  }

  /** Raw response, for asserting refusals (status codes) as well as successes. */
  fetch(method: string, path: string, data?: unknown): Promise<APIResponse> {
    const mutating = method !== 'GET' && method !== 'HEAD'
    return this.request.fetch(`${WEB_URL}${path}`, {
      method,
      headers: mutating ? ORIGIN : {},
      ...(data === undefined ? {} : { data }),
    })
  }

  private async call<T>(method: string, path: string, data?: unknown): Promise<T> {
    let res = await this.fetch(method, path, data)
    // K6-1: a stack that just started may not know its sync's engine yet (503 CANVAS_STARTING, Retry-After):
    // retried for up to 15 s as the web retries it, so the first board of a fresh stack does not fail the test
    for (let i = 0; i < 30 && res.status() === 503 && (await res.text()).includes('CANVAS_STARTING'); i++) {
      await new Promise((r) => setTimeout(r, 500))
      res = await this.fetch(method, path, data)
    }
    if (res.status() >= 300) throw new ApiError(method, path, res.status(), await res.text())
    return (res.status() === 204 ? undefined : await res.json()) as T
  }

  me = () => this.call<Me>('GET', '/api/me')
  createBoard = (workspaceId: string, title: string) =>
    this.call<ApiBoard>('POST', `/api/workspaces/${workspaceId}/boards`, { title: title.slice(0, 120) })
  getBoard = (boardId: string) =>
    this.call<{ board: ApiBoard; role: BoardRole; workspace: { id: string; name: string } }>(
      'GET',
      `/api/boards/${boardId}`,
    )
  listBoards = (workspaceId: string, status: BoardStatus = 'active') =>
    this.call<{ boards: ApiBoard[] }>('GET', `/api/workspaces/${workspaceId}/boards?status=${status}`).then(
      (r) => r.boards,
    )
  patchBoard = (boardId: string, patch: { title?: string; visibility?: BoardVisibility }) =>
    this.call<ApiBoard>('PATCH', `/api/boards/${boardId}`, patch)
  members = (boardId: string) =>
    this.call<{ members: ApiMember[] }>('GET', `/api/boards/${boardId}/members`).then((r) => r.members)
  putMember = (boardId: string, userId: string, role: BoardRole) =>
    this.call<{ members: ApiMember[] }>('PUT', `/api/boards/${boardId}/members/${userId}`, { role })
  ticket = (boardId: string) =>
    this.call<{ ticket: string; role: BoardRole; user: { id: string } }>(
      'POST',
      `/api/boards/${boardId}/ticket`,
    )

  dispose = () => this.request.dispose()
}
