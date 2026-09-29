// B8's generated boards (docs/EXCALIDRAW-MIGRATION.md §8.3 B8 "The corpus"), made with the CURRENT build:
// today's tldraw sync (the spike branch's apps/sync with DRAFTROOM_ENGINE unset, on O4's port 7900) and
// today's tldraw client (the sync harness's NodeSyncClient: a real TLSyncClient on a Node store), so each
// board file is exactly what the current build writes.
//
//   node e2e/spike-b/b8/corpus.ts --out <folder> [--only tour,multipage,heavy,fixtures]
//
//  - `b8-tour`: the Lobby tour (packages/templates `lobby-tour`) inserted into an empty board, as the
//    board page inserts it on first open; its comment anchors are listed in `b8-tour.anchors.json`
//    (every note, geo, text and frame: structural, the api rows are the rehearsal's, §8.1);
//  - `b8-multipage`: three pages with content (notes, labelled geos, text, frames with children, bound
//    arrows, a group, draw, line, an image), for `page-flattened` and the frozen offsets;
//  - `b8-heavy`: the heavy perf board (e2e/perf/seed.ts HEAVY ported: 20 frames, 4,500 notes, 200
//    images, tags), with its 40 comment anchors;
//  - `b8-fx-<name>`: [DATA]'s 8 fixtures (packages/tldraw-import/test/fixtures), through the seed route.
// Each board also gets two deletes through the client, so "Recently deleted" holds real captured rows.
// These boards hold no real data; nothing here reads a staging copy.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { ShapeRecord } from '../../../apps/sync/test/harness/records.ts'
import { NodeSyncClient } from '../../../apps/sync/test/harness/sync-client.ts'
import type { TLRecord } from '../../../apps/sync/test/migrate/tl-records.ts'
import {
  arrow,
  binding,
  draw,
  frame,
  geo,
  heavyBoardRecords,
  image,
  imageAsset,
  line,
  note,
  nthIndex,
  pageRecord,
  text,
} from '../../../apps/sync/test/migrate/tl-records.ts'
import { instantiateTemplate } from '../../../packages/templates/src/index.ts'
import { callInternal, REPO_ROOT, startSync } from './stand-in.ts'

/** O4 runs the stand-in on 7900; the lead's integration pass sets SPIKE_B8_STANDIN_PORT inside 7850-7859 (§8.6.8). */
export const CORPUS_PORT = Number(process.env.SPIKE_B8_STANDIN_PORT ?? 7900)

async function withClient<T>(
  wsUrl: string,
  boardId: string,
  fn: (c: NodeSyncClient) => Promise<T>,
): Promise<T> {
  const c = new NodeSyncClient({
    wsUrl,
    boardId,
    user: 'usr_b8corpus0001',
    name: 'B8 corpus',
    autoReconnect: false,
  })
  try {
    await c.waitForSynced(30_000)
    return await fn(c)
  } finally {
    c.dispose()
  }
}

async function putAll(c: NodeSyncClient, records: readonly TLRecord[], batch = 250) {
  for (let i = 0; i < records.length; i += batch) {
    c.put(...(records.slice(i, i + batch) as unknown as ShapeRecord[]))
    await c.waitForAcked(60_000)
  }
}

/** The multi-page board: pages 2 and 3 with content. */
export function multipageRecords(): TLRecord[] {
  const p1 = 'page:page'
  const p2 = 'page:p2'
  const p3 = 'page:p3'
  return [
    pageRecord(p2, 'Second page', 'a2'),
    pageRecord(p3, 'Third page', 'a3'),
    imageAsset('asset:mp-img', 'ast_mp00000001', 'ver_mp00000001', 1600, 1200, 'photo.jpg'),
    // page 1
    frame('mp-f1', p1, 'a1', 0, 0, 900, 600, 'Plan'),
    note('mp-n1', 'shape:mp-f1', 'a1', 40, 60, 'First note on page one'),
    note('mp-n2', 'shape:mp-f1', 'a2', 300, 60, 'Second note, a little longer so it wraps inside the note', {
      color: 'light-blue',
    }),
    geo('mp-g1', p1, 'a2', 1000, 0, 240, 140, 'A box'),
    arrow('mp-a1', p1, 'a3', 0, 0, { x: 10, y: 10 }),
    binding('mp-a1s', 'mp-a1', 'mp-n1', 'start'),
    binding('mp-a1e', 'mp-a1', 'mp-g1', 'end'),
    // page 2
    note('mp-p2n1', p2, 'a1', 0, 0, 'Page two note', { color: 'orange' }),
    geo('mp-p2g1', p2, 'a2', 260, 0, 200, 160, 'Decide', { geo: 'diamond', color: 'red' }),
    text('mp-p2t1', p2, 'a3', 0, 260, 'Free text on page two'),
    image('mp-p2i1', p2, 'a4', 520, 0, 400, 300, 'asset:mp-img'),
    draw('mp-p2d1', p2, 'a5', 0, 400, [
      { x: 0, y: 0 },
      { x: 30, y: 20 },
      { x: 80, y: 10 },
    ]),
    line('mp-p2l1', p2, 'a6', 200, 400, [
      { x: 0, y: 0 },
      { x: 120, y: 60 },
    ]),
    frame('mp-p2f1', p2, 'a7', 1000, 0, 500, 400, 'Page two frame'),
    note('mp-p2f1n', 'shape:mp-p2f1', 'a1', 40, 60, 'Inside the page two frame', { color: 'light-green' }),
    arrow('mp-p2a1', p2, 'a8', 0, 0, { x: 10, y: 10 }, { bend: 40 }),
    binding('mp-p2a1s', 'mp-p2a1', 'mp-p2n1', 'start'),
    binding('mp-p2a1e', 'mp-p2a1', 'mp-p2g1', 'end', { x: 0.5, y: 1 }, true),
    // page 3
    note('mp-p3n1', p3, 'a1', 0, 0, 'Page three', { color: 'violet' }),
    note('mp-p3n2', p3, 'a2', 400, 200, 'Page three, second'),
    {
      id: 'shape:mp-p3grp',
      typeName: 'shape',
      type: 'group',
      parentId: p3,
      index: 'a3',
      x: 0,
      y: 400,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: {},
      props: {},
    } as unknown as TLRecord,
    geo('mp-p3g1', 'shape:mp-p3grp', 'a1', 0, 0, 120, 80, 'In a group', { geo: 'ellipse' }),
    geo('mp-p3g2', 'shape:mp-p3grp', 'a2', 160, 0, 120, 80, 'Also grouped'),
    arrow('mp-p3a1', p3, 'a4', 0, 0, { x: 10, y: 10 }),
    binding('mp-p3a1s', 'mp-p3a1', 'mp-p3n1', 'start'),
    binding('mp-p3a1e', 'mp-p3a1', 'mp-p3n2', 'end'),
  ]
}

