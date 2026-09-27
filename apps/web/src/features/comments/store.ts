// Client state for one open board's comments: threads (from GET + board events), the caller's read
// marks, UI state (open thread, new-comment composer, hover, filters, Shift+C), per-thread drafts and
// the notification inbox. Reactive through tldraw atoms (useValue in components). No React, no DOM:
// unit-tested in Node with a fake API.

import {
  type CommentAnchor,
  CommentsDeletedEvent,
  CommentsThreadEvent,
  type CommentThread,
  type ListNotificationsResponse,
} from '@draftroom/contracts'
import { type Atom, atom } from 'tldraw'
import type { CommentsApi } from './api.ts'
import { bodyFromDraft, type Draft, EMPTY_DRAFT, type Mentionable, pruneMentions } from './mentions.ts'
import { isUnread, type ThreadFilter } from './model.ts'
import {
  draftsKey,
  type KeyValueStorage,
  pinsHiddenKey,
  readDrafts,
  readFlag,
  showResolvedKey,
  writeDrafts,
  writeFlag,
} from './prefs.ts'

export const NEW_THREAD_DRAFT = 'new'

/** The dashboard-share feature's board event for sharing changes (its reason says what changed). */
export const SHARING_CHANGED_EVENT = 'sharing.changed'

/** `sharing.changed` about access requests: reason "access-request" or "access-request-<decision>". */
export function isAccessRequestChange(data: unknown): boolean {
  const reason = (data as { reason?: unknown } | null)?.reason
  return typeof reason === 'string' && reason.startsWith('access-request')
}

export interface CommentsStoreOptions {
  boardId: string
  meId: string
  canComment: boolean
  api: CommentsApi
  storage: KeyValueStorage | null
  /** User-facing failures (a toast). */
  onError?(message: string): void
  /** Someone else mentioned me in a comment that just arrived through a board event. */
  onMentioned?(thread: CommentThread, authorName: string): void
  /** I resolved a thread (it just left the board): the UI offers an undo. */
  onResolved?(thread: CommentThread): void
}

const messageOf = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback)

const newer = (a: CommentThread, b: CommentThread | undefined) =>
  !b || Date.parse(a.updatedAt) >= Date.parse(b.updatedAt)

export class CommentsStore {
  readonly boardId: string
  readonly meId: string
  private readonly api: CommentsApi
  private readonly storage: KeyValueStorage | null
  private readonly opts: CommentsStoreOptions

  readonly threads = atom<Readonly<Record<string, CommentThread>>>('dr-comments.threads', {})
  readonly reads = atom<Readonly<Record<string, string>>>('dr-comments.reads', {})
  readonly status = atom<'loading' | 'ready' | 'error'>('dr-comments.status', 'loading')
  /** The thread whose popover is open. */
  readonly openThreadId = atom<string | null>('dr-comments.open', null)
  /** A new comment being written at this anchor (the composer is open). */
  readonly pending = atom<{ anchor: CommentAnchor } | null>('dr-comments.pending', null)
  readonly hoverThreadId = atom<string | null>('dr-comments.hover', null)
  readonly pinsHidden: Atom<boolean>
  readonly showResolved: Atom<boolean>
  readonly filter = atom<ThreadFilter>('dr-comments.filter', 'open')
  readonly canComment: Atom<boolean>
  readonly notifications = atom<ListNotificationsResponse>('dr-comments.notifications', {
    notifications: [],
    unreadCount: 0,
  })
  readonly mentionables = atom<Mentionable[] | null>('dr-comments.mentionables', null)
  /** Bumped when drafts change, so composers re-read them. */
  readonly draftsVersion = atom('dr-comments.drafts-version', 0)

  private drafts: Map<string, Draft>
  /** Comments deleted during this session: a list fetched before the delete must not revive them. */
  private readonly deletedComments = new Set<string>()
  private loadSeq = 0
  private notificationsTimer: ReturnType<typeof setTimeout> | null = null
  private mentionablesLoading: Promise<void> | null = null
  private readonly pendingReads = new Set<string>()
  private disposed = false

