import type { CommentAnchor, CommentThread, ListThreadsResponse } from '@draftroom/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommentsApi } from './api.ts'
import { draftsKey, type KeyValueStorage, pinsHiddenKey } from './prefs.ts'
import { CommentsStore, NEW_THREAD_DRAFT } from './store.ts'

const BOARD = 'b-0123456789'
const ME = 'usr_me0000000000000000'
const ANN = 'usr_ann0000000000000000'
const ref = (id: string) => ({ id, name: id === ME ? 'Me' : 'Ann', color: '#123456' })

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

let seq = 0
function makeThread(author = ANN, extra: Partial<CommentThread> = {}): CommentThread {
  seq++
  const at = new Date(Date.UTC(2026, 8, 26, 10, seq)).toISOString()
  const id = `thr_${String(seq).padStart(20, '0')}`
  return {
    id,
    boardId: BOARD,
    anchor: { kind: 'point', x: 1, y: 2 },
    status: 'open',
    createdBy: ref(author),
    createdAt: at,
    updatedAt: at,
    resolvedBy: null,
    resolvedAt: null,
    comments: [
      {
        id: `cmt_${String(seq).padStart(20, '0')}`,
        threadId: id,
        author: ref(author),
        body: 'hi',
        mentions: [],
        createdAt: at,
        editedAt: null,
      },
    ],
    ...extra,
  }
}

function fakeApi(list: ListThreadsResponse = { threads: [], reads: {} }) {
  const api: CommentsApi = {
    listThreads: vi.fn(async () => list),
    createThread: vi.fn(async (_b: string, anchor: CommentAnchor, body: string) => {
      const t = makeThread(ME, { anchor })
      return { ...t, comments: [{ ...t.comments[0], body } as CommentThread['comments'][number]] }
    }),
    reply: vi.fn(),
    edit: vi.fn(),
    remove: vi.fn(async () => {}),
    setStatus: vi.fn(),
    markRead: vi.fn(async (threadId: string) => ({ threadId, readAt: '2030-01-01T00:00:00.000Z' })),
    notifications: vi.fn(async () => ({ notifications: [], unreadCount: 0 })),
    markNotificationsRead: vi.fn(async () => {}),
    mentionables: vi.fn(async () => []),
  }
  return api
}

let store: CommentsStore | null = null
afterEach(() => {
  store?.dispose()
  store = null
})

function make(api: CommentsApi, storage = memoryStorage(), extra: { onMentioned?: () => void } = {}) {
  store = new CommentsStore({ boardId: BOARD, meId: ME, canComment: true, api, storage, ...extra })
  return store
}

