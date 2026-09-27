// Schema negotiation and migration with the shared dr-file-card shape (migration 1 added
// posterDerivativeId): older tabs keep working during a deploy, newer tabs are refused, and boards
// written under the old schema are migrated when the room opens.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { DEFAULT_INITIAL_SNAPSHOT, NodeSqliteWrapper, SQLiteSyncStorage } from '@tldraw/sync-core'
import type { TLRecord } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { newBoardId, useProtocolHarness } from '../harness/fixture.ts'
import {
  FILE_CARD_SEQUENCE,
  fileCard,
  fileCardFutureSchema,
  fileCardV0,
  fileCardV0Schema,
  TEST_DERIVATIVE_ID,
} from '../harness/records.ts'
import { sleep, waitFor } from '../harness/wait.ts'

const h = useProtocolHarness()

const sequenceVersion = (schema: { serialize(): unknown }) =>
  (schema.serialize() as { sequences: Record<string, number> }).sequences[FILE_CARD_SEQUENCE]

const CARD = 'shape:card'

/** A current tab created a card with a poster; then a tab still on the v0 schema joins. */
async function currentAndOldClient() {
  const server = await h.server()
  const boardId = newBoardId()
  const current = await h.connected(server, { boardId, user: 'alice' })
  current.put(fileCard('card', { posterDerivativeId: TEST_DERIVATIVE_ID }))
  await current.waitForAcked()
  const old = await h.connected(server, { boardId, user: 'bob', schema: fileCardV0Schema })
  return { server, boardId, current, old }
}

describe('schema negotiation at connect', () => {
  it('fixtures: the old client is at dr-file-card v0, the server at v1, the future client at v2', () => {
    expect(sequenceVersion(fileCardV0Schema)).toBe(0)
    expect(sequenceVersion(draftroomSchema)).toBe(1)
    expect(sequenceVersion(fileCardFutureSchema)).toBe(2)
  })

  it('an older client connects, is served down-migrated file cards, and its creates are stored up-migrated', async () => {
    const { server, boardId, current, old } = await currentAndOldClient()
    const seen = old.get(CARD)
    expect(seen?.props).not.toHaveProperty('posterDerivativeId')
    expect(seen?.props).toMatchObject({ name: 'clip.mp4', kind: 'video', durationMs: 5000 })

    old.put(fileCardV0('fromold', { name: 'old.pdf' }))
    await old.waitForAcked()
    expect(old.pushResults.at(-1)?.action).not.toBe('discard')
    await waitFor(() => current.get('shape:fromold'))
    expect(current.get('shape:fromold')?.props).toMatchObject({
      name: 'old.pdf',
      posterDerivativeId: null,
    })

    // the current client's later edits reach the old client, still down-migrated
    current.update(CARD, (r) => ({ ...r, x: 42 }))
    await current.waitForAcked()
    await waitFor(() => old.get(CARD)?.x === 42)
    expect(old.get(CARD)?.props).not.toHaveProperty('posterDerivativeId')

    const served = await h.freshView(server, boardId)
    expect(served.get(CARD)?.props).toMatchObject({ posterDerivativeId: TEST_DERIVATIVE_ID })
    expect(served.get('shape:fromold')?.props).toMatchObject({ name: 'old.pdf', posterDerivativeId: null })
    expect([...old.syncErrors, ...current.syncErrors]).toEqual([])
  })

  it("DOCUMENTED LIMITATION: an older client's patch to a file card resets posterDerivativeId to null (down-migrate, patch, up-migrate)", async () => {
    const { server, boardId, current, old } = await currentAndOldClient()
    old.update(CARD, (r) => ({ ...r, props: { ...r.props, name: 'renamed.mp4' } }))
    await old.waitForAcked()
    expect(old.pushResults.at(-1)?.action).not.toBe('discard')
    await waitFor(() => current.get(CARD)?.props.name === 'renamed.mp4')
    // TLSyncRoom applies an old session's patch to down(stored) and stores up(result); migration 1's
    // `up` can only default the prop it re-adds, so the poster the old tab never saw is lost.
    expect(current.get(CARD)?.props.posterDerivativeId).toBeNull()
    expect((await h.freshView(server, boardId)).get(CARD)?.props).toMatchObject({
      name: 'renamed.mp4',
      posterDerivativeId: null,
    })
  })

  it('a newer client (one dr-file-card migration ahead) is refused with 4099 SERVER_TOO_OLD and stops', async () => {
    const server = await h.server()
    const future = h.client(server, { boardId: newBoardId(), user: 'alice', schema: fileCardFutureSchema })
    expect(await future.waitForClose()).toMatchObject({ code: 4099, reason: 'SERVER_TOO_OLD' })
    expect(future.syncErrors).toEqual(['SERVER_TOO_OLD'])
    expect(future.isSynced()).toBe(false)
    await sleep(300)
    expect(future.socketGeneration).toBe(1)
  })
})

describe('migration of stored records when a room opens', () => {
  it('a board written under dr-file-card v0 is served (and re-stored) migrated: posterDerivativeId null', async () => {
    const dataDir = h.dataDir()
    const boardId = newBoardId()
    const dbPath = join(dataDir, 'rooms', `board-${boardId}.sqlite`)
    mkdirSync(join(dataDir, 'rooms'), { recursive: true })

    // Write the board the way an older server build would have left it: v0 schema + a v0 record.
    const legacy = fileCardV0('legacy', { name: 'legacy.pdf' })
    const db = new DatabaseSync(dbPath)
    new SQLiteSyncStorage<TLRecord>({
      sql: new NodeSqliteWrapper(db),
      snapshot: {
        documentClock: 1,
        documents: [...DEFAULT_INITIAL_SNAPSHOT.documents, { state: legacy, lastChangedClock: 1 }],
        schema: fileCardV0Schema.serialize(),
      },
    })
    db.close()
    expect(readStored(dbPath)).toMatchObject({ version: 0, props: { name: 'legacy.pdf' } })
    expect(readStored(dbPath).props).not.toHaveProperty('posterDerivativeId')

    const server = await h.server({ dataDir })
    const served = await h.freshView(server, boardId)
    expect(served.get('shape:legacy')?.props).toMatchObject({ name: 'legacy.pdf', posterDerivativeId: null })

    // the migration was written back, not just applied on the way out
    expect(await server.kill('SIGINT')).toEqual({ code: 0, signal: null })
    expect(readStored(dbPath)).toMatchObject({
      version: 1,
      props: { name: 'legacy.pdf', posterDerivativeId: null },
    })
  })
})

function readStored(dbPath: string): { version: number | undefined; props: Record<string, unknown> } {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const meta = db.prepare('SELECT schema FROM metadata').get() as { schema: string }
    const row = db.prepare('SELECT state FROM documents WHERE id = ?').get('shape:legacy') as {
      state: Uint8Array
    }
    const record = JSON.parse(Buffer.from(row.state).toString('utf8')) as { props: Record<string, unknown> }
    const version = (JSON.parse(meta.schema) as { sequences: Record<string, number> }).sequences[
      FILE_CARD_SEQUENCE
    ]
    return { version, props: record.props }
  } finally {
    db.close()
  }
}
