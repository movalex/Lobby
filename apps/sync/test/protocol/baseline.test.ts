import { describe, expect, it } from 'vitest'
import { newBoardId, useProtocolHarness } from '../harness/fixture.ts'
import { geoShape } from '../harness/records.ts'
import { loadedTldrawCopies } from '../harness/tldraw-runtime.ts'
import { waitFor } from '../harness/wait.ts'

const h = useProtocolHarness()

describe('baseline: real server process + real TLSyncClients', () => {
  it('loads one copy of each tldraw runtime library (no split reactive state)', () => {
    const copies = loadedTldrawCopies()
    for (const pkg of ['@tldraw/state', '@tldraw/store', '@tldraw/sync-core', '@tldraw/tlschema']) {
      expect(copies[pkg], pkg).toEqual(['esm'])
    }
  })

  it('an edit acked for one session is broadcast to another session on the same board', async () => {
    const server = await h.server()
    const boardId = newBoardId()
    const a = await h.connected(server, { boardId, user: 'alice' })
    const b = await h.connected(server, { boardId, user: 'bob' })

    a.put(geoShape('one', { x: 10 }))
    await a.waitForAcked()
    expect(a.pushResults.at(-1)?.action).toBe('commit')
    await waitFor(() => b.get('shape:one'))
    expect(b.get('shape:one')).toMatchObject({ x: 10 })

    a.setPresence({ userName: 'alice', meta: { editingShapeId: null } })
    await waitFor(() => b.presences().find((p) => p.userName === 'alice'))
  })
})
