// GET /internal/boards/:bid/asset-refs (the api's asset collector): the reference rules, and the
// endpoint on a real server with real TLSyncClients over WebSocket, "Recently deleted" included.
import { existsSync, readdirSync } from 'node:fs'
import { draftroomSchema } from '@draftroom/canvas-schema'
import type { TLShape } from '@tldraw/tlschema'
import { afterEach, describe, expect, it } from 'vitest'
import { AssetRefScan } from '../../src/http/asset-refs.ts'
import { AST_A, AST_B, fileCard, imageAsset, VER_A, VER_B } from '../backup/offsite-fixtures.ts'
import { PAGE } from '../deleted/fixtures.ts'
import type { ShapeRecord } from '../harness/records.ts'
import { NodeSyncClient } from '../harness/sync-client.ts'
import { callInternal, errorCode } from '../harness/tickets.ts'
import { waitFor } from '../harness/wait.ts'
import { startServer, type TestServer } from './helpers.ts'

const BOARD = 'b-assetrefs0'
const AST_C = 'ast_CCCCCCCCCCCCCCCCCCCC'
const VER_C = 'ver_CCCCCCCCCCCCCCCCCCCC'
const AST_D = 'ast_DDDDDDDDDDDDDDDDDDDD'
const VER_D = 'ver_DDDDDDDDDDDDDDDDDDDD'

let servers: TestServer[] = []
let clients: NodeSyncClient[] = []
afterEach(async () => {
  for (const c of clients) c.dispose()
  await Promise.all(servers.map((s) => s.stop()))
  servers = []
  clients = []
})

/** A tldraw image shape showing the asset record `asset:<assetRecord>`. */
function imageShape(id: string, assetRecord: string, index = 'a2'): TLShape {
  return draftroomSchema.types.shape.validate({
    id: `shape:${id}`,
    typeName: 'shape',
    type: 'image',
    x: 300,
    y: 0,
    rotation: 0,
    index,
    parentId: PAGE,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      w: 320,
      h: 240,
      assetId: `asset:${assetRecord}`,
      playing: true,
      url: '',
      crop: null,
      flipX: false,
      flipY: false,
      altText: '',
    },
  }) as TLShape
}

const ref = (assetId: string, versionId: string) => ({ assetId, versionId })

describe('reference rules', () => {
  it('file cards and asset records a shape uses count; an asset record no shape uses is listed apart', () => {
    const scan = new AssetRefScan()
    scan.addCanvas(fileCard('card', AST_A, VER_A))
    scan.addCanvas(imageAsset('used', AST_B, VER_B))
    scan.addCanvas(imageShape('img', 'used'))
    scan.addCanvas(imageAsset('left-behind', AST_C, VER_C)) // its image shape was deleted long ago
    expect(scan.result(BOARD, true)).toEqual({
      boardId: BOARD,
      exists: true,
      canvas: [ref(AST_A, VER_A), ref(AST_B, VER_B)],
      deleted: [],
      unusedAssetRecords: [ref(AST_C, VER_C)],
    })
  })

  it('a captured shape keeps its version: a file card directly, an image through the asset record on the canvas', () => {
    const scan = new AssetRefScan()
    scan.addCanvas(imageAsset('photo', AST_B, VER_B))
    scan.addDeleted(JSON.stringify(fileCard('gone-card', AST_A, VER_A)))
    scan.addDeleted(JSON.stringify(imageShape('gone-img', 'photo')))
    // An image shape whose asset record is gone from the canvas cannot show anything if restored.
    scan.addDeleted(JSON.stringify(imageShape('orphan', 'missing-record')))
    expect(scan.result(BOARD, true)).toMatchObject({
      canvas: [],
      deleted: [ref(AST_A, VER_A), ref(AST_B, VER_B)],
      unusedAssetRecords: [],
    })
  })

  it('ignores malformed ids, foreign src values and unreadable rows', () => {
    const scan = new AssetRefScan()
    const card = fileCard('bad', AST_A, VER_A) as unknown as ShapeRecord
    scan.addCanvas({ ...card, props: { ...card.props, assetId: 'ast_x', versionId: VER_A } })
    scan.addCanvas({ ...imageAsset('ext', AST_B, VER_B), props: { src: 'https://example.com/a.png' } })
    scan.addCanvas({ ...imageAsset('signed', AST_B, VER_B), props: { src: `/files/${AST_B}/${VER_B}/d/x` } })
    scan.addCanvas(null)
    scan.addCanvas('text')
    scan.addDeleted('{"assetId": not json')
    scan.addDeleted(JSON.stringify({ typeName: 'binding', props: { assetId: AST_A } }))
    expect(scan.result(BOARD, true)).toMatchObject({ canvas: [], deleted: [], unusedAssetRecords: [] })
  })

  it('two asset records naming one version: the version is used when any shape uses either', () => {
    const scan = new AssetRefScan()
    scan.addCanvas(imageAsset('one', AST_D, VER_D))
    scan.addCanvas(imageAsset('two', AST_D, VER_D))
    scan.addCanvas(imageShape('img', 'two'))
    expect(scan.result(BOARD, true)).toMatchObject({ canvas: [ref(AST_D, VER_D)], unusedAssetRecords: [] })
  })
})

