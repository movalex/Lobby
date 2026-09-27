import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SESSION_SETTINGS,
  parseSessionSettings,
  SESSION_META_KEY,
  withSessionSettings,
} from './session-settings.ts'

describe('session settings in the document meta', () => {
  it('reads missing, partial and malformed values as off', () => {
    expect(parseSessionSettings(undefined)).toEqual(DEFAULT_SESSION_SETTINGS)
    expect(parseSessionSettings({})).toEqual(DEFAULT_SESSION_SETTINGS)
    expect(parseSessionSettings({ [SESSION_META_KEY]: 'yes' })).toEqual(DEFAULT_SESSION_SETTINGS)
    expect(parseSessionSettings({ [SESSION_META_KEY]: { hideNoteAuthors: 'true', hideCursors: 1 } })).toEqual(
      DEFAULT_SESSION_SETTINGS,
    )
    expect(parseSessionSettings({ [SESSION_META_KEY]: { hideNoteAuthors: true } })).toEqual({
      hideNoteAuthors: true,
      hideCursors: false,
    })
  })

  it('writes one setting without losing the other or anyone else’s meta', () => {
    const meta = { other: { x: 1 }, [SESSION_META_KEY]: { hideCursors: true } }
    const next = withSessionSettings(meta, { hideNoteAuthors: true })
    expect(next).toEqual({
      other: { x: 1 },
      [SESSION_META_KEY]: { hideNoteAuthors: true, hideCursors: true },
    })
    expect(parseSessionSettings(withSessionSettings(next, { hideCursors: false }))).toEqual({
      hideNoteAuthors: true,
      hideCursors: false,
    })
    // The input is not mutated.
    expect(meta[SESSION_META_KEY]).toEqual({ hideCursors: true })
    expect(withSessionSettings(null, { hideCursors: true })).toEqual({
      [SESSION_META_KEY]: { hideNoteAuthors: false, hideCursors: true },
    })
  })
})
