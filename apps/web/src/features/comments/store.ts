// Client state for one open board's comments: threads (from GET + board events), the caller's read
// marks, UI state (open thread, new-comment composer, hover, filters, Shift+C), per-thread drafts and
// the notification inbox. Reactive through the cells of the board page's SignalsKit (./cells.ts: tldraw's
// atoms on the tldraw page, lib/signals on the Excalidraw page; components read them with the kit's
// useValue). No React, no DOM, no engine: unit-tested in Node with a fake API.

import {
  type CommentAnchor,
  type CommentPrivacy,
  CommentsDeletedEvent,
  CommentsHiddenEvent,
  CommentsThreadEvent,
  type CommentThread,
  type CommentThreadVisibility,
  type ListNotificationsResponse,
} from '@draftroom/contracts'
import type { CommentsApi } from './api.ts'
import type { Cell, SignalsKit } from './cells.ts'
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

/**
 * F4: whether a `sharing.changed` can change who has access (so who can be mentioned). Only a new
 * access request, or a denied one, certainly does not; anything else (and any unknown reason) does.
 */
export function mayChangeWhoHasAccess(data: unknown): boolean {
  const reason = (data as { reason?: unknown } | null)?.reason
  return reason !== 'access-request' && reason !== 'access-request-deny'
}

/** A burst of sharing changes (several guests joining) costs one refetch of the mention list. */
export const MENTIONABLES_REFRESH_DELAY_MS = 300
/** An @query that matches nobody asks the server again at most this often. */
export const MENTIONABLES_MISS_REFETCH_MS = 5_000

export interface CommentsStoreOptions {
  boardId: string
  meId: string
  canComment: boolean
  api: CommentsApi
  storage: KeyValueStorage | null
  /** The board page's reactive cells (./cells.ts: TLDRAW_SIGNALS or LOBBY_SIGNALS). */
  signals: SignalsKit
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
  /** The board page's cells: components read this store's state with `signals.useValue(cell)`. */
  readonly signals: SignalsKit
  private readonly api: CommentsApi
  private readonly storage: KeyValueStorage | null
  private readonly opts: CommentsStoreOptions

  readonly threads: Cell<Readonly<Record<string, CommentThread>>>
  readonly reads: Cell<Readonly<Record<string, string>>>
  readonly status: Cell<'loading' | 'ready' | 'error'>
  /** The thread whose popover is open. */
  readonly openThreadId: Cell<string | null>
  /** A new comment being written at this anchor (the composer is open). */
  readonly pending: Cell<{ anchor: CommentAnchor } | null>
  readonly hoverThreadId: Cell<string | null>
  readonly pinsHidden: Cell<boolean>
  readonly showResolved: Cell<boolean>
  readonly filter: Cell<ThreadFilter>
  readonly canComment: Cell<boolean>
  readonly notifications: Cell<ListNotificationsResponse>
  readonly mentionables: Cell<Mentionable[] | null>
  /**
   * F10: from the server's list. `teamOnly`: I am on the team (the composer offers "Team only");
   * `teamOnlyDefault`: people outside the team can open this board, so it starts on.
   */
  readonly privacy: Cell<CommentPrivacy>
  /**
   * F10: the new-comment composer's "Team only" choice for the comment being written (reset once it
   * is posted); null follows privacy.teamOnlyDefault.
   */
  readonly teamOnlyChoice: Cell<boolean | null>
  /** Bumped when drafts change, so composers re-read them. */
  readonly draftsVersion: Cell<number>

  private drafts: Map<string, Draft>
  /** Comments deleted during this session: a list fetched before the delete must not revive them. */
  private readonly deletedComments = new Set<string>()
  private loadSeq = 0
  private notificationsTimer: ReturnType<typeof setTimeout> | null = null
  /** M5-3: whether the scheduled refresh must be a whole one (any caller that asked for one wins). */
  private notificationsTimerWhole = false
  /** M5-3: the `seq` of the last bell answer applied (null: none yet, or an api that sends none). */
  private notificationsSeq: number | null = null
  /** M5-3: bell requests sent, and the newest one applied (an older answer never overwrites a newer one). */
  private notificationsAsked = 0
  private notificationsApplied = 0
  private mentionablesLoading: Promise<void> | null = null
  private mentionablesSeq = 0
  private mentionablesAskedAt = 0
  private mentionablesTimer: ReturnType<typeof setTimeout> | null = null
  private privacyTimer: ReturnType<typeof setTimeout> | null = null
  private readonly pendingReads = new Set<string>()
  private disposed = false

