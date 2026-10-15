// Wave Q (WS3): what the Elements panel's tests share: a library item summary as the api answers it, and a fake api
// client for ./client.ts (each call recorded; the answer from `answer`, an Error is thrown, and parsed with the
// route's schema as the real client does).
import type { LibraryItemSummary } from '@draftroom/contracts'
import { setLibraryRequester } from './client.ts'

export const TEST_WORKSPACE = 'wsp_0123456789abcdefghij'
export const TEST_ITEM = 'lbi_0123456789abcdefghij'

export const summary = (over: Partial<LibraryItemSummary> = {}): LibraryItemSummary => ({
  id: TEST_ITEM,
  scope: 'workspace',
  folderId: null,
  name: 'Flow start',
  tags: ['flow'],
  elementCount: 2,
  imageCount: 0,
  width: 120,
  height: 80,
  internalOnly: false,
  revision: 1,
  sourceKind: 'board',
  createdBy: null,
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
  deletedAt: null,
  canEdit: true,
  ...over,
})

export interface FakeCall {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

interface RequestOpts {
  readonly schema: { parse(v: unknown): unknown } | null
  readonly body?: unknown
}

/** Installs a fake api client; returns its calls (cleared by the next install). */
export function fakeLibraryApi(answer: (c: FakeCall) => unknown): FakeCall[] {
  const calls: FakeCall[] = []
  const request = async (method: string, path: string, o: RequestOpts) => {
    const c = { method, path, body: o.body }
    calls.push(c)
    const v = answer(c)
    if (v instanceof Error) throw v
    return o.schema ? o.schema.parse(v) : undefined
  }
  setLibraryRequester({ request: request as never })
  return calls
}
