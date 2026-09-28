// A page recorder for the demo: Chromium's screencast (CDP Page.startScreencast), sampled at a steady
// 30 fps against the wall clock and encoded with x264 as it arrives.
//
// Playwright's recordVideo writes 25 fps VP8 at 1 Mbit/s (realtime, speed 8): converted to the video's
// 30 fps it stutters (every fifth frame doubles) and small UI text smears when the canvas moves. This
// keeps every frame the browser paints, at the page's device pixels (a deviceScaleFactor > 1 draws the
// UI larger and still sharp), so the composer starts from a clean 30 fps picture.
import { spawn } from 'node:child_process'
import type { CDPSession, Page } from '@playwright/test'

export const RECORD_FPS = 30

export interface PageRecording {
  file: string
  /** Wall-clock time (epoch ms) the video's first frame stands for. */
  createdAt: number
  width: number
  height: number
  stop(): Promise<void>
}

interface ScreencastFrame {
  data: string
  sessionId: number
}

/**
 * Starts recording `page` into `file` (an .mp4) at `size` device pixels. Frames are the latest picture
 * the page painted at each 1/30 s tick; a page that paints nothing repeats its last frame, as a screen
 * would.
 */
export async function recordPage(
  page: Page,
  file: string,
  size: { width: number; height: number },
): Promise<PageRecording> {
  const { width, height } = size
  const ffmpeg = spawn(
    'ffmpeg',
    [
      ...['-hide_banner', '-loglevel', 'error', '-y'],
      ...['-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(RECORD_FPS), '-i', 'pipe:0'],
      // The screencast's JPEGs are full-range BT.601; x264 gets them as ordinary (limited-range) 4:2:0,
      // which the composer reads back the same way.
      ...['-vf', `scale=${width}:${height}:flags=lanczos,format=yuv420p`],
      ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '11', '-g', String(RECORD_FPS * 2)],
      ...['-movflags', '+faststart', file],
    ],
    { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
  )
  let err = ''
  ffmpeg.stderr.on('data', (d) => {
    err = (err + String(d)).slice(-4000)
  })
  const closed = new Promise<number>((r) => ffmpeg.once('close', (c) => r(c ?? 1)))
  ffmpeg.stdin.on('error', () => {})

  const cdp: CDPSession = await page.context().newCDPSession(page)
  let latest: Buffer | null = null
  let t0 = 0
  let written = 0
  let ticker: ReturnType<typeof setInterval> | null = null
  let firstFrame: (() => void) | null = null
  const gotFirst = new Promise<void>((r) => {
    firstFrame = r
  })

  const tick = () => {
    if (!latest) return
    const due = Math.floor(((Date.now() - t0) * RECORD_FPS) / 1000) + 1
    while (written < due) {
      ffmpeg.stdin.write(latest)
      written++
    }
  }

  cdp.on('Page.screencastFrame', (f: ScreencastFrame) => {
    latest = Buffer.from(f.data, 'base64')
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
    if (!t0) {
      t0 = Date.now()
      ticker = setInterval(tick, 6)
      tick()
      firstFrame?.()
    }
  })
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 94,
    maxWidth: width,
    maxHeight: height,
    everyNthFrame: 1,
  })
  // A page that has painted nothing yet sends its first frame once it does; nudge it.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null)))).catch(() => {})
  await Promise.race([gotFirst, new Promise((r) => setTimeout(r, 5000))])
  if (!t0) throw new Error('the screencast sent no frame in 5 s')

  let stopping: Promise<void> | null = null
  return {
    file,
    createdAt: t0,
    width,
    height,
    stop() {
      stopping ??= (async () => {
        tick()
        if (ticker) clearInterval(ticker)
        await cdp.send('Page.stopScreencast').catch(() => {})
        await cdp.detach().catch(() => {})
        ffmpeg.stdin.end()
        const code = await closed
        if (code !== 0) throw new Error(`recording ${file}: ffmpeg exited ${code}: ${err}`)
      })()
      return stopping
    },
  }
}
