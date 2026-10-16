// OWNER: WS3 (wave S, media comments). The review viewer's `body` for a video (docs/WAVE-S-CONTRACTS.md §4): Lobby's
// own transport over a <video> of the original (native controls off): play/pause, ±1 s and ±1 frame (at the probe's
// frame rate, else 25 fps), the timecode (hh:mm:ss:ff when the rate is known, else mm:ss.d), and a scrubber with a
// marker per thread with a time on this version (clustered under 6 px; a cluster opens a list). A marker click
// seeks there, pauses and picks its thread; "Comment at 00:12.4" pauses and opens the composer at the playhead; a
// click on the paused frame does too, with the spot clicked. Threads with a spot near the playhead show their pin.
//
// Keys (only inside the viewer: its dialog stops them, the board never sees them): Space or K play/pause, J and L
// one second back and on, ← and → one frame (Shift: one second), C comment here.
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { derivativeUrl, originalUrl, usableDerivatives } from '../../../assets/contract.ts'
import type { ViewerSlotProps } from '../slots.ts'
import { type MediaThread, spotAt, spotsShown } from '../threads/model.ts'
import { patchSession, requestSeek } from '../threads/session.ts'
import { DraftPin, mediaCommentsOn, ReactKeys, SpotPin, startComment, useMedia } from '../threads/shared.tsx'
import { clusterMarkers, type MarkerCluster, timeAtX } from './markers.ts'
import { formatClock, formatTimecode, frameRateOrNull, stepFrame, stepSecond } from './timecode.ts'

export function VideoBody(props: ViewerSlotProps) {
  if (!mediaCommentsOn()) return null
  return (
    <ReactKeys>
      <Video {...props} />
    </ReactKeys>
  )
}

