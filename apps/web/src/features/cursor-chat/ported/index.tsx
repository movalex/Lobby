// OWNER: 3c (people and presence; added in wave K, K6-4). Cursor chat on the Excalidraw board page: press /
// with the board in hand, type a short line, Enter, and it floats at your cursor for everyone on the board
// for a few seconds, then fades. Never stored: the api relays it on the board's event stream
// (@draftroom/contracts cursor-chat.ts); no sync push, no board write, no presence field.
//
// - The key: a command with kbd '/' (it shows in the shortcuts dialog), and (wave K.1) a key matched on the
//   character '/' whatever Shift does, for layouts that put '/' on Shift (German Shift+7). Not offered at all
//   on a device without a cursor (a phone: `hasCursor`). The key registry runs them before
//   the key allowlist, in the canvas scope only: never inside the text editor, an overlay's field or any
//   other input (canvas/board/input.ts), and it is not delegated to Excalidraw. It steps aside when '/'
//   would type into the one selected note (type-to-edit), for people who may not comment, and while
//   presenting (focus mode hides the layers and everyone's cursors).
// - The composer: a small field at the pointer (or the middle of the view when the pointer is elsewhere);
//   Enter sends, Escape or leaving it closes; keys typed into it never reach the board.
// - The bubbles: someone else's message floats at their live cursor (the tab nearest to where they sent it)
//   when this page shows that cursor (not hidden by a facilitator, not presenting); where they sent it from
//   when this page has no cursor of theirs, and then it names them (`Name: text`, wave K round 1 refix: that
//   point is the sender's to choose and may be a colleague's cursor); nowhere when their cursor is hidden
//   here. This person's own floats where they sent it. One per person; CURSOR_CHAT_SHOW_MS, then a
//   CURSOR_CHAT_FADE_MS fade. The board's own polite live region (the a11y announcer's, features/a11y) reads each message out:
//   the board has one set of live regions (e2e a11y-audit rule 6), never one per feature.
import '../cursor-chat.css'
import { CURSOR_CHAT_EVENT, CURSOR_CHAT_MAX_CHARS, cursorChatPath } from '@draftroom/contracts'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { CanvasFeature, CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { safeColor } from '../../../lib/identity.ts'
import { type Atom, atom, useValue } from '../../../lib/signals.ts'
import { announcerFor } from '../../a11y/ported/announcer.ts'
import {
  addBubble,
  anchorFor,
  BUBBLE_OFFSET,
  type Bubble,
  ChatThrottle,
  clampText,
  failureText,
  hasCursor,
  incoming,
  mayChat,
  messageOf,
  nextChangeAt,
  type Point,
  phaseOf,
  placeBubble,
} from '../model.ts'

type Ctx = CanvasFeatureContext

/** The open composer: where it sits (scene), and a key so a new open starts empty. */
interface Composer {
  readonly anchor: Point
  readonly key: number
}

/** One board page's cursor chat: the bubbles, the composer and the sends. */
export class CursorChatController {
  readonly bubbles: Atom<readonly Bubble[]> = atom('cursor-chat.bubbles', [] as readonly Bubble[])
  readonly composer: Atom<Composer | null> = atom('cursor-chat.composer', null as Composer | null)
  private readonly throttle = new ChatThrottle()
  private timer: ReturnType<typeof setTimeout> | null = null
  private opened = 0
  /** The board page's context: its getters follow the role and the board while the board is open. */
  private readonly ctx: Ctx

  constructor(ctx: Ctx) {
    this.ctx = ctx
  }

  mount(): () => void {
    const off = this.ctx.events.on(CURSOR_CHAT_EVENT, (data) => this.receive(data))
    return () => {
      off()
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      this.bubbles.set([])
      this.composer.set(null)
    }
  }

  /** Whether / opens the composer now (see the header). */
  canOpen(): boolean {
    const { canvas, registries } = this.ctx
    if (!mayChat(this.ctx.role, this.ctx.board.status)) return false
    // a touch screen with no cursor (K.1): nothing to chat at
    if (!hasCursor()) return false
    if (this.composer.get()) return false
    // presenting (focus mode): the layers are hidden, and so are everyone's cursors
    if (focusModeOf(canvas)) return false
    if (!canvas.readOnly()) {
      // '/' types into the one selected note (type-to-edit), or the element a feature's rule edits
      const sel = canvas.selection
      if (sel.length === 1) {
        const id = sel[0] as string
        if (canvas.get(id)?.type === 'stickynote') return false
        if (registries.typeToEdit.list().some((s) => s.applies(id))) return false
      }
    }
    return true
  }

  open(): void {
    if (!this.canOpen()) return
    this.composer.set({ anchor: anchorOf(this.ctx.canvas), key: ++this.opened })
  }

  close(opts: { focusBoard: boolean }): void {
    if (!this.composer.get()) return
    this.composer.set(null)
    if (opts.focusBoard) this.ctx.canvas.focus({ preventScroll: true })
  }

  /** Sends what the composer holds (shown here at once); closes the composer. */
  async send(raw: string): Promise<void> {
    const composer = this.composer.get()
    const text = messageOf(raw)
    this.close({ focusBoard: true })
    if (!text || !composer) return
    const { ctx } = this
    if (!this.throttle.tryTake(Date.now())) {
      ctx.notify({ key: 'cursor-chat', text: failureText({ status: 429 }), testId: 'cursor-chat-toast' })
      return
    }
    const since = Date.now()
    this.add({
      userId: ctx.me.user.id,
      name: ctx.me.user.name,
      text,
      mine: true,
      sid: null,
      at: composer.anchor,
      since,
      color: safeColor(ctx.me.user.color, ctx.me.user.id),
    })
    try {
      await ctx.api.request('POST', cursorChatPath(ctx.board.id), {
        body: { text, at: roundPoint(composer.anchor) },
        schema: null,
      })
    } catch (e) {
      // nobody saw it: it does not float here either
      this.bubbles.set(this.bubbles.get().filter((b) => !(b.mine && b.since === since)))
      ctx.notify({
        key: 'cursor-chat',
        text: failureText(e as { status?: number; code?: string }),
        tone: 'error',
        testId: 'cursor-chat-toast',
      })
    }
  }

  private receive(data: unknown): void {
    const { ctx } = this
    const m = incoming(data, ctx.me.user.id)
    if (!m) return
    const peers = ctx.canvas.presence.peers()
    const visible = (sid: string) => ctx.registries.cursorVisible.call(sid)
    const anchor = anchorFor(peers, m.userId, m.at, visible)
    // their cursor is hidden here (a facilitator hid the cursors, or presenting): no bubble, nothing read out
    if (!anchor) return
    const { sid } = anchor
    const peer = sid ? peers.find((p) => p.sid === sid) : undefined
    this.add({
      userId: m.userId,
      name: m.name,
      text: m.text,
      mine: false,
      sid,
      at: anchor.at,
      since: Date.now(),
      color: safeColor(peer?.color, m.userId),
    })
    // said politely, so it never cuts off what the selection says
    announcerFor(ctx.canvas).sayPolitely(`${m.name} says: ${m.text}`)
  }

  private add(b: Bubble): void {
    this.bubbles.set(addBubble(this.bubbles.get(), b, Date.now()))
    this.reschedule()
  }

  /** One timer for the next fade or removal: the list is re-set then, so the layer re-renders. */
  private reschedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const now = Date.now()
    const next = nextChangeAt(this.bubbles.get(), now)
    if (next === null) return
    this.timer = setTimeout(
      () => {
        this.timer = null
        const at = Date.now()
        this.bubbles.set(this.bubbles.get().filter((b) => phaseOf(b, at) !== 'gone'))
        this.reschedule()
      },
      Math.max(0, next - now) + 15,
    )
  }
}

