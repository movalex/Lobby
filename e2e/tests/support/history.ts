// Helpers for the history suite (checkpoints, "Recently deleted", duplicate, export/import, backups):
// the history dock panel, server-side reads through the real HTTP API, board content fixtures and
// the backup restore drill. Test ids: docs/FEATURES-M2-CONTRACTS.md "history".
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, type Locator, type Page } from '@playwright/test'
import type { Api } from './api.ts'
import {
  type BoardDocument,
  boardDocument,
  documentDiff,
  edit,
  insertFiles,
  read,
  waitForValue,
} from './board.ts'
import type { BindingLike, EditorLike, RecordLike, ShapeLike } from './editor.ts'
import { plainText, richText } from './editor.ts'
import { FIXTURES_DIR, REPO_ROOT } from './stack.ts'

// ---- the editor slice this suite needs beyond support/editor.ts (tldraw 5.4.2 Editor) -----------

export interface HistoryEditorLike extends EditorLike {
  createBindings(partials: Record<string, unknown>[]): HistoryEditorLike
  getViewportScreenBounds(): { x: number; y: number; w: number; h: number }
  screenToPage(point: { x: number; y: number }): { x: number; y: number }
  getShapeAtPoint(point: { x: number; y: number }, opts?: Record<string, unknown>): ShapeLike | undefined
  getShapePageTransform(id: string): { point(): { x: number; y: number } }
}

// ---- the dock panel ------------------------------------------------------------------------------

export const historyPanel = (page: Page) => page.getByTestId('history-panel')
export const checkpointRow = (page: Page, snapshotId?: string) =>
  snapshotId
    ? page.locator(`[data-testid="checkpoint-row"][data-snapshot-id="${snapshotId}"]`)
    : page.getByTestId('checkpoint-row')
export const deletedRow = (page: Page, shapeId?: string) =>
  shapeId
    ? page.locator(`[data-testid="deleted-row"][data-shape-id="${shapeId}"]`)
    : page.getByTestId('deleted-row')

/** Opens the History dock panel and waits until both of its lists have loaded. */
export async function openHistory(page: Page): Promise<Locator> {
  const panel = historyPanel(page)
  if (!(await panel.isVisible())) await page.getByTestId('dock-tab-history').click()
  await expect(panel).toBeVisible()
  await expect(panel.getByText('Loading…')).toHaveCount(0)
  return panel
}

// ---- driving the canvas like a user ----------------------------------------------------------------

/**
 * Clicks a spot of the canvas that has no shape and no UI over it: the canvas gets keyboard focus
 * (and the selection is cleared, as any click on empty canvas does).
 */
export async function clickEmptyCanvas(page: Page) {
  const spot = await read(page, (editor) => {
    const ed = editor as HistoryEditorLike
    const vb = ed.getViewportScreenBounds()
    for (const fy of [0.85, 0.7, 0.55, 0.4, 0.25]) {
      for (const fx of [0.9, 0.75, 0.6, 0.45, 0.3, 0.15]) {
        const x = Math.round(vb.x + vb.w * fx)
        const y = Math.round(vb.y + vb.h * fy)
        const el = document.elementFromPoint(x, y)
        if (!el?.closest('.tl-canvas')) continue // tldraw UI or app chrome is on top here
        if (ed.getShapeAtPoint(ed.screenToPage({ x, y }), { hitInside: true, margin: 16 })) continue
        return { x, y }
      }
    }
    return null
  })
  if (!spot) throw new Error('no empty canvas spot to click')
  await page.mouse.click(spot.x, spot.y)
}

/** Selects `ids` and presses Delete, as a user deleting a selection does. */
export async function deleteWithKeyboard(page: Page, ids: string[]) {
  await clickEmptyCanvas(page)
  await edit(page, (ed, list) => ed.select(...list), ids)
  await page.keyboard.press('Delete')
  await expect.poll(() => read(page, (ed, list) => list.filter((id) => ed.getShape(id)).length, ids)).toBe(0)
}