  constructor(opts: CommentsStoreOptions) {
    this.opts = opts
    this.boardId = opts.boardId
    this.meId = opts.meId
    this.api = opts.api
    this.storage = opts.storage
    this.pinsHidden = atom('dr-comments.pins-hidden', readFlag(opts.storage, pinsHiddenKey(opts.meId)))
    this.showResolved = atom('dr-comments.show-resolved', readFlag(opts.storage, showResolvedKey(opts.meId)))
    this.canComment = atom('dr-comments.can-comment', opts.canComment)
    this.drafts = readDrafts(opts.storage, draftsKey(opts.boardId, opts.meId))
  }

  /** (Re)connects after dispose (React StrictMode mounts features twice). */
  attach() {
    this.disposed = false
  }

  dispose() {
    this.disposed = true
    if (this.notificationsTimer) clearTimeout(this.notificationsTimer)
  }

  private fail(e: unknown, fallback: string) {
    this.opts.onError?.(messageOf(e, fallback))
  }

  // ---- threads ---------------------------------------------------------------------------------

  thread(id: string | null): CommentThread | undefined {
    return id ? this.threads.get()[id] : undefined
  }

  /** Authoritative refetch (on mount and after every event-stream reconnect). */
  async load(): Promise<void> {
    const seq = ++this.loadSeq
    const startedAt = Date.now()
    try {
      const res = await this.api.listThreads(this.boardId)
      if (seq !== this.loadSeq || this.disposed) return
      const current = this.threads.get()
      const next: Record<string, CommentThread> = {}
      for (const t of res.threads) {
        const clean = this.withoutDeleted(t)
        if (!clean) continue
        const mine = current[t.id]
        next[t.id] = mine && Date.parse(mine.updatedAt) > Date.parse(clean.updatedAt) ? mine : clean
      }
      // Threads that arrived by event while the list was in flight stay.
      for (const [id, t] of Object.entries(current)) {
        if (!next[id] && Date.parse(t.createdAt) >= startedAt - 1_000) next[id] = t
      }
      this.threads.set(next)
      this.reads.set({ ...res.reads, ...this.localReadsNewerThan(res.reads) })
      this.status.set('ready')
      const open = this.openThreadId.get()
      if (open && !next[open]) this.openThreadId.set(null)
    } catch (e) {
      if (seq !== this.loadSeq || this.disposed) return
      if (this.status.get() !== 'ready') this.status.set('error')
      this.fail(e, 'Comments could not be loaded.')
    }
  }

  private localReadsNewerThan(server: Readonly<Record<string, string>>) {
    const out: Record<string, string> = {}
    for (const [id, at] of Object.entries(this.reads.get())) {
      const s = server[id]
      if (!s || Date.parse(at) > Date.parse(s)) out[id] = at
    }
    return out
  }

  private withoutDeleted(t: CommentThread): CommentThread | null {
    if (!t.comments.some((c) => this.deletedComments.has(c.id))) return t
    const comments = t.comments.filter((c) => !this.deletedComments.has(c.id))
    return comments.length ? { ...t, comments } : null
  }

  /** A thread from a response or a board event (ignored when older than what we have). */
  applyThread(incoming: CommentThread, opts: { fromEvent?: boolean } = {}) {
    if (incoming.boardId !== this.boardId) return
    const thread = this.withoutDeleted(incoming)
    if (!thread) return
    const prev = this.threads.get()[thread.id]
    if (!newer(thread, prev)) return
    this.threads.update((all) => ({ ...all, [thread.id]: thread }))
    if (opts.fromEvent) {
      const known = new Set(prev?.comments.map((c) => c.id) ?? [])
      const fresh = thread.comments.filter((c) => !known.has(c.id) && c.author.id !== this.meId)
      const mention = fresh.find((c) => c.mentions.includes(this.meId))
      if (mention) this.opts.onMentioned?.(thread, mention.author.name)
      // Someone replied while I have the thread open: I have seen it.
      if (fresh.length && this.openThreadId.get() === thread.id) void this.markRead(thread.id)
      // New comments or a resolve may have notified me: refresh the bell.
      if (fresh.length || (prev && prev.status !== thread.status)) this.scheduleNotificationsRefresh()
    }
  }