const controllers = new WeakMap<LobbyCanvas, CursorChatController>()

/** The board page's controller (made on mount). */
export function cursorChatOf(ctx: Ctx): CursorChatController | null {
  return controllers.get(ctx.canvas) ?? null
}

/** Where the composer opens: the pointer on the canvas, else the middle of the view (scene). */
function anchorOf(canvas: LobbyCanvas): Point {
  const p = canvas.pointer()
  if (p?.overCanvas) return { x: p.scene.x, y: p.scene.y }
  const v = canvas.viewport.get()
  return { x: v.x + v.width / 2, y: v.y + v.height / 2 }
}

function focusModeOf(canvas: LobbyCanvas): boolean {
  try {
    return canvas.settings.get().focusMode
  } catch {
    return false
  }
}

const roundPoint = (p: Point): Point => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })

/** Re-renders when any registry changes (a facilitator hiding cursors provides cursorVisible). */
function useRegistryVersion(ctx: Ctx): number {
  const ref = useRef(0)
  return useSyncExternalStore(
    (l) =>
      ctx.registries.subscribe(() => {
        ref.current++
        l()
      }),
    () => ref.current,
  )
}

// ---- the layers ---------------------------------------------------------------------------------------------

/** Every bubble on the board, at its cursor (or where it was sent). Never takes a click. */
function BubblesLayer({ ctx }: { ctx: Ctx }) {
  const c = cursorChatOf(ctx)
  const version = useRegistryVersion(ctx)
  const list = useValue('cursor-chat-list', () => c?.bubbles.get() ?? [], [c])
  const placed = useValue('cursor-chat-placed', () => {
    const out: { b: Bubble; x: number; y: number; named: boolean }[] = []
    for (const b of list) {
      let cursor: Point | null = null
      if (b.sid) {
        const peer = ctx.canvas.presence.peer(b.sid)
        // a cursor this page does not show (hidden by a facilitator, presenting) gives nothing away
        if (peer && !ctx.registries.cursorVisible.call(b.sid)) continue
        cursor = peer?.point ?? null
      }
      // away from the sender's own cursor it names them (it may sit at someone else's)
      const place = placeBubble(b, cursor)
      if (!place) continue
      const o = ctx.canvas.sceneToOverlay(place.point)
      out.push({ b, x: o.x + BUBBLE_OFFSET.x, y: o.y + BUBBLE_OFFSET.y, named: place.named })
    }
    return out
  }, [ctx, list, version])
  const now = Date.now()
  return (
    <>
      {placed.map(({ b, x, y, named }) => (
        <div
          key={`${b.userId}:${b.since}`}
          className="dr-cchat-bubble"
          data-testid="cursor-chat-bubble"
          data-user-id={b.userId}
          data-mine={b.mine ? 'true' : 'false'}
          data-phase={phaseOf(b, now)}
          data-named={named ? 'true' : 'false'}
          aria-hidden="true"
          style={{ left: x, top: y, background: b.color }}
        >
          {named && (
            <span className="dr-cchat-bubble__name" data-testid="cursor-chat-bubble-name">
              {b.name}:{' '}
            </span>
          )}
          {b.text}
        </div>
      ))}
    </>
  )
}