/** Ctrl/Cmd+Z on the canvas. */
export async function undoWithKeyboard(page: Page) {
  await clickEmptyCanvas(page)
  await page.keyboard.press('ControlOrMeta+z')
}

// ---- board content -------------------------------------------------------------------------------

export interface FrameBoard {
  frame: string
  note1: string
  note2: string
  box: string
  arrow: string
}

/**
 * A frame "Sprint ideas" holding two notes, a box outside it, and a connector on the page from the
 * first note to the box (bound at both ends).
 */
export async function drawFrameBoard(page: Page, prefix: string): Promise<FrameBoard> {
  const ids: FrameBoard = {
    frame: `shape:${prefix}-frame`,
    note1: `shape:${prefix}-note-1`,
    note2: `shape:${prefix}-note-2`,
    box: `shape:${prefix}-box`,
    arrow: `shape:${prefix}-arrow`,
  }
  await edit(
    page,
    (editor, a) => {
      const ed = editor as HistoryEditorLike
      ed.createShapes([
        { id: a.ids.frame, type: 'frame', x: 60, y: 60, props: { w: 460, h: 300, name: 'Sprint ideas' } },
        {
          id: a.ids.note1,
          type: 'note',
          parentId: a.ids.frame,
          x: 30,
          y: 60,
          props: { color: 'yellow', richText: a.t1 },
        },
        {
          id: a.ids.note2,
          type: 'note',
          parentId: a.ids.frame,
          x: 240,
          y: 60,
          props: { color: 'blue', richText: a.t2 },
        },
        { id: a.ids.box, type: 'geo', x: 640, y: 380, props: { w: 160, h: 110, color: 'green' } },
        {
          id: a.ids.arrow,
          type: 'arrow',
          x: 0,
          y: 0,
          props: { start: { x: 190, y: 330 }, end: { x: 700, y: 420 } },
        },
      ])
      const binding = (terminal: string, toId: string) => ({
        id: `binding:${a.ids.arrow.slice(6)}-${terminal}`,
        type: 'arrow',
        fromId: a.ids.arrow,
        toId,
        props: {
          terminal,
          normalizedAnchor: { x: 0.5, y: 0.5 },
          isExact: false,
          isPrecise: false,
          snap: 'none',
        },
      })
      ed.createBindings([binding('start', a.ids.note1), binding('end', a.ids.box)])
    },
    { ids, t1: richText('Ship the moodboard'), t2: richText('Record the voiceover') },
  )
  return ids
}

/** "start->shape:x" strings for an arrow's bindings, sorted (the same on every client when bound). */
export const boundEnds = (page: Page, arrowId: string) =>
  read(
    page,
    (ed, id) =>
      ed
        .getBindingsFromShape(id, 'arrow')
        .map((b) => `${b.props.terminal}->${b.toId}`)
        .sort(),
    arrowId,
  )

/** Where a shape sits: its parent and its own (parent-space) position, plus its text. */
export const placement = (page: Page, id: string) =>
  page.evaluate((shapeId) => {
    const s = window.editor?.getShape(shapeId)
    return s ? { parentId: s.parentId, x: s.x, y: s.y } : null
  }, id)

export const selectedIds = (page: Page) =>
  page.evaluate(() => [...(window.editor?.getSelectedShapeIds() ?? [])].sort())

// ---- files -----------------------------------------------------------------------------------------

export const fixture = (name: string) => join(FIXTURES_DIR, name)

export interface FileRef {
  assetId: string
  versionId: string
}

const STABLE_REF = /^\/files\/(ast_[0-9A-Za-z]{20})\/(ver_[0-9A-Za-z]{20})\/original$/

