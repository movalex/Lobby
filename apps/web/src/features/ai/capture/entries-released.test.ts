// Wave N (WS5, N5-2): the ways into Capture the room (./entries.ts) once the contracts no longer hold 'ai.capture'
// pending (here the contracts' pending list is mocked without it, as the integration leaves it): AI › "Capture the
// room…" for an editor with AI on, the image entries only on a photo-like image (not a PDF page or a file card),
// nothing for viewers or before the AI status, and the palette command registered.
import type { AiStatus } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasFeatureContext, LobbyCanvas, MenuTarget } from '../../../canvas/api/index.ts'
import { COMMANDS } from '../ported/menus.tsx'
import { aiStatus } from '../ported/runtime.ts'
import { AI_CAPTURE_COMMAND_ID, releaseCaptureCanvas, setCaptureCanvas } from './client.ts'
import { CAPTURE_COMMAND, CAPTURE_MENU, captureCommandHeld, imageOf } from './entries.ts'

vi.mock('@draftroom/contracts', async (importOriginal) => {
  const real = await importOriginal<typeof import('@draftroom/contracts')>()
  return {
    ...real,
    PENDING_PALETTE_COMMAND_IDS: real.PENDING_PALETTE_COMMAND_IDS.filter((id) => id !== 'ai.capture'),
  }
})

const ON: AiStatus = {
  enabled: true,
  reason: null,
  canInsert: true,
  canSummarize: true,
  noticeAccepted: true,
  budget: null,
  settings: null,
}
const els: Record<string, Record<string, unknown>> = {
  photo: {
    id: 'photo',
    type: 'image',
    fileId: 'ver_0123456789abcdef',
    isDeleted: false,
    customData: { lobby: { file: { kind: 'image' } } },
  },
  page: { id: 'page', type: 'image', fileId: 'ver_0123456789abcdef.p2', isDeleted: false },
  card: {
    id: 'card',
    type: 'image',
    fileId: 'ver_0123456789abcdef',
    isDeleted: false,
    customData: { lobby: { file: { kind: 'pdf' } } },
  },
  note: { id: 'note', type: 'stickynote', isDeleted: false },
}
let readOnly = false
const canvas = {
  readOnly: () => readOnly,
  get: (id: string) => els[id],
} as unknown as LobbyCanvas
const ctx = { canvas } as unknown as CanvasFeatureContext
const at = (ids: string[], hit?: string): MenuTarget =>
  ({ ids, point: { x: 0, y: 0 }, hit: hit ? (els[hit] as never) : null }) as unknown as MenuTarget
const visible = (id: string, t: MenuTarget) => {
  const e = CAPTURE_MENU.find((m) => m.id === id)
  return typeof e?.visible === 'function' ? e.visible(ctx, t) : e?.visible !== false
}

beforeEach(() => {
  readOnly = false
  setCaptureCanvas(canvas)
  aiStatus(canvas).set(ON)
})
afterEach(() => releaseCaptureCanvas(canvas))

describe('the entries, once released', () => {
  it('"Capture the room…" for an editor with AI on; never before the status, read-only, or for a guest', () => {
    expect(captureCommandHeld()).toBe(false)
    expect(visible('ai.capture', at([]))).toBe(true)
    readOnly = true
    expect(visible('ai.capture', at([]))).toBe(false)
    readOnly = false
    aiStatus(canvas).set(null)
    expect(visible('ai.capture', at([]))).toBe(false)
    aiStatus(canvas).set({ ...ON, enabled: false, reason: 'guest', canInsert: false, canSummarize: false })
    expect(visible('ai.capture', at([]))).toBe(false)
  })

  it('the image entries only on one photo-like image (the selected one, or the one under the pointer)', () => {
    expect(imageOf(ctx, at(['photo']))).toBe('photo')
    expect(imageOf(ctx, at([], 'photo'))).toBe('photo')
    for (const t of [at(['page']), at(['card']), at(['note']), at(['photo', 'note']), at([])])
      expect(imageOf(ctx, t)).toBeNull()
    expect(visible('ai.capture.photo-notes', at(['photo']))).toBe(true)
    expect(visible('ai.capture.photo-diagram', at(['photo']))).toBe(true)
    expect(visible('ai.capture.photo-notes', at(['note']))).toBe(false)
  })
})

describe('the palette command, once released', () => {
  it('is registered, and enabled for an editor who may add to the board', () => {
    expect(COMMANDS.some((c) => c.id === AI_CAPTURE_COMMAND_ID)).toBe(true)
    expect(CAPTURE_COMMAND.id).toBe('ai.capture')
    expect(CAPTURE_COMMAND.enabled?.(ctx)).toBe(true)
    aiStatus(canvas).set({ ...ON, canInsert: false })
    expect(CAPTURE_COMMAND.enabled?.(ctx)).toBe(false)
  })
})
