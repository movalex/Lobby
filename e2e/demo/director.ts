// Scene bookkeeping for the recording: when each scene starts and ends (wall clock), how long it has to
// run to fit its narration, what inside it is cut (waits), and what happened (recorded / partial /
// skipped, with a note).
import { composedSec, minSceneSec, type NarrationScene, type SceneWindow } from './timeline.ts'

/** Thrown inside a scene when the feature it shows is not in this build: the scene is left out. */
export class SkipScene extends Error {}

export class Director {
  readonly scenes: SceneWindow[] = []
  private readonly narration: Map<string, NarrationScene>
  private readonly log: (msg: string) => void

  constructor(narration: NarrationScene[], log: (msg: string) => void) {
    this.narration = new Map(narration.map((n) => [n.id, n]))
    this.log = log
  }

  private need(id: string): NarrationScene {
    const n = this.narration.get(id)
    if (!n) throw new Error(`narration.json has no scene "${id}"`)
    return n
  }

  /** A title or outro card, drawn by the composer. */
  card(id: string, extraSec = 0.9) {
    const n = this.need(id)
    this.scenes.push({
      id,
      kind: 'card',
      status: 'recorded',
      note: 'card',
      durationSec: +(minSceneSec(n) + extraSec).toFixed(3),
    })
  }

  /**
   * Runs one recorded scene: `prepare` happens off camera (it is cut), then `act` is filmed. The scene
   * runs at least as long as its narration needs, counted in video time (cut waits do not count);
   * `act` may take longer. A SkipScene from either leaves the scene out; any other error keeps what
   * was filmed and marks the scene partial.
   */
  async scene(
    id: string,
    act: (s: SceneClock, win: SceneWindow) => Promise<void>,
    opts: { prepare?: () => Promise<void>; minSec?: number } = {},
  ): Promise<SceneWindow> {
    const n = this.need(id)
    const minMs = Math.max(minSceneSec(n), opts.minSec ?? 0) * 1000
    const win: SceneWindow = { id, kind: 'split', status: 'recorded', note: '' }
    this.scenes.push(win)
    try {
      if (opts.prepare) await opts.prepare()
    } catch (e) {
      win.status = 'skipped'
      win.note = e instanceof SkipScene ? e.message : `prepare failed: ${errText(e)}`
      this.log(`[${id}] skipped: ${win.note}`)
      return win
    }
    const start = Date.now()
    win.start = start
    const clock = new SceneClock(win)
    this.log(`[${id}] rolling`)
    try {
      await act(clock, win)
    } catch (e) {
      if (e instanceof SkipScene) {
        win.status = 'skipped'
        win.note = e.message
        win.start = undefined
        this.log(`[${id}] skipped: ${win.note}`)
        return win
      }
      win.status = 'partial'
      win.note = `failed mid-scene: ${errText(e)}`
      this.log(`[${id}] PARTIAL: ${win.note}`)
    }
    const left = minMs - clock.elapsed
    if (left > 0) await new Promise((r) => setTimeout(r, left))
    win.end = Date.now()
    const shown = composedSec(win)
    if (!win.note) win.note = `${shown.toFixed(1)} s in the video`
    this.log(
      `[${id}] cut after ${((win.end - start) / 1000).toFixed(1)} s filmed, ${shown.toFixed(1)} s shown (min ${(minMs / 1000).toFixed(1)} s)`,
    )
    return win
  }
}

/** Time since the scene started as the video will show it, for pacing actions against the narration. */
export class SceneClock {
  private readonly win: SceneWindow
  constructor(win: SceneWindow) {
    this.win = win
  }
  get start(): number {
    return this.win.start ?? Date.now()
  }
  /** Video time since the scene started (ms): wall time minus the cut waits. */
  get elapsed() {
    return composedSec(this.win) * 1000
  }
  /** Waits until `ms` of video time after the scene started (no-op if that is already past). */
  async at(ms: number) {
    const left = ms - this.elapsed
    if (left > 0) await new Promise((r) => setTimeout(r, left))
  }
  /**
   * Runs `fn` (a wait: a board loading, a file rendering) and cuts that stretch out of the video; the
   * pieces either side are joined with a short dissolve.
   */
  async cut<T>(fn: () => Promise<T>): Promise<T> {
    const start = Date.now()
    try {
      return await fn()
    } finally {
      const end = Date.now()
      this.win.cuts = [...(this.win.cuts ?? []), { start, end }]
    }
  }
}

export const errText = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0] : String(e))
