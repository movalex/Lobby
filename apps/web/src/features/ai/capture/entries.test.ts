// Wave N (WS5, N5-2): the ways into Capture the room (./entries.ts) as the contracts have them now. While the contracts
// list 'ai.capture' as pending (PENDING_PALETTE_COMMAND_IDS) nothing is offered: not the palette command, and not the
// AI menu's entries either, even to an editor with AI on (they would only dead-end on the api's 404). Once the id
// leaves that list (the integration) all of them follow the rules of ./entries-released.test.ts.
import type { AiStatus } from '@draftroom/contracts'
import { PENDING_PALETTE_COMMAND_IDS } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasFeatureContext, LobbyCanvas, MenuTarget } from '../../../canvas/api/index.ts'
import { COMMANDS, CONTEXT_MENU } from '../ported/menus.tsx'
import { aiStatus } from '../ported/runtime.ts'
import { AI_CAPTURE_COMMAND_ID, releaseCaptureCanvas, setCaptureCanvas } from './client.ts'
import { CAPTURE_COMMAND, CAPTURE_MENU, captureCommandHeld } from './entries.ts'

const ON: AiStatus = {
  enabled: true,
  reason: null,
  canInsert: true,
  canSummarize: true,
  noticeAccepted: true,
  budget: null,
  settings: null,
}
const photo = {
  id: 'photo',
  type: 'image',
  fileId: 'ver_0123456789abcdef',
  isDeleted: false,
  customData: { lobby: { file: { kind: 'image' } } },
}
const canvas = {
  readOnly: () => false,
  get: (id: string) => (id === 'photo' ? photo : undefined),
} as unknown as LobbyCanvas
const ctx = { canvas } as unknown as CanvasFeatureContext
const onPhoto = { ids: ['photo'], point: { x: 0, y: 0 }, hit: null } as unknown as MenuTarget
const visible = (id: string) => {
  const e = CAPTURE_MENU.find((m) => m.id === id)
  return typeof e?.visible === 'function' ? e.visible(ctx, onPhoto) : e?.visible !== false
}

beforeEach(() => {
  setCaptureCanvas(canvas)
  aiStatus(canvas).set(ON)
})
afterEach(() => releaseCaptureCanvas(canvas))

describe('held while the contracts list ai.capture as pending', () => {
  it('the entries sit in the AI submenu', () => {
    const ai = CONTEXT_MENU.find((m) => m.id === 'ai')
    expect(ai?.submenu?.map((m) => m.id)).toEqual(
      expect.arrayContaining([
        'flow.diagram',
        'ai.capture',
        'ai.capture.photo-notes',
        'ai.capture.photo-diagram',
      ]),
    )
  })

  it('held: no menu entry and no palette command, even for an editor with AI on a photo; released: all of them', () => {
    const held = (PENDING_PALETTE_COMMAND_IDS as readonly string[]).includes(AI_CAPTURE_COMMAND_ID)
    expect(captureCommandHeld()).toBe(held)
    for (const id of ['ai.capture', 'ai.capture.photo-notes', 'ai.capture.photo-diagram'])
      expect(visible(id), id).toBe(!held)
    expect(COMMANDS.some((c) => c.id === AI_CAPTURE_COMMAND_ID)).toBe(!held)
    expect(CAPTURE_COMMAND.enabled?.(ctx)).toBe(!held)
    expect(captureCommandHeld([])).toBe(false)
    expect(captureCommandHeld([AI_CAPTURE_COMMAND_ID])).toBe(true)
  })
})
