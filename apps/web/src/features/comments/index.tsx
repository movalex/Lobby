// Feature module: comments (docs/FEATURES-M2-CONTRACTS.md, "comments"; checklist REV-01..06).
// Owned by the comments engineer.
//
// - Comment tool (C): click an object to attach a thread that moves with it, click the board for a
//   pinned point; Enter posts, Shift+Enter adds a line; unsent text stays as a draft.
// - Markers per person: unread / read / resolved / mentions me; hover preview; Shift+C hides them.
// - Thread popover: replies, edit/delete own (owners delete any), resolve/reopen.
// - Dock panel `comments` with filters; orphans ("On a deleted object") re-attach when the object returns.
// - @mentions from the board's members; notifications bell (in-app only; no email).
// Everything works for commenters on a read-only canvas; the API enforces every rule.

import { COMMENTS_DELETED_EVENT, COMMENTS_THREAD_EVENT, CommentThreadId } from '@draftroom/contracts'
import type { BoardFeature, FeatureContext } from '../types.ts'
import './comments.css'
import { CommentsOverlay } from './CommentsOverlay.tsx'
import { CommentsPanel } from './CommentsPanel.tsx'
import { CommentsTopBar } from './CommentsTopBar.tsx'
import { commentOverrides, controllerFor, focusThread } from './controller.ts'
import { anchorAt } from './geometry.ts'
import { CommentIcon } from './icons.tsx'
import { registerCommentTool, setCommentToolHandler } from './tool.ts'

const NOTIFICATIONS_POLL_MS = 60_000
/** A resync right after a load (the stream's first hello) does not refetch again. */
const RESYNC_DEBOUNCE_MS = 1_500

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

function mount(ctx: FeatureContext): () => void {
  const { editor, events } = ctx
  const controller = controllerFor(ctx)
  const { store } = controller
  store.attach()
  registerCommentTool(editor)
  setCommentToolHandler(editor, {
    place(point) {
      // The first click with something open just closes it (the draft stays); the next one places.
      if (store.closeAll()) return
      if (!store.canComment.get()) return
      store.startNewThread(anchorAt(editor, point))
    },
    cancel: () => store.closeAll(),
    exit: () => store.cancelNewThread(),
  })

  let lastLoad = 0
  const load = () => {
    lastLoad = Date.now()
    return store.load()
  }
  const offs = [
    events.on(COMMENTS_THREAD_EVENT, (data) => store.handleEvent(COMMENTS_THREAD_EVENT, data)),
    events.on(COMMENTS_DELETED_EVENT, (data) => store.handleEvent(COMMENTS_DELETED_EVENT, data)),
    events.onResync(() => {
      if (Date.now() - lastLoad > RESYNC_DEBOUNCE_MS) void load()
      store.scheduleNotificationsRefresh(0)
    }),
  ]
  const deepLink = takeDeepLinkedThread()
  void load().then(() => {
    if (!deepLink) return
    if (!focusThread(editor, deepLink))
      controller.ctx.notify({
        key: 'comments:gone',
        text: 'That comment was deleted, or you no longer have access to it.',
        testId: 'comments-gone',
      })
  })
  store.scheduleNotificationsRefresh(0)
  const poll = setInterval(() => void store.refreshNotifications(), NOTIFICATIONS_POLL_MS)
  const onFocus = () => store.scheduleNotificationsRefresh(0)
  window.addEventListener('focus', onFocus)

  return () => {
    for (const off of offs) off()
    clearInterval(poll)
    window.removeEventListener('focus', onFocus)
    setCommentToolHandler(editor, null)
    store.dispose()
  }
}

export const commentsFeature: BoardFeature = {
  id: 'comments',
  panels: [
    {
      id: 'comments',
      label: 'Comments',
      icon: <CommentIcon />,
      shortcutHint: 'C to comment, Shift+C to hide',
      Component: CommentsPanel,
    },
  ],
  TopBarItem: CommentsTopBar,
  Overlay: CommentsOverlay,
  overrides: commentOverrides,
  onMount: mount,
}
