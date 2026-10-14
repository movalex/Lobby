/**
 * Paste and drop on the Excalidraw board page (docs/EXCALIDRAW-CONTRACTS.md §3 `contentHandlers`;
 * tldraw's registerExternalContentHandler / putExternalContent): what arrived becomes an
 * `ExternalContent` (files, a URL, or text with its HTML), and the handlers features register run by
 * priority, highest first, until one takes it. Excalidraw's own clipboard (elements copied on a board) is
 * never content: Excalidraw pastes it, through Lobby's onDuplicate rules, once the files this board cannot
 * show are taken out of it (CRIT-38, `filesBoardCannotShow` below).
 *
 * Pure (Node-tested): the DOM transfer objects are read through narrow shapes.
 */
import { isId } from '@draftroom/dev-assets/shared'
import type { CanvasFeatureContext } from '../api/feature.ts'
import type { ScenePoint } from '../api/lobby-canvas.ts'
import type { ContentHandlerSpec, ExternalContent } from '../api/registries.ts'
import { parseFileKey } from '../files/loader.ts'

/** The parts of a DataTransfer (a drop, a clipboard) Lobby reads. */
export interface TransferLike {
  readonly files?: ArrayLike<File> | null
  getData?(type: string): string
}

const URL_RE = /^https?:\/\/\S+$/i

/** Files if any, else a lone http(s) URL, else text (with its HTML); null for nothing usable. */
export function contentOf(t: TransferLike | null | undefined): ExternalContent | null {
  if (!t) return null
  const files = t.files ? Array.from(t.files) : []
  if (files.length) return { kind: 'files', files }
  const text = (t.getData?.('text/plain') ?? '').trim()
  const uri = (t.getData?.('text/uri-list') ?? '').split(/\r?\n/).find((l) => l && !l.startsWith('#'))
  if (!text && uri && URL_RE.test(uri)) return { kind: 'url', url: uri }
  if (!text) return null
  if (URL_RE.test(text)) return { kind: 'url', url: text }
  const html = t.getData?.('text/html') ?? ''
  return html ? { kind: 'text', text, html } : { kind: 'text', text }
}

/** The handlers for `content`, highest priority first (ties keep registration order). */
export function handlersFor(
  handlers: readonly ContentHandlerSpec[],
  content: ExternalContent,
): ContentHandlerSpec[] {
  return handlers
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h.kinds.includes(content.kind))
    .sort((a, b) => b.h.priority - a.h.priority || a.i - b.i)
    .map(({ h }) => h)
}

/**
 * Runs the handlers until one returns true; resolves whether one took the content. A handler that throws
 * is logged and passed over.
 */
export async function dispatchContent(
  handlers: readonly ContentHandlerSpec[],
  content: ExternalContent,
  ctx: CanvasFeatureContext,
  at: ScenePoint | null,
  source: 'paste' | 'drop' | 'insert',
): Promise<boolean> {
  for (const h of handlersFor(handlers, content)) {
    try {
      if (await h.handle(content, ctx, at, source)) return true
    } catch (err) {
      console.error(`content handler ${h.id} failed`, err)
    }
  }
  return false
}

// ---- Excalidraw's own clipboard: files this board cannot show (CRIT-38) -------------------------------

/** The fields of an element in Excalidraw's own clipboard that the paste check reads and repairs. */
export interface ClipboardElement {
  readonly id: string
  readonly type: string
  readonly fileId?: string | null
  readonly customData?: { readonly lobby?: Readonly<Record<string, unknown>> } | null
  readonly boundElements?: readonly { readonly id: string; readonly type: string }[] | null
  readonly startBinding?: { readonly elementId: string } | null
  readonly endBinding?: { readonly elementId: string } | null
}

/** A pasted file element's version and asset (its `customData.lobby.file`). */
export interface PastedFile {
  readonly assetId: string
  readonly versionId: string
}

