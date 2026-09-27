// Untrusted input at the protocol boundary: invalid records in a push, and board ids / sessions in
// the upgrade URL (board ids become file names, so they are validated before any file is touched).
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { newBoardId, roomFiles, useProtocolHarness } from '../harness/fixture.ts'
import { geoShape } from '../harness/records.ts'
import { upgradeStatus } from '../harness/server-process.ts'
import { sleep, waitFor } from '../harness/wait.ts'

const h = useProtocolHarness()

function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort()
}

describe('invalid records in a push', () => {
  for (const [label, bad] of [
    ['a prop of the wrong type', { ...geoShape('bad'), x: 'not-a-number' }],
    ['an unregistered shape type', { ...geoShape('bad'), type: 'not-registered' }],
  ] as const) {
    it(`${label} closes the session with 4099 INVALID_RECORD and rolls back the whole push`, async () => {
      const server = await h.server()
      const boardId = newBoardId()
      const peer = await h.connected(server, { boardId, user: 'bob' })
      const writer = await h.connected(server, { boardId, user: 'alice' })
      const clockBefore = writer.observedServerClock()

      writer.sendRawPush({ 'shape:valid': ['put', geoShape('valid')], 'shape:bad': ['put', bad] })
      const close = await writer.waitForClose()
      expect(close).toMatchObject({ code: 4099, reason: 'INVALID_RECORD' })
      expect(writer.status).toBe('error')
      expect(writer.syncErrors).toEqual(['INVALID_RECORD'])
      await sleep(300)
      expect(writer.socketGeneration).toBe(1) // terminal: the client does not reconnect

      // the valid record in the same push was not committed or broadcast
      expect(peer.get('shape:valid')).toBeUndefined()
      const served = await h.freshView(server, boardId)
      expect(served.has('shape:valid')).toBe(false)
      expect(served.has('shape:bad')).toBe(false)

      // the room itself is unaffected: the peer keeps editing, and the clock only moves for its write
      peer.put(geoShape('after'))
      await peer.waitForAcked()
      expect(peer.pushResults.at(-1)?.action).toBe('commit')
      expect(peer.observedServerClock()).toBe(clockBefore + 1)
    })
  }
})

describe('upgrade URL validation', () => {
  it('rejects bad board ids and a missing sessionId with HTTP 400 before upgrading, creating no files', async () => {
    const server = await h.server()
    const before = tree(server.dataDir)
    const q = '?sessionId=s1&devUser=alice'
    const bad = [
      `/connect/Board-upper${q}`, // uppercase (case-insensitive FS would split the room)
      `/connect/..%2F..%2Fescape${q}`, // encoded traversal
      `/connect/..%2Fboard-x${q}`,
      `/connect/%2e%2e${q}`,
      `/connect/${'a'.repeat(65)}${q}`, // too long
      `/connect/ab${q}`, // too short
      `/connect/${q}`, // empty
      `/connect/good-board/extra${q}`, // extra path segment
      '/connect/good-board?devUser=alice', // no sessionId
      `/connect/good-board?sessionId=${'s'.repeat(129)}&devUser=alice`, // sessionId too long
    ]
    for (const path of bad) expect(await upgradeStatus(server.port, path), path).toBe(400)
    expect(tree(server.dataDir)).toEqual(before)
    expect(roomFiles(server.dataDir)).toEqual([])

    // control: the same request shape with a valid id upgrades and opens exactly that board's file
    const boardId = newBoardId()
    expect(await upgradeStatus(server.port, `/connect/${boardId}${q}`)).toBe(101)
    await waitFor(() => roomFiles(server.dataDir).includes(`board-${boardId}.sqlite`))
    expect(roomFiles(server.dataDir).filter((f) => !f.startsWith(`board-${boardId}.sqlite`))).toEqual([])
  })

  it('an unauthenticated session is upgraded then closed with 4099 NOT_AUTHENTICATED (terminal), opening no room', async () => {
    const server = await h.server()
    for (const user of [undefined, 'Not-Valid!']) {
      const c = h.client(server, { boardId: newBoardId(), user })
      expect(await c.waitForClose()).toMatchObject({ code: 4099, reason: 'NOT_AUTHENTICATED' })
      expect(c.syncErrors).toEqual(['NOT_AUTHENTICATED'])
    }
    expect(roomFiles(server.dataDir)).toEqual([])
  })
})
