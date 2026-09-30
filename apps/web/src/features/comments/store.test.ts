import type { CommentAnchor, CommentThread, ListThreadsResponse } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommentsApi } from './api.ts'
import { LOBBY_SIGNALS, type SignalsKit } from './cells.ts'
import type { Mentionable } from './mentions.ts'
import { draftsKey, type KeyValueStorage, pinsHiddenKey } from './prefs.ts'
import {
  CommentsStore,
  MENTIONABLES_MISS_REFETCH_MS,
  mayChangeWhoHasAccess,
  NEW_THREAD_DRAFT,
} from './store.ts'
import { TLDRAW_SIGNALS } from './tldraw-cells.ts'

// The store runs on either board page's cells (./cells.ts): every case runs on both kits.
const KITS = [
  ['lib/signals', LOBBY_SIGNALS],
  ['tldraw atoms', TLDRAW_SIGNALS],
] as const
let SIGNALS: SignalsKit = LOBBY_SIGNALS

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
    visibility: 'everyone',
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
    setVisibility: vi.fn(async (threadId: string, visibility: 'everyone' | 'team') => ({
      ...makeThread(ANN),
      id: threadId,
      visibility,
      updatedAt: '2030-01-01T00:00:00.000Z',
    })),
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
  store = new CommentsStore({
    signals: SIGNALS,
    boardId: BOARD,
    meId: ME,
    canComment: true,
    api,
    storage,
    ...extra,
  })
  return store
}

