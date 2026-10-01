// OWNER: 3g. D2 (docs/research/excalidraw/REVIEW-W5-EARLY.md §9, W5-18): a URL pasted on the Excalidraw
// board becomes a LINK CARD, the page's title and site icon that opens in a new tab. There are no
// embeds and no third-party script or request on the board (plan §2.10.4: the server refuses
// `embeddable` and `iframe`): the api reads the page's <head> and icon on the person's behalf
// (apps/api/src/features/link-preview, with its SSRF rules and limits), and the card face is drawn by the
// media feature's DOM overlay (./CardLayer.tsx), like a file card's.
//
// The element is what the converter makes of today's tldraw bookmarks and embeds (packages/tldraw-import
// `linkCard`): a rounded `rectangle` with `link` = the URL, `customData.lobby.kind = 'link-card'`, and a
// bound label holding the title and the site, so exports, thumbnails, search and the PDF text layer read
// it without the overlay. The icon is never stored: every viewer's overlay asks the api (cached there).
//
// A link card lands at the paste point (the view's centre otherwise), inside the unlocked frame under
// it, in one undo step. Its face's ↗ link (and the engine's link badge on its corner, through the board
// page's onLinkOpen) opens the page in a new tab, with no opener and no referrer; a double-click edits
// its words like any shape's (the face steps aside while the editor is open). A name-only guest may only hold Lobby-relative links (canvas-schema
// `isAllowedLink`), so their pasted URL stays plain text, as before.
import { LOBBY_INK } from '@draftroom/board-ops/elements'
import { isAllowedLink } from '@draftroom/canvas-schema/limits'
import { type LinkPreview, linkPreviewPath } from '@draftroom/contracts'
import { type CSSProperties, useEffect, useState } from 'react'
import type {
  CanvasElement,
  CanvasFeatureContext,
  ContentHandlerSpec,
  FeatureRegistries,
  LobbyCanvas,
  ScenePoint,
} from '../../canvas/api/index.ts'
import { knownUserKind } from '../../invite/guest.tsx'

export const LINK_CARD_KIND = 'link-card'
export const LINK_CARD_W = 320
export const LINK_CARD_MIN_H = 88
export const LINK_CARD_RADIUS = 10
/** How long a paste waits for the page's title before the card lands with its site name only. */
export const LINK_PREVIEW_WAIT_MS = 3_000
const FONT_FAMILY = 6
const LABEL_SIZE = 16
/** Excalidraw's BOUND_TEXT_PADDING. */
const PAD = 5

const EMPTY: LinkPreview = { title: null, siteName: null, icon: null }

// ---- what a link card is --------------------------------------------------------------------------------

