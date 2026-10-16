// OWNER: WS3 (wave T). The animatic player (the design §3.1): a full-window overlay that plays one storyboard's panels
// in order, each for its duration, from pictures drawn ahead of the playhead (./pictures.ts) on its own clock
// (./clock.ts: performance.now, or the sound track's time while it plays). Not the presenter: moving the board's camera
// per panel re-renders the scene; Present storyboard (./present.ts) is the slide show of the same panels.
//
// Controls: play/pause, previous/next panel, the scrub bar (panel ticks), loop, speed 0.5×/1×/2×, "Show fields" (the
// dialogue as a subtitle, the camera above it), full screen and close. Keys while it is open (it is modal: no key
// reaches the board): Space or K play/pause, ←/→ previous/next panel, Home/End first/last panel, L loop, F fields,
// Esc closes, Tab stays inside. On a phone the bar wraps and a tap on the picture plays or pauses.
//
// Test hooks on the stage (read by e2e/excalidraw/t2-*.spec.ts): data-panel-index, data-state, data-prepared and
// data-swaps (the last swaps as JSON: panel index, performance.now() when it was drawn, the playhead, the sound's time),
// data-playing-at and data-playing-from (performance.now() and the playhead when the clock last started running).
import { formatDuration, formatRunningTime } from '@draftroom/canvas-schema/planning'
import { originalUrl } from '@draftroom/dev-assets/shared'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { SPEEDS, type Speed, segmentAt, Transport, type TransportState } from './clock.ts'
import { FIELD_LABELS, type PanelView, type StoryboardView, shotLabel, storyboardById } from './model.ts'
import { type Picture, PictureWindow } from './pictures.ts'
import { closePlayer, type PlayerRequest, playerOf } from './state.ts'

/** Pictures are drawn at the screen's pixel ratio, at most this. */
const MAX_DPR = 2
/** The longest side a picture is drawn at (px). */
const MAX_PICTURE_SIDE = 2048
/** No rendering starts this close (ms of playhead) before a swap: it would make the swap late. */
const RENDER_QUIET_MS = 300
/** How many swaps the stage keeps in data-swaps. */
const SWAP_LOG = 200

interface Swap {
  /** panel index */
  readonly i: number
  /** performance.now() when it was drawn */
  readonly at: number
  /** the playhead (ms) */
  readonly pos: number
  /** the sound's time (ms), when a sound plays */
  readonly a?: number
}

