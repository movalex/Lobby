// OWNER: 3c (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'comments' feature on the Excalidraw board page
// (the tldraw page's ../index.tsx; docs/EXCALIDRAW-MIGRATION.md §4.3 "Comments: tool (C), pins that follow
// shapes, anchors, orphans"):
// - the comment tool (C): click an object to attach a thread that moves with it, click the board for a
//   pinned point; Enter posts, Shift+Enter adds a line; unsent text stays as a draft;
// - markers per person: unread / read / resolved / mentions me; hover preview; Shift+C hides them;
// - the thread popover: replies, edit/delete own (owners delete any), resolve/reopen, team-only (F10);
// - the dock panel `comments` with filters; orphans ("On a deleted object") re-attach when the object
//   returns;
// - @mentions from the board's members; the notifications bell (in-app only; no email);
// - "Comment" in the context menu for the selection (A11Y2-04).
// Everything works for commenters on a read-only canvas; the API enforces every rule.

import { COMMENTS_DELETED_EVENT, COMMENTS_THREAD_EVENT, CommentThreadId } from '@draftroom/contracts'
import type { CanvasFeature, CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { SHARE_CHANGED_EVENT } from '../../sharing/api.ts'
import '../comments.css'
import { CommentIcon } from '../icons.tsx'
import { SHARING_CHANGED_EVENT } from '../store.ts'
import { CommentsOverlay } from './CommentsOverlay.tsx'
import { CommentsPanel } from './CommentsPanel.tsx'
import { CommentsMenuItem, CommentsTopBar } from './CommentsTopBar.tsx'
import { COMMENT_TOOL_ID, controllerFor, focusThread, selectCommentTool } from './controller.ts'
import { anchorAt, anchorForKeyboard } from './geometry.ts'
import { COMMENT_TOOL_KEYS, placeCommentFromKeyboard } from './keys.ts'
import { startNotificationsPoll } from './poll.ts'
import { mountCommentTool } from './tool.ts'

const NOTIFICATIONS_POLL_MS = 60_000
/** A resync right after a load does not refetch again. */
const RESYNC_DEBOUNCE_MS = 1_500
/**
 * K2-6 (PERF-10): the board's threads are fetched ONCE per open. The first fetch waits for the event stream's
 * first hello (its resync: nothing said before it can be missed after it), at most this long; before wave K
 * the mount fetched, and the stream's first hello (fired at once when it was already up, or a moment later)
 * fetched again.
 */
export const FIRST_LOAD_WAIT_MS = 2_500

/** `/b/:bid?thread=thr_…` (links from notifications) opens that thread once the threads are loaded. */
function takeDeepLinkedThread(): string | null {
  try {
    const url = new URL(window.location.href)
    const id = url.searchParams.get('thread')
    if (!id) return null
    url.searchParams.delete('thread')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    return CommentThreadId.safeParse(id).success ? id : null
  } catch {
    return null
  }
}

/** Picks the comment tool and opens a new thread on the selection (a no-op for people who cannot comment). */
export function commentOnSelection(ctx: CanvasFeatureContext) {
  const ids = [...ctx.canvas.selection]
  const anchor = anchorForKeyboard(ctx.canvas)
  selectCommentTool(ctx)
  if (ctx.canvas.tool() === COMMENT_TOOL_ID) {
    placeCommentFromKeyboard(ctx)
    return
  }
  // The tool can land a render later (the board page reports it through toolChanged): the composer opens
  // once it is on (the wave-3 integration: 3a's context menu "Comment" found the tool still off).
  let done = false
  const finish = () => {
    done = true
    off()
    clearTimeout(timer)
  }
  const off = ctx.canvas.on('toolChanged', (tool) => {
    if (done || tool !== COMMENT_TOOL_ID) return
    finish()
    // the switch may have dropped the selection the comment is for: it is the selection when asked
    if (ids.length && ctx.canvas.selection.length === 0) ctx.canvas.select(ids)
    placeCommentFromKeyboard(ctx, anchor)
  })
  const timer = setTimeout(() => {
    if (!done) finish()
  }, 1000)
}

function mount(ctx: CanvasFeatureContext): () => void {
  const { canvas, events } = ctx
  const controller = controllerFor(ctx)
  const { store } = controller
  store.attach()
  const offTool = mountCommentTool(ctx, {
    place(point) {
      // The first click with something open just closes it (the draft stays); the next one places.
      if (store.closeAll()) return
      if (!store.canComment.get()) return
      store.startNewThread(anchorAt(canvas, point))
    },
  })

  let lastLoad = 0
  const load = () => {
    lastLoad = Date.now()
    return store.load()
  }
  // K2-6: the first load, on the stream's first hello or after FIRST_LOAD_WAIT_MS, whichever comes first
  let resolveFirst: () => void = () => {}
  const firstLoaded = new Promise<void>((resolve) => {
    resolveFirst = resolve
  })
  let firstTimer: ReturnType<typeof setTimeout> | null = null
  const firstLoad = () => {
    if (firstTimer === null) return false
    clearTimeout(firstTimer)
    firstTimer = null
    void load().finally(resolveFirst)
    return true
  }
  firstTimer = setTimeout(firstLoad, FIRST_LOAD_WAIT_MS)
  const offs = [
    events.on(COMMENTS_THREAD_EVENT, (data) => store.handleEvent(COMMENTS_THREAD_EVENT, data)),
    events.on(COMMENTS_DELETED_EVENT, (data) => store.handleEvent(COMMENTS_DELETED_EVENT, data)),
    // Someone asked for access (or a request was decided): the owners' bell has news right away; and who
    // can be @mentioned follows any change of who has access (F4).
    events.on(SHARING_CHANGED_EVENT, (data) => store.handleEvent(SHARING_CHANGED_EVENT, data)),
    events.onResync(() => {
      if (!firstLoad() && Date.now() - lastLoad > RESYNC_DEBOUNCE_MS) void load()
      store.scheduleNotificationsRefresh(0)
    }),
  ]
  const deepLink = takeDeepLinkedThread()
  void firstLoaded.then(() => {
    if (!deepLink) return
    if (!focusThread(controller.ctx, deepLink))
      controller.ctx.notify({
        key: 'comments:gone',
        text: 'That comment was deleted, or you no longer have access to it.',
        testId: 'comments-gone',
      })
  })
  // F4: a change made in this tab's Share dialog (the board event covers everyone else's, and this tab's
  // too while the stream is up; the store folds the two into one refetch).
  const onShareChanged = (e: Event) => {
    const id = (e as CustomEvent<{ boardId?: string }>).detail?.boardId
    if (!id || id === store.boardId) store.invalidateMentionables()
  }
  window.addEventListener(SHARE_CHANGED_EVENT, onShareChanged)
  store.scheduleNotificationsRefresh(0)
  // K2-6 (F8): no poll while the tab is hidden; one refresh when it is shown again (folded with a focus)
  const stopPoll = startNotificationsPoll({
    poll: () => void store.refreshNotifications(),
    wake: () => store.scheduleNotificationsRefresh(0),
    doc: document,
    intervalMs: NOTIFICATIONS_POLL_MS,
  })
  const onFocus = () => store.scheduleNotificationsRefresh(0)
  window.addEventListener('focus', onFocus)

  return () => {
    for (const off of offs) off()
    if (firstTimer !== null) clearTimeout(firstTimer)
    firstTimer = null
    offTool()
    window.removeEventListener(SHARE_CHANGED_EVENT, onShareChanged)
    stopPoll()
    window.removeEventListener('focus', onFocus)
    store.dispose()
  }
}

function PanelIcon() {
  return <CommentIcon />
}

function ToolIcon() {
  return <CommentIcon size={20} />
}

export const feature: CanvasFeature = {
  id: 'comments',
  panels: [
    {
      id: 'comments',
      label: 'Comments',
      icon: PanelIcon,
      shortcutHint: 'c',
      order: 20,
      component: CommentsPanel,
    },
  ],
  // the bell stays in the bar on narrow screens (PRI-02); K2-5: on a phone it is in "⋯" with the comment tool
  // (the second item, which draws nothing on wider screens; the comment tool left the bar there)
  topBar: [
    { id: 'comments', order: 20, pinned: true, component: CommentsTopBar },
    { id: 'comments-menu', order: 21, overflowCaption: 'Comments', component: CommentsMenuItem },
  ],
  tools: [
    {
      id: COMMENT_TOOL_ID,
      label: 'Comment',
      readOnlyAllowed: true,
      cursor: 'crosshair',
      toolbar: { group: 'main', order: 900, icon: ToolIcon },
      // Esc or another tool: the new-comment composer closes (its text stays a draft)
      onExit: (ctx) => controllerFor(ctx).store.cancelNewThread(),
    },
  ],
  commands: [
    {
      id: 'comments.select-tool',
      label: 'Comment',
      kbd: ['c'],
      readOnlyAllowed: true,
      run: (ctx) => selectCommentTool(ctx),
    },
    {
      id: 'comments.toggle-pins',
      label: 'Show or hide comments',
      kbd: ['shift+c'],
      readOnlyAllowed: true,
      run: (ctx) => controllerFor(ctx).store.togglePins(),
    },
    {
      id: 'comments.comment-selection',
      label: 'Comment on the selection',
      readOnlyAllowed: true,
      enabled: (ctx) => ctx.canvas.selection.length > 0 && controllerFor(ctx).store.canComment.get(),
      run: (ctx) => commentOnSelection(ctx),
    },
  ],
  keys: COMMENT_TOOL_KEYS,
  overlays: [{ id: 'comments', layer: 'scene', order: 30, pointer: 'none', component: CommentsOverlay }],
  contextMenu: [
    {
      id: 'comments.comment-selection',
      group: 'collaborate',
      order: 10,
      label: 'Comment',
      visible: (ctx, target) => target.ids.length > 0 && controllerFor(ctx).store.canComment.get(),
      // After the menu has closed and handed the focus back, so the composer keeps it.
      run: (ctx) => {
        setTimeout(() => commentOnSelection(ctx), 0)
      },
    },
  ],
  onMount: mount,
}