/** The composer at the pointer. Its field takes clicks and keys; the board gets neither. */
function ComposerLayer({ ctx }: { ctx: Ctx }) {
  const c = cursorChatOf(ctx)
  const composer = useValue('cursor-chat-composer', () => c?.composer.get() ?? null, [c])
  const at = useValue(
    'cursor-chat-composer-at',
    () => (composer ? ctx.canvas.sceneToOverlay(composer.anchor) : null),
    [ctx, composer],
  )
  if (!c || !composer || !at) return null
  return (
    <ComposerField
      key={composer.key}
      controller={c}
      color={safeColor(ctx.me.user.color, ctx.me.user.id)}
      x={at.x + BUBBLE_OFFSET.x}
      y={at.y + BUBBLE_OFFSET.y}
    />
  )
}

function ComposerField({
  controller,
  color,
  x,
  y,
}: {
  controller: CursorChatController
  color: string
  x: number
  y: number
}) {
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus({ preventScroll: true })
  }, [])
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // the board never sees a key typed here (its allowlist, Excalidraw's document listeners)
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      void controller.send(text)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      controller.close({ focusBoard: true })
    }
  }
  const left = CURSOR_CHAT_MAX_CHARS - [...text].length
  return (
    <div
      className="dr-cchat-composer"
      style={{ left: x, top: y, background: color }}
      data-testid="cursor-chat-composer"
    >
      <input
        ref={input}
        className="dr-cchat-composer__input"
        data-testid="cursor-chat-input"
        type="text"
        value={text}
        aria-label="Cursor chat: a message everyone on the board sees at your cursor for a few seconds. Enter sends, Escape closes."
        placeholder="Say something…"
        autoComplete="off"
        spellCheck
        enterKeyHint="send"
        onChange={(e) => setText(clampText(e.target.value))}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => e.stopPropagation()}
        onBlur={() => controller.close({ focusBoard: false })}
      />
      {left <= 15 && (
        <span className="dr-cchat-composer__left" aria-hidden="true">
          {left}
        </span>
      )}
    </div>
  )
}

export const feature: CanvasFeature = {
  id: 'cursor-chat',
  commands: [
    {
      id: 'cursor-chat.open',
      label: 'Chat at your cursor',
      kbd: ['/'],
      scope: 'canvas',
      // commenters run the board read-only, and may chat
      readOnlyAllowed: true,
      // K.1: not offered without a cursor (a phone): no row in the shortcuts dialog, and the key does nothing
      available: () => hasCursor(),
      enabled: (ctx) => cursorChatOf(ctx)?.canOpen() ?? false,
      run: (ctx) => cursorChatOf(ctx)?.open(),
    },
  ],
  keys: [
    {
      // K.1 (follow-up 11): '/' by the character it types, so layouts that need Shift for it (German Shift+7,
      // French Shift+:) open the composer too; the command above keeps the plain '/' chord (and its dialog row)
      id: 'cursor-chat.open-char',
      scope: 'canvas',
      chords: [],
      chars: ['/'],
      handle: (_e, ctx) => {
        const c = cursorChatOf(ctx)
        if (!c?.canOpen()) return false
        c.open()
        return true
      },
    },
  ],
  overlays: [
    // above the canvas's own marks, under the workshop and present layers; never takes a click
    { id: 'cursor-chat.bubbles', layer: 'scene', order: 60, pointer: 'none', component: BubblesLayer },
    { id: 'cursor-chat.composer', layer: 'scene', order: 61, pointer: 'auto', component: ComposerLayer },
  ],
  onMount(ctx) {
    const c = new CursorChatController(ctx)
    controllers.set(ctx.canvas, c)
    const unmount = c.mount()
    return () => {
      unmount()
      if (controllers.get(ctx.canvas) === c) controllers.delete(ctx.canvas)
    }
  },
}
