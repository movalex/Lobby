// Helpers for the file/image drop suites: images generated in the page (no fixture files to keep in
// the repo), dropping files on the canvas like a desktop drag, request logs per tab, and the
// placement invariants those suites assert.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { Page } from '@playwright/test'
import { edit, read } from './board.ts'
import type { CanvasEditor } from './canvas-ux.ts'
import type { BoxLike, EditorLike, RecordLike, ShapeLike } from './editor.ts'

/** A file for Playwright's setFiles / our drop helper. */
export interface FilePayload {
  name: string
  mimeType: string
  buffer: Buffer
}

export interface ImageSpec {
  name: string
  w: number
  h: number
  type?: 'image/jpeg' | 'image/png' | 'image/webp'
  /** 0..1: how much fine detail (bigger files, slower previews). Default 0.2. */
  detail?: number
}

/**
 * Renders each spec to a real, decodable image in the page (OffscreenCanvas): a colour gradient, a
 * few shapes, the name, and `detail` worth of small random marks.
 */
export async function makeImages(page: Page, specs: readonly ImageSpec[]): Promise<FilePayload[]> {
  const encoded = await page.evaluate(async (list) => {
    const out: string[] = []
    let seed = 7
    const rand = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    for (const [i, s] of list.entries()) {
      const canvas = new OffscreenCanvas(s.w, s.h)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      const g = ctx.createLinearGradient(0, 0, s.w, s.h)
      g.addColorStop(0, `hsl(${(i * 47) % 360} 60% 45%)`)
      g.addColorStop(1, `hsl(${(i * 47 + 120) % 360} 70% 70%)`)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, s.w, s.h)
      for (let k = 0; k < 6; k++) {
        ctx.fillStyle = `hsl(${(i * 31 + k * 60) % 360} 70% 55% / 0.8)`
        ctx.beginPath()
        ctx.arc(rand() * s.w, rand() * s.h, (0.05 + rand() * 0.15) * Math.min(s.w, s.h), 0, Math.PI * 2)
        ctx.fill()
      }
      const marks = Math.round(((s.detail ?? 0.2) * (s.w * s.h)) / 400)
      for (let k = 0; k < marks; k++) {
        ctx.fillStyle = `rgb(${rand() * 255} ${rand() * 255} ${rand() * 255})`
        ctx.fillRect(rand() * s.w, rand() * s.h, 1 + rand() * 6, 1 + rand() * 6)
      }
      ctx.fillStyle = '#fff'
      ctx.font = `bold ${Math.round(Math.min(s.w, s.h) / 8)}px sans-serif`
      ctx.fillText(s.name, Math.min(s.w, s.h) / 12, s.h - Math.min(s.w, s.h) / 12)
      const blob = await canvas.convertToBlob({ type: s.type ?? 'image/jpeg', quality: 0.9 })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let bin = ''
      for (let o = 0; o < bytes.length; o += 0x8000)
        bin += String.fromCharCode(...bytes.subarray(o, o + 0x8000))
      out.push(btoa(bin))
    }
    return out
  }, specs)
  return specs.map((s, i) => ({
    name: s.name,
    mimeType: s.type ?? 'image/jpeg',
    buffer: Buffer.from(encoded[i] ?? '', 'base64'),
  }))
}

/** Opens "Insert file" (Ctrl/Cmd+U) and picks the given files (paths or in-memory payloads). */
export async function insertPayloads(page: Page, files: (string | FilePayload)[]) {
  // Playwright cannot mix paths and buffers in one setFiles call.
  const payloads = files.map((f) => (typeof f === 'string' ? fileFromPath(f) : f))
  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.press('ControlOrMeta+u')
  await (await chooser).setFiles(payloads)
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  zip: 'application/zip',
}

/** A fixture file as a payload (the MIME type a browser would report for its extension). */
export function fileFromPath(path: string): FilePayload {
  const name = basename(path)
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return { name, mimeType: MIME_BY_EXT[ext] ?? 'application/octet-stream', buffer: readFileSync(path) }
}