export interface PasteFileCheck {
  /** A version this board already shows (an element of its scene uses it): nothing to ask. */
  known(versionId: string): boolean
  /**
   * Whether this board may show the version: the api's meta route for this board (404 for a version
   * uploaded to another board, in this workspace or another, as the room's file-refs check answers).
   * null when that could not be learned (the network): the element is kept and the room decides.
   */
  servable(file: PastedFile): Promise<boolean | null>
}

/**
 * The ids of the pasted file elements (images, file cards, placed PDF pages: `image` elements) this board
 * cannot show (docs/EXCALIDRAW-MIGRATION.md §2.10.4 "Clipboard across boards"). The room refuses such an
 * element (file-refs: not on this board → INVALID), so pasted as is it ended in "Change not saved". They
 * are taken out of the paste before anything is created:
 *  - a `fileId` that is no Lobby version (another app's clipboard: its images are keyed by a hash);
 *  - a file whose facts (`customData.lobby.file`) are missing or name another version, unless this
 *    board already shows that version;
 *  - a version the board's meta route does not know (copied on another board).
 */
export async function filesBoardCannotShow(
  elements: readonly ClipboardElement[],
  check: PasteFileCheck,
): Promise<Set<string>> {
  const drop = new Set<string>()
  const asks = new Map<string, { file: PastedFile; ids: string[] }>()
  for (const el of elements) {
    if (el.type !== 'image') continue
    const key = typeof el.fileId === 'string' ? parseFileKey(el.fileId) : null
    if (!key) {
      drop.add(el.id)
      continue
    }
    if (check.known(key.versionId)) continue
    const facts = el.customData?.lobby?.file as { assetId?: unknown; versionId?: unknown } | undefined
    if (!isId('ast', facts?.assetId) || facts?.versionId !== key.versionId) {
      drop.add(el.id)
      continue
    }
    const k = `${facts.assetId}/${key.versionId}`
    const ask = asks.get(k) ?? { file: { assetId: facts.assetId, versionId: key.versionId }, ids: [] }
    ask.ids.push(el.id)
    asks.set(k, ask)
  }
  await Promise.all(
    [...asks.values()].map(async ({ file, ids }) => {
      let ok: boolean | null = null
      try {
        ok = await check.servable(file)
      } catch {
        ok = null
      }
      if (ok === false) for (const id of ids) drop.add(id)
    }),
  )
  return drop
}

/**
 * The paste without the elements in `drop`, and with every reference to them cleared: an arrow bound to a
 * dropped image is kept unbound, and no `boundElements` entry names a dropped element (the room refuses a
 * binding to an element that is not there).
 */
export function withoutElements<T extends ClipboardElement>(
  elements: readonly T[],
  drop: ReadonlySet<string>,
): T[] {
  if (!drop.size) return [...elements]
  const out: T[] = []
  for (const el of elements) {
    if (drop.has(el.id)) continue
    let next: T = el
    if (el.startBinding && drop.has(el.startBinding.elementId)) next = { ...next, startBinding: null }
    if (el.endBinding && drop.has(el.endBinding.elementId)) next = { ...next, endBinding: null }
    if (el.boundElements?.some((b) => drop.has(b.id))) {
      const bound = el.boundElements.filter((b) => !drop.has(b.id))
      next = { ...next, boundElements: bound.length ? bound : null }
    }
    out.push(next)
  }
  return out
}

/** The notice for `n` file elements left out of a paste (CRIT-38). */
export function filesLeftOutNotice(n: number): string {
  return n === 1
    ? 'One image or file was left out of the paste: images and files can’t be copied from another board. Upload it to this board instead.'
    : `${n} images or files were left out of the paste: images and files can’t be copied from another board. Upload them to this board instead.`
}

/**
 * What a drop on the canvas says when this person cannot add to the board (CRIT-38: the input layer
 * takes a read-only role's drop and did nothing, silently). The same words as Ctrl+U's for files.
 */
export function readOnlyDropNotice(kind: ExternalContent['kind'], archived: boolean): string {
  if (archived) return 'This board is archived, so nothing can be added to it.'
  return kind === 'files'
    ? 'You can view this board but not add files to it.'
    : 'You can view this board but not add to it.'
}
