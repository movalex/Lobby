import { describe, expect, it } from 'vitest'
import { contrastRatio } from '../../theme/contrast.ts'
import type { PinState } from './model.ts'
import { inkOn, opaqueHex, overWhite, PIN_INK_MIN_CONTRAST, pinFace, READ_FACE_SHARE } from './pin-face.ts'

// The presence palette the api assigns (apps/api/src/auth/users.ts, apps/web/src/lib/identity.ts).
const PRESENCE = ['#c2410c', '#1d4ed8', '#047857', '#7c3aed', '#be123c', '#0e7490', '#a16207', '#4d7c0f']
const STATES: PinState[] = ['unread', 'read', 'mentioned', 'resolved']

/** A fixed pseudo-random sequence of #rrggbb colours (the same on every run). */
function colours(n: number): string[] {
  let s = 0x2545f491
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out.push(`#${((s >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`)
  }
  return out
}

describe('comment marker faces (W5-49)', () => {
  it('a read thread by any presence colour was below 4.5:1 with white initials on its faded face', () => {
    // the defect this fixes: the face faded to 78 % with the initials kept white
    const worst = Math.min(...PRESENCE.map((c) => contrastRatio(overWhite(c, READ_FACE_SHARE), '#ffffff')))
    expect(worst).toBeLessThan(PIN_INK_MIN_CONTRAST)
  })

  it('every presence colour in every state keeps its initials at 4.5:1 or more', () => {
    for (const c of PRESENCE)
      for (const state of STATES) {
        const face = pinFace(c, state)
        expect(contrastRatio(face.background, face.ink), `${c} ${state}`).toBeGreaterThanOrEqual(
          PIN_INK_MIN_CONTRAST,
        )
      }
  })

  it('any colour the api may send keeps 4.5:1 (white where it reaches it, black otherwise)', () => {
    for (const c of colours(2000))
      for (const state of ['unread', 'read'] as const) {
        const face = pinFace(c, state)
        expect(contrastRatio(face.background, face.ink), `${c} ${state}`).toBeGreaterThanOrEqual(
          PIN_INK_MIN_CONTRAST,
        )
      }
  })

  it('keeps today’s white initials on an unread thread of the presence palette, and fades read ones', () => {
    for (const c of PRESENCE) {
      expect(pinFace(c, 'unread')).toEqual({ background: c, ink: '#ffffff' })
      expect(pinFace(c, 'mentioned').ink).toBe('#ffffff')
      expect(pinFace(c, 'read').background).toBe(overWhite(c, READ_FACE_SHARE))
    }
    expect(pinFace('#4d7c0f', 'read')).toEqual({ background: '#749944', ink: '#000000' })
    expect(pinFace('#be123c', 'resolved')).toEqual({ background: '#5f6b7a', ink: '#ffffff' })
  })

  it('reads short and alpha hex colours as opaque #rrggbb', () => {
    expect(opaqueHex('#abc')).toBe('#aabbcc')
    expect(opaqueHex('#abcd')).toBe('#aabbcc')
    expect(opaqueHex('#1D4ED8')).toBe('#1d4ed8')
    expect(opaqueHex('#1d4ed880')).toBe('#1d4ed8')
    expect(opaqueHex('red')).toBeNull()
    expect(opaqueHex('#12345')).toBeNull()
    expect(inkOn('#ffffff')).toBe('#000000')
    expect(inkOn('#000000')).toBe('#ffffff')
  })
})