/** Uploads image.png through the app's "Insert file" (Ctrl/Cmd+U) and waits until it has rendered. */
export async function uploadImage(page: Page, boardId: string): Promise<{ shapeId: string; file: FileRef }> {
  await insertFiles(page, [fixture('image.png')])
  const found = await waitForValue(
    () =>
      page.evaluate((stable) => {
        const records = window.editor?.store.allRecords() ?? []
        const image = records.find((r) => r.typeName === 'shape' && r.type === 'image') as
          | { id: string; props: { assetId?: string } }
          | undefined
        const asset = records.find((r) => r.id === image?.props.assetId) as
          | { props?: { src?: unknown } }
          | undefined
        // The asset exists (with an empty src) while the upload runs: wait for the stored reference.
        const src = asset?.props?.src
        return image && typeof src === 'string' && new RegExp(stable).test(src)
          ? { shapeId: image.id, src }
          : null
      }, STABLE_REF.source),
    { timeout: 30_000, message: 'the uploaded image has a stable file reference' },
  )
  const m = STABLE_REF.exec(found.src)
  if (!m?.[1] || !m[2]) throw new Error(`unexpected image src ${found.src}`)
  // image.png is 1920×1080 and lands at full size: scale it down and put it beside the other
  // content (as a person would), then show the page at 100% again.
  await edit(
    page,
    (editor, id) => {
      const ed = editor as HistoryEditorLike & { setCamera(c: { x: number; y: number; z: number }): unknown }
      ed.updateShape({ id, type: 'image', x: 560, y: 40, props: { w: 240, h: 135 } })
      ed.selectNone()
      ed.setCamera({ x: 0, y: 0, z: 1 })
    },
    found.shapeId,
  )
  await expectImageRendered(page, found.shapeId, boardId)
  return { shapeId: found.shapeId, file: { assetId: m[1], versionId: m[2] } }
}

/**
 * The image of `shapeId` shows its generated PREVIEW (a derivative, not the original) for `boardId`
 * (board-scoped URL), and the browser decoded it.
 */
