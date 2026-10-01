import { describe, expect, it } from 'vitest'
import { rejectionNotice, SAVE_LABEL, saveLabel, saveTitle } from './copy.ts'
import type { Rejection } from './save-state.ts'

const rejection = (over: Partial<Rejection> = {}): Rejection => ({
  at: 1,
  records: [{ id: 'shape:a', typeName: 'shape', kind: 'vetoed' }],
  serverMessage: null,
  ...over,
})

describe('save indicator copy', () => {
  it('uses the WRK-03 words', () => {
    expect(SAVE_LABEL.saved).toBe('Saved')
    expect(SAVE_LABEL.saving).toBe('Saving…')
    expect(SAVE_LABEL['offline-pending']).toBe('Offline — changes will sync')
    expect(SAVE_LABEL.rejected).toBe('Change not saved')
    expect(SAVE_LABEL.readonly).toBe('View only')
    // An unreadable protocol never claims "Saved".
    expect(SAVE_LABEL.unsupported).not.toMatch(/saved/i)
  })

  it('explains a rejection in the tooltip when the server said why', () => {
    const lease = rejection({ serverMessage: { type: 'text-lease-denied', shapeId: 'shape:a' } })
    expect(saveTitle('rejected', lease, false)).toBe(
      'Your last change was not saved: someone else is editing that text',
    )
    expect(saveTitle('rejected', rejection(), true)).toMatch(/you can only view this board/)
    expect(saveTitle('rejected', rejection(), false)).toMatch(/did not accept your last change/)
    expect(saveTitle('offline-pending', null, false)).toMatch(
      /Reloading or closing the tab now would lose them/,
    )
    expect(saveTitle('saving', null, false, 1)).toBe('Uploading a file to the board server')
    expect(saveTitle('saving', null, false, 3)).toBe('Uploading 3 files to the board server')
  })

  it('toasts a rejection unless the text-lease toast already explains it', () => {
    expect(rejectionNotice(rejection({ serverMessage: { type: 'text-lease-denied' } }), false)).toBeNull()
    expect(rejectionNotice(rejection(), true)).toBe(
      'You can only view this board, so your change was not saved.',
    )
    expect(
      rejectionNotice(
        rejection({ records: [{ id: 'shape:a', typeName: 'shape', kind: 'deleted-remotely' }] }),
        false,
      ),
    ).toBe('Someone else deleted that object, so your change to it was not saved.')
    expect(rejectionNotice(rejection(), false)).toBe(
      'The board did not accept your last change, so it was undone.',
    )
  })
})

describe('read-only indicator (RETRO-17)', () => {
  it('a commenter reads that her comments are saved; nobody reads that their work is not saved', () => {
    expect(saveLabel('readonly', 'commenter')).toBe('Can comment · comments are saved')
    expect(saveLabel('readonly', 'viewer')).toBe('View only')
    expect(saveLabel('saved', 'commenter')).toBe('Saved')
    for (const role of ['viewer', 'commenter']) {
      const title = saveTitle('readonly', null, true, 0, role)
      expect(title, role).not.toMatch(/not saved/i)
    }
    expect(saveTitle('readonly', null, true, 0, 'commenter')).toMatch(/your comments are saved/)
  })
})
