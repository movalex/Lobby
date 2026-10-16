// OWNER: WS3 (wave T). The animatic's pictures: each panel's picture drawn once, ahead of the playhead, at the size the
// player shows it (× the screen's pixel ratio, at most 2), and kept in a SLIDING WINDOW of WINDOW bitmaps around the
// playhead (memory on phones: a 200-panel storyboard never holds more than WINDOW pictures). One rendering at a time
// (the engine's export is the expensive part), the nearest panels ahead first; a picture whose panel changed (its
// signature) is drawn again. The renderer is injected (the player's is canvas.export.canvas → createImageBitmap), so
// the window is unit-tested with fakes.

/** Pictures kept at once. */
export const WINDOW = 8
/** Of those, how many behind the playhead (the rest are ahead). */
export const BEHIND = 1

export interface Picture {
  readonly width: number
  readonly height: number
  close(): void
}

export interface PictureJob {
  readonly key: string
  /** the panel's picture signature: a cached picture with another one is stale */
  readonly sig: string
}

export type RenderPicture<P extends Picture> = (index: number) => Promise<P | null>

/** The panel indices the window holds around `current` (of `count`), nearest ahead first, then behind. */
export function windowOrder(current: number, count: number, size = WINDOW, behind = BEHIND): number[] {
  if (count <= 0) return []
  const out: number[] = []
  const at = Math.min(Math.max(current, 0), count - 1)
  const ahead = Math.min(size - Math.min(behind, at), count - at)
  for (let i = 0; i < ahead; i++) out.push(at + i)
  // behind; a short tail ahead leaves room for more of them
  for (let i = 1; out.length < Math.min(size, count) && at - i >= 0; i++) out.push(at - i)
  return out
}

interface Entry<P extends Picture> {
  sig: string
  picture: P | null
  pending: boolean
}

export class PictureWindow<P extends Picture> {
  private readonly entries = new Map<number, Entry<P>>()
  private jobs: readonly PictureJob[] = []
  private current = 0
  private running = false
  private disposed = false
  private readonly render: RenderPicture<P>
  private readonly onReady: (index: number) => void
  private readonly size: number
  private readonly canStart: () => boolean

  /**
   * `canStart`: whether a rendering may start now (the player says no while a swap is near: a rendering blocks the
   * page for a moment, which would make that swap late); the player calls `kick` again on its next frames.
   */
  constructor(
    render: RenderPicture<P>,
    onReady: (index: number) => void,
    opts: { size?: number; canStart?: () => boolean } = {},
  ) {
    this.render = render
    this.onReady = onReady
    this.size = opts.size ?? WINDOW
    this.canStart = opts.canStart ?? (() => true)
  }

  /** Starts the next rendering if one is due and allowed now. */
  kick(): void {
    this.pump()
  }

  /** Whether every picture of the window around panel `index` was drawn. */
  windowReady(index: number): boolean {
    return windowOrder(index, this.jobs.length, this.size).every((i) => this.ready(i))
  }

  /** The panels (their keys and signatures, in order); pictures of panels that changed are dropped. */
  setJobs(jobs: readonly PictureJob[]): void {
    const before = this.jobs
    this.jobs = jobs
    for (const [i, e] of [...this.entries]) {
      const job = jobs[i]
      if (!job || job.key !== before[i]?.key || job.sig !== e.sig) this.drop(i)
    }
    this.pump()
  }

  /** The playhead's panel: the window moves there (pictures outside it are closed). */
  moveTo(index: number): void {
    this.current = index
    const keep = new Set(windowOrder(index, this.jobs.length, this.size))
    for (const i of [...this.entries.keys()]) if (!keep.has(i) && !this.entries.get(i)?.pending) this.drop(i)
    this.pump()
  }

  /** The picture of panel `index` when it is ready (null: not yet, or the panel has none). */
  get(index: number): P | null {
    return this.entries.get(index)?.picture ?? null
  }

  /** Whether panel `index` was drawn (with or without a picture). */
  ready(index: number): boolean {
    const e = this.entries.get(index)
    return !!e && !e.pending
  }

  /** How many pictures are held now (for the memory test). */
  held(): number {
    let n = 0
    for (const e of this.entries.values()) if (e.picture) n++
    return n
  }

  dispose(): void {
    this.disposed = true
    for (const i of [...this.entries.keys()]) this.drop(i)
  }

  private drop(i: number) {
    const e = this.entries.get(i)
    if (!e) return
    e.picture?.close()
    this.entries.delete(i)
  }

  private next(): number | null {
    for (const i of windowOrder(this.current, this.jobs.length, this.size)) if (!this.entries.has(i)) return i
    return null
  }

  private pump() {
    if (this.running || this.disposed) return
    const i = this.next()
    if (i !== null && !this.canStart()) return
    if (i === null) return
    const job = this.jobs[i] as PictureJob
    const entry: Entry<P> = { sig: job.sig, picture: null, pending: true }
    this.entries.set(i, entry)
    this.running = true
    this.render(i)
      .catch(() => null)
      .then((picture) => {
        this.running = false
        const still = this.entries.get(i) === entry && !this.disposed
        const inWindow = windowOrder(this.current, this.jobs.length, this.size).includes(i)
        if (!still || !inWindow || this.jobs[i]?.sig !== entry.sig) {
          picture?.close()
          if (this.entries.get(i) === entry) this.entries.delete(i)
        } else {
          entry.picture = picture
          entry.pending = false
          this.onReady(i)
        }
        this.pump()
      })
  }
}
