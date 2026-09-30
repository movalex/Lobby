/**
 * Paste and drop on the Excalidraw board page (docs/EXCALIDRAW-CONTRACTS.md §3 `contentHandlers`;
 * tldraw's registerExternalContentHandler / putExternalContent): what arrived becomes an
 * `ExternalContent` (files, a URL, or text with its HTML), and the handlers features register run by
 * priority, highest first, until one takes it. Excalidraw's own clipboard (elements copied on a board) is
 * never content: Excalidraw pastes it, through Lobby's onDuplicate rules.
 *
 * Pure (Node-tested): the DOM transfer objects are read through narrow shapes.
 */
import type { CanvasFeatureContext } from '../api/feature.ts'
import type { ScenePoint } from '../api/lobby-canvas.ts'
import type { ContentHandlerSpec, ExternalContent } from '../api/registries.ts'

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
