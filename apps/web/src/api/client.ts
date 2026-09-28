import {
  AuthConfig,
  Board,
  BoardDetail,
  type DevLoginInput,
  ErrorBody,
  InvitationAccepted,
  InvitationCreated,
  InvitationPreview,
  ListBoardsResponse,
  ListMembersResponse,
  Me,
  Project,
  TicketResponse,
  WorkspaceMember,
} from '@draftroom/contracts'
import { z } from 'zod'
import type { BoardRole, BoardVisibility } from '../lib/permissions.ts'

// Response shapes docs/M1-CONTRACTS.md §5 names but packages/contracts does not export yet.
// Kept here, in the same style as the shared ListBoards/ListMembers responses.
export const ListProjectsResponse = z.object({ projects: z.array(Project) })
export const ListWorkspaceMembersResponse = z.object({ members: z.array(WorkspaceMember) })

export type ApiErrorKind =
  | 'unauthorized' // 401: no or expired session -> the signed-out flow
  | 'forbidden' // 403 (includes the CSRF Origin check)
  | 'not-found' // 404: missing OR not visible to the caller (the API never leaks existence)
  | 'gone' // 410: expired / revoked / already-used invitation
  | 'conflict' // 409
  | 'invalid' // other 4xx (validation, last-owner protection, ...)
  | 'rate-limited' // 429
  | 'server' // 5xx
  | 'network' // the request never got a response
  | 'bad-response' // a 2xx whose body does not match the contract

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  /** HTTP status; 0 when there was no response. */
  readonly status: number
  /** The server's error code (e.g. `LAST_OWNER`), or a synthetic `HTTP_<status>` / `NETWORK` / `BAD_RESPONSE`. */
  readonly code: string
  constructor(kind: ApiErrorKind, status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.code = code
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError

/** A 403 or 404 on a board/workspace: the UI shows one "no access" screen for both (no existence leak). */
export const isNoAccess = (e: unknown) => isApiError(e) && (e.kind === 'forbidden' || e.kind === 'not-found')

export function kindForStatus(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not-found'
  if (status === 409) return 'conflict'
  if (status === 410) return 'gone'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'server'
  return 'invalid'
}

const FALLBACK_MESSAGES: Record<ApiErrorKind, string> = {
  unauthorized: 'Your session has ended. Sign in again to continue.',
  forbidden: "You don't have permission to do that.",
  'not-found': "That doesn't exist, or you don't have access to it.",
  gone: 'This link has expired or was revoked.',
  conflict: 'That conflicts with a change someone else just made. Refresh and try again.',
  invalid: 'That request was not accepted.',
  'rate-limited': 'Too many requests. Wait a moment and try again.',
  server: 'Draftroom had a problem handling that. Try again in a moment.',
  network: "Can't reach Draftroom. Check your connection and try again.",
  'bad-response': 'Draftroom sent an unexpected response. Reload the page and try again.',
}

const MAX_SERVER_MESSAGE = 300

/** Maps a non-2xx response to an ApiError. Server messages are user-safe by contract; anything else is replaced. */
export async function errorFromResponse(res: Response): Promise<ApiError> {
  const kind = kindForStatus(res.status)
  const raw: unknown = await res.json().catch(() => null)
  const parsed = ErrorBody.safeParse(raw)
  if (parsed.success) {
    const { code, message } = parsed.data.error
    const safe =
      message.length > 0 && message.length <= MAX_SERVER_MESSAGE ? message : FALLBACK_MESSAGES[kind]
    return new ApiError(kind, res.status, code, safe)
  }
  return new ApiError(kind, res.status, `HTTP_${res.status}`, FALLBACK_MESSAGES[kind])
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface RequestOptions<S extends z.ZodType | null> {
  body?: unknown
  /** Parses a 2xx body. `null` = the body is ignored (204s, or responses we re-fetch instead). */
  schema: S
  signal?: AbortSignal
  headers?: Record<string, string>
}
type Result<S> = S extends z.ZodType ? z.output<S> : undefined

export interface ApiClientOptions {
  fetchImpl?: typeof fetch
  /** Called on every 401, before the error is thrown: the session context switches to signed-out. */
  onUnauthorized?: () => void
}

const enc = encodeURIComponent

export const CLERK_EXCHANGE_PATH = '/api/auth/clerk/session'

export function createApiClient(opts: ApiClientOptions = {}) {
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))

  async function request<S extends z.ZodType | null>(
    method: Method,
    path: string,
    { body, schema, signal, headers: extra }: RequestOptions<S>,
  ): Promise<Result<S>> {
    const headers: Record<string, string> = { ...extra, accept: 'application/json' }
    // A content-type without a body is rejected by the API's JSON parser, so only set it with a body.
    if (body !== undefined) headers['content-type'] = 'application/json'
    let res: Response
    try {
      res = await fetchImpl(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // Same-origin only: the session cookie must never be offered to another origin.
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      })
    } catch (e) {
      if (signal?.aborted) throw e
      throw new ApiError('network', 0, 'NETWORK', FALLBACK_MESSAGES.network)
    }
    if (!res.ok) {
      const err = await errorFromResponse(res)
      if (err.kind === 'unauthorized') opts.onUnauthorized?.()
      throw err
    }
    if (schema === null) return undefined as Result<S>
    const raw: unknown = await res.json().catch(() => undefined)
    const parsed = schema.safeParse(raw)
    if (!parsed.success)
      throw new ApiError('bad-response', res.status, 'BAD_RESPONSE', FALLBACK_MESSAGES['bad-response'])
    return parsed.data as Result<S>
  }

  return {
    /** Generic typed request for feature modules (same-origin, JSON, contracts-validated). */
    request,
    // ---- auth ----------------------------------------------------------------------------------
    authConfig: (signal?: AbortSignal) => request('GET', '/api/auth/config', { schema: AuthConfig, signal }),
    /** Sets the session cookie; callers re-read the session with me(). */
    devLogin: (input: DevLoginInput) => request('POST', '/api/auth/dev/login', { body: input, schema: null }),
    logout: () => request('POST', '/api/auth/logout', { schema: null }),
    /**
     * SCA-4 "Sign out everywhere": revokes every Draftroom session of the signed-in user, on every
     * device. An API that does not have the route yet answers 404 (auth/signOut.ts says so).
     */
    revokeAllSessions: () => request('POST', '/api/auth/sessions/revoke-all', { schema: null }),
    /**
     * UNVERIFIED (no Clerk keys exist yet): trades a Clerk session token for a Draftroom session
     * cookie. The endpoint is not in docs/M1-CONTRACTS.md §5; see ClerkSignIn.tsx.
     */
    clerkExchange: (clerkToken: string) =>
      request('POST', CLERK_EXCHANGE_PATH, {
        schema: null,
        headers: { authorization: `Bearer ${clerkToken}` },
      }),
    me: (signal?: AbortSignal) => request('GET', '/api/me', { schema: Me, signal }),

    // ---- boards --------------------------------------------------------------------------------
    listBoards: async (
      workspaceId: string,
      query: { status?: 'active' | 'archived' | 'trashed'; projectId?: string; q?: string } = {},
      signal?: AbortSignal,
    ) => {
      const params = new URLSearchParams()
      if (query.status) params.set('status', query.status)
      if (query.projectId) params.set('projectId', query.projectId)
      if (query.q) params.set('q', query.q)
      const qs = params.toString() ? `?${params}` : ''
      const out = await request('GET', `/api/workspaces/${enc(workspaceId)}/boards${qs}`, {
        schema: ListBoardsResponse,
        signal,
      })
      return out.boards
    },
    createBoard: (workspaceId: string, input: { title: string; projectId?: string | null }) =>
      request('POST', `/api/workspaces/${enc(workspaceId)}/boards`, { body: input, schema: Board }),
    getBoard: (boardId: string, signal?: AbortSignal) =>
      request('GET', `/api/boards/${enc(boardId)}`, { schema: BoardDetail, signal }),
    patchBoard: (
      boardId: string,
      patch: { title?: string; projectId?: string | null; visibility?: BoardVisibility },
    ) => request('PATCH', `/api/boards/${enc(boardId)}`, { body: patch, schema: Board }),
    setBoardStatus: (boardId: string, action: 'archive' | 'trash' | 'restore') =>
      request('POST', `/api/boards/${enc(boardId)}/${action}`, { schema: Board }),

    // ---- board members + tickets ---------------------------------------------------------------
    listMembers: async (boardId: string, signal?: AbortSignal) =>
      (await request('GET', `/api/boards/${enc(boardId)}/members`, { schema: ListMembersResponse, signal }))
        .members,
    /** Grant or change a role; resolves with the board's updated member list. */
    putMember: async (boardId: string, userId: string, role: BoardRole) =>
      (
        await request('PUT', `/api/boards/${enc(boardId)}/members/${enc(userId)}`, {
          body: { role },
          schema: ListMembersResponse,
        })
      ).members,
    /** Revoke a grant; resolves with the board's updated member list. */
    removeMember: async (boardId: string, userId: string) =>
      (
        await request('DELETE', `/api/boards/${enc(boardId)}/members/${enc(userId)}`, {
          schema: ListMembersResponse,
        })
      ).members,
    boardTicket: (boardId: string, signal?: AbortSignal) =>
      request('POST', `/api/boards/${enc(boardId)}/ticket`, { schema: TicketResponse, signal }),

    // ---- workspaces + projects -----------------------------------------------------------------
    listProjects: async (workspaceId: string, signal?: AbortSignal) =>
      (
        await request('GET', `/api/workspaces/${enc(workspaceId)}/projects`, {
          schema: ListProjectsResponse,
          signal,
        })
      ).projects,
    createProject: (workspaceId: string, name: string) =>
      request('POST', `/api/workspaces/${enc(workspaceId)}/projects`, { body: { name }, schema: Project }),
    renameProject: (projectId: string, name: string) =>
      request('PATCH', `/api/projects/${enc(projectId)}`, { body: { name }, schema: Project }),
    listWorkspaceMembers: async (workspaceId: string, signal?: AbortSignal) =>
      (
        await request('GET', `/api/workspaces/${enc(workspaceId)}/members`, {
          schema: ListWorkspaceMembersResponse,
          signal,
        })
      ).members,

    // ---- invitations ---------------------------------------------------------------------------
    createBoardInvitation: (boardId: string, role: Exclude<BoardRole, 'owner'>) =>
      request('POST', `/api/boards/${enc(boardId)}/invitations`, {
        body: { role },
        schema: InvitationCreated,
      }),
    getInvitation: (token: string, signal?: AbortSignal) =>
      request('GET', `/api/invitations/${enc(token)}`, { schema: InvitationPreview, signal }),
    acceptInvitation: (token: string) =>
      request('POST', `/api/invitations/${enc(token)}/accept`, { schema: InvitationAccepted }),
    revokeInvitation: (id: string) => request('DELETE', `/api/invitations/${enc(id)}`, { schema: null }),
  }
}

export type ApiClient = ReturnType<typeof createApiClient>

let unauthorizedHandler: (() => void) | null = null
/** The session provider registers itself here so any 401, from any screen, signs the UI out. */
export function setUnauthorizedHandler(fn: (() => void) | null) {
  unauthorizedHandler = fn
}

/** The app's client. Tests build their own with createApiClient({ fetchImpl }). */
export const api: ApiClient = createApiClient({ onUnauthorized: () => unauthorizedHandler?.() })