/** "0:03.2": minutes, seconds and tenths. */
export function clockLabel(ms: number): string {
  const tenths = Math.floor(Math.max(0, ms) / 100)
  const s = Math.floor(tenths / 10)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${tenths % 10}`
}

/** The largest `ratio` box inside `w`×`h`, centred. */
export function fitBox(w: number, h: number, ratio: number): { x: number; y: number; w: number; h: number } {
  const bw = Math.min(w, h * ratio)
  const bh = bw / ratio
  return { x: (w - bw) / 2, y: (h - bh) / 2, w: bw, h: bh }
}

/** The previous panel's start from `pos`: this panel's start when more than half a second in, else the one before. */
export function previousStart(panels: readonly PanelView[], pos: number): number {
  const i = segmentAt(panels, pos)
  if (i < 0) return 0
  const p = panels[i] as PanelView
  if (pos - p.startMs > 500 || i === 0) return p.startMs
  return (panels[i - 1] as PanelView).startMs
}

/** The overlay: the player while one is open on this canvas. */
export function AnimaticOverlay({ ctx }: { ctx: CanvasFeatureContext }) {
  const request = useValue(playerOf(ctx.canvas))
  if (!request) return null
  return <AnimaticPlayer key={request.seq} ctx={ctx} request={request} />
}

const isControl = (el: EventTarget | null) =>
  el instanceof HTMLElement && !!el.closest('button, select, input, [role="button"]')

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), select, input, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement)
}

async function renderPicture(
  canvas: LobbyCanvas,
  panel: PanelView,
  box: { w: number; h: number },
): Promise<ImageBitmap | null> {
  const pic = panel.picture
  if (!pic || box.w <= 0 || box.h <= 0) return null
  const scale = Math.min(box.w / pic.bounds.width, box.h / pic.bounds.height)
  const c = await canvas.export.canvas({
    ids: pic.ids,
    bounds: pic.bounds,
    scale: Math.max(0.05, scale),
    maxSide: MAX_PICTURE_SIDE,
    background: true,
    theme: 'light',
    files: 'display',
  })
  try {
    return await createImageBitmap(c)
  } finally {
    // the export's canvas is let go at once: only the bitmap is kept
    c.width = 0
    c.height = 0
  }
}

function AnimaticPlayer({ ctx, request }: { ctx: CanvasFeatureContext; request: PlayerRequest }) {
  const { canvas } = ctx
  const view = useValue('lobby-animatic-view', () => storyboardById(canvas, request.id), [canvas, request.id])
  const viewRef = useRef<StoryboardView | null>(view)
  viewRef.current = view
  // the sound is the one the storyboard had when the player opened
  const [audio] = useState(() => view?.audio ?? null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLCanvasElement | null>(null)
  const stageBoxRef = useRef<HTMLDivElement | null>(null)
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const transportRef = useRef<Transport | null>(null)
  const windowRef = useRef<PictureWindow<ImageBitmap> | null>(null)
  const shownRef = useRef(-1)
  const redrawRef = useRef(true)
  const swapsRef = useRef<Swap[]>([])
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 })
  const [index, setIndex] = useState(0)
  const [state, setState] = useState<TransportState>('paused')
  const [loop, setLoop] = useState(false)
  const [speed, setSpeedState] = useState<Speed>(1)
  const [fields, setFields] = useState(false)
  const [prepared, setPrepared] = useState(false)
  const [audioNote, setAudioNote] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const timeRef = useRef<HTMLSpanElement | null>(null)
  const scrubRef = useRef<HTMLInputElement | null>(null)

  const close = useCallback(() => closePlayer(canvas), [canvas])

  // focus mode while it is open (the board's chrome and other layers hide), no text editor, the focus back after
  useEffect(() => {
    const before = canvas.settings.get().focusMode
    if (canvas.editingId()) canvas.text.stop()
    canvas.settings.set({ focusMode: true })
    const opener = request.opener
    return () => {
      canvas.settings.set({ focusMode: before })
      if (document.fullscreenElement && rootRef.current?.contains(document.fullscreenElement))
        document.exitFullscreen().catch(() => {})
      requestAnimationFrame(() => {
        if (opener?.isConnected) opener.focus({ preventScroll: true })
        else canvas.focus({ preventScroll: true })
      })
    }
  }, [canvas, request.opener])

  // the transport (the clock and the sound)
  useEffect(() => {
    const v = viewRef.current
    const t = new Transport({
      totalMs: v?.totalMs ?? 0,
      now: () => performance.now(),
      media: mediaRef.current,
      offsetMs: audio?.offsetMs ?? 0,
    })
    transportRef.current = t
    return () => {
      t.pause()
      transportRef.current = null
    }
  }, [audio])

  // the pictures' window
  useEffect(() => {
    const win = new PictureWindow<ImageBitmap & Picture>(
      (i) => {
        const v = viewRef.current
        const p = v?.panels[i]
        if (!v || !p) return Promise.resolve(null)
        const { w, h, dpr } = sizeRef.current
        const box = fitBox(w * dpr, h * dpr, v.ratio)
        return renderPicture(canvas, p, box)
      },
      (i) => {
        if (i === shownRef.current) redrawRef.current = true
      },
      {
        canStart: () => {
          const t = transportRef.current
          const v = viewRef.current
          if (!t || !v || !t.playing) return true
          const pos = t.position()
          const next = v.panels[segmentAt(v.panels, pos) + 1]
          return !next || (next.startMs - pos) / t.speed > RENDER_QUIET_MS
        },
      },
    )
    windowRef.current = win
    return () => {
      win.dispose()
      windowRef.current = null
    }
  }, [canvas])

  // the panels' pictures follow the storyboard (a panel changed, moved, added or removed)
  useEffect(() => {
    windowRef.current?.setJobs(view?.panels.map((p) => ({ key: p.id, sig: p.picture?.sig ?? '' })) ?? [])
    redrawRef.current = true
  }, [view])

  // the stage's size (device pixels)
  useLayoutEffect(() => {
    const box = stageBoxRef.current
    const stage = stageRef.current
    if (!box || !stage) return
    const measure = () => {
      const r = box.getBoundingClientRect()
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
      sizeRef.current = { w: r.width, h: r.height, dpr }
      stage.width = Math.max(1, Math.round(r.width * dpr))
      stage.height = Math.max(1, Math.round(r.height * dpr))
      redrawRef.current = true
    }
    measure()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    ro?.observe(box)
    return () => ro?.disconnect()
  }, [])

  // the frame loop: the playhead, the swap, the clock's words
  useEffect(() => {
    let raf = 0
    let lastState: TransportState | null = null
    let lastPrepared = false
    const draw = (i: number) => {
      const stage = stageRef.current
      const g = stage?.getContext('2d')
      const v = viewRef.current
      if (!stage || !g || !v) return
      const W = stage.width
      const H = stage.height
      g.fillStyle = '#101418'
      g.fillRect(0, 0, W, H)
      const box = fitBox(W, H, v.ratio)
      g.fillStyle = '#ffffff'
      g.fillRect(box.x, box.y, box.w, box.h)
      const panel = v.panels[i]
      const pic = windowRef.current?.get(i) ?? null
      if (pic) {
        const k = Math.min(box.w / pic.width, box.h / pic.height)
        const w = pic.width * k
        const h = pic.height * k
        g.drawImage(pic, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h)
      } else if (panel?.picture && !windowRef.current?.ready(i)) {
        g.fillStyle = '#6b7280'
        g.font = `${Math.round(14 * sizeRef.current.dpr)}px ui-sans-serif, system-ui, sans-serif`
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillText('Drawing the picture…', box.x + box.w / 2, box.y + box.h / 2)
      }
    }
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const t = transportRef.current
      const v = viewRef.current
      const win = windowRef.current
      if (!t || !v || !win) return
      t.totalMs = v.totalMs
      const pos = t.tick()
      const i = Math.max(0, segmentAt(v.panels, pos))
      if (i !== shownRef.current || redrawRef.current) {
        const swapped = i !== shownRef.current
        shownRef.current = i
        redrawRef.current = false
        win.moveTo(i)
        draw(i)
        const stage = stageRef.current
        if (swapped && stage) {
          const m = mediaRef.current
          const swap: Swap = {
            i,
            at: Math.round(performance.now() * 10) / 10,
            pos: Math.round(pos),
            ...(m && t.hasMedia ? { a: Math.round(m.currentTime * 1000) } : {}),
          }
          swapsRef.current = [...swapsRef.current.slice(1 - SWAP_LOG), swap]
          stage.dataset.panelIndex = String(i)
          stage.dataset.swaps = JSON.stringify(swapsRef.current)
          setIndex(i)
        }
      }
      win.kick()
      if (timeRef.current) timeRef.current.textContent = `${clockLabel(pos)} / ${clockLabel(v.totalMs)}`
      if (scrubRef.current && document.activeElement !== scrubRef.current)
        scrubRef.current.value = String(Math.round(pos))
      if (t.state !== lastState) {
        const stage = stageRef.current
        if (stage) {
          stage.dataset.state = t.state
          // when the clock started running, and from where (the swaps' wall-clock reference)
          if (t.state === 'playing') {
            stage.dataset.playingAt = String(Math.round(performance.now() * 10) / 10)
            stage.dataset.playingFrom = String(Math.round(pos))
          }
        }
        lastState = t.state
        setState(t.state)
      }
      const ready = win.windowReady(0)
      if (ready !== lastPrepared) {
        lastPrepared = ready
        if (stageRef.current) stageRef.current.dataset.prepared = String(ready)
        setPrepared(ready)
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  const panelWords = useCallback((i: number) => {
    const v = viewRef.current
    const p = v?.panels[i]
    if (!v || !p) return ''
    const dialogue = p.fields.dialogue ? `: ${p.fields.dialogue}` : ''
    return `Shot ${p.number} of ${v.panels.length}, ${formatDuration(p.durationMs)}${dialogue}`
  }, [])

  const seekTo = useCallback(
    (ms: number, say = true) => {
      const t = transportRef.current
      const v = viewRef.current
      if (!t || !v) return
      t.seek(ms)
      if (say && !t.playing) setAnnounce(panelWords(Math.max(0, segmentAt(v.panels, ms))))
    },
    [panelWords],
  )
  const step = useCallback(
    (delta: 1 | -1) => {
      const t = transportRef.current
      const v = viewRef.current
      if (!t || !v?.panels.length) return
      const pos = t.position()
      if (delta < 0) seekTo(previousStart(v.panels, pos))
      else {
        const next = v.panels[segmentAt(v.panels, pos) + 1]
        if (next) seekTo(next.startMs)
      }
    },
    [seekTo],
  )
  const toggle = useCallback(() => {
    const t = transportRef.current
    if (!t) return
    t.toggle()
    setAnnounce(t.playing ? 'Playing' : `Paused. ${panelWords(shownRef.current)}`)
  }, [panelWords])
  const toggleLoop = useCallback(() => {
    setLoop((on) => {
      if (transportRef.current) transportRef.current.loop = !on
      return !on
    })
  }, [])
  const setSpeed = useCallback((s: Speed) => {
    transportRef.current?.setSpeed(s)
    setSpeedState(s)
  }, [])
  const fullscreen = useCallback(() => {
    const root = rootRef.current
    if (!root) return
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else root.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {})
  }, [])

  // keys: modal while open (window capture phase, before the board's key layers)
  useEffect(() => {
    const swallowed = new Set<string>()
    const onKeyUp = (e: KeyboardEvent) => {
      if (swallowed.delete(e.code || e.key)) e.stopPropagation()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      const root = rootRef.current
      if (!root) return
      e.stopPropagation()
      swallowed.add(e.code || e.key)
      if (e.isComposing) return
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return
      }
      if (e.key === 'Tab') {
        const items = focusables(root)
        e.preventDefault()
        if (!items.length) return root.focus()
        const at = items.indexOf(document.activeElement as HTMLElement)
        const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at >= items.length - 1 ? 0 : at + 1
        items[next]?.focus()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const onControl = isControl(e.target)
      if ((e.key === ' ' || e.key === 'Enter') && onControl && !(e.target instanceof HTMLInputElement)) return
      if (e.target instanceof HTMLSelectElement && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return
      const act: Record<string, () => void> = {
        ' ': toggle,
        k: toggle,
        K: toggle,
        ArrowRight: () => step(1),
        ArrowLeft: () => step(-1),
        Home: () => seekTo(0),
        End: () => {
          const v = viewRef.current
          const last = v?.panels[v.panels.length - 1]
          if (last) seekTo(last.startMs)
        },
        l: toggleLoop,
        L: toggleLoop,
        f: () => setFields((on) => !on),
        F: () => setFields((on) => !on),
      }
      const run = act[e.key]
      if (run) {
        e.preventDefault()
        run()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      // the keyup of the key that closed it (Esc) still never reaches the board
      setTimeout(() => window.removeEventListener('keyup', onKeyUp, true), 1000)
    }
  }, [close, seekTo, step, toggle, toggleLoop])

  // the play button has the focus first
  const playRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    playRef.current?.focus({ preventScroll: true })
  }, [])

  const playing = state === 'playing' || state === 'starting'
  const panel = view?.panels[index] ?? view?.panels[0] ?? null
  const total = view?.totalMs ?? 0
  const title = view?.title ?? ''
  const url = audio ? originalUrl(ctx.board.id, audio.assetId, audio.versionId) : null

  return (
    <div
      ref={rootRef}
      className="dr-animatic"
      role="dialog"
      aria-modal="true"
      aria-label={`Animatic: ${title}`}
      data-testid="animatic-player"
      tabIndex={-1}
    >
      <div className="dr-animatic__top">
        <h2 className="dr-animatic__title">{title}</h2>
        {panel && (
          <span className="dr-animatic__chip" data-testid="animatic-chip">
            {shotLabel(panel.number)} · {formatDuration(panel.durationMs)}
            {panel.name ? <span className="dr-animatic__name"> · {panel.name}</span> : null}
          </span>
        )}
        <button
          type="button"
          className="dr-animatic__btn dr-animatic__close"
          data-testid="animatic-close"
          aria-label="Close the animatic (Esc)"
          title="Close (Esc)"
          onClick={close}
        >
          ×
        </button>
      </div>
      <div ref={stageBoxRef} className="dr-animatic__stage">
        <canvas
          ref={stageRef}
          className="dr-animatic__canvas"
          data-testid="animatic-stage"
          data-state="paused"
          data-prepared="false"
          data-swaps="[]"
          role="img"
          aria-label={panel ? `${shotLabel(panel.number)}${panel.name ? `, ${panel.name}` : ''}` : title}
        />
        {/* a tap or click on the picture plays or pauses (the bar's Play button is the keyboard's way) */}
        <button
          type="button"
          className="dr-animatic__tap"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="animatic-tap"
          onClick={toggle}
        />
        {fields && panel && (panel.fields.camera || panel.fields.dialogue) && (
          <div className="dr-animatic__fields" data-testid="animatic-fields">
            {panel.fields.camera && (
              <p className="dr-animatic__camera">
                {FIELD_LABELS.camera}: {panel.fields.camera}
              </p>
            )}
            {panel.fields.dialogue && <p className="dr-animatic__subtitle">{panel.fields.dialogue}</p>}
          </div>
        )}
        {!view && (
          <p className="dr-animatic__empty" role="status">
            This storyboard has no panels any more.
          </p>
        )}
      </div>
      {url && audio?.source === 'audio' && (
        // biome-ignore lint/a11y/useMediaCaption: the sound track of the animatic, played with its pictures
        <audio
          ref={(el) => {
            mediaRef.current = el
          }}
          src={url}
          preload="auto"
          data-testid="animatic-audio"
          onPlaying={() => transportRef.current?.mediaPlaying()}
          onWaiting={() => transportRef.current?.mediaStalled()}
          onError={() => {
            transportRef.current?.detachMedia()
            setAudioNote('The sound could not be played: the animatic plays without it.')
          }}
        />
      )}
      {url && audio?.source === 'video' && (
        // biome-ignore lint/a11y/useMediaCaption: only the video's sound is used, as the animatic's sound track
        <video
          ref={(el) => {
            mediaRef.current = el
          }}
          src={url}
          preload="auto"
          playsInline
          hidden
          data-testid="animatic-audio"
          onPlaying={() => transportRef.current?.mediaPlaying()}
          onWaiting={() => transportRef.current?.mediaStalled()}
          onError={() => {
            transportRef.current?.detachMedia()
            setAudioNote('The sound could not be played: the animatic plays without it.')
          }}
        />
      )}
      <div className="dr-animatic__bar">
        <button
          ref={playRef}
          type="button"
          className="dr-animatic__btn dr-animatic__play"
          data-testid="animatic-play"
          aria-label={playing ? 'Pause (Space)' : 'Play (Space)'}
          aria-keyshortcuts="Space K"
          onClick={toggle}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <button
          type="button"
          className="dr-animatic__btn"
          data-testid="animatic-prev"
          aria-label="Previous panel (Left arrow)"
          onClick={() => step(-1)}
        >
          ⏮
        </button>
        <button
          type="button"
          className="dr-animatic__btn"
          data-testid="animatic-next"
          aria-label="Next panel (Right arrow)"
          onClick={() => step(1)}
        >
          ⏭
        </button>
        <span ref={timeRef} className="dr-animatic__time" data-testid="animatic-time">
          {clockLabel(0)} / {clockLabel(total)}
        </span>
        <div className="dr-animatic__scrub">
          <div className="dr-animatic__ticks" aria-hidden="true">
            {view?.panels.map((p) =>
              total > 0 ? (
                <span
                  key={p.id}
                  className="dr-animatic__tick"
                  style={{ left: `${(p.startMs / total) * 100}%` }}
                />
              ) : null,
            )}
          </div>
          <input
            ref={scrubRef}
            type="range"
            className="dr-animatic__range"
            data-testid="animatic-scrub"
            min={0}
            max={Math.max(1, total)}
            step={1}
            defaultValue={0}
            aria-label="Position in the animatic"
            aria-valuetext={
              panel
                ? `${formatRunningTime(panel.startMs)}, shot ${panel.number} of ${view?.panels.length ?? 0}`
                : undefined
            }
            onInput={(e) => seekTo(Number((e.target as HTMLInputElement).value), false)}
            onChange={(e) => seekTo(Number(e.target.value), false)}
          />
        </div>
        <button
          type="button"
          className="dr-animatic__btn"
          data-testid="animatic-loop"
          aria-pressed={loop}
          aria-label="Loop (L)"
          title="Loop (L)"
          onClick={toggleLoop}
        >
          ⟲
        </button>
        <label className="dr-animatic__speed">
          <span className="dr-sr-only">Speed</span>
          <select
            data-testid="animatic-speed"
            value={String(speed)}
            onChange={(e) => setSpeed(Number(e.target.value) as Speed)}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={String(s)}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="dr-animatic__btn dr-animatic__text-btn"
          data-testid="animatic-fields-toggle"
          aria-pressed={fields}
          title="Show the dialogue and camera (F)"
          onClick={() => setFields((on) => !on)}
        >
          Fields
        </button>
        <button
          type="button"
          className="dr-animatic__btn"
          data-testid="animatic-fullscreen"
          aria-label="Full screen"
          title="Full screen"
          onClick={fullscreen}
        >
          ⛶
        </button>
      </div>
      <p className="dr-animatic__note" data-testid="animatic-status">
        {!prepared && view ? 'Drawing the pictures… ' : ''}
        {audio && !audioNote ? `Sound: ${audio.name || 'the sound track'}` : ''}
        {audioNote ?? ''}
      </p>
      <p className="dr-sr-only" role="status" aria-live="polite">
        {announce}
      </p>
    </div>
  )
}
