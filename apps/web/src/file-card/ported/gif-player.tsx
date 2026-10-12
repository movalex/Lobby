// OWNER: 3g. F9 / FIL-08: animated GIFs get a player. The canvas keeps showing the worker's still (the
// plan's "poster plus a player": inline playback stays deferred, and exports never include an animation), so
// a GIF is played in a lightweight overlay on request: a play chip over each GIF on the board, or a
// double-click on it. The overlay loads the ORIGINAL file only then (`/files/<ast>/<ver>/original`, the one
// route the export policy guards), so a board of GIFs costs nothing until someone presses play.
//
//  - `isGifFacts`: which files are GIFs (an image file whose type is image/gif);
//  - GifPlayChips: a `scene`-layer overlay with one chip per GIF, at its bottom-left corner, never smaller
//    than a tap target on screen and left out when the picture is too small on screen to hold it;
//  - GifPlayerHost: the dialog (portalled to <body>, like the PDF viewer): the GIF, "Pause" / "Play" (paused
//    shows the still the canvas has; people who prefer reduced motion start paused), "Close". While the export
//    policy turns downloads off for this person, nothing opens and the policy says why (the api refuses the
//    original anyway).
import { type CSSProperties, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { originalUrl } from '../../assets/contract.ts'
import type { CanvasElement, CanvasFeatureContext, FeatureRegistries } from '../../canvas/api/index.ts'
import { knownUserKind } from '../../invite/guest.tsx'
import { type Atom, atom, useValue } from '../../lib/signals.ts'
import { Dialog } from '../../ui/Dialog.tsx'
import { downloadsAllowed, notifyDownloadsOff } from './downloads.ts'
import './media.css'
import { type FileFacts, factsOf, fileItemKind } from './model.ts'

/** A GIF: an image file (not a card, not a placed PDF page) whose type is image/gif. */
export const isGifFacts = (facts: Pick<FileFacts, 'kind' | 'mimeType'> | null): boolean =>
  !!facts && facts.kind === 'image' && facts.mimeType.toLowerCase() === 'image/gif'

/** The element is a GIF on the canvas. */
export function isGifElement(el: CanvasElement | null | undefined): el is CanvasElement {
  return !!el && !el.isDeleted && fileItemKind(el) === 'image' && isGifFacts(factsOf(el))
}

// ---- which GIF's player is open (local UI state, never synced) ---------------------------------------------

export interface GifPlayerRequest {
  readonly id: string
  /** changes on every open, so reopening the same GIF starts fresh */
  readonly nonce: number
}

const requests = new WeakMap<FeatureRegistries, Atom<GifPlayerRequest | null>>()
let nonce = 0

export function gifPlayerRequest(registries: FeatureRegistries): Atom<GifPlayerRequest | null> {
  let a = requests.get(registries)
  if (!a) {
    a = atom<GifPlayerRequest | null>('media-gif-player', null)
    requests.set(registries, a)
  }
  return a
}

/** Opens the player for a GIF element; false when it is not one. While downloads are off it only says so. */
export function openGifPlayer(ctx: CanvasFeatureContext, id: string): boolean {
  const el = ctx.canvas.get(id)
  if (!isGifElement(el)) return false
  const kind = knownUserKind(ctx.me.user.id)
  if (!downloadsAllowed(ctx, kind === null ? null : kind === 'guest')) {
    notifyDownloadsOff(ctx)
    return true
  }
  gifPlayerRequest(ctx.registries).set({ id, nonce: ++nonce })
  return true
}

export function closeGifPlayer(registries: FeatureRegistries): void {
  gifPlayerRequest(registries).set(null)
}

// ---- the chips on the canvas -----------------------------------------------------------------------------------

/** Chip box on screen (px), and the least a picture's screen size must be to hold it beside the corner. */
const CHIP_PX = 28
const MIN_PICTURE_PX = 56

interface Entry {
  readonly id: string
  readonly name: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly angle: number
}

const entriesOf = (canvas: CanvasFeatureContext['canvas']): Entry[] => {
  const out: Entry[] = []
  // wave N.1: the elements with a `customData.lobby.file`, from the scene index (no walk of the scene per change)
  for (const el of canvas.index.withLobbyKey('file')) {
    if (!isGifElement(el) || canvas.isHidden(el.id)) continue
    out.push({
      id: el.id,
      name: factsOf(el)?.name ?? '',
      x: el.x,
      y: el.y,
      w: Math.abs(el.width),
      h: Math.abs(el.height),
      angle: el.angle ?? 0,
    })
  }
  return out
}

/** The scene-layer overlay: a play chip at the bottom-left corner of every GIF big enough on screen to hold one. */
export function GifPlayChips({ ctx }: { ctx: CanvasFeatureContext }) {
  const canvas = ctx.canvas
  const entries = useValue('media-gifs', () => entriesOf(canvas), [canvas])
  const view = useValue('media-gifs-view', () => canvas.viewport.get(), [canvas])
  const zoom = view.zoom
  if (entries.length === 0) return null
  return (
    <>
      {entries.map((e) => {
        if (Math.min(e.w, e.h) * zoom < MIN_PICTURE_PX) return null
        // the picture's box on screen, rotated with it; the chip sits in its corner
        const c = canvas.sceneToOverlay({ x: e.x + e.w / 2, y: e.y + e.h / 2 })
        const style = {
          position: 'absolute',
          left: c.x - (e.w * zoom) / 2,
          top: c.y - (e.h * zoom) / 2,
          width: e.w * zoom,
          height: e.h * zoom,
          transform: e.angle ? `rotate(${e.angle}rad)` : undefined,
          transformOrigin: 'center',
          pointerEvents: 'none',
        } as CSSProperties
        return (
          <div key={e.id} className="lobby-gif-corner" style={style}>
            <button
              type="button"
              className="lobby-gif-chip"
              data-testid="gif-play"
              data-lobby-gif={e.id}
              aria-label={`Play ${e.name || 'GIF'}`}
              title="Play this GIF"
              style={{ width: CHIP_PX, height: CHIP_PX }}
              onClick={() => openGifPlayer(ctx, e.id)}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
              </svg>
            </button>
          </div>
        )
      })}
    </>
  )
}

// ---- the player ----------------------------------------------------------------------------------------------------

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** Mounted once per board page (the media feature's screen overlay): shows the player a GIF asked for. */
export function GifPlayerHost({ ctx }: { ctx: CanvasFeatureContext }) {
  const request = useValue('media-gif-player-request', () => gifPlayerRequest(ctx.registries).get(), [ctx])
  const el = useValue('media-gif-player-element', () => {
    if (!request) return null
    const found = ctx.canvas.get(request.id)
    return isGifElement(found) ? found : null
  }, [ctx, request])
  // The GIF was deleted (here or by someone else), or became something else, while its player was open.
  useEffect(() => {
    if (request && !el) closeGifPlayer(ctx.registries)
  }, [ctx, request, el])
  if (!request || !el) return null
  const facts = factsOf(el) as FileFacts
  // Portalled to <body>, like the PDF viewer: a native modal outside the board's key allowlist and pointer rules
  return createPortal(
    <GifPlayer
      key={request.nonce}
      ctx={ctx}
      id={el.id}
      facts={facts}
      alt={(el.customData as { lobby?: { alt?: unknown } } | undefined)?.lobby?.alt}
      onClose={() => {
        closeGifPlayer(ctx.registries)
        // once the modal is gone (the board is inert while it is open): the keyboard goes back to the board
        requestAnimationFrame(() => ctx.canvas.focus())
      }}
    />,
    document.body,
  )
}

function GifPlayer({
  ctx,
  id,
  facts,
  alt,
  onClose,
}: {
  ctx: CanvasFeatureContext
  id: string
  facts: FileFacts
  alt: unknown
  onClose(): void
}) {
  const [playing, setPlaying] = useState(() => !prefersReducedMotion())
  const [still, setStill] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  // the poster: what the canvas shows (its derivative), asked for once
  useEffect(() => {
    let live = true
    void ctx.canvas.files.urlOf(id).then((u) => live && setStill(u))
    return () => {
      live = false
    }
  }, [ctx, id])
  const name = facts.name || 'GIF'
  const src = playing ? originalUrl(ctx.board.id, facts.assetId, facts.versionId) : still
  return (
    <Dialog
      title={name}
      description="The board keeps showing this GIF as a still; it plays only here."
      onClose={onClose}
      testId="gif-player"
      size="lg"
    >
      <div className="lobby-gif-player">
        {failed ? (
          <p className="lobby-gif-player__error" role="alert" data-testid="gif-player-error">
            This GIF could not be loaded.
          </p>
        ) : src ? (
          <img
            key={playing ? 'play' : 'still'}
            className="lobby-gif-player__image"
            data-testid="gif-player-image"
            data-state={playing ? 'playing' : 'paused'}
            src={src}
            alt={typeof alt === 'string' && alt ? alt : name}
            decoding="async"
            draggable={false}
            onError={() => setFailed(true)}
          />
        ) : (
          <p className="lobby-gif-player__error" role="status">
            Paused
          </p>
        )}
        <div className="lobby-gif-player__bar">
          <button
            type="button"
            className="dr-btn dr-btn--sm"
            data-testid="gif-player-toggle"
            aria-pressed={playing}
            disabled={failed}
            onClick={() => setPlaying((p) => !p)}
          >
            {playing ? 'Pause' : 'Play'}
          </button>
          <button
            type="button"
            className="dr-btn dr-btn--sm"
            data-testid="gif-player-close"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </Dialog>
  )
}
