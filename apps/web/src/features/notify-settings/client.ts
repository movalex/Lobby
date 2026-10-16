// OWNER: WS2 (wave R, notifications to Slack and Teams; a stub landed by the wave R foundation). The web side of the
// chat hook routes (@draftroom/contracts chat-hooks.ts; docs/WAVE-R-CONTRACTS.md §4).
//
// Frozen signatures (same origin, the session cookie; every answer parsed with its contract schema; the reads never
// throw: a 404 from an api without the routes, or CHAT_HOOKS_OFF from one without DRAFTROOM_WEBHOOK_SECRET, answers
// empty and `chatHooksAvailable()` turns false):
//   chatHooksAvailable(): boolean                                  whether the settings and "My notifications" show
//   listChatHooks(workspaceId): Promise<ChatHook[]>                hints only, never a URL
//   getChatPrefs(workspaceId): Promise<ChatPrefsResponse>
// The writes reject with ChatHookRequestError (`code`: 'unavailable', or the api's: CHAT_HOOK_URL_INVALID,
// CHAT_HOOK_URL_RETIRED, CHAT_HOOKS_FULL, CHAT_HOOKS_OFF, CREATOR_REQUIRED, …):
//   createChatHook(workspaceId, input) / patchChatHook(workspaceId, hookId, input): Promise<ChatHook>
//   deleteChatHook(workspaceId, hookId): Promise<void>
//   testChatHook(workspaceId, hookId): Promise<TestChatHookResponse>
//   putChatPrefs(input): Promise<ChatPrefsResponse>
// A pasted webhook URL is sent once, in the body of create or patch, and dropped from the form at once.
//
// The stub: chatHooksAvailable() is false, the reads answer empty without a request, the writes reject 'unavailable'.
import type {
  ChatHook,
  ChatPrefsResponse,
  CreateChatHookInput,
  PatchChatHookInput,
  PutChatPrefsInput,
  TestChatHookResponse,
} from '@draftroom/contracts'

/** A chat hook request that did not happen: 'unavailable' (no api routes, hooks off, offline) or the api's code. */
export class ChatHookRequestError extends Error {
  readonly code: string
  readonly status: number | null
  constructor(code: string, status: number | null = null) {
    super(`chat hook request failed: ${code}`)
    this.name = 'ChatHookRequestError'
    this.code = code
    this.status = status
  }
}

const unavailable = <T>(): Promise<T> => Promise.reject(new ChatHookRequestError('unavailable'))

export function chatHooksAvailable(): boolean {
  return false
}

export async function listChatHooks(_workspaceId: string): Promise<ChatHook[]> {
  return []
}

export async function getChatPrefs(_workspaceId: string): Promise<ChatPrefsResponse> {
  return { hooks: [], prefs: [] }
}

export function createChatHook(_workspaceId: string, _input: CreateChatHookInput): Promise<ChatHook> {
  return unavailable()
}

export function patchChatHook(
  _workspaceId: string,
  _hookId: string,
  _input: PatchChatHookInput,
): Promise<ChatHook> {
  return unavailable()
}

export function deleteChatHook(_workspaceId: string, _hookId: string): Promise<void> {
  return unavailable()
}

export function testChatHook(_workspaceId: string, _hookId: string): Promise<TestChatHookResponse> {
  return unavailable()
}

export function putChatPrefs(_input: PutChatPrefsInput): Promise<ChatPrefsResponse> {
  return unavailable()
}
