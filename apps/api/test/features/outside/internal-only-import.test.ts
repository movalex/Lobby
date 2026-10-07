// Wave J refix round 2, IO-10: export + import carried an internal-only project's stored files to a board
// outside it. A creator who may not move a board out of an internal-only project (IO-1: only a workspace
// owner or admin who is a creator may) could export it (or write an archive naming its file versions) and
// import that into no project, or into a project that is not internal only: the import linked the project's
// original file versions to a board of their own outside the switch, where outside invitations and links
// work. Now an import outside every internal-only scope leaves those files out (shown as missing, with a
// warning), decided under the workspace row lock the switch takes; into an internal-only project, or for a
// creator owner or admin, they are carried as before.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import {
  baseRecords,
  createFakeSync,
  type FakeSync,
  fileStatus,
  imageAssetRec,
  imageRec,
  noteRec,
  type Rec,
  upload,
} from '../history/helpers.ts'
import { commitAfter, grant, newProject, setProject } from './internal-only-support.ts'

const FENCED_ONE =
  '1 file(s) in this archive are on boards of an internal-only project, so they were not carried over to a board outside it and show as missing.'

interface Imported {
  board: { id: string; projectId: string | null }
  linkedFiles: number
  droppedFiles: number
  warnings: string[]
}

describe('IO-10 under the dev provider: an import does not carry an internal-only project’s files out', () => {
  let api: TestApi
  let sync: FakeSync
  let alice: Client // Dev Studio owner (creator)
  let bob: Client // creator member, owns `board`
  let carol: Client // creator member, editor on `board` (export allowed)
  let project: string // internal only
  let open: string // not internal only
  let board: string
  let photo: { assetId: string; versionId: string }

  beforeEach(async () => {
    sync = createFakeSync()
    api = await createTestApi({ deps: { syncInternal: sync } })
    alice = await api.login('alice')
    bob = await api.login('bob')
    carol = await api.login('carol')
    project = await newProject(bob, DEV_STUDIO, 'Secret')
    open = await newProject(bob, DEV_STUDIO, 'Open')
    board = await createBoard(bob, DEV_STUDIO, 'Internal plan')
    photo = await upload(api, bob, board, 'plan.png')
    const records: Rec[] = [
      ...baseRecords(),
      noteRec('n1', 'x'),
      imageAssetRec('plan', photo.assetId, photo.versionId),
      imageRec('img', 'plan'),
    ]
    sync.setBoard(board, records)
    expect((await bob.req('PATCH', `/api/boards/${board}`, { projectId: project })).statusCode).toBe(200)
    await grant(api, board, carol.userId, 'editor', bob.userId)
    const on = await setProject(alice, project, true)
    expect(on.statusCode, on.body).toBe(200)
  })
  afterEach(() => api.close())

  const archiveOf = async (c: Client) => {
    const res = await c.req('GET', `/api/boards/${board}/export`)
    expect(res.statusCode, res.body).toBe(200)
    return res.json() as unknown
  }
  const importAs = async (c: Client, archive: unknown, query = '') => {
    const res = await c.req('POST', `/api/workspaces/${DEV_STUDIO}/boards/import${query}`, archive)
    expect(res.statusCode, res.body).toBe(201)
    return res.json() as Imported
  }

  it('an editor importing into no project, or a project that is not internal only, gets none of its files', async () => {
    const archive = await archiveOf(carol)
    for (const query of ['', `?projectId=${open}`]) {
      const body = await importAs(carol, archive, query)
      expect(body).toMatchObject({ linkedFiles: 0, droppedFiles: 1 })
      expect(body.warnings).toContain(FENCED_ONE)
      expect(await fileStatus(carol, photo, body.board.id)).toBe(404)
      const links = await api.db.query('SELECT 1 FROM board_asset_links WHERE board_id = $1', [body.board.id])
      expect(links.rows).toHaveLength(0)
    }
  })

  it('into an internal-only project, or by a creator owner, the files are carried as before', async () => {
    const archive = await archiveOf(carol)
    const inside = await importAs(carol, archive, `?projectId=${project}`)
    expect(inside).toMatchObject({ linkedFiles: 1, droppedFiles: 0 })
    expect(inside.warnings).not.toContain(FENCED_ONE)
    expect(await fileStatus(carol, photo, inside.board.id)).toBe(200)
    const owner = await importAs(alice, await archiveOf(alice))
    expect(owner).toMatchObject({ linkedFiles: 1, droppedFiles: 0 })
  })

  it('a switch-on that commits during the import is seen; with the switch off the files are carried', async () => {
    expect((await setProject(alice, project, false)).statusCode).toBe(200)
    const archive = await archiveOf(carol)
    // The switch goes on right after the route's own (unlocked) file check: the decision under the
    // workspace row lock sees it.
    const restore = commitAfter(api, /FROM board_asset_links l/, (q) =>
      q('UPDATE projects SET internal_only = true WHERE id = $1', [project]),
    )
    try {
      expect(await importAs(carol, archive)).toMatchObject({ linkedFiles: 0, droppedFiles: 1 })
    } finally {
      restore()
    }
    expect((await setProject(alice, project, false)).statusCode).toBe(200)
    expect(await importAs(carol, archive)).toMatchObject({ linkedFiles: 1, droppedFiles: 0 })
  })

  it('a file also on a board outside the project that the importer can view is already outside: kept', async () => {
    const elsewhere = await createBoard(carol, DEV_STUDIO, 'Elsewhere')
    await api.db.query(
      `INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id, created_at)
       VALUES ($1, $2, $3, $4, now())`,
      [DEV_STUDIO, elsewhere, photo.assetId, photo.versionId],
    )
    expect(await importAs(carol, await archiveOf(carol))).toMatchObject({ linkedFiles: 1, droppedFiles: 0 })
  })
})
