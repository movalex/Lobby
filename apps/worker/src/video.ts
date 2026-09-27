// Video: validate with ffprobe, extract a poster with ffmpeg. Both run as child processes with
// hardened input options and timeouts. M0 plays originals in a plain <video>, so only what
// browsers play everywhere is accepted: H.264 (Baseline/Main/High, 8-bit 4:2:0) + AAC or no audio.
import { LIMITS } from '@draftroom/dev-assets'
import { PREVIEW } from './config.ts'
import type { DerivativeWriter } from './derivatives.ts'
import { AbortedError, PreviewError, TransientError } from './errors.ts'
import type { Derived } from './image.ts'
import { toWebp } from './image.ts'
import { scanTopLevelBoxes } from './mp4-boxes.ts'
import { type RunResult, run, stderrTail } from './run.ts'

// Force the MP4/MOV demuxer so a disguised HLS/concat/image2 input is never auto-probed, allow only
// the file protocol (no network fetches), and pin external data references off (the 9.0.1 defaults,
// pinned for older builds such as Debian's 7.1).
const INPUT_HARDENING = [
  '-protocol_whitelist',
  'file',
  '-f',
  'mov',
  '-enable_drefs',
  '0',
  '-use_absolute_path',
  '0',
]

const H264_PROFILES = new Set(['Constrained Baseline', 'Baseline', 'Main', 'High'])
const PIX_FMTS = new Set(['yuv420p', 'yuvj420p'])

export interface VideoOptions {
  ffmpegPath?: string
  ffprobePath?: string
  probeTimeoutMs?: number
  posterTimeoutMs?: number
  signal?: AbortSignal
}

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  profile?: string
  pix_fmt?: string
  width?: number
  height?: number
  duration?: string
  disposition?: { attached_pic?: number }
  side_data_list?: { rotation?: number }[]
}
interface ProbeJson {
  format?: { format_name?: string; duration?: string; tags?: { major_brand?: string } }
  streams?: ProbeStream[]
}

export const ffmpegPath = (o: VideoOptions) => o.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg'
export const ffprobePath = (o: VideoOptions) => o.ffprobePath ?? process.env.FFPROBE_PATH ?? 'ffprobe'

function checkRun(tool: string, r: RunResult, invalid: PreviewError) {
  if (r.aborted) throw new AbortedError()
  if (r.timedOut) throw new PreviewError('TIMEOUT', `${tool} killed after ${r.ms} ms`)
  if (r.spawnError)
    throw new TransientError(`${tool} could not start (${r.spawnError}); check FFMPEG_PATH/FFPROBE_PATH`)
  if (r.overflow) throw invalid
  if (r.code !== 0)
    throw new PreviewError(invalid.code, `${tool} exit ${r.code}: ${stderrTail(r.stderr)}`, invalid.probe)
}

export async function deriveVideo(
  input: string,
  writer: DerivativeWriter,
  opts: VideoOptions = {},
): Promise<Derived> {
  // A faststart file cut short still probes fine and yields a poster; the box scan catches it.
  const boxes = await scanTopLevelBoxes(input)
  if (boxes.corrupt || boxes.truncated) {
    throw new PreviewError('VIDEO_INVALID', boxes.corrupt ? 'corrupt box header' : 'truncated')
  }

  const pr = await run(
    ffprobePath(opts),
    [
      '-v',
      'error',
      '-hide_banner',
      ...INPUT_HARDENING,
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      input,
    ],
    {
      timeoutMs: opts.probeTimeoutMs ?? PREVIEW.probeTimeoutMs,
      maxStdoutBytes: PREVIEW.maxProbeStdoutBytes,
      signal: opts.signal,
    },
  )
  checkRun('ffprobe', pr, new PreviewError('VIDEO_INVALID', 'probe output too large'))
  let probe: ProbeJson
  try {
    probe = JSON.parse(pr.stdout.toString('utf8')) as ProbeJson
  } catch {
    throw new PreviewError('VIDEO_INVALID', 'unparseable probe output')
  }
  const facts = validate(probe)

  // Poster: input-side seek (fast) to min(1 s, duration/2), one frame, PNG on stdout.
  const seek = Math.min(1, (facts.durationMs ?? 0) / 2000)
  const fr = await run(
    ffmpegPath(opts),
    [
      '-nostdin',
      '-hide_banner',
      '-v',
      'error',
      ...INPUT_HARDENING,
      '-ss',
      seek.toFixed(3),
      '-i',
      input,
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      '-dn',
      '-frames:v',
      '1',
      '-vf',
      `scale='min(${PREVIEW.posterMaxEdge},iw)':-2`,
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      'pipe:1',
    ],
    {
      timeoutMs: opts.posterTimeoutMs ?? PREVIEW.posterTimeoutMs,
      maxStdoutBytes: PREVIEW.maxPosterStdoutBytes,
      signal: opts.signal,
    },
  )
  checkRun('ffmpeg', fr, new PreviewError('VIDEO_INVALID', 'poster too large', facts))
  if (fr.stdout.length === 0) throw new PreviewError('VIDEO_INVALID', 'no frame decoded', facts)
  let poster: Awaited<ReturnType<typeof toWebp>>
  try {
    poster = await toWebp(fr.stdout, PREVIEW.posterMaxEdge, PREVIEW.displayQuality)
  } catch {
    throw new PreviewError('VIDEO_INVALID', 'poster frame unreadable', facts)
  }
  const thumb = await toWebp(poster.data, PREVIEW.thumbEdge, PREVIEW.thumbQuality)
  const derivatives = [
    await writer.write({ role: 'poster', page: null, ...poster }),
    await writer.write({ role: 'thumb', page: null, ...thumb }),
  ]
  return { probe: facts, derivatives }
}

