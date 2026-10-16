import { type AssetKind, designUploadFormat, isOfficeUpload } from '@draftroom/dev-assets'

/**
 * Wave T (WS3, docs/WAVE-T-CONTRACTS.md §1): the audio types an attachment (kind 'other') may be served inline with,
 * for a storyboard's sound track (the animatic plays it in an <audio> element). Only these four, and only when the
 * upload's first bytes say so (`audioUploadMime`): anything else of kind 'other' stays an octet-stream attachment.
 */
export const AUDIO_MIMES = ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg'] as const
export type AudioMime = (typeof AUDIO_MIMES)[number]

/**
 * The only types ever served inline for each previewable kind; anything else is an attachment. Office
 * documents are kind 'pdf' (previewed as the pages of their PDF conversion) but their own types are
 * deliberately NOT here: the original is always a download, never rendered by the browser. Attachments
 * ('other') are inline only as one of the four byte-checked audio types (wave T).
 */
export const INLINE_MIMES: Record<AssetKind, readonly string[]> = {
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  pdf: ['application/pdf'],
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
  other: AUDIO_MIMES,
}

export const DERIVATIVE_MIMES: readonly string[] = ['image/webp', 'image/png']

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  // wave T: audio attachments (byte-checked at upload: audioUploadMime)
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
}

/** What browsers and systems declare for the four audio types (Windows says audio/x-m4a, older ones audio/x-wav). */
const AUDIO_ALIASES: Record<string, AudioMime> = {
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/mpeg3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/mp4': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'audio/wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/ogg': 'audio/ogg',
  'application/ogg': 'audio/ogg',
}

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/

/** The client's Content-Type reduced to a well-formed `type/subtype`, or octet-stream. Untrusted either way. */
export function normalizeDeclaredMime(raw: string | undefined): string {
  const base = (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return MIME_RE.test(base) ? base : 'application/octet-stream'
}

/**
 * How a 413 names what the size limit is for, when that is not the kind's usual label: an Office
 * document (LIMITS.maxOfficeBytes, see dev-assets maxUploadBytes) is kind 'pdf' but not a PDF, nor are
 * Photoshop, Illustrator and TIFF files (their own limits: dev-assets DESIGN_FORMATS); HEIC is an attachment.
 */
export function uploadLimitLabel(kind: AssetKind, declared: string, name: string): string | null {
  if (isOfficeUpload(kind, declared, name)) return 'Office documents'
  const design = designUploadFormat(kind, declared, name)
  return design ? `${design.kind.toUpperCase()} files` : null
}

/**
 * The type the original is served with until the worker confirms it by content: the declared type
 * when it is allowlisted for the kind, else the extension's, else octet-stream. For an attachment this is only
 * what the upload CLAIMS (an audio type by its declared type or extension): the upload route keeps it only when the
 * first bytes agree (`audioUploadMime`), because the worker never looks at an attachment.
 */
export function initialServedMime(kind: AssetKind, declared: string, name: string): string {
  const allowed = INLINE_MIMES[kind]
  const claimed = kind === 'other' ? (AUDIO_ALIASES[declared] ?? declared) : declared
  if (allowed.includes(claimed)) return claimed
  const byExt = EXT_MIME[name.toLowerCase().split('.').pop() ?? '']
  return byExt && allowed.includes(byExt) ? byExt : 'application/octet-stream'
}

/** How many first bytes `sniffAudio` reads (the route keeps no more of the body). */
export const AUDIO_SNIFF_BYTES = 16

const ascii = (b: Uint8Array, at: number, s: string) => {
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false
  return true
}

/** The ISO base media brands of an audio-only MPEG-4 file (iTunes M4A/M4B and the generic brands encoders write). */
const M4A_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'mp41', 'mp42', 'isom', 'iso2', 'dash'])

/**
 * The audio type the first bytes of a file say it is, or null: `ID3` (an ID3v2 tag) or an MPEG audio frame sync
 * (11 set bits, a layer that is not "reserved", so not ADTS AAC either) for MP3; an `ftyp` box with an M4A brand;
 * `RIFF` … `WAVE`; `OggS`. A header only: it says the file is not something else (HTML, a script, an image)
 * pretending, not that every byte after it is good audio (the browser's decoder is the judge of that).
 */
export function sniffAudio(head: Uint8Array): AudioMime | null {
  if (head.length >= 3 && ascii(head, 0, 'ID3')) return 'audio/mpeg'
  if (head.length >= 2 && head[0] === 0xff && ((head[1] as number) & 0xe0) === 0xe0) {
    const version = ((head[1] as number) >> 3) & 0b11
    const layer = ((head[1] as number) >> 1) & 0b11
    if (version !== 0b01 && layer !== 0b00) return 'audio/mpeg'
  }
  if (head.length >= 12 && ascii(head, 4, 'ftyp')) {
    const brand = String.fromCharCode(...head.subarray(8, 12))
    return M4A_BRANDS.has(brand) ? 'audio/mp4' : null
  }
  if (head.length >= 12 && ascii(head, 0, 'RIFF') && ascii(head, 8, 'WAVE')) return 'audio/wav'
  if (head.length >= 4 && ascii(head, 0, 'OggS')) return 'audio/ogg'
  return null
}

/**
 * The type an upload is stored (and so served) with: `initialServedMime`, except that an attachment claiming one of
 * the four audio types keeps it only when its first bytes (`head`) are that type; any other claim, or bytes that
 * disagree (an HTML page named `.mp3`, a WAV named `.ogg`), is an octet-stream attachment.
 */
export function uploadServedMime(kind: AssetKind, declared: string, name: string, head: Uint8Array): string {
  const claimed = initialServedMime(kind, declared, name)
  if (kind !== 'other' || claimed === 'application/octet-stream') return claimed
  return sniffAudio(head) === claimed ? claimed : 'application/octet-stream'
}
