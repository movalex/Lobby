// DANA-05: the History dock panel is never offered to a name-only guest (a client on a review link, a
// workshop guest); people with an account keep it, and so does anyone whose kind is not known yet.
import { describe, expect, it } from 'vitest'
import { seedUserKind } from '../../invite/guest.tsx'
import type { FeatureContext } from '../types.ts'
import { historyFeature } from './index.tsx'

const panel = historyFeature.panels?.find((p) => p.id === 'history')
const ctxOf = (userId: string) =>
  ({ me: { user: { id: userId }, workspaces: [] } }) as unknown as FeatureContext

describe('the History panel in the dock rail', () => {
  it('is hidden for a name-only guest and shown for an account', () => {
    expect(panel?.visible).toBeTypeOf('function')
    seedUserKind('usr_guest', 'guest')
    seedUserKind('usr_account', 'account')
    expect(panel?.visible?.(ctxOf('usr_guest'))).toBe(false)
    expect(panel?.visible?.(ctxOf('usr_account'))).toBe(true)
    // Not known yet, in a tab no guest signed in to: shown (the panel itself waits for the kind).
    expect(panel?.visible?.(ctxOf('usr_unknown'))).toBe(true)
  })
})
