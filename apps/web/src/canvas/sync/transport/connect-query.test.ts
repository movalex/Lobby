// CONTRACTS_REV 12: the board socket's connect URL names the contracts revision this build reads (`rev`), so the
// room serves it every frame in its revision's form and writes its pushes as its revision's from the first frame
// on (canvas-schema protocol.ts CONNECT_REV_PARAM; apps/sync/src/room/reader-frames.ts). A rev-11 room reads only
// `sessionId` and the ticket.

import { CONNECT_REV_PARAM, CONTRACTS_REV, connectRevOf } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { connectQuery } from './socket.ts'

describe('connectQuery', () => {
  it('names the tab and this build’s contracts revision', () => {
    const q = connectQuery('tab-1')
    expect(q.get('sessionId')).toBe('tab-1')
    expect(q.get(CONNECT_REV_PARAM)).toBe(String(CONTRACTS_REV))
    expect(connectRevOf(q.get(CONNECT_REV_PARAM))).toBe(CONTRACTS_REV)
  })

  it('keeps what the caller adds (the headless client’s ticket), and its own two cannot be overridden', () => {
    const q = connectQuery('tab-2', { ticket: 't0k', sessionId: 'forged', [CONNECT_REV_PARAM]: '3' })
    expect(q.get('ticket')).toBe('t0k')
    expect(q.get('sessionId')).toBe('tab-2')
    expect(q.get(CONNECT_REV_PARAM)).toBe(String(CONTRACTS_REV))
  })
})
