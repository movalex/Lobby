// Wave 4 tags (packages/contracts/src/tags.ts) store ONE META KEY PER TAG: `drTags:<key>` on a note and
// `drTagList:<key>` on the document record. These tests prove, against the real server and the real
// TLSyncClient, why: concurrent tag changes by different people (and an editor coming back online)
// merge per tag. The last test shows what the rejected layout, all tags in one meta object, would lose.
// "Concurrent" is forced as in conflicts.test.ts: both pushes are built while outgoing frames are held.
import { describe, expect, it } from 'vitest'
import { newBoardId, useProtocolHarness } from '../harness/fixture.ts'
import { noteShape, type ShapeRecord } from '../harness/records.ts'
import type { NodeSyncClient } from '../harness/sync-client.ts'
import { waitFor } from '../harness/wait.ts'

const h = useProtocolHarness()
const N = 'shape:n'
const DOC = 'document:document'

const tag = (name: string, color: string) => ({ name, color })
type Meta = Record<string, unknown>
const metaOf = (c: NodeSyncClient, id: string) => (c.get<{ meta: Meta }>(id)?.meta ?? {}) as Meta
const tagKeys = (meta: Meta, prefix: string) =>
  Object.keys(meta)
    .filter((k) => k.startsWith(prefix))
    .sort()

/** Writes the record's whole meta (what the web app does: it puts whole records). */
function setMeta(c: NodeSyncClient, id: string, fn: (meta: Meta) => Meta) {
  c.update(
    id,
    (r) => ({ ...r, meta: fn({ ...((r as ShapeRecord & { meta: Meta }).meta ?? {}) }) }) as ShapeRecord,
  )
}
const withKey = (key: string, value: unknown) => (m: Meta) => ({ ...m, [key]: value })
const withoutKey = (key: string) => (m: Meta) => {
  const next = { ...m }
  delete next[key]
  return next
}

async function twoClientsWithNote() {
  const server = await h.server()
  const boardId = newBoardId()
  const a = await h.connected(server, { boardId, user: 'alice' })
  const b = await h.connected(server, { boardId, user: 'bob' })
  a.put(noteShape('n', 'Interview notes'))
  await a.waitForAcked()
  await waitFor(() => b.get(N) && b.get(DOC))
  return { server, boardId, a, b }
}

async function processInOrder(first: NodeSyncClient, second: NodeSyncClient) {
  first.releaseOutgoing()
  await first.waitForAcked()
  second.releaseOutgoing()
  await second.waitForAcked()
}

async function freshMeta(server: Awaited<ReturnType<typeof h.server>>, boardId: string, id: string) {
  const c = await h.connected(server, { boardId, user: 'verifier', autoReconnect: false })
  const meta = metaOf(c, id)
  c.dispose()
  return meta
}