describe('GET /internal/boards/:bid/asset-refs', () => {
  async function setup() {
    const t = await startServer()
    servers.push(t)
    const connect = async (user: string) => {
      const c = new NodeSyncClient({ wsUrl: t.wsUrl, boardId: BOARD, user })
      clients.push(c)
      await c.waitForSynced()
      return c
    }
    return { t, connect }
  }
  const refs = async (t: TestServer, board = BOARD) => {
    const res = await callInternal(t.url, 'GET', `/internal/boards/${board}/asset-refs`)
    return { status: res.status, body: await res.json() }
  }

  it('follows edits over the wire: deleted shapes move to "deleted", a restore brings them back', async () => {
    const { t, connect } = await setup()
    const alice = await connect('usr_alice')
    alice.put(
      fileCard('card', AST_A, VER_A) as unknown as ShapeRecord,
      imageAsset('photo', AST_B, VER_B) as unknown as ShapeRecord,
      imageShape('img', 'photo') as unknown as ShapeRecord,
      imageAsset('stale', AST_C, VER_C) as unknown as ShapeRecord,
    )
    await alice.waitForAcked()
    expect(await refs(t)).toEqual({
      status: 200,
      body: {
        boardId: BOARD,
        exists: true,
        canvas: [ref(AST_A, VER_A), ref(AST_B, VER_B)],
        deleted: [],
        unusedAssetRecords: [ref(AST_C, VER_C)],
      },
    })

    // Deleting the shapes leaves the image's asset record behind (as tldraw does); both versions are
    // still restorable from "Recently deleted".
    alice.remove('shape:card', 'shape:img')
    await alice.waitForAcked()
    expect((await refs(t)).body).toMatchObject({
      canvas: [],
      deleted: [ref(AST_A, VER_A), ref(AST_B, VER_B)],
      unusedAssetRecords: [ref(AST_C, VER_C)],
    })

    const restored = await callInternal(t.url, 'POST', `/internal/boards/${BOARD}/deleted/restore`, {
      body: { ids: ['shape:card'] },
    })
    expect(restored.status).toBe(200)
    await waitFor(() => alice.get('shape:card') !== undefined)
    expect((await refs(t)).body).toMatchObject({
      canvas: [ref(AST_A, VER_A)],
      deleted: [ref(AST_B, VER_B)],
    })
  })

  it('answers exists:false for a board without storage, and creates nothing', async () => {
    const { t } = await setup()
    expect(await refs(t, 'b-neverseen1')).toEqual({
      status: 200,
      body: { boardId: 'b-neverseen1', exists: false, canvas: [], deleted: [], unusedAssetRecords: [] },
    })
    const rooms = existsSync(t.roomsDir) ? readdirSync(t.roomsDir) : []
    expect(rooms.filter((f) => f.includes('neverseen1'))).toEqual([])
  })

  it('requires the internal secret, GET only, and a valid board id', async () => {
    const { t } = await setup()
    const path = `/internal/boards/${BOARD}/asset-refs`
    const noSecret = await callInternal(t.url, 'GET', path, { secret: null })
    expect(noSecret.status).toBe(401)
    const post = await callInternal(t.url, 'POST', path, { body: {} })
    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET')
    const bad = await callInternal(t.url, 'GET', '/internal/boards/Bad..Id/asset-refs')
    expect(bad.status).toBe(400)
    expect(await errorCode(bad)).toBe('INVALID_BOARD_ID')
  })
})