export async function expectImageRendered(page: Page, shapeId: string, boardId: string) {
  const imgs = page.locator(`[data-shape-id="${shapeId}"] img.tl-image`)
  await expect
    .poll(
      () =>
        imgs.evaluateAll((els) =>
          els.map((i) => ({
            src: i.getAttribute('src') ?? '',
            loaded: (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0,
          })),
        ),
      { timeout: 30_000, message: `image ${shapeId} rendered for ${boardId}` },
    )
    .toEqual([
      {
        src: expect.stringMatching(
          new RegExp(`^/files/ast_\\w{20}/ver_\\w{20}/d/drv_\\w{20}\\?board=${boardId}$`),
        ),
        loaded: true,
      },
    ])
}

/** Status of the original file of `ref`, asked for in the scope of `boardId`. */
export async function fileStatus(api: Api, ref: FileRef, boardId: string): Promise<number> {
  const res = await api.fetch('GET', `/files/${ref.assetId}/${ref.versionId}/original?board=${boardId}`)
  return res.status()
}

// ---- server-side reads (the API is the source of truth, not a tab's copy) -----------------------

export interface DeletedEntry {
  shapeId: string
  type: string
  label: string
  deletedAt: string
  deletedBy: { id: string; name: string }
  childCount: number
}

async function json<T>(api: Api, method: string, path: string, data?: unknown): Promise<T> {
  const res = await api.fetch(method, path, data)
  if (res.status() >= 300) throw new Error(`${method} ${path} -> ${res.status()} ${await res.text()}`)
  return (await res.json()) as T
}

export const listDeleted = (api: Api, boardId: string) =>
  json<{ entries: DeletedEntry[]; total: number }>(api, 'GET', `/api/boards/${boardId}/deleted`)

export interface SnapshotInfo {
  id: string
  boardId: string
  name: string
  kind: string
  createdBy: { id: string; name: string } | null
  recordCount: number
}
export const listSnapshots = (api: Api, boardId: string) =>
  json<{ snapshots: SnapshotInfo[] }>(api, 'GET', `/api/boards/${boardId}/snapshots`).then((r) => r.snapshots)

export interface Archive {
  format: string
  version: number
  records: RecordLike[]
  assets: { assetId: string; versionId: string; name: string; mimeType: string }[]
}

/** The board as the sync server holds it (GET /api/boards/:bid/export: the room's snapshot). */
export const serverArchive = (api: Api, boardId: string) =>
  json<Archive>(api, 'GET', `/api/boards/${boardId}/export`)

export async function serverShapes(api: Api, boardId: string): Promise<Record<string, ShapeLike>> {
  const archive = await serverArchive(api, boardId)
  const out: Record<string, ShapeLike> = {}
  for (const r of archive.records) if (r.typeName === 'shape') out[r.id] = r as ShapeLike
  return out
}

export async function serverBindings(api: Api, boardId: string): Promise<BindingLike[]> {
  const archive = await serverArchive(api, boardId)
  return archive.records.filter((r) => r.typeName === 'binding') as BindingLike[]
}

/**
 * Waits until the sync server holds exactly the shapes, bindings and assets `page` holds (every edit
 * of that tab has landed). The export clears notes' `textLastEditedBy`, so the comparison does too.
 */
export async function expectServerHasTab(api: Api, boardId: string, page: Page) {
  const normalize = (doc: BoardDocument): BoardDocument => {
    for (const s of Object.values(doc.shapes))
      if (s.type === 'note') doc.shapes[s.id] = { ...s, props: { ...s.props, textLastEditedBy: null } }
    return doc
  }
  await expect
    .poll(
      async () => {
        const [tab, archive] = await Promise.all([boardDocument(page), serverArchive(api, boardId)])
        const server: BoardDocument = { shapes: {}, bindings: {}, assets: {} }
        for (const r of archive.records) {
          if (r.typeName === 'shape') server.shapes[r.id] = r as ShapeLike
          else if (r.typeName === 'binding') server.bindings[r.id] = r as BindingLike
          else if (r.typeName === 'asset') server.assets[r.id] = r
        }
        return documentDiff(normalize(tab), normalize(server))
      },
      { timeout: 20_000, message: 'records that differ between the tab and the server' },
    )
    .toEqual([])
}

/** A comparable summary of a shape: what a person sees, not its id. */
export function describeShape(s: ShapeLike): string {
  const p = s.props as Record<string, unknown>
  const text = p.richText ? plainText(p.richText) : ''
  const name = typeof p.name === 'string' ? p.name : ''
  return `${s.type}|${Math.round(s.x)},${Math.round(s.y)}|${name}${text}`
}

// ---- backup restore drill ----------------------------------------------------------------------------

export interface DrillRun {
  status: number | null
  output: string
}

/**
 * `pnpm --filter @draftroom/sync backup:restore-drill` against a data dir (the documented command).
 * --backup-first makes a fresh online backup of each board first (safe next to a running server).
 */
export function runRestoreDrill(dataDir: string, boardIds: string[]): DrillRun {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env))
    if (key.startsWith('DRAFTROOM_') || key === 'NODE_OPTIONS') delete env[key]
  // One command line through the shell (pnpm is a .cmd shim on Windows). Every part is ours: the data
  // dir is a temp path and board ids match /^[a-z0-9_-]+$/; both are checked before use anyway.
  if (/["\r\n]/.test(dataDir)) throw new Error(`unexpected data dir ${dataDir}`)
  for (const b of boardIds) if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(b)) throw new Error(`bad board id ${b}`)
  const command = [
    'pnpm --filter @draftroom/sync backup:restore-drill',
    `--data-dir "${dataDir}" --backup-first`,
    ...boardIds.map((b) => `--board ${b}`),
  ].join(' ')
  const r = spawnSync(command, {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
    timeout: 120_000,
  })
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` }
}
