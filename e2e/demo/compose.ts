// The composer: turns the recordings and timeline.json into out/lobby-demo.mp4 with ffmpeg.
//   1. one intermediate segment per scene (1920x1080, 30 fps): the title/outro cards, or Alex (left) and
//      Sam (right) cut to the scene's window, with the divider, name labels, the scene's lower-third
//      caption and, in the guest scene, the phone inset;
//   2. the segments cross-faded into one picture, each narration clip placed at its scene's start, the
//      mix loudness-normalised (two-pass loudnorm, -16 LUFS), H.264 + AAC with faststart;
//   3. a contact sheet (one frame per scene) for review.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Browser, chromium } from '@playwright/test'
import {
  BT709_FLAGS,
  BT709_TAGS,
  captionHtml,
  FPS,
  H,
  labelsHtml,
  outroCardHtml,
  PHONE_SCREEN,
  phoneFrameHtml,
  renderCard,
  renderPng,
  TO_BT709,
  titleCardHtml,
  W,
} from './cards.ts'
import {
  FADE_SEC,
  LEAD_SEC,
  type NarrationScene,
  type SceneWindow,
  type Timeline,
  type Track,
} from './timeline.ts'

export interface ComposeOptions {
  timeline: Timeline
  narration: NarrationScene[]
  outDir: string
  repoRoot: string
  people: { left: { name: string; color: string }; right: { name: string; color: string } }
  phoneLabel: string
  log: (msg: string) => void
}

export interface ComposedScene {
  id: string
  status: SceneWindow['status']
  note: string
  /** Where the scene starts in the final video, and how long its segment is (seconds). */
  at: number
  duration: number
  narrationSec: number
}

export interface ComposeResult {
  video: string
  contactSheet: string
  durationSec: number
  scenes: ComposedScene[]
}

function run(args: string[], what: string): string {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-y', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  if (r.status !== 0) throw new Error(`ffmpeg ${what} failed (${r.status}): ${(r.stderr ?? '').slice(-3000)}`)
  return r.stderr ?? ''
}

async function runAsync(args: string[], what: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-y', ...args], { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => {
      err += String(d)
      if (err.length > 200_000) err = err.slice(-100_000)
    })
    p.once('close', (code) => {
      if (code === 0) resolve(err)
      else reject(new Error(`ffmpeg ${what} failed (${code}): ${err.slice(-3000)}`))
    })
  })
}

export function probe(file: string): { duration: number; creation?: number; streams: string[] } {
  const r = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:format_tags=creation_time:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels',
      '-of',
      'json',
      file,
    ],
    { encoding: 'utf8', windowsHide: true },
  )
  if (r.status !== 0) throw new Error(`ffprobe ${file}: ${r.stderr}`)
  const j = JSON.parse(r.stdout) as {
    format?: { duration?: string; tags?: { creation_time?: string } }
    streams?: Array<Record<string, string | number>>
  }
  const created = j.format?.tags?.creation_time ? Date.parse(j.format.tags.creation_time) : Number.NaN
  return {
    duration: Number(j.format?.duration ?? 0),
    creation: Number.isFinite(created) ? created : undefined,
    streams: (j.streams ?? []).map((s) =>
      s.codec_type === 'video'
        ? `video ${s.codec_name} ${s.width}x${s.height} @ ${s.r_frame_rate}`
        : `${s.codec_type} ${s.codec_name} ${s.sample_rate ?? ''} Hz ${s.channels ?? ''} ch`,
    ),
  }
}

/**
 * Scenes whose caption goes lower than usual: while presenting, Alex's slide fills the middle of the
 * window, and the band under it (the slide's letterbox) is free; the Export dialog reaches further
 * down than other panels.
 */
const CAPTION_BOTTOM: Record<string, number> = { '09-present': 150, '10-history': 100 }

/** Seconds into `track`'s video for the wall-clock time `at` (epoch ms). */
function offsetIn(track: Track, at: number): number {
  return Math.max(0, (at - track.createdAt) / 1000)
}

