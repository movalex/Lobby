// OWNER: 3g. W5-13: Replace media, Crop and Alternative text for images and files on the Excalidraw canvas
// (tldraw's image toolbar: "Replace media", "Crop", "Alternative text"). The client-review loop: key art
// v1 becomes v2 and keeps its element, so its comment thread, tags, position, frame and template slot
// stay with it.
//
//   - Replace: the new file is uploaded like a drop (tracked: Saved waits for it), then ONE write (one
//     undo step) points the same element at the new version (`fileId` and `customData.lobby.file`; the
//     server re-checks the version against the board's workspace). An image stays an image (a cropped
//     one, a template slot's photo, is cropped again to the same box); a card takes any other file. The
//     uploading tab shows the new picture at once (local-previews.ts).
//   - Crop: Excalidraw's own crop editor (its corner handles; Escape, Enter or a click elsewhere ends it:
//     the key allowlist lets Enter through while a crop is open, CR-W5-3G-4),
//     opened through `files.crop` (CR-W5-3G-1), which first puts the image back on its thumb: a crop is
//     written in the pixels of the thumb every tab loads, and a cropped image never switches to the
//     2,048 px rendering (canvas/api/parts/files.ts).
//   - Wave S (WS2, the versions switch): the upload sends X-Lobby-Supersedes with the deliverable's newest version
//     (the version list's, else the element's), so the new file is a new VERSION of the same asset: the write is the
//     same one, and `customData.lobby.file.assetId` stays. The entry reads "Upload new version". A newer version
//     uploaded meanwhile: the upload goes on top of it (once); a chain that moved on on another board, a version only
//     linked here (a copy: only the board a chain's newest version was uploaded to continues it), or a version this
//     board no longer serves: a fresh asset, as before wave S (that card's history starts again at v1).
//     "Make current" (the version list) is the same write to an older version: no upload, no new version.
//   - Alternative text: `customData.lobby.alt` (≤ 500 characters, canvas-schema custom-data.ts), one undo
//     step; board search and the PDF text layer read it.
//
// Everything checks the role and the lock first (the server refuses a viewer's or a locked write anyway).
import { MAX_ALT_CHARS } from '@draftroom/canvas-schema/limits'
import { type FormEvent, useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { trackBoardUpload } from '../../assets/board-media.ts'
import {
  type AssetKind,
  type AssetVersionMeta,
  classifyUpload,
  maxUploadBytes,
} from '../../assets/contract.ts'
import { coverSlot, type Rect } from '../../assets/drop-layout.ts'
import { UploadError, uploadFile } from '../../assets/upload.ts'
import type {
  CanvasElement,
  CanvasFeatureContext,
  FeatureRegistries,
  MenuEntrySpec,
  SelectionBarItemSpec,
} from '../../canvas/api/index.ts'
import { reviewFlags } from '../../features/review/flags.ts'
import { supersedesHeader } from '../../features/review-viewer/versions/client.ts'
import { versionStoreOf } from '../../features/review-viewer/versions/store.ts'
import { formatBytes } from '../../lib/format.ts'
import { type Atom, atom, useValue } from '../../lib/signals.ts'
import { Dialog } from '../../ui/Dialog.tsx'
import { CARD_SIZE } from '../card-model.ts'
import { factsFromMeta, nativeSize } from './insert.ts'
import { localPreviewsOf } from './local-previews.ts'
import {
  CARD_ROUNDNESS,
  excalidrawCrop,
  type FileFacts,
  factsOf,
  fileItemKind,
  type PixelSize,
} from './model.ts'

// ---- what can be edited -----------------------------------------------------------------------------------

/** The one selected element, when it is a file element (an image, a placed page or a card). */
export function onlyFileElement(ctx: CanvasFeatureContext, ids: readonly string[]): CanvasElement | null {
  if (ids.length !== 1) return null
  const el = ctx.canvas.get(ids[0] as string)
  if (!el || el.isDeleted || !fileItemKind(el)) return null
  return el
}

const writable = (ctx: CanvasFeatureContext, el: CanvasElement) =>
  !ctx.canvas.readOnly() && !ctx.canvas.isLocked(el.id)

/** Replace: an image or a card (a placed PDF page is a rendering of its card's file, not a file). */
export function canReplace(ctx: CanvasFeatureContext, ids: readonly string[]): CanvasElement | null {
  const el = onlyFileElement(ctx, ids)
  const kind = el ? fileItemKind(el) : null
  return el && (kind === 'image' || kind === 'card') && writable(ctx, el) ? el : null
}

/** Crop and alternative text: a picture (an image or a placed page), not a card. */
export function canEditPicture(ctx: CanvasFeatureContext, ids: readonly string[]): CanvasElement | null {
  const el = onlyFileElement(ctx, ids)
  const kind = el ? fileItemKind(el) : null
  return el && (kind === 'image' || kind === 'page') && writable(ctx, el) ? el : null
}

// ---- Replace media ---------------------------------------------------------------------------------------

export interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface ReplacedGeometry {
  readonly box: Box
  /** Excalidraw's crop (in the new thumb's pixels), or null for none */
  readonly crop: ReturnType<typeof excalidrawCrop> | null
}

/**
 * Where the new file goes:
 *   - a cropped image (a template slot's photo, a crop someone made) keeps its box exactly and the new
 *     picture is centre-cropped to it;
 *   - another image keeps its centre and its longer side, with the new picture's proportions;
 *   - a card of the same kind keeps its box; a card of another kind takes that kind's card shape, at
 *     the same width, from the same top-left corner.
 */
export function replacedGeometry(
  old: Box & { readonly cropped: boolean; readonly kind: AssetKind },
  next: { readonly kind: AssetKind; readonly size: PixelSize | null },
): ReplacedGeometry {
  if (next.kind === 'image' && old.kind === 'image') {
    const size = next.size ?? { w: old.w, h: old.h }
    if (old.cropped) {
      const { rect, crop } = coverSlot(size, old as Rect)
      return { box: rect, crop: crop ? excalidrawCrop(crop, size) : null }
    }
    const long = Math.max(old.w, old.h)
    const w = size.w >= size.h ? long : (long * size.w) / size.h
    const h = size.w >= size.h ? (long * size.h) / size.w : long
    return { box: { x: old.x + old.w / 2 - w / 2, y: old.y + old.h / 2 - h / 2, w, h }, crop: null }
  }
  if (next.kind === old.kind) return { box: { x: old.x, y: old.y, w: old.w, h: old.h }, crop: null }
  const card = CARD_SIZE[next.kind]
  return { box: { x: old.x, y: old.y, w: old.w, h: (old.w * card.h) / card.w }, crop: null }
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Why `file` cannot replace `facts` (null: it can). Checked before any byte is sent. */
export function replaceRefusal(facts: FileFacts, file: File): string | null {
  const kind = classifyUpload(file.type, file.name)
  if (facts.kind === 'image' && kind !== 'image') return 'Pick an image to replace this image.'
  if (facts.kind !== 'image' && kind === 'image')
    return 'Pick a file that is not an image to replace this file (images replace images).'
  const limit = maxUploadBytes(kind, file.type, file.name)
  if (file.size > limit)
    return `${file.name} is larger than the ${formatBytes(limit)} limit for this file type.`
  return null
}

const reasonOf = (e: unknown) => (e instanceof UploadError ? e.message : 'Upload failed.')

let replaceSeq = 0

/**
 * Uploads `file` and points element `id` at it (one undo step). Resolves true once the element shows
 * the new version; false (with a notice) when it could not.
 */
export async function replaceMedia(ctx: CanvasFeatureContext, id: string, file: File): Promise<boolean> {
  const canvas = ctx.canvas
  const el = canvas.get(id)
  const facts = el ? factsOf(el) : null
  if (!el || el.isDeleted || !facts) return false
  if (canvas.readOnly()) {
    ctx.notify({ key: 'readonly-upload', text: 'You can view this board but not add files to it.' })
    return false
  }
  if (canvas.isLocked(id)) {
    ctx.notify({ key: 'media-replace-locked', text: 'Unlock it first to replace it.', tone: 'error' })
    return false
  }
  const refusal = replaceRefusal(facts, file)
  if (refusal) {
    ctx.notify({ key: 'media-replace-refused', text: refusal, tone: 'error' })
    return false
  }
  const seq = ++replaceSeq
  const key = `media-replace:${seq}`
  const kind = classifyUpload(file.type, file.name)
  const size = kind === 'image' ? await nativeSize(file) : null
  const previews = localPreviewsOf(ctx.registries)
  const preview = size ? previews.make(file, size) : null
  const asVersion = reviewFlags().versions
  ctx.notify({
    key,
    text: asVersion
      ? `Uploading ${file.name} as a new version of ${facts.name || 'file'}…`
      : `Replacing ${facts.name || 'file'} with ${file.name}…`,
    timeoutMs: null,
  })
  const send = (supersedes: string | null) =>
    trackBoardUpload(
      ctx.registries,
      uploadFile({
        boardId: ctx.board.id,
        file,
        ...(supersedes ? { headers: supersedesHeader(supersedes) } : {}),
      }),
    )
  let meta: AssetVersionMeta
  try {
    meta = asVersion ? await uploadVersion(ctx, facts, send) : await send(null)
  } catch (e) {
    ctx.dismiss(key)
    if (preview) previews.drop(preview)
    ctx.notify({ key: `${key}:failed`, text: `${file.name}: ${reasonOf(e)}`, tone: 'error' })
    return false
  }
  ctx.dismiss(key)
  if (preview) {
    previews.keep(meta.versionId, preview)
    previews.drop(preview)
  }
  // this tab's chip at once (the board event tells the other tabs)
  if (asVersion) void versionStoreOf(ctx).refresh(meta.assetId)
  // as it is now: someone may have moved, locked or deleted it while the file was uploading
  const now = canvas.get(id)
  if (!now || now.isDeleted || canvas.readOnly() || canvas.isLocked(id)) {
    ctx.notify({
      key: `${key}:gone`,
      text:
        now && !now.isDeleted
          ? 'It was locked meanwhile: nothing was replaced.'
          : 'It was deleted meanwhile.',
      tone: 'error',
    })
    return false
  }
  pointAtVersion(ctx, now, facts.kind, meta, size, asVersion ? 'Upload new version' : 'Replace media')
  return true
}

/**
 * The one write of Replace media, "Upload new version" and "Make current": element `el` (showing a file of kind
 * `was`) shows `meta`'s version, in the box replacedGeometry gives it. One undo step named `label`.
 */
export function pointAtVersion(
  ctx: CanvasFeatureContext,
  el: CanvasElement,
  was: AssetKind,
  meta: AssetVersionMeta,
  size: PixelSize | null,
  label: string,
): void {
  const id = el.id
  const geometry = replacedGeometry(
    {
      x: el.x,
      y: el.y,
      w: el.width,
      h: el.height,
      cropped: !!(el as { crop?: unknown }).crop,
      kind: was,
    },
    { kind: meta.kind, size },
  )
  const { box } = geometry
  ctx.canvas.transact(label, (tx) =>
    tx.update(id, {
      fileId: meta.versionId,
      x: round2(box.x),
      y: round2(box.y),
      width: Math.max(1, round2(box.w)),
      height: Math.max(1, round2(box.h)),
      crop: geometry.crop,
      ...(meta.kind !== 'image' ? { roundness: CARD_ROUNDNESS } : {}),
      // every other lobby key (alt text, tags, slot, present) stays: the element is the same thing
      customData: { lobby: { file: factsFromMeta(meta) } },
    }),
  )
}

/** The code of the api's refusal of a superseded version that is not the newest (contracts asset-versions.ts). */
const NOT_LATEST = 'VERSION_NOT_LATEST'

/**
 * Wave S: the upload as a new version of `facts`' deliverable. It supersedes the newest version the board serves (the
 * version list's; else the element's own). A newer one uploaded meanwhile (409 with another latestVersionId): once on
 * top of that one. The chain moved on on another board, or its newest version was uploaded to another board and is
 * only linked here (409 naming the same version: only the origin board continues a chain), or the version is not one
 * this board serves (404): a fresh asset, and the person is told the history starts again (a review item on the card
 * then reads "File replaced: review again").
 */
export async function uploadVersion(
  ctx: Pick<CanvasFeatureContext, 'registries' | 'board' | 'events' | 'notify'>,
  facts: FileFacts,
  send: (supersedes: string | null) => Promise<AssetVersionMeta>,
): Promise<AssetVersionMeta> {
  const list = await versionStoreOf(ctx).whenLoaded(facts.assetId)
  const first = list?.latestVersionId ?? facts.versionId
  const fresh = async () => {
    const meta = await send(null)
    ctx.notify({
      key: `media-version-fresh:${meta.versionId}`,
      text: 'This file’s versions are kept on another board, so this upload starts its own version history here.',
    })
    return meta
  }
  try {
    return await send(first)
  } catch (e) {
    if (!(e instanceof UploadError)) throw e
    if (e.status === 404) return fresh()
    if (e.code !== NOT_LATEST) throw e
    const latest = typeof e.details.latestVersionId === 'string' ? e.details.latestVersionId : null
    if (!latest || latest === first) return fresh()
    try {
      return await send(latest)
    } catch (again) {
      if (again instanceof UploadError && (again.status === 404 || again.code === NOT_LATEST)) return fresh()
      throw again
    }
  }
}

/** "Replace media": a file picker, then `replaceMedia`. */
function pickOne(accept: string | null): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (accept) input.accept = accept
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true })
    input.addEventListener('cancel', () => resolve(null), { once: true })
    input.click()
  })
}