/** Drops files on the canvas at a screen point, like a drag from the desktop. */
export async function dropFiles(page: Page, files: FilePayload[], at: { x: number; y: number }) {
  const payload = files.map((f) => ({ name: f.name, type: f.mimeType, b64: f.buffer.toString('base64') }))
  await page.evaluate(
    ({ payload, at }) => {
      const dt = new DataTransfer()
      for (const f of payload) {
        const bin = atob(f.b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        dt.items.add(new File([bytes], f.name, { type: f.type }))
      }
      const target = document.elementFromPoint(at.x, at.y)
      if (!target) throw new Error('nothing at the drop point')
      const init = { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, dataTransfer: dt }
      target.dispatchEvent(new DragEvent('dragenter', init))
      target.dispatchEvent(new DragEvent('dragover', init))
      target.dispatchEvent(new DragEvent('drop', init))
    },
    { payload, at },
  )
}

/** Records every request URL a page makes from now on. */
export function recordRequests(page: Page) {
  const urls: string[] = []
  page.on('request', (r) => urls.push(r.url()))
  return {
    urls,
    originals: () => urls.filter((u) => /\/files\/ast_\w+\/ver_\w+\/original/.test(u)),
    metas: () => urls.filter((u) => /\/api\/boards\/[^/]+\/assets\/ast_/.test(u)),
  }
}

export interface PlacedShape {
  id: string
  type: string
  parentId: string
  parentType: string | null
  bounds: BoxLike
  parentBounds: BoxLike | null
}

/** Every shape of `type` with its page bounds and its parent's (null parent = the page). */
export const placedShapes = (page: Page, type: string) =>
  read(
    page,
    (ed, t) =>
      ed
        .getCurrentPageShapes()
        .filter((s: ShapeLike) => s.type === t)
        .map((s: ShapeLike) => {
          const b = ed.getShapePageBounds(s.id)
          const parent = s.parentId.startsWith('shape:') ? ed.getShape(s.parentId) : null
          const pb = parent ? ed.getShapePageBounds(parent.id) : null
          return {
            id: s.id,
            type: s.type,
            parentId: s.parentId,
            parentType: parent?.type ?? null,
            bounds: b ? { x: b.x, y: b.y, w: b.w, h: b.h } : { x: 0, y: 0, w: 0, h: 0 },
            parentBounds: pb ? { x: pb.x, y: pb.y, w: pb.w, h: pb.h } : null,
          }
        }),
    type,
  ) as Promise<PlacedShape[]>

/**
 * Shapes that break the frame rule: a shape parented to a frame must lie inside it (frames clip
 * their children, so anything outside is hidden). Returns the offenders (empty = fine).
 */
export function outsideTheirFrame(shapes: readonly PlacedShape[], tolerance = 0.5): string[] {
  return shapes
    .filter((s) => {
      if (!s.parentBounds) return false
      const p = s.parentBounds
      const b = s.bounds
      return (
        b.x < p.x - tolerance ||
        b.y < p.y - tolerance ||
        b.x + b.w > p.x + p.w + tolerance ||
        b.y + b.h > p.y + p.h + tolerance
      )
    })
    .map((s) => s.id)
}

/** Resolves once `count` new shapes of `type` exist (ids not in `before`), returning their ids. */
export async function newShapeIds(page: Page, type: string, before: ReadonlySet<string>) {
  return read(
    page,
    (ed, arg) =>
      ed
        .getCurrentPageShapes()
        .filter((s: ShapeLike) => s.type === arg.type && !arg.before.includes(s.id))
        .map((s: ShapeLike) => s.id),
    { type, before: [...before] },
  ) as Promise<string[]>
}

export const allShapeIds = async (page: Page) =>
  new Set(await read(page, (ed) => ed.getCurrentPageShapes().map((s: ShapeLike) => s.id)))

/** The src of the <img> tldraw renders for an image shape ('' while there is none). */
export const imageSrc = (page: Page, id: string) =>
  page.evaluate((shapeId) => {
    const imgs = [...document.querySelectorAll(`[data-shape-id="${shapeId}"] img.tl-image`)]
    const img = imgs[imgs.length - 1] as HTMLImageElement | undefined
    return img ? { src: img.getAttribute('src') ?? '', loaded: img.complete && img.naturalWidth > 0 } : null
  }, id)

/** Clears the selection and lets the camera settle (an animated zoom-out takes ~320 ms). */
export async function settleCamera(page: Page) {
  await page.waitForTimeout(450)
  await editF(page, (ed) => ed.stopCameraAnimation())
}

/** CanvasEditor plus the asset/camera calls these suites make (tldraw 5.4.2 Editor). */
export interface FilesEditor extends CanvasEditor {
  stopCameraAnimation(): FilesEditor
  getAsset(id: string): RecordLike | undefined
  resolveAssetUrl(
    id: string,
    ctx: { screenScale?: number; shouldResolveToOriginal?: boolean; dpr?: number },
  ): Promise<string | null>
  getTemporaryAssetPreview(id: string): string | undefined
  undo(): FilesEditor
}

/** `read` from board.ts, typed for FilesEditor (the callback is still serialized into the page). */
export function readF<T, A = undefined>(page: Page, fn: (editor: FilesEditor, arg: A) => T, arg?: A) {
  return read<T, A>(page, fn as unknown as (e: EditorLike, a: A) => T, arg)
}
export function editF<A>(page: Page, fn: (editor: FilesEditor, arg: A) => unknown, arg?: A) {
  return edit<A>(page, fn as unknown as (e: EditorLike, a: A) => unknown, arg)
}
