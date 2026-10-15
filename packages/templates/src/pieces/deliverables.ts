// The deliverable frames, for an agency that ships to platforms: a frame at the exact pixel size of the format (one
// board unit is one pixel), named with it, with the guides that format needs drawn and labelled inside it: broadcast
// action-safe and title-safe areas, the margin of a feed post, the UI areas of a story or reel, the areas of a
// YouTube banner on each device, the margin of a Steam capsule. The guides are locked, dashed outlines (the frame
// itself is not), so they stay out of the way of whatever is put in the frame; delete or hide them before export.
// The numbers are common platform guidance; a platform can change its own, so check the current spec before a
// delivery. Original work.
import type { BoardBuilder, LobbyColor, LobbySize, PlanFrame } from '../builder.ts'
import { INK, MUTED, type PieceDef } from './kit.ts'

/** One guide: a rectangle in the frame (frame units), what it says, and how it looks. */
interface Guide {
  x: number
  y: number
  w: number
  h: number
  label: string
  color: LobbyColor
  /** a pale tint inside (a UI area to keep clear) */
  tint?: boolean
  /** which line of the corner its label sits on, when guides share a corner (default 0, the top) */
  row?: number
}

/** Stroke and label size by the size of the frame: a 3840 px guide needs a thicker line than a 462 px one. */
function sizeFor(w: number, h: number): LobbySize {
  const long = Math.max(w, h)
  return long >= 3000 ? 'xl' : long >= 1800 ? 'l' : long >= 900 ? 'm' : 's'
}

/** The line height of a label in each size (the engine's text sizes, times its line height 1.25). */
const LINE: Record<LobbySize, number> = { s: 23, m: 30, l: 45, xl: 55 }

/** Adds a frame of `w` by `h` at `at` with its guides; each label sits inside its guide's top-left corner. */
function addDeliverable(
  b: BoardBuilder,
  at: { x: number; y: number },
  w: number,
  h: number,
  name: string,
  guides: readonly Guide[],
): PlanFrame {
  const frame = b.frame({ x: at.x, y: at.y, w, h, name })
  const size = sizeFor(w, h)
  const pad = Math.max(6, Math.round(Math.min(w, h) / 90))
  for (const g of guides) {
    b.geo(frame, {
      x: g.x,
      y: g.y,
      w: g.w,
      h: g.h,
      color: g.color,
      fill: g.tint ? 'solid' : 'none',
      dash: 'dashed',
      size,
      locked: true,
    })
    b.text(frame, {
      x: g.x + pad,
      y: g.y + pad + (g.row ?? 0) * (LINE[size] + 4),
      w: Math.max(80, g.w - pad * 2),
      text: g.label,
      size,
      color: g.tint ? INK : MUTED,
      locked: true,
    })
  }
  return frame
}

const deliverable = (name: string, w: number, h: number, guides: readonly Guide[]): PieceDef => ({
  build(b) {
    addDeliverable(b, { x: 0, y: 0 }, w, h, name, guides)
    return undefined
  },
})

/** Broadcast safe areas: action safe 93% and title safe 90% of the frame, centred (EBU and SMPTE guidance). */
function broadcast(w: number, h: number): Guide[] {
  const area = (pct: number, label: string, color: LobbyColor, row: number): Guide => {
    const gw = Math.round(w * pct)
    const gh = Math.round(h * pct)
    return { x: Math.round((w - gw) / 2), y: Math.round((h - gh) / 2), w: gw, h: gh, label, color, row }
  }
  return [area(0.93, 'Action safe 93%', 'grey', 0), area(0.9, 'Title safe 90%', 'blue', 1)]
}

/** A margin all the way round (`inset` units). */
function margin(w: number, h: number, inset: number, label: string): Guide {
  return { x: inset, y: inset, w: w - inset * 2, h: h - inset * 2, label, color: 'blue' }
}

/** A margin in proportion to the frame's short side, never under 12 units. */
const marginFor = (w: number, h: number) => Math.max(12, Math.round(Math.min(w, h) * 0.05))

const STORY = { w: 1080, h: 1920, top: 250, bottom: 340, reelsBottom: 670, side: 60 }
const BANNER = { w: 2560, h: 1440, bandY: 508, bandH: 423, safeW: 1546, tabletW: 1855 }