describe.each(KITS)('%s: CommentsStore', (_, kit) => {
  beforeEach(() => {
    SIGNALS = kit
  })
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
    const again = new CommentsStore({
      signals: SIGNALS,
      boardId: BOARD,
      meId: ME,
      canComment: true,
      api,
      storage,
    })
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
      signals: SIGNALS,
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
        signals: SIGNALS,
        boardId: 'b-another01',
        meId: ME,
        canComment: true,
        api: fakeApi(),
        storage,
      }).pinsHidden.get(),
    ).toBe(true)
    expect(
      new CommentsStore({
        signals: SIGNALS,
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

describe.each(KITS)('%s: live bell and resolve feedback', (_, kit) => {
  beforeEach(() => {
    SIGNALS = kit
  })
  it('refreshes the bell right away when someone asks for access (and not for other sharing changes)', async () => {
    vi.useFakeTimers()
    try {
      const api = fakeApi()
      const s = make(api)
      s.handleEvent('sharing.changed', { reason: 'visibility' })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(api.notifications).not.toHaveBeenCalled()
      s.handleEvent('sharing.changed', { reason: 'access-request' })
      await vi.advanceTimersByTimeAsync(0)
      expect(api.notifications).toHaveBeenCalledTimes(1)
      s.handleEvent('sharing.changed', { reason: 'access-request-approved' })
      await vi.advanceTimersByTimeAsync(0)
      expect(api.notifications).toHaveBeenCalledTimes(2)
      s.handleEvent('sharing.changed', 'garbage')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(api.notifications).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tells the UI when I resolve an open thread (for its Undo), not when I reopen one', async () => {
    const open = makeThread(ANN)
    const resolved = { ...open, status: 'resolved' as const, updatedAt: '2030-01-01T00:00:00.000Z' }
    const api = fakeApi({ threads: [open], reads: {} })
    api.setStatus = vi.fn(async (_id: string, action: 'resolve' | 'reopen') => {
      if (action === 'reopen') return { ...open, updatedAt: '2030-01-02T00:00:00.000Z' }
      // The server's board event can arrive before the response does.
      store?.handleEvent('comments.thread', { thread: resolved })
      return resolved
    })
    const onResolved = vi.fn()
    store = new CommentsStore({
      signals: SIGNALS,
      boardId: BOARD,
      meId: ME,
      canComment: true,
      api,
      storage: memoryStorage(),
      onResolved,
    })
    await store.load()
    expect(await store.setStatus(open.id, 'resolve')).toBe(true)
    expect(onResolved).toHaveBeenCalledTimes(1)
    expect(onResolved.mock.calls[0]?.[0]).toMatchObject({ id: open.id, status: 'resolved' })
    // Undo = reopen: no second "resolved" message.
    expect(await store.setStatus(open.id, 'reopen')).toBe(true)
    expect(store.thread(open.id)?.status).toBe('open')
    expect(onResolved).toHaveBeenCalledTimes(1)
  })
})

describe.each(KITS)('%s: who can be @mentioned follows sharing changes (F4)', (_, kit) => {
  beforeEach(() => {
    SIGNALS = kit
  })
  const lena: Mentionable = { userId: 'usr_lena000000000000000', name: 'Lena Ortiz', handle: 'lena' }

  it('a sharing change refetches a loaded list once per burst, so someone just added is mentionable', async () => {
    vi.useFakeTimers()
    try {
      const api = fakeApi()
      api.mentionables = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([lena])
      const s = make(api)
      await s.ensureMentionables()
      expect(s.mentionables.get()).toEqual([])
      // A grant, then a guest joining, arrive close together: one refetch.
      s.handleEvent('sharing.changed', { reason: 'grant' })
      s.handleEvent('sharing.changed', { reason: 'guest-joined' })
      expect(s.mentionables.get()).toEqual([]) // the old list stays until the new one lands
      await vi.advanceTimersByTimeAsync(1_000)
      expect(api.mentionables).toHaveBeenCalledTimes(2)
      expect(s.mentionables.get()).toEqual([lena])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a new or denied access request changes nobody’s access: no refetch; an approval does', async () => {
    vi.useFakeTimers()
    try {
      const api = fakeApi()
      const s = make(api)
      await s.ensureMentionables()
      s.handleEvent('sharing.changed', { reason: 'access-request' })
      s.handleEvent('sharing.changed', { reason: 'access-request-deny' })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(api.mentionables).toHaveBeenCalledTimes(1)
      s.handleEvent('sharing.changed', { reason: 'access-request-approve' })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(api.mentionables).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a list never fetched stays unfetched (the next @ asks); a disposed store never fetches', async () => {
    vi.useFakeTimers()
    try {
      const api = fakeApi()
      const s = make(api)
      s.invalidateMentionables()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(api.mentionables).not.toHaveBeenCalled()
      await s.ensureMentionables()
      s.invalidateMentionables()
      s.dispose()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(api.mentionables).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an @query that matches nobody asks again, at most once per few seconds', async () => {
    vi.useFakeTimers()
    try {
      const api = fakeApi()
      api.mentionables = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([lena])
      const s = make(api)
      s.refetchMentionablesOnMiss() // nothing loaded yet: the composer's first @ loads it
      expect(api.mentionables).not.toHaveBeenCalled()
      await s.ensureMentionables()
      s.refetchMentionablesOnMiss() // just asked
      expect(api.mentionables).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(MENTIONABLES_MISS_REFETCH_MS + 1)
      s.refetchMentionablesOnMiss()
      s.refetchMentionablesOnMiss()
      await vi.advanceTimersByTimeAsync(0)
      expect(api.mentionables).toHaveBeenCalledTimes(2)
      expect(s.mentionables.get()).toEqual([lena])
    } finally {
      vi.useRealTimers()
    }
  })

  it('only the newest answer lands (an older, slower answer never overwrites it)', async () => {
    vi.useFakeTimers()
    try {
      let releaseOld: (v: Mentionable[]) => void = () => {}
      const api = fakeApi()
      api.mentionables = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockImplementationOnce(
          () =>
            new Promise<Mentionable[]>((r) => {
              releaseOld = r
            }),
        )
        .mockResolvedValueOnce([lena])
      const s = make(api)
      await s.ensureMentionables()
      s.invalidateMentionables(0)
      await vi.advanceTimersByTimeAsync(0) // the slow request is out
      s.invalidateMentionables(0)
      await vi.advanceTimersByTimeAsync(0) // the newer one answered
      expect(s.mentionables.get()).toEqual([lena])
      releaseOld([])
      await vi.advanceTimersByTimeAsync(0)
      expect(s.mentionables.get()).toEqual([lena])
    } finally {
      vi.useRealTimers()
    }
  })

  describe('F10: team-only threads', () => {
    it('"Team only" follows the board for the team, can be switched, and is sent with a new thread', async () => {
      const api = fakeApi({ threads: [], reads: {}, privacy: { teamOnly: true, teamOnlyDefault: true } })
      const s = make(api)
      expect(s.newThreadTeamOnly()).toBe(false) // nothing known before the list
      await s.load()
      expect(s.newThreadTeamOnly()).toBe(true)
      s.setDraft(NEW_THREAD_DRAFT, { text: 'Internal', mentions: [] })
      await s.createThread({ kind: 'point', x: 0, y: 0 }, s.draft(NEW_THREAD_DRAFT))
      expect(api.createThread).toHaveBeenLastCalledWith(
        BOARD,
        { kind: 'point', x: 0, y: 0 },
        'Internal',
        'team',
      )
      s.teamOnlyChoice.set(false)
      expect(s.newThreadTeamOnly()).toBe(false)
      s.setDraft(NEW_THREAD_DRAFT, { text: 'For all', mentions: [] })
      await s.createThread({ kind: 'point', x: 0, y: 0 }, s.draft(NEW_THREAD_DRAFT))
      expect(api.createThread).toHaveBeenLastCalledWith(
        BOARD,
        { kind: 'point', x: 0, y: 0 },
        'For all',
        'everyone',
      )
    })

    it('outside the team there is no "Team only", and a hidden thread is dropped (open popover closed)', async () => {
      const t = makeThread()
      const s = make(
        fakeApi({ threads: [t], reads: {}, privacy: { teamOnly: false, teamOnlyDefault: false } }),
      )
      await s.load()
      s.teamOnlyChoice.set(true)
      expect(s.newThreadTeamOnly()).toBe(false)
      s.openThread(t.id)
      s.handleEvent('comments.hidden', { threadId: 'not-an-id' }) // untrusted: ignored
      expect(s.thread(t.id)).toBeDefined()
      s.handleEvent('comments.hidden', { threadId: t.id })
      expect(s.thread(t.id)).toBeUndefined()
      expect(s.openThreadId.get()).toBeNull()
    })

    it('a list from an older api (no privacy, no visibility) means everyone, and team threads never show outside the team', async () => {
      const old = makeThread()
      const team = makeThread(ANN, { visibility: 'team' })
      const s = make(fakeApi({ threads: [old, team], reads: {} }))
      await s.load()
      expect(s.privacy.get()).toEqual({ teamOnly: false, teamOnlyDefault: false })
      expect(Object.keys(s.threads.get())).toEqual([old.id])
    })

    it('a sharing change refetches the list for the team (a new client link turns the default on)', async () => {
      vi.useFakeTimers()
      try {
        const api = fakeApi({ threads: [], reads: {}, privacy: { teamOnly: true, teamOnlyDefault: false } })
        const s = make(api)
        await s.load()
        expect(s.newThreadTeamOnly()).toBe(false)
        api.listThreads = vi.fn(async () => ({
          threads: [],
          reads: {},
          privacy: { teamOnly: true, teamOnlyDefault: true },
        }))
        s.handleEvent('sharing.changed', { reason: 'review-link-created' })
        s.handleEvent('sharing.changed', { reason: 'review-link-created' })
        await vi.advanceTimersByTimeAsync(1_000)
        expect(api.listThreads).toHaveBeenCalledTimes(1)
        expect(s.newThreadTeamOnly()).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('"Team only" is chosen per comment: after a post the next new comment starts from the board’s default', async () => {
      const api = fakeApi({ threads: [], reads: {}, privacy: { teamOnly: true, teamOnlyDefault: true } })
      const s = make(api)
      await s.load()
      // One comment meant for the client…
      s.teamOnlyChoice.set(false)
      s.setDraft(NEW_THREAD_DRAFT, { text: 'For the client', mentions: [] })
      expect(await s.createThread({ kind: 'point', x: 0, y: 0 }, s.draft(NEW_THREAD_DRAFT))).not.toBeNull()
      expect(api.createThread).toHaveBeenLastCalledWith(
        BOARD,
        { kind: 'point', x: 0, y: 0 },
        'For the client',
        'everyone',
      )
      // …never turns the switch off for the internal remark that follows.
      expect(s.newThreadTeamOnly()).toBe(true)
      s.setDraft(NEW_THREAD_DRAFT, { text: 'Internal', mentions: [] })
      await s.createThread({ kind: 'point', x: 0, y: 0 }, s.draft(NEW_THREAD_DRAFT))
      expect(api.createThread).toHaveBeenLastCalledWith(
        BOARD,
        { kind: 'point', x: 0, y: 0 },
        'Internal',
        'team',
      )
      // A failed post keeps the draft and the choice made for it.
      s.teamOnlyChoice.set(false)
      api.createThread = vi.fn(async () => {
        throw new Error('offline')
      })
      s.setDraft(NEW_THREAD_DRAFT, { text: 'Retry me', mentions: [] })
      expect(await s.createThread({ kind: 'point', x: 0, y: 0 }, s.draft(NEW_THREAD_DRAFT))).toBeNull()
      expect(s.newThreadTeamOnly()).toBe(false)
    })

    it('setVisibility applies the thread the server returns', async () => {
      const t = makeThread()
      const s = make(fakeApi({ threads: [t], reads: {}, privacy: { teamOnly: true, teamOnlyDefault: true } }))
      await s.load()
      expect(await s.setVisibility(t.id, 'team')).toBe(true)
      expect(s.thread(t.id)?.visibility).toBe('team')
    })
  })

  it('only a new or denied request is known not to change who has access', () => {
    expect(mayChangeWhoHasAccess({ reason: 'access-request' })).toBe(false)
    expect(mayChangeWhoHasAccess({ reason: 'access-request-deny' })).toBe(false)
    for (const reason of ['grant', 'visibility', 'guest-joined', 'review-link-revoked', 'something-new'])
      expect(mayChangeWhoHasAccess({ reason })).toBe(true)
    expect(mayChangeWhoHasAccess(null)).toBe(true)
  })
})