function Video(props: ViewerSlotProps) {
  const { ctx, request } = props
  const { session, state, threads, canComment, meta } = useMedia(props)
  const video = useRef<HTMLVideoElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLElement>(null)
  const [playing, setPlaying] = useState(false)
  const [mediaMs, setMediaMs] = useState<number | null>(null)
  const [broken, setBroken] = useState(false)
  const [cluster, setCluster] = useState<MarkerCluster | null>(null)
  const probe = meta.meta?.probe
  const fps = frameRateOrNull(probe?.frameRate)
  const durationMs = mediaMs ?? probe?.durationMs ?? 0
  const now = state.currentMs
  const src = originalUrl(ctx.board.id, request.assetId, request.versionId)
  const poster = useMemo(() => {
    const m = meta.meta
    const d = m ? usableDerivatives(m).find((x) => x.role === 'poster') : undefined
    return d ? derivativeUrl(ctx.board.id, request.assetId, request.versionId, d.id) : undefined
  }, [meta.meta, ctx.board.id, request.assetId, request.versionId])

  // The playhead into the session while playing (each frame), and on every seek.
  useEffect(() => {
    const v = video.current
    if (!v) return
    let raf = 0
    const tick = () => {
      patchSession(session, { currentMs: Math.round(v.currentTime * 1000) })
      if (!v.paused) raf = requestAnimationFrame(tick)
    }
    const onPlay = () => {
      setPlaying(true)
      raf = requestAnimationFrame(tick)
    }
    const onPause = () => {
      setPlaying(false)
      cancelAnimationFrame(raf)
      tick()
    }
    const onMeta = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) setMediaMs(Math.round(v.duration * 1000))
    }
    const onError = () => setBroken(true)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('seeked', tick)
    v.addEventListener('loadedmetadata', onMeta)
    v.addEventListener('error', onError)
    return () => {
      cancelAnimationFrame(raf)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('seeked', tick)
      v.removeEventListener('loadedmetadata', onMeta)
      v.removeEventListener('error', onError)
    }
  }, [session])

  // A seek asked for by the list, a marker or the request ("Jump to 00:12.4"): there, paused.
  const seekN = state.seek?.n ?? 0
  const seekMs = state.seek?.ms ?? 0
  useEffect(() => {
    const v = video.current
    if (!v || seekN === 0) return
    v.pause()
    v.currentTime = seekMs / 1000
  }, [seekN, seekMs])

  // The composer opened (here or from the list): the picture stops where it is commented on.
  const drafting = state.draft !== null
  useEffect(() => {
    if (drafting) video.current?.pause()
  }, [drafting])

  // The keyboard starts on the player.
  useEffect(() => {
    stage.current?.focus({ preventScroll: true })
  }, [])

  const seek = (ms: number) => requestSeek(session, Math.max(0, Math.min(durationMs || ms, ms)))
  const toggle = () => {
    const v = video.current
    if (!v) return
    if (v.paused) void v.play().catch(() => setBroken(true))
    else v.pause()
  }
  const commentHere = (spot?: { u: number; v: number }) => {
    if (!canComment) return
    video.current?.pause()
    const at = Math.round((video.current?.currentTime ?? now / 1000) * 1000)
    startComment(session, { timeMs: at, ...(spot ? { spot } : {}) })
  }
  const pick = (t: MediaThread) => {
    if (t.anchor.timeMs !== undefined) seek(t.anchor.timeMs)
    patchSession(session, { selected: t.id, draft: null })
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const t = e.target
    if (t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && t.type !== 'range')) return
    if (e.altKey || e.metaKey || e.ctrlKey) return
    let handled = true
    switch (e.key) {
      case ' ':
      case 'k':
      case 'K':
        toggle()
        break
      case 'j':
      case 'J':
        seek(stepSecond(now, -1, durationMs))
        break
      case 'l':
      case 'L':
        seek(stepSecond(now, 1, durationMs))
        break
      case 'ArrowLeft':
        seek(e.shiftKey ? stepSecond(now, -1, durationMs) : stepFrame(now, -1, fps, durationMs))
        break
      case 'ArrowRight':
        seek(e.shiftKey ? stepSecond(now, 1, durationMs) : stepFrame(now, 1, fps, durationMs))
        break
      case 'c':
      case 'C':
        commentHere()
        break
      default:
        handled = false
    }
    if (handled) e.preventDefault()
  }

  const shown = spotsShown(threads, { ms: now })
  const draftSpot = state.draft?.spot

  return (
    <div className="dr-rvm-video" data-testid="rv-video">
      <section
        ref={stage}
        className="dr-rvm-video__stage"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the player takes the transport keys
        tabIndex={0}
        aria-label="Video player: Space plays or pauses, arrows step a frame, C comments here"
        onKeyDown={onKeyDown}
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: C and the transport comment by keyboard; a click picks the spot */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a click on the paused frame is a comment on that spot */}
        <div
          ref={frame}
          className="dr-rvm-frame"
          data-testid="rv-video-frame"
          onClick={(e) => {
            if (playing) {
              video.current?.pause()
              return
            }
            const spot = spotAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY)
            if (spot) commentHere(spot)
          }}
        >
          {/* biome-ignore lint/a11y/useMediaCaption: a client's cut under review has no captions track to offer */}
          <video
            ref={video}
            className="dr-rvm-video__el"
            data-testid="rv-video-el"
            src={src}
            poster={poster}
            preload="metadata"
            playsInline
          />
          {shown.map((t) => (
            <SpotPin key={t.id} thread={t} selected={state.selected === t.id} onPick={() => pick(t)} />
          ))}
          {draftSpot && <DraftPin spot={draftSpot} />}
        </div>
        {broken && (
          <p className="dr-rvm-note" role="note" data-testid="rv-video-broken">
            This browser can’t play this file; download it to watch it.
          </p>
        )}
      </section>
      <Scrubber
        durationMs={durationMs}
        nowMs={now}
        threads={threads}
        selected={state.selected}
        cluster={cluster}
        onCluster={setCluster}
        onSeek={seek}
        onPick={pick}
      />
      <div className="dr-rvm-transport">
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="rv-video-play"
          aria-pressed={playing}
          onClick={toggle}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          className="dr-btn dr-btn--sm dr-btn--ghost"
          data-testid="rv-video-back-second"
          aria-label="Back one second"
          onClick={() => seek(stepSecond(now, -1, durationMs))}
        >
          −1 s
        </button>
        <button
          type="button"
          className="dr-btn dr-btn--sm dr-btn--ghost"
          data-testid="rv-video-back-frame"
          aria-label="Back one frame"
          onClick={() => seek(stepFrame(now, -1, fps, durationMs))}
        >
          −1 f
        </button>
        <output className="dr-rvm-time" data-testid="rv-video-time" aria-live="off">
          {formatTimecode(now, fps)} / {formatTimecode(durationMs, fps)}
        </output>
        <button
          type="button"
          className="dr-btn dr-btn--sm dr-btn--ghost"
          data-testid="rv-video-next-frame"
          aria-label="Forward one frame"
          onClick={() => seek(stepFrame(now, 1, fps, durationMs))}
        >
          +1 f
        </button>
        <button
          type="button"
          className="dr-btn dr-btn--sm dr-btn--ghost"
          data-testid="rv-video-next-second"
          aria-label="Forward one second"
          onClick={() => seek(stepSecond(now, 1, durationMs))}
        >
          +1 s
        </button>
        <span className="dr-rvm-spacer" />
        {canComment && (
          <button
            type="button"
            className="dr-btn dr-btn--sm dr-btn--primary"
            data-testid="rv-comment-here"
            onClick={() => commentHere()}
          >
            Comment at {formatClock(now)}
          </button>
        )}
      </div>
    </div>
  )
}

