// OWNER: WS5 (wave N, N5-2). The ways into Capture the room, for ../ported/menus.tsx:
// - AI › "Capture the room…" in the context menu (with Diagram from words, M4-5);
// - on an image (the one selected, or the one under the pointer): AI › "Turn photo into notes" and "Turn photo into a
//   diagram" (it reads the board's own copy of the image: nothing is uploaded again);
// - the palette command 'ai.capture'. It is held while the contracts still list it as pending
//   (PENDING_PALETTE_COMMAND_IDS, WS4's list: removing the id there registers it, as the api's PENDING_ROUTES does
//   for the routes), so the palette never offers a command the contract calls pending.
// Every entry shows only while capture is available (./client.ts: AI on for this editor here, an api with the
// routes; photos also the server's vision), so viewers, commenters, name-only guests and a board with AI off see none.
import { PENDING_PALETTE_COMMAND_IDS } from '@draftroom/contracts'
import type {
  CanvasFeatureContext,
  CommandSpec,
  MenuEntrySpec,
  MenuTarget,
} from '../../../canvas/api/index.ts'
import { items } from '../../../canvas/api/index.ts'
import { ensureAiStatus } from '../ported/actions.ts'
import { setAiCtx } from '../ported/runtime.ts'
import { AI_CAPTURE_COMMAND_ID, captureAvailable, captureFacts, photoCaptureAvailable } from './client.ts'
import { openCaptureDialog } from './run.ts'

const VERSION_ID = /^ver_[0-9A-Za-z]{10,40}$/

/** Capture offered on this board's canvas (the one the AI feature mounted). */
export const captureOfferedOn = (ctx: CanvasFeatureContext): boolean =>
  captureFacts.get().canvas === ctx.canvas && captureAvailable()
export const photoOfferedOn = (ctx: CanvasFeatureContext): boolean =>
  captureFacts.get().canvas === ctx.canvas && photoCaptureAvailable()

/** The image the menu is about (under the pointer, else the one selected), when it is a photo-like image. */
export function imageOf(
  ctx: Pick<CanvasFeatureContext, 'canvas'>,
  t: Pick<MenuTarget, 'hit' | 'ids'>,
): string | null {
  const id = t.hit?.id ?? (t.ids.length === 1 ? t.ids[0] : undefined)
  const el = id ? ctx.canvas.get(id) : undefined
  if (!el || el.isDeleted || el.type !== 'image') return null
  const fileId = (el as { fileId?: unknown }).fileId
  // a PDF page (`ver_….p2`) or a file card is not a photo
  if (typeof fileId !== 'string' || !VERSION_ID.test(fileId)) return null
  const file = items.lobbyValue(el, 'file') as { kind?: unknown } | undefined
  if (file && typeof file === 'object' && file.kind !== undefined && file.kind !== 'image') return null
  return el.id
}

/** After the menu has closed (its focus handling first). */
const later = (fn: () => void) => void setTimeout(fn, 0)

export const CAPTURE_MENU: readonly MenuEntrySpec[] = [
  {
    id: 'ai.capture',
    group: 'ai',
    order: 4.6,
    label: 'Capture the room…',
    visible: captureOfferedOn,
    run: (ctx) => {
      setAiCtx(ctx)
      later(() => openCaptureDialog(ctx))
    },
  },
  {
    id: 'ai.capture.photo-notes',
    group: 'ai',
    order: 4.7,
    label: 'Turn photo into notes',
    visible: (ctx, t) => photoOfferedOn(ctx) && imageOf(ctx, t) !== null,
    run: (ctx, t) => {
      const elementId = imageOf(ctx, t)
      if (!elementId) return
      setAiCtx(ctx)
      later(() => openCaptureDialog(ctx, { boardImage: { elementId, mode: 'notes' } }))
    },
  },
  {
    id: 'ai.capture.photo-diagram',
    group: 'ai',
    order: 4.8,
    label: 'Turn photo into a diagram',
    visible: (ctx, t) => photoOfferedOn(ctx) && imageOf(ctx, t) !== null,
    run: (ctx, t) => {
      const elementId = imageOf(ctx, t)
      if (!elementId) return
      setAiCtx(ctx)
      later(() => openCaptureDialog(ctx, { boardImage: { elementId, mode: 'diagram' } }))
    },
  },
]

export const CAPTURE_COMMAND: CommandSpec = {
  id: AI_CAPTURE_COMMAND_ID,
  label: 'Capture the room…',
  group: 'AI',
  keywords: [
    'photo',
    'camera',
    'sticky notes',
    'whiteboard',
    'picture',
    'transcript',
    'meeting',
    'minutes',
    'ai',
  ],
  enabled: captureOfferedOn,
  run: async (ctx) => {
    setAiCtx(ctx)
    await ensureAiStatus(ctx.canvas)
    if (captureOfferedOn(ctx)) openCaptureDialog(ctx)
  },
}

/** Whether the contracts still hold 'ai.capture' pending (then the palette does not get it yet). */
export const captureCommandHeld = (pending: readonly string[] = PENDING_PALETTE_COMMAND_IDS): boolean =>
  pending.includes(AI_CAPTURE_COMMAND_ID)

/** The capture commands the AI feature registers: none while the contract holds the id pending. */
export const CAPTURE_COMMANDS: readonly CommandSpec[] = captureCommandHeld() ? [] : [CAPTURE_COMMAND]
