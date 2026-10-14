// P-003 (wave P) and its review: the board's connection as the page shows it. The browser's offline signal is said
// at once when the socket is not live; while the socket is live (phase ready) it is asked first (a quick probe):
// Windows and VPNs often report offline wrongly, and the board must not say "Offline" while it syncs.
import { describe, expect, it } from 'vitest'
import { connWith } from './connection.ts'

const ready = { phase: 'ready' } as const
const connecting = { phase: 'connecting' } as const
const closed = { phase: 'closed' } as const

describe('connWith', () => {
  it('online: the socket says', () => {
    expect(connWith(ready, true)).toBe('online')
    expect(connWith(connecting, true)).toBe('connecting')
    expect(connWith(closed, true)).toBe('error')
  })

  it('the browser says offline while the socket is not live: offline at once (a closed socket keeps its screen)', () => {
    expect(connWith(connecting, false)).toBe('offline')
    expect(connWith({ phase: 'offline' }, false)).toBe('offline')
    expect(connWith(closed, false)).toBe('error')
  })

  it('the browser says offline while the socket is live: trusted while asked and once it answered; offline when not', () => {
    expect(connWith(ready, false, 'pending')).toBe('online')
    expect(connWith(ready, false, 'alive')).toBe('online')
    expect(connWith(ready, false, 'dead')).toBe('offline')
    expect(connWith(ready, false)).toBe('offline')
  })
})