  constructor(opts: CommentsStoreOptions) {
    this.opts = opts
    this.boardId = opts.boardId
    this.meId = opts.meId
    this.api = opts.api
    this.storage = opts.storage
    const { atom } = opts.signals
    this.signals = opts.signals
    this.threads = atom<Readonly<Record<string, CommentThread>>>('dr-comments.threads', {})
    this.reads = atom<Readonly<Record<string, string>>>('dr-comments.reads', {})
    this.status = atom<'loading' | 'ready' | 'error'>('dr-comments.status', 'loading')
    this.openThreadId = atom<string | null>('dr-comments.open', null)
    this.pending = atom<{ anchor: CommentAnchor } | null>('dr-comments.pending', null)
    this.hoverThreadId = atom<string | null>('dr-comments.hover', null)
    this.filter = atom<ThreadFilter>('dr-comments.filter', 'open')
    this.notifications = atom<ListNotificationsResponse>('dr-comments.notifications', {
      notifications: [],
      unreadCount: 0,
    })
    this.mentionables = atom<Mentionable[] | null>('dr-comments.mentionables', null)
    this.privacy = atom<CommentPrivacy>('dr-comments.privacy', { teamOnly: false, teamOnlyDefault: false })
    this.teamOnlyChoice = atom<boolean | null>('dr-comments.team-only-choice', null)
    this.draftsVersion = atom('dr-comments.drafts-version', 0)
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
    if (this.mentionablesTimer) clearTimeout(this.mentionablesTimer)
    this.mentionablesTimer = null
    if (this.privacyTimer) clearTimeout(this.privacyTimer)
    this.privacyTimer = null
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
      // F10: a thread I could see that became team-only is simply not in the list any more.
      const team = res.privacy?.teamOnly ?? false
      if (!team) for (const [id, t] of Object.entries(next)) if (t.visibility === 'team') delete next[id]
      this.threads.set(next)
      this.reads.set({ ...res.reads, ...this.localReadsNewerThan(res.reads) })
      this.privacy.set(res.privacy ?? { teamOnly: false, teamOnlyDefault: false })
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

  private dropThread(threadId: string) {
    if (!this.threads.get()[threadId]) return
    this.threads.update((all) => {
      const next = { ...all }
      delete next[threadId]
      return next
    })
    if (this.openThreadId.get() === threadId) this.openThreadId.set(null)
    this.scheduleNotificationsRefresh()
  }

  /** A burst of sharing changes (several guests joining) costs one refetch. */
  private schedulePrivacyRefresh() {
    if (this.privacyTimer) clearTimeout(this.privacyTimer)
    this.privacyTimer = setTimeout(() => {
      this.privacyTimer = null
      if (!this.disposed) void this.load()
    }, MENTIONABLES_REFRESH_DELAY_MS)
  }

  /** F10: whether the new-comment composer's "Team only" is on (my choice, else the board's default). */
  newThreadTeamOnly(): boolean {
    const p = this.privacy.get()
    if (!p.teamOnly) return false
    return this.teamOnlyChoice.get() ?? p.teamOnlyDefault
  }

  /** Board event payloads are untrusted input: parse them against the contract first. */
  handleEvent(type: string, data: unknown) {
    if (type === 'comments.thread') {
      const r = CommentsThreadEvent.safeParse(data)
      if (r.success) this.applyThread(r.data.thread, { fromEvent: true })
    } else if (type === 'comments.deleted') {
      const r = CommentsDeletedEvent.safeParse(data)
      if (r.success) this.applyDeleted(r.data.threadId, r.data.commentId)
    } else if (type === 'comments.hidden') {
      // F10: a thread became team-only (only people outside the team get this): drop it.
      const r = CommentsHiddenEvent.safeParse(data)
      if (r.success && !this.privacy.get().teamOnly) this.dropThread(r.data.threadId)
    } else if (type === SHARING_CHANGED_EVENT) {
      // Someone asked for access (or a request was decided): the owners' bell has news right away.
      if (isAccessRequestChange(data)) this.scheduleNotificationsRefresh(0)
      // F4: who can be mentioned may have changed with it (a grant, a guest joining, a link revoked).
      if (mayChangeWhoHasAccess(data)) {
        this.invalidateMentionables()
        // F10: a client link or a guest may have appeared (or gone): "Team only" follows the board.
        if (this.privacy.get().teamOnly) this.schedulePrivacyRefresh()
      }
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
      const visibility: CommentThreadVisibility = this.newThreadTeamOnly() ? 'team' : 'everyone'
      const thread = await this.api.createThread(this.boardId, anchor, body, visibility)
      this.clearDraft(NEW_THREAD_DRAFT)
      // F10: the choice went with this comment (like its draft); the next one starts from the board's
      // default, so one comment shown to the client never leaves "Team only" off for the next remark.
      this.teamOnlyChoice.set(null)
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

  /** F10: a team member makes a thread team-only, or visible to everyone again. */
  async setVisibility(threadId: string, visibility: CommentThreadVisibility): Promise<boolean> {
    try {
      this.applyThread(await this.api.setVisibility(threadId, visibility))
      return true
    } catch (e) {
      this.fail(e, 'Who sees this comment could not be changed.')
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
    this.mentionablesLoading ??= this.fetchMentionables()
    return this.mentionablesLoading
  }

  /** One GET of the people who can be mentioned; only the newest answer lands. */
  private fetchMentionables(): Promise<void> {
    const seq = ++this.mentionablesSeq
    this.mentionablesAskedAt = Date.now()
    return this.api.mentionables(this.boardId).then(
      (list) => {
        if (!this.disposed && seq === this.mentionablesSeq) this.mentionables.set(list)
      },
      () => {
        if (seq === this.mentionablesSeq) this.mentionablesLoading = null // retry next time
      },
    )
  }

  /**
   * F4: who has access changed (a `sharing.changed` board event, or this tab's Share dialog). A list
   * already fetched is fetched again, soon and once for a burst of changes, so someone just added can
   * be mentioned without a reload; until it lands the old list stays. Never fetched: the next @ does.
   */
  invalidateMentionables(delayMs = MENTIONABLES_REFRESH_DELAY_MS) {
    if (this.disposed) return
    if (this.mentionables.get() === null && this.mentionablesLoading === null) return
    if (this.mentionablesTimer) clearTimeout(this.mentionablesTimer)
    this.mentionablesTimer = setTimeout(() => {
      this.mentionablesTimer = null
      if (this.disposed) return
      this.mentionablesLoading = this.fetchMentionables()
    }, delayMs)
  }

  /**
   * F4: an @query matched nobody. Before the composer's "Nobody with access matches" stays up, ask
   * once more (access can change without a board event, e.g. someone accepting an invite link); at
   * most once per MENTIONABLES_MISS_REFETCH_MS, so typing does not fetch on every key.
   */
  refetchMentionablesOnMiss() {
    if (this.disposed || this.mentionables.get() === null) return
    if (Date.now() - this.mentionablesAskedAt < MENTIONABLES_MISS_REFETCH_MS) return
    this.mentionablesLoading = this.fetchMentionables()
  }

  /**
   * Reads the bell. Wave M (M5-3, CAP-BELL-POLL): `onlyIfNew` (the minute poll) sends the `seq` of the last answer,
   * and a 204 (nothing added or removed since) keeps the list as it is, after one cheap query on the api. Every
   * other refresh (opening the bell, a board event, a reconnect, the tab shown or focused, after marking read)
   * asks for the whole list: read marks made elsewhere do not change the seq. Both send `since`, so the answer
   * carries the seq to send next; a whole refresh sends 0, which only an empty bell answers with a 204.
   */
  async refreshNotifications(opts: { onlyIfNew?: boolean } = {}): Promise<void> {
    const since = opts.onlyIfNew && this.notificationsSeq !== null ? this.notificationsSeq : 0
    const asked = ++this.notificationsAsked
    try {
      const res = await this.api.notifications(undefined, since)
      if (this.disposed || asked < this.notificationsApplied) return
      this.notificationsApplied = asked
      if (res === null) {
        // nothing newer than `since`; and "since 0" answered so means there is nothing at all
        if (since === 0) {
          this.notificationsSeq = 0
          this.notifications.set({ notifications: [], unreadCount: 0 })
        }
        return
      }
      const { seq, ...list } = res
      this.notificationsSeq = seq ?? null
      this.notifications.set(list)
    } catch {
      // keep the previous list; the next refresh tries again
    }
  }

  scheduleNotificationsRefresh(delayMs = 400, opts: { onlyIfNew?: boolean } = {}) {
    if (this.disposed) return
    // folded with a pending refresh: a whole one wins over a poll's
    const whole = !opts.onlyIfNew || (this.notificationsTimer !== null && this.notificationsTimerWhole)
    if (this.notificationsTimer) clearTimeout(this.notificationsTimer)
    this.notificationsTimerWhole = whole
    this.notificationsTimer = setTimeout(() => {
      this.notificationsTimer = null
      void this.refreshNotifications({ onlyIfNew: !whole })
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