describe('tags: one meta key per tag merges', () => {
  it('two people tag the same note at the same time: both tags are kept everywhere', async () => {
    const { server, boardId, a, b } = await twoClientsWithNote()
    a.holdOutgoing()
    b.holdOutgoing()
    setMeta(a, N, withKey('drTags:research', tag('Research', 'blue')))
    setMeta(b, N, withKey('drTags:idea', tag('Idea', 'green')))
    await processInOrder(a, b)
    const want = ['drTags:idea', 'drTags:research']
    await waitFor(() => tagKeys(metaOf(a, N), 'drTags:').length === 2)
    expect(tagKeys(metaOf(a, N), 'drTags:')).toEqual(want)
    expect(tagKeys(metaOf(b, N), 'drTags:')).toEqual(want)
    expect(tagKeys(await freshMeta(server, boardId, N), 'drTags:')).toEqual(want)
  })

  it('one person removes a tag while another adds one: the removal and the addition both land', async () => {
    const { server, boardId, a, b } = await twoClientsWithNote()
    setMeta(a, N, withKey('drTags:research', tag('Research', 'blue')))
    await a.waitForAcked()
    await waitFor(() => 'drTags:research' in metaOf(b, N))
    a.holdOutgoing()
    b.holdOutgoing()
    setMeta(a, N, withoutKey('drTags:research'))
    setMeta(b, N, withKey('drTags:blocked', tag('Blocked', 'red')))
    await processInOrder(b, a)
    await waitFor(() => !('drTags:research' in metaOf(b, N)))
    for (const meta of [metaOf(a, N), metaOf(b, N), await freshMeta(server, boardId, N)])
      expect(tagKeys(meta, 'drTags:')).toEqual(['drTags:blocked'])
  })

  it('two people create different board tags at once: the board list keeps both (and the other document settings)', async () => {
    const { server, boardId, a, b } = await twoClientsWithNote()
    setMeta(a, DOC, withKey('drWorkshop', { hideNoteAuthors: true, hideCursors: false }))
    await a.waitForAcked()
    await waitFor(() => 'drWorkshop' in metaOf(b, DOC))
    a.holdOutgoing()
    b.holdOutgoing()
    setMeta(a, DOC, withKey('drTagList:research', tag('Research', 'blue')))
    setMeta(b, DOC, withKey('drTagList:idea', tag('Idea', 'green')))
    await processInOrder(a, b)
    await waitFor(() => tagKeys(metaOf(a, DOC), 'drTagList:').length === 2)
    for (const meta of [metaOf(a, DOC), metaOf(b, DOC), await freshMeta(server, boardId, DOC)]) {
      expect(tagKeys(meta, 'drTagList:')).toEqual(['drTagList:idea', 'drTagList:research'])
      expect(meta.drWorkshop).toEqual({ hideNoteAuthors: true, hideCursors: false })
    }
  })

  it('an editor tags offline while others tag the same note: after reconnecting, nobody’s tags are lost', async () => {
    const { server, boardId, a, b } = await twoClientsWithNote()
    b.goOffline()
    setMeta(b, N, withKey('drTags:blocked', tag('Blocked', 'red')))
    setMeta(b, DOC, withKey('drTagList:blocked', tag('Blocked', 'red')))
    setMeta(a, N, withKey('drTags:idea', tag('Idea', 'green')))
    setMeta(a, DOC, withKey('drTagList:idea', tag('Idea', 'green')))
    await a.waitForAcked()
    b.goOnline()
    await b.waitForSynced()
    await b.waitForAcked()
    await waitFor(() => tagKeys(metaOf(a, N), 'drTags:').length === 2)
    for (const c of [a, b]) {
      expect(tagKeys(metaOf(c, N), 'drTags:')).toEqual(['drTags:blocked', 'drTags:idea'])
      expect(tagKeys(metaOf(c, DOC), 'drTagList:')).toEqual(['drTagList:blocked', 'drTagList:idea'])
    }
    expect(tagKeys(await freshMeta(server, boardId, N), 'drTags:')).toEqual(['drTags:blocked', 'drTags:idea'])
  })

  it('WHY NOT ONE OBJECT: all tags in one meta key lose one of two concurrent additions', async () => {
    const { a, b } = await twoClientsWithNote()
    a.holdOutgoing()
    b.holdOutgoing()
    setMeta(a, N, withKey('tagsAsOneObject', { research: tag('Research', 'blue') }))
    setMeta(b, N, withKey('tagsAsOneObject', { idea: tag('Idea', 'green') }))
    await processInOrder(a, b)
    await waitFor(() => {
      const one = metaOf(a, N).tagsAsOneObject as Meta | undefined
      return one !== undefined && 'idea' in one
    })
    // sync-core sends a nested object as one `put`: the second push replaces the first one's object.
    expect(Object.keys(metaOf(a, N).tagsAsOneObject as Meta)).toEqual(['idea'])
    expect(Object.keys(metaOf(b, N).tagsAsOneObject as Meta)).toEqual(['idea'])
  })
})
