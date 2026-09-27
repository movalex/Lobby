import { FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import { useEffect, useRef } from 'react'
import {
  createShapeId,
  defaultHandleExternalFileContent,
  type Editor,
  type TLAssetId,
  type TLDefaultExternalContentHandlerOpts,
  type TLShapeId,
  useEditor,
  useToasts,
  useTranslation,
  type VecLike,
} from 'tldraw'
import { type AssetVersionMeta, LIMITS } from '../assets/contract.ts'
import { type AssetMetaStore, watchMeta } from '../assets/meta-store.ts'
import { type CardFile, NATIVE_IMAGE_MIME_TYPES, partitionFiles } from '../assets/partition.ts'
import { UploadError, uploadFile } from '../assets/upload.ts'
import { CARD_SIZE, changedHints, hintPropsFromMeta } from '../file-card/card-model.ts'
import { type BoardContextValue, useBoard } from './board-context.ts'

const CARD_GAP = 24

/** Options shared by <Tldraw> and our delegation to the default image handler. */
export const IMAGE_HANDLER_LIMITS = {
  maxAssetSize: LIMITS.maxBytes.image,
  acceptedImageMimeTypes: NATIVE_IMAGE_MIME_TYPES,
  // Videos become dr-file-cards (poster + original playback), never native video shapes.
  acceptedVideoMimeTypes: [] as readonly string[],
}

/**
 * Replaces tldraw's 'files' handler: images keep the native image-shape path (through our
 * TLAssetStore), everything else is uploaded to the dev route and becomes a dr-file-card. Text, URL,
 * tldraw and excalidraw pastes keep their default handlers because only 'files' is replaced.
 *
 * Rendered as a child of <Tldraw> so it can reach the UI toasts/translations the default handler
 * needs. Its effect runs after <Tldraw> registers the defaults (those run in a layout effect).
 */
export function ExternalContentHandlers() {
  const editor = useEditor()
  const board = useBoard()
  const toasts = useToasts()
  const msg = useTranslation()
  // Read at call time: `msg` changes identity when translations finish loading, and re-running the
  // effect for that would abort uploads that are still in flight.
  const ui = useRef({ toasts, msg })
  ui.current = { toasts, msg }

  useEffect(() => {
    if (!board) return
    const controller = new AbortController()
    const defaults = (): TLDefaultExternalContentHandlerOpts => ({ ...IMAGE_HANDLER_LIMITS, ...ui.current })
    editor.registerExternalContentHandler('files', async ({ files, point }) => {
      const { images, cards, rejected } = partitionFiles(files)
      for (const r of rejected) {
        board.notify({ key: `reject:${r.file.name}`, text: `${r.file.name} ${r.reason}.`, tone: 'error' })
      }
      const at = point ?? editor.getViewportPageBounds().center
      // Card uploads start immediately; the card row is placed once this drop's images exist, just
      // below them (the default handler selects the images it creates), so nothing overlaps.
      const rowCenter: Promise<VecLike> = images.length
        ? defaultHandleExternalFileContent(editor, { point: at, files: images }, defaults()).then(
            () => {
              const b = editor.getSelectionPageBounds()
              return b ? { x: b.center.x, y: b.maxY + CARD_GAP * 2 + rowHeight(cards) / 2 } : at
            },
            () => at,
          )
        : Promise.resolve(at)
      await uploadFileCards(editor, board, cards, rowCenter, controller.signal)
    })
    return () => {
      controller.abort()
      editor.registerExternalContentHandler('files', (content) =>
        defaultHandleExternalFileContent(editor, content, defaults()),
      )
    }
  }, [editor, board])

  return null
}

const rowHeight = (files: CardFile[]) => Math.max(0, ...files.map((f) => CARD_SIZE[f.kind].h))

/** A row of card slots centered on `center`, tops aligned. */
function rowSlots(files: CardFile[], center: VecLike): VecLike[] {
  const totalW = files.reduce((s, f) => s + CARD_SIZE[f.kind].w, 0) + CARD_GAP * (files.length - 1)
  const top = center.y - rowHeight(files) / 2
  let x = center.x - totalW / 2
  return files.map((f) => {
    const slot = { x, y: top }
    x += CARD_SIZE[f.kind].w + CARD_GAP
    return slot
  })
}

async function uploadFileCards(
  editor: Editor,
  board: BoardContextValue,
  files: CardFile[],
  rowCenter: Promise<VecLike>,
  signal: AbortSignal,
) {
  if (!files.length) return
  // Each card appears in its slot as soon as its own upload finishes.
  const slots = rowCenter.then((c) => rowSlots(files, c))
  await Promise.all(
    files.map(async ({ file }, i) => {
      const key = `upload:${i}:${file.name}:${file.size}:${file.lastModified}`
      board.notify({ key, text: `Uploading ${file.name}…`, timeoutMs: null, testId: 'upload-toast' })
      try {
        const meta = await uploadFile({ boardId: board.boardId, devUser: board.userId, file, signal })
        const slot = (await slots)[i]
        if (signal.aborted || !slot) return
        if (editor.getIsReadonly()) throw new UploadError('READONLY', 'This board is read-only.', 403)
        const id = createFileCard(editor, meta, slot)
        board.dismiss(key)
        if (id) watchCardHints(editor, board.metaStore, board.boardId, id, meta, signal)
      } catch (e) {
        if (signal.aborted) return
        const reason = e instanceof UploadError ? e.message : 'Upload failed.'
        board.notify({ key, text: `${file.name}: ${reason}`, tone: 'error' })
      }
    }),
  )
}

function createFileCard(editor: Editor, meta: AssetVersionMeta, at: VecLike): TLShapeId | null {
  const id = createShapeId()
  const size = CARD_SIZE[meta.kind]
  editor.createShape({
    id,
    type: FILE_CARD_TYPE,
    x: at.x,
    y: at.y,
    props: {
      w: size.w,
      h: size.h,
      assetId: meta.assetId,
      versionId: meta.versionId,
      kind: meta.kind,
      name: meta.name,
      mimeType: meta.mimeType || meta.declaredMimeType || 'application/octet-stream',
      sizeBytes: Math.max(0, Math.round(meta.sizeBytes)),
      ...hintPropsFromMeta(meta),
    },
  })
  return editor.getShape(id) ? id : null
}

/**
 * Uploading tab only: mirror server meta into the card's hint props until the version is terminal,
 * so a stale or offline reader still sees roughly the right state. Written with history 'ignore' so
 * the user's undo stack only contains their own actions.
 */
function watchCardHints(
  editor: Editor,
  metaStore: AssetMetaStore,
  boardId: string,
  shapeId: TLShapeId,
  initial: AssetVersionMeta,
  signal: AbortSignal,
) {
  watchMeta(metaStore, boardId, initial.assetId, initial.versionId, signal, ({ meta }) => {
    const shape = editor.getShape(shapeId)
    if (!shape || shape.type !== FILE_CARD_TYPE) return true
    if (!meta) return false
    const patch = changedHints(shape.props, hintPropsFromMeta(meta))
    if (patch) {
      editor.run(() => editor.updateShape({ id: shapeId, type: FILE_CARD_TYPE, props: patch }), {
        history: 'ignore',
      })
    }
    return false
  })
}

/**
 * Uploading tab only, for native image shapes: once derivatives exist, touch the asset record so every
 * tab re-runs TLAssetStore.resolve() and swaps the original for a sized derivative.
 */
export function watchImagePreview(
  editor: Editor,
  metaStore: AssetMetaStore,
  boardId: string,
  assetRecordId: TLAssetId,
  meta: AssetVersionMeta,
  signal: AbortSignal,
) {
  watchMeta(metaStore, boardId, meta.assetId, meta.versionId, signal, (snap) => {
    const status = snap.missing ? 'failed' : snap.meta?.status
    if (status !== 'ready' && status !== 'failed') return false
    const asset = editor.getAsset(assetRecordId)
    // The default handler writes src right after upload() resolves; if it has not landed yet there
    // is nothing to re-resolve, and the next render resolves against the (already cached) meta.
    if (!asset || asset.meta.previewStatus === status) return true
    editor.run(
      () =>
        editor.updateAssets([
          { id: asset.id, type: asset.type, meta: { ...asset.meta, previewStatus: status } },
        ]),
      { history: 'ignore' },
    )
    return true
  })
}