export async function compose(opts: ComposeOptions): Promise<ComposeResult> {
  const { timeline, outDir, log } = opts
  const segDir = join(outDir, 'segments')
  const gfxDir = join(outDir, 'graphics')
  rmSync(segDir, { recursive: true, force: true })
  mkdirSync(segDir, { recursive: true })
  mkdirSync(gfxDir, { recursive: true })
  const narration = new Map(opts.narration.map((n) => [n.id, n]))
  const tracks = new Map(timeline.tracks.map((t) => [t.id, { ...t }]))
  // The recorder stamps each video with the time its first frame stands for; prefer it to our estimate.
  for (const t of tracks.values()) {
    const p = probe(t.file)
    if (p.creation && Math.abs(p.creation - t.createdAt) < 5000) t.createdAt = p.creation
    log(`track ${t.id}: ${p.duration.toFixed(1)} s, ${p.streams.join('; ')}`)
  }

  const used = timeline.scenes.filter((s) => s.status !== 'skipped')
  const browser: Browser = await chromium.launch()
  const segments: Array<{ scene: SceneWindow; file: string; duration: number }> = []
  try {
    const labels = join(gfxDir, 'labels.png')
    await renderPng(browser, labelsHtml(opts.people), labels)
    const phoneFrame = join(gfxDir, 'phone-frame.png')
    await renderPng(browser, phoneFrameHtml(opts.phoneLabel), phoneFrame)

    for (const [i, scene] of used.entries()) {
      const file = join(segDir, `${String(i + 1).padStart(2, '0')}-${scene.id}.mp4`)
      if (scene.kind === 'card') {
        const html = scene.id.includes('outro') ? outroCardHtml(opts.repoRoot) : titleCardHtml(opts.repoRoot)
        const seconds = scene.durationSec ?? 8
        log(`segment ${scene.id}: card, ${seconds.toFixed(2)} s`)
        await renderCard(browser, html, seconds, file)
        segments.push({ scene, file, duration: seconds })
        continue
      }
      if (scene.start === undefined || scene.end === undefined) continue
      const n = narration.get(scene.id)
      const caption = join(gfxDir, `caption-${scene.id}.png`)
      await renderPng(browser, captionHtml(n?.caption ?? scene.id, CAPTION_BOTTOM[scene.id]), caption)
      const seconds = (scene.end - scene.start) / 1000
      const alex = tracks.get('alex')
      const sam = tracks.get('sam')
      if (!alex || !sam) throw new Error('timeline has no alex/sam tracks')
      const args = [
        ...['-ss', offsetIn(alex, scene.start).toFixed(3), '-t', seconds.toFixed(3), '-i', alex.file],
        ...['-ss', offsetIn(sam, scene.start).toFixed(3), '-t', seconds.toFixed(3), '-i', sam.file],
        ...['-loop', '1', '-framerate', String(FPS), '-t', seconds.toFixed(3), '-i', labels],
        ...['-loop', '1', '-framerate', String(FPS), '-t', seconds.toFixed(3), '-i', caption],
      ]
      // The caption comes in with the scene and leaves soon after its narration, out of the way.
      const capIn = 0.55
      const capOut = Math.max(capIn + 1, Math.min(seconds - 0.95, LEAD_SEC + (n?.durationSec ?? 5) + 0.8))
      const f: string[] = [
        `[0:v]fps=${FPS},scale=${W / 2}:${H}:flags=lanczos,format=rgb24,setsar=1,setpts=PTS-STARTPTS[l]`,
        `[1:v]fps=${FPS},scale=${W / 2}:${H}:flags=lanczos,format=rgb24,setsar=1,setpts=PTS-STARTPTS[r]`,
      ]
      let right = '[r]'
      const phone = tracks.get('phone')
      if (scene.phone && phone) {
        // The client's phone, as an inset over Sam's half, which dims behind it.
        const pStart = Math.max(0, (scene.phone.start - scene.start) / 1000)
        const pEnd = Math.min(seconds, ((scene.phone.end || scene.end) - scene.start) / 1000)
        const pLen = Math.max(0.5, pEnd - pStart)
        args.push(
          ...['-ss', offsetIn(phone, scene.phone.start).toFixed(3), '-t', pLen.toFixed(3), '-i', phone.file],
          ...['-loop', '1', '-framerate', String(FPS), '-t', seconds.toFixed(3), '-i', phoneFrame],
        )
        f.push(
          `[r]drawbox=x=0:y=0:w=iw:h=ih:color=0x0b1020@0.45:t=fill:enable='between(t,${pStart.toFixed(2)},${pEnd.toFixed(2)})'[rd]`,
          `[4:v]fps=${FPS},scale=${PHONE_SCREEN.w}:${PHONE_SCREEN.h}:flags=lanczos,format=rgb24,setsar=1,setpts=PTS-STARTPTS+${pStart.toFixed(3)}/TB[ph]`,
        )
        right = '[rd]'
        f.push(`[l]${right}hstack=inputs=2[base0]`)
        f.push(
          `[base0][ph]overlay=x=${PHONE_SCREEN.x}:y=${PHONE_SCREEN.y}:format=rgb:eof_action=pass:enable='between(t,${pStart.toFixed(2)},${pEnd.toFixed(2)})'[base1]`,
          `[5:v]format=rgba,fade=t=in:st=${pStart.toFixed(2)}:d=0.35:alpha=1,fade=t=out:st=${Math.max(pStart, pEnd - 0.35).toFixed(2)}:d=0.35:alpha=1[pf]`,
          `[base1][pf]overlay=0:0:format=rgb[base]`,
        )
      } else {
        f.push(`[l]${right}hstack=inputs=2[base]`)
      }
      f.push(
        `[2:v]format=rgba[lab]`,
        `[base][lab]overlay=0:0:format=rgb[b2]`,
        `[3:v]format=rgba,fade=t=in:st=${capIn}:d=0.4:alpha=1,fade=t=out:st=${capOut.toFixed(2)}:d=0.4:alpha=1[cap]`,
        `[b2][cap]overlay=0:0:format=rgb,${TO_BT709}[v]`,
      )
      args.push(
        ...['-filter_complex', f.join(';'), '-map', '[v]', '-t', seconds.toFixed(3), '-r', String(FPS)],
        ...['-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-pix_fmt', 'yuv420p', ...BT709_FLAGS],
        ...['-video_track_timescale', '15360'],
        file,
      )
      log(`segment ${scene.id}: ${seconds.toFixed(2)} s from the recordings${scene.phone ? ' + phone' : ''}`)
      await runAsync(args, `segment ${scene.id}`)
      segments.push({ scene, file, duration: probe(file).duration || seconds })
    }
  } finally {
    await browser.close()
  }

  // ---- 2. cross-fades, narration, loudness ----
  const at: number[] = []
  let t = 0
  for (const [i, s] of segments.entries()) {
    at.push(t)
    t += s.duration - (i < segments.length - 1 ? FADE_SEC : 0)
  }
  const total = t
  const clips = segments
    .map((s, i) => ({ n: narration.get(s.scene.id), at: at[i] ?? 0 }))
    .filter((c): c is { n: NarrationScene; at: number } => !!c.n)
  const mixWav = join(outDir, 'narration-mix.wav')
  const audioArgs: string[] = []
  const af: string[] = []
  for (const [k, c] of clips.entries()) {
    audioArgs.push('-i', c.n.audio)
    const ms = Math.round((c.at + (k === 0 ? LEAD_SEC + 0.35 : LEAD_SEC)) * 1000)
    af.push(`[${k}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[a${k}]`)
  }
  af.push(
    `${clips.map((_, k) => `[a${k}]`).join('')}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[mix]`,
  )
  run(
    [...audioArgs, '-filter_complex', af.join(';'), '-map', '[mix]', '-c:a', 'pcm_s16le', mixWav],
    'narration mix',
  )
  const measured = run(
    ['-i', mixWav, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'],
    'loudness measure',
  )
  const m = JSON.parse(measured.slice(measured.lastIndexOf('{'), measured.lastIndexOf('}') + 1)) as Record<
    string,
    string
  >
  const loudnorm = `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`

  const video = join(outDir, 'lobby-demo.mp4')
  const vArgs: string[] = []
  for (const s of segments) vArgs.push('-i', s.file)
  vArgs.push('-i', mixWav)
  const vf: string[] = segments.map((_, i) => `[${i}:v]fps=${FPS},settb=AVTB,setpts=PTS-STARTPTS[s${i}]`)
  let last = '[s0]'
  for (let i = 1; i < segments.length; i++) {
    const offset = (at[i] ?? 0).toFixed(3)
    const out = i === segments.length - 1 ? '[vx]' : `[x${i}]`
    vf.push(`${last}[s${i}]xfade=transition=fade:duration=${FADE_SEC}:offset=${offset}${out}`)
    last = out
  }
  if (segments.length === 1) vf.push('[s0]null[vx]')
  vf.push(
    `[vx]fade=t=in:st=0:d=0.5,fade=t=out:st=${(total - 0.8).toFixed(3)}:d=0.8,format=yuv420p,${BT709_TAGS}[v]`,
  )
  vf.push(
    `[${segments.length}:a]${loudnorm},aresample=48000,afade=t=out:st=${(total - 0.8).toFixed(3)}:d=0.8[a]`,
  )
  log(`final: ${segments.length} segments, ${total.toFixed(1)} s`)
  await runAsync(
    [
      ...vArgs,
      ...['-filter_complex', vf.join(';'), '-map', '[v]', '-map', '[a]'],
      ...['-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS)],
      ...BT709_FLAGS,
      ...['-profile:v', 'high', '-level', '4.1', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000'],
      ...['-movflags', '+faststart', '-t', total.toFixed(3), video],
    ],
    'final encode',
  )

  const scenes: ComposedScene[] = timeline.scenes.map((s) => {
    const i = segments.findIndex((x) => x.scene === s)
    return {
      id: s.id,
      status: s.status,
      note: s.note,
      at: i >= 0 ? +(at[i] ?? 0).toFixed(2) : -1,
      duration: i >= 0 ? +(segments[i]?.duration ?? 0).toFixed(2) : 0,
      narrationSec: narration.get(s.id)?.durationSec ?? 0,
    }
  })

  // ---- 3. contact sheet: one frame per scene, a little past its middle ----
  const contactSheet = join(outDir, 'contact-sheet.png')
  await contactSheetOf(
    video,
    scenes.filter((s) => s.at >= 0),
    contactSheet,
    gfxDir,
  )
  writeFileSync(join(outDir, 'composed.json'), JSON.stringify({ video, total, scenes }, null, 2))
  return { video, contactSheet, durationSec: total, scenes }
}

async function contactSheetOf(video: string, scenes: ComposedScene[], out: string, dir: string) {
  const shots: Array<{ id: string; file: string; at: number }> = []
  for (const s of scenes) {
    const at = s.at + s.duration * 0.62
    const file = join(dir, `frame-${s.id}.jpg`)
    run(['-ss', at.toFixed(2), '-i', video, '-frames:v', '1', '-q:v', '3', file], `frame ${s.id}`)
    shots.push({ id: s.id, file, at })
  }
  const cols = 3
  const tile = { w: 640, h: 360 }
  const rows = Math.ceil(shots.length / cols)
  const html = `<!doctype html><html><head><style>
body { margin: 0; background: #0f1626; font: 600 18px "Segoe UI", sans-serif; color: #fff; }
.g { display: grid; grid-template-columns: repeat(${cols}, ${tile.w}px); gap: 12px; padding: 12px; }
figure { margin: 0; position: relative; }
img { display: block; width: ${tile.w}px; height: ${tile.h}px; }
figcaption { position: absolute; left: 8px; top: 8px; padding: 3px 9px; border-radius: 6px; background: rgba(0,0,0,.65); }
</style></head><body><div class="g">${shots
    .map(
      (s) =>
        `<figure><img src="data:image/jpeg;base64,${readFileSync(s.file).toString('base64')}"><figcaption>${s.id} · ${s.at.toFixed(1)} s</figcaption></figure>`,
    )
    .join('')}</div></body></html>`
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({
      viewport: { width: cols * tile.w + (cols + 1) * 12, height: rows * tile.h + (rows + 1) * 12 },
    })
    await page.setContent(html)
    await page.screenshot({ path: out, fullPage: true })
  } finally {
    await browser.close()
  }
}