/** The Steam capsules: id, name and size. */
export const STEAM_CAPSULES = [
  { id: 'steam-main', name: 'Steam main capsule 1232 x 706', w: 1232, h: 706 },
  { id: 'steam-header', name: 'Steam header capsule 920 x 430', w: 920, h: 430 },
  { id: 'steam-small', name: 'Steam small capsule 462 x 174', w: 462, h: 174 },
  { id: 'steam-vertical', name: 'Steam vertical capsule 748 x 896', w: 748, h: 896 },
] as const

const steamGuides = (w: number, h: number): Guide[] => [
  margin(w, h, marginFor(w, h), 'Keep the logo and key art inside'),
]

const steam = (c: (typeof STEAM_CAPSULES)[number]): PieceDef =>
  deliverable(c.name, c.w, c.h, steamGuides(c.w, c.h))

export const DELIVERABLE_PIECES = {
  'deliver-fhd': deliverable('Full HD 1920 x 1080 (16:9)', 1920, 1080, broadcast(1920, 1080)),
  'deliver-4k': deliverable('4K UHD 3840 x 2160 (16:9)', 3840, 2160, broadcast(3840, 2160)),
  'deliver-square': deliverable('Square post 1080 x 1080 (1:1)', 1080, 1080, [
    margin(1080, 1080, 54, 'Safe margin 54 px'),
  ]),
  'deliver-portrait': deliverable('Portrait post 1080 x 1350 (4:5)', 1080, 1350, [
    margin(1080, 1350, 54, 'Safe margin 54 px'),
  ]),
  'deliver-story': deliverable('Story / Reel 1080 x 1920 (9:16)', STORY.w, STORY.h, [
    {
      x: 0,
      y: 0,
      w: STORY.w,
      h: STORY.top,
      label: 'Top UI: keep clear (250 px)',
      color: 'light-red',
      tint: true,
    },
    {
      x: 0,
      y: STORY.h - STORY.bottom,
      w: STORY.w,
      h: STORY.bottom,
      label: 'Bottom UI: keep clear (340 px)',
      color: 'light-red',
      tint: true,
    },
    {
      x: STORY.side,
      y: STORY.top,
      w: STORY.w - STORY.side * 2,
      h: STORY.h - STORY.top - STORY.bottom,
      label: 'Story safe area',
      color: 'blue',
    },
    {
      x: STORY.side,
      y: STORY.top,
      w: STORY.w - STORY.side * 2,
      h: STORY.h - STORY.top - STORY.reelsBottom,
      label: 'Reels: keep text above 670 px from the bottom',
      color: 'violet',
      row: 1,
    },
  ]),
  'deliver-link': deliverable('Link image 1200 x 628 (1.91:1)', 1200, 628, [
    margin(1200, 628, 48, 'Safe margin 48 px'),
  ]),
  'deliver-yt-banner': deliverable('YouTube banner 2560 x 1440', BANNER.w, BANNER.h, [
    { x: 0, y: BANNER.bandY, w: BANNER.w, h: BANNER.bandH, label: 'Desktop 2560 x 423', color: 'grey' },
    {
      x: (BANNER.w - BANNER.tabletW) / 2,
      y: BANNER.bandY,
      w: BANNER.tabletW,
      h: BANNER.bandH,
      label: 'Tablet 1855 x 423',
      color: 'violet',
      row: 1,
    },
    {
      x: (BANNER.w - BANNER.safeW) / 2,
      y: BANNER.bandY,
      w: BANNER.safeW,
      h: BANNER.bandH,
      label: 'Safe area on every device 1546 x 423',
      color: 'blue',
      row: 2,
    },
  ]),
  'steam-main': steam(STEAM_CAPSULES[0]),
  'steam-header': steam(STEAM_CAPSULES[1]),
  'steam-small': steam(STEAM_CAPSULES[2]),
  'steam-vertical': steam(STEAM_CAPSULES[3]),
  'steam-set': {
    build(b) {
      // the main and the vertical capsule in a row, the header and the small one under both, 80 units apart
      const at: Record<(typeof STEAM_CAPSULES)[number]['id'], { x: number; y: number }> = {
        'steam-main': { x: 0, y: 0 },
        'steam-vertical': { x: 1312, y: 0 },
        'steam-header': { x: 0, y: 976 },
        'steam-small': { x: 1000, y: 976 },
      }
      for (const c of STEAM_CAPSULES) addDeliverable(b, at[c.id], c.w, c.h, c.name, steamGuides(c.w, c.h))
      return undefined
    },
  },
} satisfies Record<string, PieceDef>