export function startReplace(ctx: CanvasFeatureContext, ids: readonly string[] = ctx.canvas.selection): void {
  const el = canReplace(ctx, ids)
  const facts = el ? factsOf(el) : null
  if (!el || !facts) return
  void pickOne(facts.kind === 'image' ? 'image/*' : null).then((file) => {
    if (file) void replaceMedia(ctx, el.id, file)
  })
}

// ---- Crop ----------------------------------------------------------------------------------------------

export function startCrop(ctx: CanvasFeatureContext, ids: readonly string[] = ctx.canvas.selection): boolean {
  const el = canEditPicture(ctx, ids)
  if (!el) return false
  const started = ctx.canvas.files.crop?.(el.id) ?? false
  if (started) {
    // the keyboard goes back to the board (Escape ends the crop there), not the button that was pressed
    ctx.canvas.focus()
    ctx.notify({
      key: 'media-crop',
      text: 'Drag the corners to crop. Press Enter or Escape, or click outside the image, when done.',
      testId: 'media-crop-hint',
    })
  }
  return started
}

// ---- Alternative text ---------------------------------------------------------------------------------------

const altRequests = new WeakMap<FeatureRegistries, Atom<{ id: string; nonce: number } | null>>()
let altNonce = 0
function altRequest(registries: FeatureRegistries) {
  let a = altRequests.get(registries)
  if (!a) {
    a = atom<{ id: string; nonce: number } | null>('media-alt-text', null)
    altRequests.set(registries, a)
  }
  return a
}