/** The two deletes every generated board gets (through the client, so they are captured). */
function extraForDeletes(pageId: string): TLRecord[] {
  return [
    note('b8-del1', pageId, nthIndex(3800), -2000, -2000, 'deleted note one'),
    geo('b8-del2', pageId, nthIndex(3801), -2000, -1600, 120, 80, 'deleted box'),
  ]
}

export interface CorpusBoard {
  readonly boardId: string
  readonly file: string
  readonly anchors: readonly string[]
  readonly kind: 'tour' | 'multipage' | 'heavy' | 'fixture'
}

export async function makeCorpus(outDir: string, only?: readonly string[]): Promise<CorpusBoard[]> {
  const want = (k: string) => !only || only.includes(k)
  const work = join(outDir, '.corpus-sync')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const sync = await startSync({
    port: CORPUS_PORT,
    dataDir: work,
    engine: 'tldraw',
    logFile: join(outDir, 'corpus-sync.log'),
  })
  const made: CorpusBoard[] = []
  try {
    const client = async (
      boardId: string,
      records: readonly TLRecord[],
      kind: CorpusBoard['kind'],
      anchors: string[] = [],
    ) => {
      await withClient(sync.wsUrl, boardId, async (c) => {
        await putAll(c, records)
        await putAll(c, extraForDeletes('page:page'))
        c.remove('shape:b8-del1', 'shape:b8-del2')
        await c.waitForAcked(60_000)
      })
      made.push({ boardId, file: `board-${boardId}.sqlite`, anchors, kind })
    }
    if (want('tour')) {
      const inst = instantiateTemplate('lobby-tour', { pageId: 'page:page' as never, origin: { x: 0, y: 0 } })
      const recs = inst.records as unknown as TLRecord[]
      const anchors = recs
        .filter(
          (r) =>
            r.typeName === 'shape' &&
            ['note', 'geo', 'text', 'frame'].includes(String((r as { type?: string }).type)),
        )
        .map((r) => r.id)
      await client('b8-tour', recs, 'tour', anchors)
    }
    if (want('multipage')) await client('b8-multipage', multipageRecords(), 'multipage')
    if (want('heavy')) {
      const h = heavyBoardRecords()
      await client(
        'b8-heavy',
        h.records.filter((r) => r.typeName !== 'document' && r.id !== 'page:page'),
        'heavy',
        h.anchors,
      )
    }
    if (want('fixtures')) {
      const dir = join(REPO_ROOT, 'packages/tldraw-import/test/fixtures')
      for (const f of readdirSync(dir)
        .filter((n) => n.startsWith('tl-') && n.endsWith('.json'))
        .sort()) {
        const name = f.slice(3, -5)
        const records = JSON.parse(readFileSync(join(dir, f), 'utf8')) as TLRecord[]
        const boardId = `b8-fx-${name}`
        // the api's seed path (a new board from a plan), then the two captured deletes through the client
        const { draftroomSchema } = await import('../../../packages/canvas-schema/src/index.ts')
        const res = await callInternal(sync, 'POST', `/internal/boards/${boardId}/seed`, {
          snapshot: {
            schema: draftroomSchema.serialize(),
            documents: records.map((state) => ({ state, lastChangedClock: 0 })),
          },
        })
        if (res.status !== 201) throw new Error(`seed of a fixture failed with ${res.status}`)
        await withClient(sync.wsUrl, boardId, async (c) => {
          await putAll(c, extraForDeletes('page:page'))
          c.remove('shape:b8-del1', 'shape:b8-del2')
          await c.waitForAcked(60_000)
        })
        made.push({ boardId, file: `board-${boardId}.sqlite`, anchors: [], kind: 'fixture' })
      }
    }
  } finally {
    await sync.stop('SIGINT')
  }
  for (const b of made) {
    const from = join(work, 'rooms', b.file)
    copyFileSync(from, join(outDir, b.file))
    if (existsSync(`${from}-wal`)) copyFileSync(`${from}-wal`, join(outDir, `${b.file}-wal`))
  }
  writeFileSync(join(outDir, 'corpus.json'), `${JSON.stringify(made, null, 1)}\n`)
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  return made
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, only: { type: 'string' } } })
  if (!values.out) throw new Error('--out <folder> is required')
  const made = await makeCorpus(resolve(values.out), values.only?.split(','))
  console.log(`corpus: ${made.length} boards (${made.map((b) => b.boardId).join(', ')})`)
}