  applyDeleted(threadId: string, commentId: string) {
    this.deletedComments.add(commentId)
    const t = this.threads.get()[threadId]
    if (!t) return
    const comments = t.comments.filter((c) => c.id !== commentId)
    this.threads.update((all) => {
      const next = { ...all }
      if (comments.length) next[threadId] = { ...t, comments }
      else delete next[threadId]
      return next
    })
    if (!comments.length && this.openThreadId.get() === threadId) this.openThreadId.set(null)
  }

  /** Board event payloads are untrusted input: parse them against the contract first. */
  handleEvent(type: string, data: unknown) {
    if (type === 'comments.thread') {
      const r = CommentsThreadEvent.safeParse(data)
      if (r.success) this.applyThread(r.data.thread, { fromEvent: true })
    } else if (type === 'comments.deleted') {
      const r = CommentsDeletedEvent.safeParse(data)
      if (r.success) this.applyDeleted(r.data.threadId, r.data.commentId)
    } else if (type === SHARING_CHANGED_EVENT) {
      // Someone asked for access (or a request was decided): the owners' bell has news right away.
      if (isAccessRequestChange(data)) this.scheduleNotificationsRefresh(0)
    }
  }

  // ---- UI state ----------------------------------------------------------------------------------

  openThread(id: string | null) {
    this.pending.set(null)
    this.openThreadId.set(id)
    if (id) void this.markRead(id)
  }

  startNewThread(anchor: CommentAnchor) {
    this.openThreadId.set(null)
    this.pending.set({ anchor })
    // Placing a comment while markers are hidden shows them again (you'd lose track of it otherwise).
    if (this.pinsHidden.get()) this.setPinsHidden(false)
  }

  cancelNewThread() {
    this.pending.set(null)
  }

  /** Esc / click-away: closes whatever is open. Returns whether something was open. */
  closeAll(): boolean {
    const had = this.pending.get() !== null || this.openThreadId.get() !== null
    this.pending.set(null)
    this.openThreadId.set(null)
    return had
  }

  setPinsHidden(hidden: boolean) {
    this.pinsHidden.set(hidden)
    writeFlag(this.storage, pinsHiddenKey(this.meId), hidden)
    if (hidden) this.closeAll()
  }

  togglePins() {
    this.setPinsHidden(!this.pinsHidden.get())
  }

  setShowResolved(on: boolean) {
    this.showResolved.set(on)
    writeFlag(this.storage, showResolvedKey(this.meId), on)
  }

  setCanComment(on: boolean) {
    if (this.canComment.get() !== on) this.canComment.set(on)
  }

  // ---- drafts ------------------------------------------------------------------------------------

  draft(key: string): Draft {
    return this.drafts.get(key) ?? EMPTY_DRAFT
  }

  setDraft(key: string, draft: Draft) {
    const d = pruneMentions(draft)
    if (d.text.length === 0) this.drafts.delete(key)
    else {
      this.drafts.delete(key) // re-insert as the newest
      this.drafts.set(key, d)
    }
    writeDrafts(this.storage, draftsKey(this.boardId, this.meId), this.drafts)
    this.draftsVersion.update((n) => n + 1)
  }

  clearDraft(key: string) {
    this.setDraft(key, EMPTY_DRAFT)
  }

  // ---- mutations ---------------------------------------------------------------------------------

  async createThread(anchor: CommentAnchor, draft: Draft): Promise<CommentThread | null> {
    const body = bodyFromDraft(draft).trim()
    if (!body) return null
    try {
      const thread = await this.api.createThread(this.boardId, anchor, body)
      this.clearDraft(NEW_THREAD_DRAFT)
      this.applyThread(thread)
      this.reads.update((r) => ({ ...r, [thread.id]: thread.updatedAt }))
      if (this.pending.get()) this.pending.set(null)
      this.openThreadId.set(thread.id)
      return thread
    } catch (e) {
      this.fail(e, 'Your comment could not be posted. Your text is kept as a draft.')
      return null
    }
  }

  async reply(threadId: string, draft: Draft): Promise<boolean> {
    const body = bodyFromDraft(draft).trim()
    if (!body) return false
    try {
      const thread = await this.api.reply(threadId, body)
      this.clearDraft(threadId)
      this.applyThread(thread)
      this.reads.update((r) => ({ ...r, [threadId]: thread.updatedAt }))
      return true
    } catch (e) {
      this.fail(e, 'Your reply could not be posted. Your text is kept as a draft.')
      return false
    }
  }