export function startAltText(ctx: CanvasFeatureContext, ids: readonly string[] = ctx.canvas.selection): void {
  const el = canEditPicture(ctx, ids)
  if (el) altRequest(ctx.registries).set({ id: el.id, nonce: ++altNonce })
}

export const altOf = (el: CanvasElement | undefined): string => {
  const alt = (el?.customData as { lobby?: { alt?: unknown } } | undefined)?.lobby?.alt
  return typeof alt === 'string' ? alt : ''
}

/** Writes the alternative text (an empty one removes the key); false when nothing was written. */
export function setAltText(ctx: CanvasFeatureContext, id: string, text: string): boolean {
  const el = ctx.canvas.get(id)
  if (!el || el.isDeleted || ctx.canvas.readOnly() || ctx.canvas.isLocked(id)) return false
  const alt = text.replace(/\s+/g, ' ').trim().slice(0, MAX_ALT_CHARS)
  if (alt === altOf(el)) return false
  ctx.canvas.transact('Alternative text', (tx) =>
    tx.update(id, { customData: { lobby: { alt: alt || null } } }),
  )
  return true
}

/** The Alternative text dialog (a screen overlay of the media feature). */
export function AltTextHost({ ctx }: { ctx: CanvasFeatureContext }) {
  const request = useValue(altRequest(ctx.registries))
  const target = useValue('media-alt-text-target', () => {
    if (!request) return null
    const el = ctx.canvas.get(request.id)
    return el && !el.isDeleted ? el : null
  }, [ctx, request])
  useEffect(() => {
    if (request && !target) altRequest(ctx.registries).set(null)
  }, [ctx, request, target])
  if (!request || !target) return null
  // Portalled to <body>, like the PDF viewer: outside the board's key allowlist (Enter must reach the
  // field) and the overlay root's pointer rules
  return createPortal(
    <AltTextDialog
      key={request.nonce}
      ctx={ctx}
      id={target.id}
      initial={altOf(target)}
      name={factsOf(target)?.name ?? ''}
      onClose={() => {
        altRequest(ctx.registries).set(null)
        // once the modal is gone (the board is inert while it is open): the keyboard goes back to the board
        requestAnimationFrame(() => ctx.canvas.focus())
      }}
    />,
    document.body,
  )
}