function Scrubber({
  durationMs,
  nowMs,
  threads,
  selected,
  cluster,
  onCluster,
  onSeek,
  onPick,
}: {
  durationMs: number
  nowMs: number
  threads: readonly MediaThread[]
  selected: string | null
  cluster: MarkerCluster | null
  onCluster(c: MarkerCluster | null): void
  onSeek(ms: number): void
  onPick(t: MediaThread): void
}) {
  const track = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = track.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const timed = threads.flatMap((t) =>
    t.anchor.timeMs !== undefined ? [{ id: t.id, timeMs: t.anchor.timeMs }] : [],
  )
  const clusters = clusterMarkers(timed, durationMs, width)
  const byId = new Map(threads.map((t) => [t.id, t]))
  const progress = durationMs > 0 ? Math.min(100, (nowMs / durationMs) * 100) : 0
  const scrub = (clientX: number) => {
    const el = track.current
    if (!el) return
    const r = el.getBoundingClientRect()
    onSeek(timeAtX(clientX - r.left, durationMs, r.width))
  }
  return (
    <div className="dr-rvm-scrubber">
      <div
        ref={track}
        className="dr-rvm-track"
        data-testid="rv-scrubber"
        role="slider"
        tabIndex={-1}
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationMs / 1000)}
        aria-valuenow={Math.round(nowMs / 1000)}
        aria-valuetext={formatClock(nowMs)}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          scrub(e.clientX)
          onCluster(null)
        }}
      >
        <span className="dr-rvm-track__fill" style={{ width: `${progress}%` }} />
        <span className="dr-rvm-track__head" style={{ left: `${progress}%` }} />
        {clusters.map((c) => {
          const first = byId.get(c.ids[0] ?? '')
          const many = c.ids.length > 1
          return (
            <button
              key={c.ids.join(',')}
              type="button"
              className="dr-rvm-marker"
              data-testid="rv-marker"
              data-thread-ids={c.ids.join(' ')}
              data-time-ms={c.timeMs}
              data-selected={c.ids.includes(selected ?? '') || undefined}
              style={{ left: `${c.x}px` }}
              aria-label={
                many
                  ? `${c.ids.length} comments at ${formatClock(c.timeMs)}`
                  : `Comment by ${first?.createdBy.name ?? 'someone'} at ${formatClock(c.timeMs)}`
              }
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                if (many) onCluster(cluster?.timeMs === c.timeMs ? null : c)
                else if (first) onPick(first)
              }}
            >
              {many ? c.ids.length : ''}
            </button>
          )
        })}
      </div>
      {cluster && (
        <ul className="dr-rvm-cluster" data-testid="rv-marker-list" style={{ left: `${cluster.x}px` }}>
          {cluster.ids.map((id) => {
            const t = byId.get(id)
            if (!t) return null
            return (
              <li key={id}>
                <button
                  type="button"
                  className="dr-rvm-cluster__item"
                  data-thread-id={id}
                  onClick={() => {
                    onCluster(null)
                    onPick(t)
                  }}
                >
                  <strong>{formatClock(t.anchor.timeMs ?? 0)}</strong> {t.createdBy.name}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