interface VideoFacts {
  durationMs: number | null
  width: number | null
  height: number | null
  videoCodec: string | null
  audioCodec: string | null
  [k: string]: number | string | null
}

/** Throws UNSUPPORTED_CODEC / VIDEO_INVALID / VIDEO_TOO_LONG; the facts travel with the error so the card can still show them. */
export function validate(p: ProbeJson): VideoFacts {
  const streams = p.streams ?? []
  const video = streams.filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = streams.filter((s) => s.codec_type === 'audio')
  const v = video[0]
  const a = audio[0]
  const rotation = Math.abs(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0) % 180
  const rawMs = Math.round(Number(p.format?.duration ?? v?.duration ?? Number.NaN) * 1000)
  const facts: VideoFacts = {
    durationMs: Number.isFinite(rawMs) && rawMs > 0 ? rawMs : null,
    // Displayed size: a 90° rotation tag swaps the coded dimensions (ffmpeg auto-rotates the poster too).
    width: (rotation === 90 ? v?.height : v?.width) ?? null,
    height: (rotation === 90 ? v?.width : v?.height) ?? null,
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
  }
  if (!v) throw new PreviewError('VIDEO_INVALID', 'no video stream', facts)
  if (facts.durationMs === null) throw new PreviewError('VIDEO_INVALID', 'unknown duration', facts)

  const problems: string[] = []
  if (!/mp4|mov/.test(p.format?.format_name ?? '')) problems.push(`container ${p.format?.format_name}`)
  // Classic QuickTime (.mov 'qt  ' brand) needs a proxy transcode in M0 (research decision).
  if (p.format?.tags?.major_brand?.trim() === 'qt') problems.push('quicktime brand')
  if (video.length !== 1) problems.push(`${video.length} video streams`)
  if (audio.length > 1) problems.push(`${audio.length} audio streams`)
  if (v.codec_name !== 'h264') problems.push(`video ${v.codec_name}`)
  else if (!H264_PROFILES.has(v.profile ?? '')) problems.push(`h264 profile ${v.profile}`)
  if (!PIX_FMTS.has(v.pix_fmt ?? '')) problems.push(`pix_fmt ${v.pix_fmt}`)
  if ((v.width ?? 0) > PREVIEW.maxVideoWidth || (v.height ?? 0) > PREVIEW.maxVideoHeight) {
    problems.push(`${v.width}x${v.height}`)
  }
  if (a && a.codec_name !== 'aac') problems.push(`audio ${a.codec_name}`)
  if (problems.length) throw new PreviewError('UNSUPPORTED_CODEC', problems.join(', '), facts)
  if (facts.durationMs > LIMITS.maxVideoDurationMs) {
    throw new PreviewError('VIDEO_TOO_LONG', `${facts.durationMs} ms`, facts)
  }
  return facts
}