function AltTextDialog({
  ctx,
  id,
  initial,
  name,
  onClose,
}: {
  ctx: CanvasFeatureContext
  id: string
  initial: string
  name: string
  onClose(): void
}) {
  const [text, setText] = useState(initial)
  const field = useId()
  const save = (e?: FormEvent) => {
    e?.preventDefault()
    setAltText(ctx, id, text)
    onClose()
  }
  return (
    <Dialog
      title="Alternative text"
      description={
        name
          ? `Describe ${name} for people who can’t see it. Search and exports use it too.`
          : 'Describe the image for people who can’t see it. Search and exports use it too.'
      }
      onClose={onClose}
      testId="media-alt-text"
    >
      <form className="dr-form" onSubmit={save}>
        <label htmlFor={field}>Description</label>
        <textarea
          id={field}
          className="dr-input dr-input--block"
          data-testid="media-alt-text-input"
          rows={3}
          maxLength={MAX_ALT_CHARS}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter saves (the text is one line). Prevented: otherwise its keypress reaches the button the
            // focus returns to once the dialog has closed ("Alternative text"), which opens it again.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              save()
            }
          }}
        />
        <p className="dr-muted">
          {text.length} / {MAX_ALT_CHARS}
        </p>
        <div className="dr-dialog__actions">
          <button type="button" className="dr-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="dr-btn dr-btn--primary" data-testid="media-alt-text-save">
            Save
          </button>
        </div>
      </form>
    </Dialog>
  )
}