  async edit(commentId: string, draft: Draft): Promise<boolean> {
    const body = bodyFromDraft(draft).trim()
    if (!body) return false
    try {
      this.applyThread(await this.api.edit(commentId, body))
      return true
    } catch (e) {
      this.fail(e, 'The comment could not be saved.')
      return false
    }
  }

  async remove(threadId: string, commentId: string): Promise<boolean> {
    try {
      await this.api.remove(commentId)
      this.applyDeleted(threadId, commentId)
      return true
    } catch (e) {
      this.fail(e, 'The comment could not be deleted.')
      return false
    }
  }

  async setStatus(threadId: string, action: 'resolve' | 'reopen'): Promise<boolean> {
    try {
      // Read before the request: its board event can arrive before the response does.
      const wasOpen = this.threads.get()[threadId]?.status === 'open'
      const thread = await this.api.setStatus(threadId, action)
      this.applyThread(thread)
      if (action === 'resolve' && wasOpen && thread.status === 'resolved') this.opts.onResolved?.(thread)
      // Resolving takes the marker off the board: close its popover unless resolved ones are shown.
      if (action === 'resolve' && !this.showResolved.get() && this.openThreadId.get() === threadId)
        this.openThreadId.set(null)
      return true
    } catch (e) {
      this.fail(
        e,
        action === 'resolve' ? 'The thread could not be resolved.' : 'The thread could not be reopened.',
      )
      return false
    }
  }

  async markRead(threadId: string): Promise<void> {
    const t = this.threads.get()[threadId]
    if (!t || !isUnread(t, this.meId, this.reads.get()[threadId])) return
    if (this.pendingReads.has(threadId)) return
    this.pendingReads.add(threadId)
    // Optimistic: the marker turns "read" at once.
    const optimistic = t.comments[t.comments.length - 1]?.createdAt ?? t.updatedAt
    this.reads.update((r) => ({ ...r, [threadId]: optimistic }))
    try {
      const res = await this.api.markRead(threadId)
      this.reads.update((r) => ({ ...r, [threadId]: res.readAt }))
      this.scheduleNotificationsRefresh(0)
    } catch {
      // The server keeps the old mark; the next resync shows the truth.
    } finally {
      this.pendingReads.delete(threadId)
    }
  }

  // ---- mentions + notifications -----------------------------------------------------------------------

  ensureMentionables(): Promise<void> {
    if (this.mentionables.get() !== null) return Promise.resolve()
    this.mentionablesLoading ??= this.api
      .mentionables(this.boardId)
      .then((list) => {
        if (!this.disposed) this.mentionables.set(list)
      })
      .catch(() => {
        this.mentionablesLoading = null // retry next time
      })
    return this.mentionablesLoading
  }

  async refreshNotifications(): Promise<void> {
    try {
      const res = await this.api.notifications()
      if (!this.disposed) this.notifications.set(res)
    } catch {
      // keep the previous list; the next refresh tries again
    }
  }

  scheduleNotificationsRefresh(delayMs = 400) {
    if (this.disposed) return
    if (this.notificationsTimer) clearTimeout(this.notificationsTimer)
    this.notificationsTimer = setTimeout(() => {
      this.notificationsTimer = null
      void this.refreshNotifications()
    }, delayMs)
  }

  async markNotificationsRead(sel: { ids: string[] } | { all: true }): Promise<void> {
    const ids = 'ids' in sel ? new Set(sel.ids) : null
    const readAt = new Date().toISOString()
    this.notifications.update((n) => {
      const notifications = n.notifications.map((x) =>
        !x.readAt && (!ids || ids.has(x.id)) ? { ...x, readAt } : x,
      )
      const cleared = n.notifications.filter((x) => !x.readAt && (!ids || ids.has(x.id))).length
      return { notifications, unreadCount: Math.max(0, n.unreadCount - cleared) }
    })
    try {
      await this.api.markNotificationsRead(sel)
    } catch (e) {
      this.fail(e, 'Notifications could not be marked as read.')
    }
    await this.refreshNotifications()
  }
}
