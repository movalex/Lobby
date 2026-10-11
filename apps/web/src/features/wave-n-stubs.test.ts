// The wave N foundation's web stubs: each answers its safe default without a request (nothing changes on the board
// page until its owner lands it), and each frozen id is a contract id. OWNERS: WS4 (visits), WS5 (capture), WS7 (board
// links); each owner moves its part of this file into its own tests when it implements the client. WS7 moved board
// links out (features/board-links/board-links.test.ts): the feature, its commands and its client are implemented.
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
import { fetchVisit, sendSeen } from './visits/client.ts'
import { feature as visitsFeature } from './visits/index.tsx'

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
  it('visits is on the board page, empty', () => {
    const ids = CANVAS_FEATURES.map((f) => f.id)
    expect(ids).toContain('visits')
    expect(Object.keys(visitsFeature)).toEqual(['id'])
  })

  it('their palette commands are contract ids, pending until registered', () => {
    for (const id of [AI_CAPTURE_COMMAND_ID]) {
      expect(PALETTE_COMMAND_IDS as readonly string[]).toContain(id)
      expect(PENDING_PALETTE_COMMAND_IDS as readonly string[]).toContain(id)
    }
  })
})

describe('the stubs answer their safe default without a request', () => {
  it('visits: no visit to show, no beacon', async () => {
    expect(await fetchVisit('b-board00001')).toBeNull()
    expect(sendSeen('b-board00001')).toBe(false)
    expect(calls).toBe(0)
  })

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