// ---- the selection bar and the context menu ------------------------------------------------------------------

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path
      d={d}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
const REPLACE_ICON =
  'M4 12a8 8 0 0 1 13.7-5.6L20 8.7M20 4v4.7h-4.7M20 12a8 8 0 0 1-13.7 5.6L4 15.3M4 20v-4.7h4.7'
const CROP_ICON = 'M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14'

/** Wave S: with the versions switch on, Replace media is "Upload new version" (the same command and write). */
const asVersions = () => reviewFlags().versions

export const editSelectionBar: readonly SelectionBarItemSpec[] = [
  {
    id: 'media.replace',
    order: 76,
    visible: (ctx, selection) => !asVersions() && !!canReplace(ctx, selection),
    component: ({ ctx, selection }) => (
      <button
        type="button"
        className="dr-iconbtn"
        data-testid="media-replace"
        aria-label="Replace media"
        title="Replace media"
        onClick={() => startReplace(ctx, selection)}
      >
        <Icon d={REPLACE_ICON} />
      </button>
    ),
  },
  {
    id: 'media.new-version',
    order: 76,
    visible: (ctx, selection) => asVersions() && !!canReplace(ctx, selection),
    component: ({ ctx, selection }) => (
      <button
        type="button"
        className="dr-iconbtn"
        data-testid="media-new-version"
        aria-label="Upload new version"
        title="Upload new version"
        onClick={() => startReplace(ctx, selection)}
      >
        <Icon d={REPLACE_ICON} />
      </button>
    ),
  },
  {
    id: 'media.crop',
    order: 77,
    visible: (ctx, selection) => !!canEditPicture(ctx, selection) && !!ctx.canvas.files.crop,
    component: ({ ctx, selection }) => (
      <button
        type="button"
        className="dr-iconbtn"
        data-testid="media-crop"
        aria-label="Crop"
        title="Crop"
        onClick={() => startCrop(ctx, selection)}
      >
        <Icon d={CROP_ICON} />
      </button>
    ),
  },
  {
    id: 'media.alt-text',
    order: 78,
    visible: (ctx, selection) => !!canEditPicture(ctx, selection),
    component: ({ ctx, selection }) => (
      <button
        type="button"
        className="dr-iconbtn dr-media-alt"
        data-testid="media-alt-text-open"
        aria-label="Alternative text"
        title="Alternative text"
        onClick={() => startAltText(ctx, selection)}
      >
        <span aria-hidden="true">ALT</span>
      </button>
    ),
  },
]

export const editMenu: readonly MenuEntrySpec[] = [
  {
    id: 'media.replace',
    group: 'edit',
    order: 80,
    // wave S: with the versions switch on, the same command reads "Upload new version"
    label: () => (asVersions() ? 'Upload new version' : 'Replace media'),
    command: 'media.replace',
    visible: (ctx, target) => !!canReplace(ctx, target.ids),
  },
  {
    id: 'media.crop',
    group: 'edit',
    order: 81,
    label: 'Crop',
    command: 'media.crop',
    visible: (ctx, target) => !!canEditPicture(ctx, target.ids) && !!ctx.canvas.files.crop,
  },
  {
    id: 'media.alt-text',
    group: 'edit',
    order: 82,
    label: 'Alternative text…',
    command: 'media.alt-text',
    visible: (ctx, target) => !!canEditPicture(ctx, target.ids),
  },
]
