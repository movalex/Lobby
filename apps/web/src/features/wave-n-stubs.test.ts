// The wave N foundation's web stubs: each answers its safe default without a request (nothing changes on the board
// page until its owner lands it), and each frozen id is a contract id. OWNER: WS5 (capture); it moves its part of
// this file into its own tests when it implements the client. WS4's visits part moved to visits/client.test.ts and
// visits/index.test.ts; WS7 moved board links out (features/board-links/board-links.test.ts).
import { PALETTE_COMMAND_IDS, PENDING_PALETTE_COMMAND_IDS } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AI_CAPTURE_COMMAND_ID,
  CaptureUnavailableError,
  captureAvailable,
  captureBoardImage,
  capturePhoto,
  captureTranscript,
} from './ai/capture/client.ts'
import { CANVAS_FEATURES } from './canvas-registry.ts'

let calls = 0
const g = globalThis as { fetch?: unknown; navigator?: unknown }
let fetchBefore: unknown
beforeEach(() => {
  calls = 0
  fetchBefore = g.fetch
  g.fetch = () => {
    calls++
    return Promise.reject(new Error('no request expected'))
  }
})
afterEach(() => {
  g.fetch = fetchBefore
})

describe('the wave N features are registered and contribute nothing yet', () => {
  it('visits and board-links are on the board page (both implemented: visits/*.test.ts, board-links/*.test.ts)', () => {
    const ids = CANVAS_FEATURES.map((f) => f.id)
    expect(ids).toContain('visits')
    expect(ids).toContain('board-links')
  })

  it('the capture palette command is a contract id, registered (WS5: features/ai/capture/entries.ts)', () => {
    expect(PALETTE_COMMAND_IDS as readonly string[]).toContain(AI_CAPTURE_COMMAND_ID)
    expect(PENDING_PALETTE_COMMAND_IDS as readonly string[]).not.toContain(AI_CAPTURE_COMMAND_ID)
  })
})

describe('the stubs answer their safe default without a request', () => {
  it('capture: never available; every call rejects unavailable', async () => {
    expect(captureAvailable()).toBe(false)
    await expect(capturePhoto('b-board00001', new Blob([]), 'auto')).rejects.toBeInstanceOf(
      CaptureUnavailableError,
    )
    await expect(captureBoardImage('b-board00001', 'img-1', 'notes')).rejects.toMatchObject({
      code: 'unavailable',
    })
    await expect(captureTranscript('b-board00001', 'We decided.')).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(calls).toBe(0)
  })
})
