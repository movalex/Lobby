// M6-2 / M6-4 (wave M, PWR-4): the save indicator while this device's cached copy of the board is shown, before the
// first welcome: "Showing your last copy · connecting" (state 'cached'), offline "Offline · showing your copy from
// <time>" (state 'offline'); never "Saved", never announced as a recovery, and gone at the welcome.
import { describe, expect, it } from 'vitest'
import type { SaveStatus } from '../canvas/sync/types.ts'
import { cachedCopyText } from './CachedCopy.tsx'
import { cachedCopyTime, cachedOfflineLabel, SAVE_LABEL, saveLabel, saveTitle } from './copy.ts'
import { type EngineSaveInput, engineDisplayState, engineSaveView } from './engineSave.ts'
import { saveAnnouncement } from './SaveStatus.tsx'

const status = (over: Partial<SaveStatus> = {}): SaveStatus => ({
  state: 'offline',
  pending: 0,
  offlineChanges: 0,
  lastReject: null,
  ...over,
})
const input = (over: Partial<EngineSaveInput> = {}): EngineSaveInput => ({
  status: status(),
  welcomed: false,
  terminal: false,
  readonly: true,
  guest: false,
  uploading: 0,
  ...over,
})
const savedAt = new Date(2026, 9, 10, 14, 32).getTime()

describe("the 'cached' save state", () => {
  it('the copy is shown while connecting: cached, its words honest, never Saved', () => {
    const i = input({ cached: { savedAt, offline: false } })
    expect(engineDisplayState(i)).toBe('cached')
    const view = engineSaveView(i)
    expect(saveLabel(view.state)).toBe('Showing your last copy · connecting')
    expect(SAVE_LABEL.cached).not.toMatch(/saved/i)
    expect(saveTitle('cached', null, true)).toMatch(/copy of the board this device kept/)
    expect(cachedCopyText(savedAt, false)).toBe(SAVE_LABEL.cached)
  })

  it('offline (no socket, no network): the offline line with the copy’s time', () => {
    const i = input({ cached: { savedAt, offline: true } })
    expect(engineDisplayState(i)).toBe('offline')
    const view = engineSaveView(i)
    const time = cachedCopyTime(savedAt, savedAt + 60_000)
    expect(view.label).toBe(`Offline · showing your copy from ${cachedCopyTime(savedAt)}`)
    expect(view.title).toMatch(/may be out of date/)
    expect(cachedOfflineLabel(savedAt, savedAt + 60_000)).toBe(`Offline · showing your copy from ${time}`)
    // an older copy names its day too
    expect(cachedCopyTime(savedAt, savedAt + 3 * 86_400_000)).not.toBe(time)
    expect(cachedCopyText(savedAt, true)).toMatch(/^Offline · showing your copy from /)
  })

  it('offline with changes queued on this device: the line says so (the cached copy does not draw them yet)', () => {
    const i = input({ status: status({ offlineChanges: 3 }), cached: { savedAt, offline: true } })
    expect(engineDisplayState(i)).toBe('offline')
    const view = engineSaveView(i)
    expect(view.label).toBe(
      `Offline · showing your copy from ${cachedCopyTime(savedAt)} · 3 changes on this device, not shown yet`,
    )
    expect(view.title).toMatch(/Your 3 changes made offline are kept on this device/)
    expect(cachedCopyText(savedAt, true, 1)).toMatch(/ · 1 change on this device, not shown yet$/)
    // none queued: the line as before
    expect(cachedOfflineLabel(savedAt, undefined, 0)).toBe(cachedOfflineLabel(savedAt))
  })

  it('the welcome ends it (whatever the input still says), and a terminal close wins', () => {
    const cached = { savedAt, offline: false }
    expect(
      engineDisplayState(
        input({ welcomed: true, readonly: false, cached, status: status({ state: 'saved' }) }),
      ),
    ).toBe('saved')
    expect(engineDisplayState(input({ terminal: true, cached }))).toBe('error')
    // no copy: what it was before
    expect(engineDisplayState(input())).toBe('connecting')
  })

  it('is not announced (no problem, no recovery); offline with the copy is', () => {
    expect(saveAnnouncement(null, 'cached', null).say).toBeNull()
    expect(saveAnnouncement('connecting', 'cached', null).say).toBeNull()
    // back from offline to the cached copy while connecting: still on the way, nothing said yet
    expect(saveAnnouncement('offline', 'cached', 'offline')).toEqual({ say: null, trouble: 'offline' })
    const offline = engineSaveView(input({ cached: { savedAt, offline: true } }))
    expect(saveAnnouncement('cached', 'offline', null, undefined, offline.label).say).toBe(offline.label)
  })
})
