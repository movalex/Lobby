// A viewer or commenter ticket => isReadonly on the server (canEditCanvas). Such a client that ignores
// the flag (a forged client) must not be able to change the board, must keep its connection, and
// must still share presence. Commenters comment through the API, never through canvas writes.
import { describe, expect, it } from 'vitest'
import { newBoardId, useProtocolHarness } from '../harness/fixture.ts'
import { geoShape, PAGE_ID } from '../harness/records.ts'
import { waitFor } from '../harness/wait.ts'

const h = useProtocolHarness()
const X = 'shape:x'

describe('read-only (viewer / commenter) session', () => {
  for (const role of ['viewer', 'commenter'] as const)
    it(`${role}: forged put/patch/remove are discarded and reverted, nothing is persisted, the socket stays open, presence still flows`, async () => {
      const server = await h.server()
      const boardId = newBoardId()
      const editor = await h.connected(server, { boardId, user: 'alice' })
      editor.put(geoShape('x', { x: 5 }))
      await editor.waitForAcked()

      const viewer = await h.connected(server, { boardId, user: 'vic', role })
      expect(viewer.connectEvents()[0]?.isReadonly).toBe(true)
      const clockBefore = viewer.observedServerClock()

      // through TLSyncClient (a client that simply ignores isReadonly)...
      viewer.put(geoShape('forged', { x: 1 }))
      viewer.update(X, (r) => ({ ...r, x: 999 }))
      viewer.remove(X)
      // ...and hand-crafted frames
      viewer.sendRawPush({ 'shape:raw': ['put', geoShape('raw')] })
      viewer.sendRawPush({ [PAGE_ID]: ['remove'] })
      await viewer.waitForAcked()

      expect(viewer.pushResults.map((r) => r.action)).toEqual([
        'discard',
        'discard',
        'discard',
        'discard',
        'discard',
      ])
      // no write transaction ran: the document clock did not move
      expect(viewer.observedServerClock()).toBe(clockBefore)
      // the viewer's optimistic changes were rolled back
      expect(viewer.get('shape:forged')).toBeUndefined()
      expect(viewer.get(X)?.x).toBe(5)

      // socket still open, never closed, no sync error
      expect(viewer.status).toBe('online')
      expect(viewer.closes).toEqual([])
      expect(viewer.socketGeneration).toBe(1)
      expect(viewer.syncErrors).toEqual([])

      // presence from the viewer is still broadcast
      viewer.setPresence({ userName: 'vic', meta: { editingShapeId: null } })
      await waitFor(() => editor.presences().find((p) => p.userName === 'vic'))

      // nothing reached the editor, and nothing is on disk after a hard restart
      expect(editor.get('shape:forged')).toBeUndefined()
      expect(editor.get(X)?.x).toBe(5)
      editor.dispose()
      viewer.dispose()
      await server.restart()
      const served = await h.freshView(server, boardId)
      expect([...served.keys()]).toEqual([X])
      expect(served.get(X)?.x).toBe(5)
    })
})
