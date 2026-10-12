// Wave N.1 (wave M follow-up 7): the e2e stack's sync reads a fixed free share of its disk. The sync acts on the real
// one (apps/sync/src/disk.ts): under 20 % free it makes no backup and /healthz/deep answers `disk`, under 10 % every
// room broadcasts the DISK notice, which the web shows people. A runner whose temp disk is that full changed what
// every spec saw; DRAFTROOM_TEST_DISK_FREE (honoured only with the sync's test hooks on) pins it to half free, and a
// spec can still set its own through syncEnv.
import { describe, expect, it } from 'vitest'
import { EXCALIDRAW_SYNC_ENV, engineSyncEnv } from './stack.ts'

describe('the e2e stack’s sync env', () => {
  it('pins the disk’s free share (test hooks on, so the sync honours it)', () => {
    expect(EXCALIDRAW_SYNC_ENV.DRAFTROOM_TEST_HOOKS).toBe('1')
    expect(EXCALIDRAW_SYNC_ENV.DRAFTROOM_TEST_DISK_FREE).toBe('0.5')
    expect(engineSyncEnv('excalidraw').DRAFTROOM_TEST_DISK_FREE).toBe('0.5')
  })

  it('a spec’s own value wins (a low-disk spec), and the engine stays Excalidraw', () => {
    const env = engineSyncEnv('excalidraw', { DRAFTROOM_TEST_DISK_FREE: '0.05' })
    expect(env.DRAFTROOM_TEST_DISK_FREE).toBe('0.05')
    expect(env.DRAFTROOM_ENGINE).toBe('excalidraw')
  })
})
