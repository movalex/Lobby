// OWNER: WS2 (wave R, notifications to Slack and Teams). The web side of the chat hook routes
// (@draftroom/contracts chat-hooks.ts; docs/WAVE-R-CONTRACTS.md §4). The browser never calls Slack or Teams: it asks the
// api, which holds the (sealed) URLs and posts the messages.
//
// Same origin, the session cookie; every answer is parsed with its contract schema.
//   chatHooksAvailable(): boolean                                  false once an answer said the routes are not here
//   listChatHooks(workspaceId): Promise<ChatHook[]>                hints only, never a URL
//   getChatPrefs(workspaceId): Promise<ChatPrefsResponse>
//   createChatHook / patchChatHook / deleteChatHook / testChatHook / putChatPrefs
//
// Downgrade and off: a 404 from the reads (an api from before wave R, or CHAT_HOOKS_OFF: no DRAFTROOM_WEBHOOK_SECRET)
// answers empty and turns `chatHooksAvailable()` false for the tab; the entry points hide. Any other failure rejects
// ChatHookRequestError with the api's code (CREATOR_REQUIRED, FORBIDDEN, …) and its user-safe message. The writes reject
// the same way ('unavailable' when the routes are known to be off). A pasted webhook URL is sent once, in the body of
// create or patch, and is never kept here: the form drops it at once.
import {
  ChatHook,
  ChatPrefsResponse,
  type CreateChatHookInput,
  chatHookPath,
  chatHooksPath,
  chatHookTestPath,
  chatPrefsPath,
  ListChatHooksResponse,
  type PatchChatHookInput,
  type PutChatPrefsInput,
  TestChatHookResponse,
} from '@draftroom/contracts'
import { type ApiClient, api as defaultApi, isApiError } from '../../api/client.ts'

/** A chat hook request that did not happen: 'unavailable' (no api routes, hooks off, offline) or the api's code. */
export class ChatHookRequestError extends Error {
  readonly code: string
  readonly status: number | null
  /** the api's own user-safe message, when it gave one */
  readonly detail: string | null
  constructor(code: string, status: number | null = null, detail: string | null = null) {
    super(`chat hook request failed: ${code}`)
    this.name = 'ChatHookRequestError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

type Requester = Pick<ApiClient, 'request'>
export interface ChatHookRequestOptions {
  api?: Requester
  signal?: AbortSignal
}

let off = false
const listeners = new Set<() => void>()

function setOff() {
  if (off) return
  off = true
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch {
      // a listener's failure is its own
    }
  }
}

/** Whether the settings and "My notifications" show: true until an answer said the routes are not here. */
export function chatHooksAvailable(): boolean {
  return !off
}

/** fn runs when the routes are found to be off (re-read chatHooksAvailable then). */
export function subscribeChatHooks(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Test seam: forget what this tab learned about the routes. */
export function resetChatHooksAvailability(): void {
  off = false
}

/** An api answer that is the routes being off or absent (a 404 that is not the hook's own). */
const routesGone = (e: unknown) =>
  isApiError(e) && e.status === 404 && (e.code === 'CHAT_HOOKS_OFF' || e.code === 'NOT_FOUND')

function asRequestError(e: unknown): ChatHookRequestError {
  if (e instanceof ChatHookRequestError) return e
  if (isApiError(e)) {
    if (e.code === 'CHAT_HOOKS_OFF') setOff()
    return new ChatHookRequestError(e.code, e.status || null, e.message)
  }
  return new ChatHookRequestError('unavailable')
}


export async function listChatHooks(
  workspaceId: string,
  opts: ChatHookRequestOptions = {},
): Promise<ChatHook[]> {
  if (off) return []
  try {
    const r = await (opts.api ?? defaultApi).request('GET', chatHooksPath(workspaceId), {
      schema: ListChatHooksResponse,
      signal: opts.signal,
    })
    return r.hooks
  } catch (e) {
    if (routesGone(e)) {
      setOff()
      return []
    }
    throw asRequestError(e)
  }
}

export async function getChatPrefs(
  workspaceId: string,
  opts: ChatHookRequestOptions = {},
): Promise<ChatPrefsResponse> {
  if (off) return { hooks: [], prefs: [] }
  try {
    return await (opts.api ?? defaultApi).request('GET', chatPrefsPath(workspaceId), {
      schema: ChatPrefsResponse,
      signal: opts.signal,
    })
  } catch (e) {
    if (routesGone(e)) {
      setOff()
      return { hooks: [], prefs: [] }
    }
    throw asRequestError(e)
  }
}

const guard = async <T>(run: () => Promise<T>): Promise<T> => {
  if (off) throw new ChatHookRequestError('unavailable')
  try {
    return await run()
  } catch (e) {
    throw asRequestError(e)
  }
}

export function createChatHook(
  workspaceId: string,
  input: CreateChatHookInput,
  opts: ChatHookRequestOptions = {},
): Promise<ChatHook> {
  return guard(() =>
    (opts.api ?? defaultApi).request('POST', chatHooksPath(workspaceId), {
      body: input,
      schema: ChatHook,
      signal: opts.signal,
    }),
  )
}

export function patchChatHook(
  workspaceId: string,
  hookId: string,
  input: PatchChatHookInput,
  opts: ChatHookRequestOptions = {},
): Promise<ChatHook> {
  return guard(() =>
    (opts.api ?? defaultApi).request('PATCH', chatHookPath(workspaceId, hookId), {
      body: input,
      schema: ChatHook,
      signal: opts.signal,
    }),
  )
}

export function deleteChatHook(
  workspaceId: string,
  hookId: string,
  opts: ChatHookRequestOptions = {},
): Promise<void> {
  return guard(async () => {
    await (opts.api ?? defaultApi).request('DELETE', chatHookPath(workspaceId, hookId), {
      schema: null,
      signal: opts.signal,
    })
  })
}

export function testChatHook(
  workspaceId: string,
  hookId: string,
  opts: ChatHookRequestOptions = {},
): Promise<TestChatHookResponse> {
  return guard(() =>
    (opts.api ?? defaultApi).request('POST', chatHookTestPath(workspaceId, hookId), {
      body: {},
      schema: TestChatHookResponse,
      signal: opts.signal,
    }),
  )
}

export function putChatPrefs(
  input: PutChatPrefsInput,
  opts: ChatHookRequestOptions = {},
): Promise<ChatPrefsResponse> {
  return guard(() =>
    (opts.api ?? defaultApi).request('PUT', chatPrefsPath(), {
      body: input,
      schema: ChatPrefsResponse,
      signal: opts.signal,
    }),
  )
}
