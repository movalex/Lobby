import { describe, expect, it } from 'vitest'
import type { SaveStatus } from '../canvas/sync/types.ts'
import { engineRejectNotice, engineRejectReason, saveLabel } from './copy.ts'
import { type EngineSaveInput, engineDisplayState, engineSaveView, engineUnloadRisk } from './engineSave.ts'

const status = (over: Partial<SaveStatus> = {}): SaveStatus => ({
  state: 'saved',
  pending: 0,
  offlineChanges: 0,
  lastReject: null,
  ...over,
})
const input = (over: Partial<EngineSaveInput> = {}): EngineSaveInput => ({
  status: status(),
  welcomed: true,
  terminal: false,
  readonly: false,
  guest: false,
  uploading: 0,
  ...over,
})

describe('the Excalidraw engine save indicator (§2.5.7)', () => {
  it('maps the engine states', () => {
    expect(engineDisplayState(input({ welcomed: false, status: status({ state: 'offline' }) }))).toBe(
      'connecting',
    )
    expect(engineDisplayState(input())).toBe('saved')
    expect(engineDisplayState(input({ readonly: true }))).toBe('readonly')
    expect(engineDisplayState(input({ uploading: 1 }))).toBe('saving')
    expect(engineDisplayState(input({ status: status({ state: 'saving', pending: 2 }) }))).toBe('saving')
    expect(engineDisplayState(input({ status: status({ state: 'offline' }) }))).toBe('offline')
    expect(engineDisplayState(input({ status: status({ state: 'offline', offlineChanges: 3 }) }))).toBe(
      'offline-pending',
    )
    expect(
      engineDisplayState(
        input({ status: status({ state: 'not-saved', lastReject: { id: 'a', code: 'LOCKED' } }) }),
      ),
    ).toBe('rejected')
    expect(engineDisplayState(input({ status: status({ state: 'retrying' }) }))).toBe('retrying')
    expect(engineDisplayState(input({ terminal: true }))).toBe('error')
    // a reload while offline with queued changes says so before the first welcome
    expect(
      engineDisplayState(input({ welcomed: false, status: status({ state: 'offline', offlineChanges: 2 }) })),
    ).toBe('offline-pending')
  })

  it('says how many changes are on this device, and why a change was refused', () => {
    const off = engineSaveView(input({ status: status({ state: 'offline', offlineChanges: 1 }) }))
    expect(off.label).toBe('Offline — 1 change on this device')
    expect(off.title).toMatch(/also after a reload/)
    const guest = engineSaveView(
      input({ guest: true, status: status({ state: 'offline', offlineChanges: 4 }) }),
    )
    expect(guest.label).toBe('Offline — 4 changes on this device')
    expect(guest.title).toMatch(/would lose them/)
    const rej = engineSaveView(
      input({ status: status({ state: 'not-saved', lastReject: { id: 'a', code: 'READ_ONLY' } }) }),
    )
    expect(rej.title).toBe('Your last change was not saved: you can only view this board')
    expect(saveLabel('retrying')).toBe("Can't save right now — retrying")
    expect(engineRejectReason('INVALID')).toBeNull()
    expect(engineRejectNotice('LEASED', 'Alice')).toBe('Change not saved — Alice is typing in this note')
    // wave P review (P-005): the leased element's kind
    expect(engineRejectNotice('LEASED', 'Alice', 'shape')).toBe(
      'Change not saved — Alice is typing in this shape',
    )
    expect(engineRejectNotice('LEASED')).toBeNull()
  })

  it("asks before leaving only while this tab alone holds changes (a guest's queue, an upload)", () => {
    expect(engineUnloadRisk(input({ status: status({ state: 'saving', pending: 3 }) }))).toBe(false)
    expect(engineUnloadRisk(input({ guest: true, status: status({ state: 'offline', pending: 3 }) }))).toBe(
      true,
    )
    expect(engineUnloadRisk(input({ uploading: 1 }))).toBe(true)
  })
})
