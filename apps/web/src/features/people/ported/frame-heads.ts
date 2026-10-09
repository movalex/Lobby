// OWNER: W6 (wave L, L6-2). Frame head counts, pure (Node-tested): each person counts toward the innermost
// frame that contains the centre of their view (presence `view`, CONTRACTS_REV 10's fields need nothing new),
// once per person (a person with two tabs is one face). A person with no view (a follower the room does not
// stream past the cursor cap, an older client before its first view) is not counted. Only the people the room
// streams to this tab are counted, so the face pile says "near you", never a board total.

export interface HeadFrame {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface HeadPeer {
  readonly sid: string
  readonly uid: string
  readonly view: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  } | null
  /** false: the room does not stream this session (no view to count) */
  readonly streaming?: boolean
}

const inside = (f: HeadFrame, x: number, y: number) =>
  x >= f.x && x <= f.x + f.width && y >= f.y && y <= f.y + f.height

/**
 * The innermost frame containing the point: the smallest one (nested frames and frames on top of one
 * another), the later one in `frames` (paint order: drawn above) on a tie; null when none does.
 */
export function innermostFrame<F extends HeadFrame>(
  frames: readonly F[],
  p: { readonly x: number; readonly y: number },
): F | null {
  let best: F | null = null
  let bestArea = Number.POSITIVE_INFINITY
  for (const f of frames) {
    if (!(f.width > 0) || !(f.height > 0) || !inside(f, p.x, p.y)) continue
    const area = f.width * f.height
    if (area <= bestArea) {
      best = f
      bestArea = area
    }
  }
  return best
}

/** Per frame id, the people whose view centre is in it (innermost), one entry per person, in `peers` order. */
export function frameHeads<P extends HeadPeer>(
  frames: readonly HeadFrame[],
  peers: readonly P[],
): Map<string, P[]> {
  const out = new Map<string, P[]>()
  if (!frames.length) return out
  const seen = new Set<string>()
  for (const p of peers) {
    const v = p.view
    if (!v || p.streaming === false || seen.has(p.uid)) continue
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !(v.width >= 0) || !(v.height >= 0)) continue
    const f = innermostFrame(frames, { x: v.x + v.width / 2, y: v.y + v.height / 2 })
    if (!f) continue
    seen.add(p.uid)
    const list = out.get(f.id)
    if (list) list.push(p)
    else out.set(f.id, [p])
  }
  return out
}
