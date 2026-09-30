// The terminal sync errors the board page explains (SyncErrorScreen.tsx), including the two the bridge
// release R0 adds (docs/EXCALIDRAW-MIGRATION.md §5.10): maintenance, and a board made on the new canvas.
import { describe, expect, it } from 'vitest'
import { describeSyncError, syncErrorActions, syncErrorNote, syncErrorTitle } from './SyncErrorScreen.tsx'

describe('sync error messages', () => {
  it('maintenance: "Lobby is updating"', () => {
    expect(syncErrorTitle('MAINTENANCE')).toBe('Lobby is updating')
    expect(describeSyncError('MAINTENANCE')).toMatch(/^Lobby is updating\. /)
  })

  it('a board made on the new canvas', () => {
    expect(syncErrorTitle('NEW_CANVAS_BOARD')).toBe('Made on the new canvas')
    expect(describeSyncError('NEW_CANVAS_BOARD')).toBe(
      'This board was made on the new canvas. It opens again after the switch.',
    )
  })

  it('every other reason keeps its title and message', () => {
    expect(syncErrorTitle('FORBIDDEN')).toBe("Can't reach this board")
    expect(describeSyncError('RATE_LIMITED')).toBe(
      'Too many changes were sent too quickly. Wait a moment, then retry.',
    )
    expect(describeSyncError('SOMETHING_NEW')).toBe('The connection to this board ended unexpectedly.')
  })
})

describe('what the screen offers', () => {
  it('a board made on the new canvas: the way back to the boards, no Retry (it cannot open until the switch)', () => {
    expect(syncErrorActions('NEW_CANVAS_BOARD')).toEqual({ primary: 'boards', secondary: [] })
    // and it says what "the switch" is: users only see this during a rollback
    expect(syncErrorNote('NEW_CANVAS_BOARD')).toBe(
      'Lobby is back on its previous canvas for now. Boards made on the new canvas are kept as they are and open again when it returns.',
    )
  })

  it('every other reason keeps Retry and Reload (Reload first when the page is out of date)', () => {
    expect(syncErrorActions('MAINTENANCE')).toEqual({ primary: 'retry', secondary: ['reload'] })
    expect(syncErrorActions('RATE_LIMITED')).toEqual({ primary: 'retry', secondary: ['reload'] })
    expect(syncErrorActions('CLIENT_TOO_OLD')).toEqual({ primary: 'reload', secondary: ['retry'] })
    expect(syncErrorActions('SERVER_TOO_OLD')).toEqual({ primary: 'reload', secondary: ['retry'] })
    expect(syncErrorNote('MAINTENANCE')).toBeNull()
  })
})