describe('CommentsStore', () => {
  it('loads threads and read marks', async () => {
    const t = makeThread()
    const s = make(fakeApi({ threads: [t], reads: { [t.id]: t.updatedAt } }))
    expect(s.status.get()).toBe('loading')
    await s.load()
    expect(s.status.get()).toBe('ready')
    expect(s.thread(t.id)).toEqual(t)
    expect(s.reads.get()[t.id]).toBe(t.updatedAt)
  })

  it('applies board events, ignores stale ones and other boards, and parses payloads', async () => {
    const onMentioned = vi.fn()
    const s = make(fakeApi(), memoryStorage(), { onMentioned })
    const t = makeThread()
    s.handleEvent('comments.thread', { thread: t })
    expect(s.thread(t.id)).toEqual(t)
    const stale = { ...t, updatedAt: '2000-01-01T00:00:00.000Z', status: 'resolved' as const }
    s.handleEvent('comments.thread', { thread: stale })
    expect(s.thread(t.id)?.status).toBe('open')
    s.handleEvent('comments.thread', { thread: { ...makeThread(), boardId: 'b-otherboard' } })
    s.handleEvent('comments.thread', { thread: { id: 'nonsense' } })
    expect(Object.keys(s.threads.get())).toEqual([t.id])
    // A new comment mentioning me, by someone else, raises the mention callback once.
    const reply = {
      ...t.comments[0],
      id: 'cmt_99999999999999999999',
      mentions: [ME],
      createdAt: '2026-09-27T00:00:00.000Z',
    } as CommentThread['comments'][number]
    const updated = { ...t, updatedAt: '2026-09-27T00:00:00.000Z', comments: [...t.comments, reply] }
    s.handleEvent('comments.thread', { thread: updated })
    s.handleEvent('comments.thread', { thread: updated })
    expect(onMentioned).toHaveBeenCalledTimes(1)
  })

  it('deleting the last comment removes the thread and closes it; a later stale list cannot revive it', async () => {
    const t = makeThread()
    const api = fakeApi({ threads: [t], reads: {} })
    const s = make(api)
    await s.load()
    s.openThread(t.id)
    s.handleEvent('comments.deleted', { threadId: t.id, commentId: t.comments[0]?.id })
    expect(s.thread(t.id)).toBeUndefined()
    expect(s.openThreadId.get()).toBeNull()
    await s.load() // the fake still returns the deleted comment
    expect(s.thread(t.id)).toBeUndefined()
  })

  it('opening an unread thread marks it read (optimistically, then with the server time)', async () => {
    const t = makeThread()
    const api = fakeApi({ threads: [t], reads: {} })
    const s = make(api)
    await s.load()
    s.openThread(t.id)
    expect(s.reads.get()[t.id]).toBe(t.comments[0]?.createdAt)
    await vi.waitFor(() => expect(s.reads.get()[t.id]).toBe('2030-01-01T00:00:00.000Z'))
    expect(api.markRead).toHaveBeenCalledTimes(1)
    s.openThread(t.id) // already read: no second request
    expect(api.markRead).toHaveBeenCalledTimes(1)
  })

  it('keeps an unsent new comment as a draft across closing and reloads, and clears it once posted', async () => {
    const storage = memoryStorage()
    const api = fakeApi()
    const s = make(api, storage)
    s.startNewThread({ kind: 'point', x: 5, y: 6 })
    s.setDraft(NEW_THREAD_DRAFT, { text: 'half a thought', mentions: [] })
    s.cancelNewThread()
    expect(s.pending.get()).toBeNull()
    expect(s.draft(NEW_THREAD_DRAFT).text).toBe('half a thought')
    // A new store (page reload) reads it back from storage.
    const again = new CommentsStore({ boardId: BOARD, meId: ME, canComment: true, api, storage })
    expect(again.draft(NEW_THREAD_DRAFT).text).toBe('half a thought')
    const posted = await again.createThread({ kind: 'point', x: 5, y: 6 }, again.draft(NEW_THREAD_DRAFT))
    expect(posted?.comments[0]?.body).toBe('half a thought')
    expect(again.draft(NEW_THREAD_DRAFT).text).toBe('')
    expect(storage.data.get(draftsKey(BOARD, ME))).toBeUndefined()
    expect(again.openThreadId.get()).toBe(posted?.id)
  })

  it('keeps the draft when posting fails and reports the error', async () => {
    const api = fakeApi()
    api.createThread = vi.fn(async () => {
      throw new Error('Network down')
    })
    const onError = vi.fn()
    const s = new CommentsStore({
      boardId: BOARD,
      meId: ME,
      canComment: true,
      api,
      storage: memoryStorage(),
      onError,
    })
    store = s
    s.setDraft(NEW_THREAD_DRAFT, { text: 'keep me', mentions: [] })
    expect(await s.createThread({ kind: 'point', x: 0, y: 0 }, s.draft(NEW_THREAD_DRAFT))).toBeNull()
    expect(onError).toHaveBeenCalledWith('Network down')
    expect(s.draft(NEW_THREAD_DRAFT).text).toBe('keep me')
  })

  it('Shift+C hides markers per person (persisted) and placing a comment shows them again', () => {
    const storage = memoryStorage()
    const s = make(fakeApi(), storage)
    s.togglePins()
    expect(s.pinsHidden.get()).toBe(true)
    expect(storage.data.get(pinsHiddenKey(ME))).toBe('1')
    expect(
      new CommentsStore({
        boardId: 'b-another01',
        meId: ME,
        canComment: true,
        api: fakeApi(),
        storage,
      }).pinsHidden.get(),
    ).toBe(true)
    expect(
      new CommentsStore({
        boardId: BOARD,
        meId: 'usr_someoneelse000000',
        canComment: true,
        api: fakeApi(),
        storage,
      }).pinsHidden.get(),
    ).toBe(false)
    s.startNewThread({ kind: 'point', x: 0, y: 0 })
    expect(s.pinsHidden.get()).toBe(false)
  })

  it('closeAll reports whether something was open', () => {
    const s = make(fakeApi())
    expect(s.closeAll()).toBe(false)
    s.startNewThread({ kind: 'point', x: 0, y: 0 })
    expect(s.closeAll()).toBe(true)
    expect(s.pending.get()).toBeNull()
  })

  it('marks notifications read optimistically', async () => {
    const api = fakeApi()
    const item = {
      id: 'ntf_0123456789abcdef0123456789abcdef',
      kind: 'mention' as const,
      boardId: BOARD,
      boardTitle: 'B',
      threadId: null,
      commentId: null,
      actor: null,
      snippet: null,
      createdAt: '2026-09-26T10:00:00.000Z',
      readAt: null,
    }
    api.notifications = vi.fn(async () => ({ notifications: [{ ...item, readAt: 'x' }], unreadCount: 0 }))
    const s = make(api)
    s.notifications.set({ notifications: [item], unreadCount: 1 })
    const done = s.markNotificationsRead({ ids: [item.id] })
    expect(s.notifications.get().unreadCount).toBe(0)
    await done
    expect(api.markNotificationsRead).toHaveBeenCalledWith({ ids: [item.id] })
  })
})
