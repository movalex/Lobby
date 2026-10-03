// OWNER: 3g (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'media' feature on the Excalidraw board page:
// file cards and image placeholders (./CardLayer.tsx), the PDF page viewer and "Place on board"
// (./PdfViewer.tsx, ./place-pages.ts), paste, drop and "Insert file" (./insert.ts: upload, then place),
// opening a card's original on double-click, "Download original" (./downloads.ts), Replace media, Crop and
// Alternative text (./edit-media.tsx, W5-13), the uploading tab's local previews (./local-previews.ts,
// W5-56) and link cards for pasted URLs (./link-cards.tsx, D2). The canvas side is
// canvas/api/parts/files.ts (files.urlOf, files.insert, files.crop, the upload tracker, the derivative swap).
//
// Plan: docs/EXCALIDRAW-MIGRATION.md §2.10, §4.1; what differs from the tldraw page:
// docs/research/excalidraw/wave3/3G.md.

import { provideInserter } from '../../assets/board-media.ts'
import type { CanvasFeature, CanvasFeatureContext, SelectionBarItemSpec } from '../../canvas/api/index.ts'
import { knownUserKind } from '../../invite/guest.tsx'
import { MediaSceneLayer } from './CardLayer.tsx'
import { downloadOriginals, openOriginal, selectedDownloads, syncExportPolicy } from './downloads.ts'
import {
  AltTextHost,
  canEditPicture,
  canReplace,
  editMenu,
  editSelectionBar,
  startAltText,
  startCrop,
  startReplace,
} from './edit-media.tsx'
import { GifPlayChips, GifPlayerHost, isGifElement, openGifPlayer } from './gif-player.tsx'
import { insertFiles } from './insert.ts'
import { linkContentHandler } from './link-cards.tsx'
import { disposeLocalPreviews } from './local-previews.ts'
import { fileItemKind } from './model.ts'
import { PdfViewerHost } from './PdfViewer.tsx'

const guestOf = (ctx: CanvasFeatureContext): boolean | null => {
  const k = knownUserKind(ctx.me.user.id)
  return k === null ? null : k === 'guest'
}

/** "Insert file" (Ctrl/Cmd+U): any file (PDFs, attachments), not only images and videos. */
function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])), { once: true })
    input.addEventListener('cancel', () => resolve([]), { once: true })
    input.click()
  })
}

function insertFromPicker(ctx: CanvasFeatureContext): void {
  if (ctx.canvas.readOnly()) {
    ctx.notify({ key: 'readonly-upload', text: 'You can view this board but not add files to it.' })
    return
  }
  void pickFiles().then((files) => {
    if (files.length) void insertFiles(ctx, files, null, 'insert')
  })
}

/** "Download original" in the selection bar, for images, placed pages and cards (tldraw's image toolbar). */
const downloadButton: SelectionBarItemSpec = {
  id: 'media.download-original',
  order: 80,
  visible: (ctx, selection) => selectedDownloads(ctx, selection).length > 0,
  component: ({ ctx }) => (
    <button
      type="button"
      className="dr-iconbtn"
      data-testid="media-download-original"
      aria-label="Download original"
      title="Download original"
      onClick={() => downloadOriginals(ctx, guestOf(ctx))}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path
          d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  ),
}

export const feature: CanvasFeature = {
  id: 'media',
  commands: [
    {
      id: 'media.insert-file',
      label: 'Insert file',
      kbd: ['mod+u'],
      scope: 'canvas',
      // a read-only person hears why nothing happens (and the browser does not open "view source")
      readOnlyAllowed: true,
      run: (ctx) => insertFromPicker(ctx),
    },
    {
      id: 'media.download-original',
      label: 'Download original',
      readOnlyAllowed: true,
      enabled: (ctx) => selectedDownloads(ctx).length > 0,
      run: (ctx) => downloadOriginals(ctx, guestOf(ctx)),
    },
    {
      id: 'media.replace',
      label: 'Replace media',
      enabled: (ctx) => !!canReplace(ctx, ctx.canvas.selection),
      run: (ctx) => startReplace(ctx),
    },
    {
      id: 'media.crop',
      label: 'Crop',
      enabled: (ctx) => !!canEditPicture(ctx, ctx.canvas.selection) && !!ctx.canvas.files.crop,
      run: (ctx) => void startCrop(ctx),
    },
    {
      id: 'media.alt-text',
      label: 'Alternative text',
      enabled: (ctx) => !!canEditPicture(ctx, ctx.canvas.selection),
      run: (ctx) => startAltText(ctx),
    },
  ],
  contextMenu: [
    {
      id: 'media.download-original',
      group: 'export',
      order: 50,
      label: 'Download original',
      command: 'media.download-original',
      visible: (ctx, target) => selectedDownloads(ctx, target.ids).length > 0,
    },
    ...editMenu,
  ],
  selectionBar: [...editSelectionBar, downloadButton],
  contentHandlers: [
    {
      id: 'media.files',
      kinds: ['files'],
      priority: 100,
      handle(content, ctx, at, source) {
        if (content.kind !== 'files') return false
        // the uploads run on; paste and drop return at once
        void insertFiles(ctx, content.files, at, source)
        return true
      },
    },
    // D2: a lone pasted (or dropped) URL becomes a link card
    linkContentHandler,
  ],
  overlays: [
    { id: 'media.faces', layer: 'scene', order: 10, pointer: 'none', component: MediaSceneLayer },
    { id: 'media.gif-chips', layer: 'scene', order: 11, pointer: 'none', component: GifPlayChips },
    { id: 'media.viewer', layer: 'screen', order: 95, pointer: 'none', component: PdfViewerHost },
    { id: 'media.gif-player', layer: 'screen', order: 95, pointer: 'none', component: GifPlayerHost },
    { id: 'media.alt-text', layer: 'screen', order: 96, pointer: 'none', component: AltTextHost },
  ],
  onMount(ctx) {
    const offs = [
      syncExportPolicy(ctx),
      provideInserter(ctx.registries, (files, at) => insertFiles(ctx, files, at ?? null, 'insert')),
      // F7a: a double-click on a card opens its original in a new tab (never Excalidraw's image
      // cropping, never a new text), for every role
      ctx.canvas.on('input', (e) => {
        if (e.type !== 'double-click' || !e.hit || fileItemKind(e.hit) !== 'card') return
        e.handled()
        openOriginal(ctx, e.hit.id, guestOf(ctx))
      }),
      // F9: a double-click on a GIF plays it in the player (never Excalidraw's image cropping: Crop is in
      // the selection bar), for every role
      ctx.canvas.on('input', (e) => {
        if (e.type !== 'double-click' || e.button !== 0 || !isGifElement(e.hit)) return
        e.handled()
        openGifPlayer(ctx, e.hit.id)
      }),
    ]
    return () => {
      for (const off of offs.reverse()) off()
      disposeLocalPreviews(ctx.registries)
    }
  },
}