/** The http(s) URL a link card opens, else null. */
export function linkOf(
  el: Pick<CanvasElement, 'type'> & { link?: unknown; customData?: unknown },
): string | null {
  if (el.type !== 'rectangle') return null
  const kind = (el.customData as { lobby?: { kind?: unknown } } | undefined)?.lobby?.kind
  if (kind !== LINK_CARD_KIND || typeof el.link !== 'string') return null
  try {
    const u = new URL(el.link)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}

/** The host a card names: `www.` dropped. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return url
  }
}

/** What the card says first: the label's first line (the page title when it was read), else the host. */
export function titleOf(labelText: string, url: string): string {
  const first = labelText.split('\n')[0]?.trim()
  return first || hostOf(url)
}

/** The label's words: the title, then the site (one line when the page had no title). */
export function labelOf(preview: LinkPreview, url: string): string {
  const host = hostOf(url)
  const title = preview.title?.trim()
  const site = preview.siteName?.trim()
  const second = site && site.toLowerCase() !== host.toLowerCase() ? `${site} · ${host}` : host
  return title && title !== host ? `${title}\n${second}` : second
}

// ---- the api ------------------------------------------------------------------------------------------

const previews = new WeakMap<FeatureRegistries, Map<string, Promise<LinkPreview>>>()

/** The page's title, site name and icon, through the api (one request per URL per board page). */
export function fetchLinkPreview(ctx: CanvasFeatureContext, url: string): Promise<LinkPreview> {
  let byUrl = previews.get(ctx.registries)
  if (!byUrl) {
    byUrl = new Map()
    previews.set(ctx.registries, byUrl)
  }
  const hit = byUrl.get(url)
  if (hit) return hit
  const p = fetch(linkPreviewPath(ctx.board.id), {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  })
    .then(async (res) => {
      if (!res.ok) {
        // a refused or failed answer is not kept: a later view may ask again
        byUrl?.delete(url)
        return EMPTY
      }
      const j = (await res.json()) as Partial<LinkPreview>
      return {
        title: typeof j.title === 'string' ? j.title : null,
        siteName: typeof j.siteName === 'string' ? j.siteName : null,
        // only a raster data: URL is ever shown (the api sends nothing else)
        icon:
          typeof j.icon === 'string' && /^data:image\/(png|gif|jpeg|webp|x-icon);base64,/.test(j.icon)
            ? j.icon
            : null,
      }
    })
    .catch(() => {
      byUrl?.delete(url)
      return EMPTY
    })
  byUrl.set(url, p)
  if (byUrl.size > 500) {
    const oldest = byUrl.keys().next().value
    if (oldest !== undefined) byUrl.delete(oldest)
  }
  return p
}

/** The preview for an overlay face (null until the api answered). */
export function useLinkPreview(ctx: CanvasFeatureContext, url: string): LinkPreview | null {
  const [got, setGot] = useState<{ url: string; preview: LinkPreview } | null>(null)
  useEffect(() => {
    let live = true
    void fetchLinkPreview(ctx, url).then((preview) => {
      if (live) setGot({ url, preview })
    })
    return () => {
      live = false
    }
  }, [ctx, url])
  return got?.url === url ? got.preview : null
}

// ---- placing a card ----------------------------------------------------------------------------------------

function newId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return `ln${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** `text` wrapped to `max` scene px (greedy by words; a word wider than a line is cut). */
function wrap(canvas: LobbyCanvas, text: string, max: number): string {
  const style = { fontFamily: FONT_FAMILY, fontSize: LABEL_SIZE }
  const width = (s: string) => canvas.text.measure(s, style).width
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (width(next) <= max) {
        line = next
        continue
      }
      if (line) out.push(line)
      let rest = word
      while (rest.length > 1 && width(rest) > max) {
        let n = rest.length - 1
        while (n > 1 && width(rest.slice(0, n)) > max) n--
        out.push(rest.slice(0, n))
        rest = rest.slice(n)
      }
      line = rest
    }
    out.push(line)
  }
  return out.join('\n')
}

/** The innermost unlocked, visible frame under `at`, with its bounds. */
function frameAt(canvas: LobbyCanvas, at: ScenePoint) {
  let best: { id: string; x: number; y: number; w: number; h: number } | null = null
  for (const el of canvas.items()) {
    if (el.type !== 'frame' || canvas.isLocked(el.id) || canvas.isHidden(el.id)) continue
    const b = canvas.bounds(el.id)
    if (!b || at.x < b.x || at.y < b.y || at.x > b.x + b.width || at.y > b.y + b.height) continue
    if (best && best.w * best.h <= b.width * b.height) continue
    best = { id: el.id, x: b.x, y: b.y, w: b.width, h: b.height }
  }
  return best
}

/**
 * Creates the link card for `url` at `at` (the view's centre when null) with `preview`'s words, in one
 * undo step, selected. Returns its id.
 */
export function placeLinkCard(
  ctx: CanvasFeatureContext,
  url: string,
  preview: LinkPreview,
  at: ScenePoint | null,
): string {
  const canvas = ctx.canvas
  const vp = canvas.viewport.get()
  const point = at ?? { x: vp.x + vp.width / 2, y: vp.y + vp.height / 2 }
  const original = labelOf(preview, url)
  const text = wrap(canvas, original, LINK_CARD_W - 2 * PAD)
  const m = canvas.text.measure(text || ' ', { fontFamily: FONT_FAMILY, fontSize: LABEL_SIZE })
  const w = LINK_CARD_W
  const h = Math.max(LINK_CARD_MIN_H, Math.ceil(m.height) + 2 * PAD)
  let x = point.x - w / 2
  let y = point.y - h / 2
  const frame = frameAt(canvas, point)
  // inside its frame when it fits there (a frame clips what pokes out of it)
  if (frame && frame.w >= w && frame.h >= h) {
    x = Math.min(Math.max(x, frame.x), frame.x + frame.w - w)
    y = Math.min(Math.max(y, frame.y), frame.y + frame.h - h)
  }
  const frameId = frame && frame.w >= w && frame.h >= h ? frame.id : null
  const id = newId()
  const labelId = `${id}.t`
  canvas.transact('Add link', (tx) => {
    tx.create('rectangle', {
      id,
      x: round2(x),
      y: round2(y),
      width: w,
      height: h,
      strokeColor: '#c4bfb0',
      backgroundColor: '#ffffff',
      fillStyle: 'solid',
      strokeWidth: 1,
      roughness: 0,
      roundness: { type: 3, value: LINK_CARD_RADIUS },
      link: url,
      boundElements: [{ id: labelId, type: 'text' }],
      ...(frameId ? { frameId } : {}),
      customData: { lobby: { kind: LINK_CARD_KIND } },
    })
    tx.create('text', {
      id: labelId,
      x: round2(x + PAD),
      y: round2(y + PAD),
      text,
      originalText: original,
      fontFamily: FONT_FAMILY,
      fontSize: LABEL_SIZE,
      textAlign: 'left',
      verticalAlign: 'top',
      strokeColor: LOBBY_INK,
      containerId: id,
      autoResize: true,
      ...(frameId ? { frameId } : {}),
    })
  })
  canvas.select([id])
  return id
}

/** Whether this person may put `url` on the board as a link card (the server checks it again). */
export function canLinkCard(ctx: CanvasFeatureContext, url: string): boolean {
  if (ctx.canvas.readOnly()) return false
  // a name-only guest's links must be Lobby-relative (canvas-schema isAllowedLink)
  if (knownUserKind(ctx.me.user.id) === 'guest') return false
  if (!isAllowedLink(url)) return false
  try {
    const u = new URL(url)
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password
  } catch {
    return false
  }
}

let seq = 0

/** Paste or drop of a lone URL: fetch its preview (briefly), then place the card. */
export async function insertLinkCard(
  ctx: CanvasFeatureContext,
  url: string,
  at: ScenePoint | null,
): Promise<string | null> {
  if (!canLinkCard(ctx, url)) return null
  const key = `link-card:${++seq}`
  ctx.notify({ key, text: `Adding ${hostOf(url)}…`, timeoutMs: null, testId: 'link-card-toast' })
  const preview = await Promise.race([
    fetchLinkPreview(ctx, url),
    new Promise<LinkPreview>((r) => setTimeout(() => r(EMPTY), LINK_PREVIEW_WAIT_MS)),
  ])
  ctx.dismiss(key)
  if (ctx.canvas.readOnly()) return null
  return placeLinkCard(ctx, url, preview, at)
}

export const linkContentHandler: ContentHandlerSpec = {
  id: 'media.link-card',
  kinds: ['url'],
  priority: 100,
  handle(content, ctx, at) {
    if (content.kind !== 'url' || !canLinkCard(ctx, content.url)) return false
    void insertLinkCard(ctx, content.url, at)
    return true
  },
}

// ---- the face (drawn by ./CardLayer.tsx) -------------------------------------------------------------------

export function LinkFace({
  ctx,
  id,
  url,
  title,
  style,
}: {
  ctx: CanvasFeatureContext
  id: string
  url: string
  title: string
  style: CSSProperties
}) {
  const preview = useLinkPreview(ctx, url)
  const host = hostOf(url)
  const icon = preview?.icon ?? null
  return (
    <figure
      className="lobby-link"
      data-testid="link-card"
      data-lobby-link-card={id}
      data-icon={icon ? 'loaded' : preview ? 'none' : 'pending'}
      aria-label={`Link: ${title}, ${host}`}
      style={style}
    >
      <span className="lobby-link__icon" aria-hidden="true">
        {icon ? (
          <img src={icon} alt="" data-testid="link-card-icon" draggable={false} />
        ) : (
          <span>{(host[0] ?? '?').toUpperCase()}</span>
        )}
      </span>
      <span className="lobby-link__text">
        <span className="lobby-link__title" data-testid="link-card-title" title={title}>
          {title}
        </span>
        <span className="lobby-link__host" data-testid="link-card-host">
          {host}
        </span>
      </span>
      <a
        className="lobby-link__open dr-interactive"
        data-testid="link-card-open"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        title={`Open ${host} in a new tab`}
        draggable={false}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="dr-sr-only">Open {host} in a new tab</span>
      </a>
    </figure>
  )
}
