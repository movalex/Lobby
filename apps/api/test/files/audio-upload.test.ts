// Wave T (WS3, docs/WAVE-T-CONTRACTS.md §1): audio attachments for a storyboard's sound track. MP3, M4A, WAV and OGG
// uploads are kind 'other' (no worker step) and are served inline with their audio type only when their first bytes
// say so; anything else claiming an audio type (an HTML page named .mp3, a WAV named .ogg) is an octet-stream
// attachment, and every original keeps nosniff and the sandbox.
import type { AssetVersionMeta } from '@draftroom/dev-assets'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AUDIO_MIMES,
  INLINE_MIMES,
  initialServedMime,
  sniffAudio,
  uploadServedMime,
} from '../../src/files/mime.ts'
import { req, startApp, type TestApp, upload } from './helpers.ts'

const bytes = (...parts: (string | number[])[]) =>
  Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))))
const pad = (b: Buffer, n = 256) => Buffer.concat([b, Buffer.alloc(Math.max(0, n - b.length), 0x55)])

const MP3_ID3 = pad(bytes('ID3', [4, 0, 0, 0, 0, 0, 0]))
// an MPEG-1 Layer III frame header with no tag (0xFFFB)
const MP3_FRAME = pad(bytes([0xff, 0xfb, 0x90, 0x64]))
const M4A = pad(bytes([0, 0, 0, 0x20], 'ftypM4A ', [0, 0, 0, 0], 'M4A mp42isom'))
const WAV = pad(bytes('RIFF', [0x24, 0, 0, 0], 'WAVEfmt '))
const OGG = pad(bytes('OggS', [0, 2, 0, 0, 0, 0, 0, 0, 0, 0]))
const HTML = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>')

describe('sniffAudio (pure)', () => {
  it('names each of the four by its first bytes', () => {
    expect(sniffAudio(MP3_ID3)).toBe('audio/mpeg')
    expect(sniffAudio(MP3_FRAME)).toBe('audio/mpeg')
    expect(sniffAudio(M4A)).toBe('audio/mp4')
    expect(sniffAudio(WAV)).toBe('audio/wav')
    expect(sniffAudio(OGG)).toBe('audio/ogg')
  })

  it('refuses everything else: HTML, an ADTS AAC header (layer 00), a video ftyp brand, RIFF that is not WAVE, nothing', () => {
    expect(sniffAudio(HTML)).toBeNull()
    expect(sniffAudio(bytes([0xff, 0xf1, 0x50, 0x80]))).toBeNull()
    expect(sniffAudio(pad(bytes([0, 0, 0, 0x18], 'ftypqt  ')))).toBeNull()
    expect(sniffAudio(pad(bytes('RIFF', [0, 0, 0, 0], 'AVI ')))).toBeNull()
    expect(sniffAudio(new Uint8Array())).toBeNull()
    expect(sniffAudio(bytes('ID'))).toBeNull()
  })

  it('an attachment is inline only as one of the four; aliases and extensions claim, the bytes decide', () => {
    expect([...INLINE_MIMES.other]).toEqual([...AUDIO_MIMES])
    expect(initialServedMime('other', 'audio/x-m4a', 'take.m4a')).toBe('audio/mp4')
    expect(initialServedMime('other', 'application/octet-stream', 'vo.MP3')).toBe('audio/mpeg')
    expect(initialServedMime('other', 'text/html', 'page.html')).toBe('application/octet-stream')
    expect(uploadServedMime('other', 'audio/mpeg', 'vo.mp3', MP3_ID3)).toBe('audio/mpeg')
    expect(uploadServedMime('other', 'audio/mpeg', 'vo.mp3', HTML)).toBe('application/octet-stream')
    // a WAV named .ogg is not served as Ogg
    expect(uploadServedMime('other', 'audio/ogg', 'vo.ogg', WAV)).toBe('application/octet-stream')
    // other kinds are untouched
    expect(uploadServedMime('image', 'image/png', 'a.png', HTML)).toBe('image/png')
  })
})

let t: TestApp
beforeAll(async () => {
  t = await startApp()
})
afterAll(async () => {
  await t.stop()
})
beforeEach(() => {
  t.auth.roles = { 'board-a': 'editor' }
})

const original = (m: AssetVersionMeta) => `/files/${m.assetId}/${m.versionId}/original?board=${m.boardId}`

describe('audio uploads (the route)', () => {
  const cases = [
    ['audio/mpeg', 'voice over.mp3', MP3_ID3, 'audio/mpeg'],
    ['audio/mpeg', 'frames.mp3', MP3_FRAME, 'audio/mpeg'],
    ['audio/x-m4a', 'scratch.m4a', M4A, 'audio/mp4'],
    ['audio/wav', 'temp.wav', WAV, 'audio/wav'],
    ['application/octet-stream', 'music.ogg', OGG, 'audio/ogg'],
  ] as const

  it('MP3, M4A, WAV and OGG are kind other, stored with their audio type and served inline (nosniff, sandboxed)', async () => {
    for (const [type, name, body, served] of cases) {
      const up = await upload(t.port, { type, name, body })
      expect(up.status, name).toBe(201)
      const meta = up.json<AssetVersionMeta>()
      expect(meta, name).toMatchObject({ kind: 'other', mimeType: served })
      const got = await req(t.port, { path: original(meta) })
      expect(got.status, name).toBe(200)
      expect(got.headers['content-type'], name).toBe(served)
      expect(got.headers['content-disposition'], name).toMatch(/^inline/)
      expect(got.headers['x-content-type-options'], name).toBe('nosniff')
      expect(got.headers['content-security-policy'], name).toBe("sandbox; default-src 'none'")
      expect(Buffer.compare(got.body, body), name).toBe(0)
      // ranges, as an <audio> element seeks
      const part = await req(t.port, { path: original(meta), headers: { range: 'bytes=0-3' } })
      expect(part.status, name).toBe(206)
      expect(part.headers['content-type'], name).toBe(served)
    }
  })

  it('a disguised file (HTML named .mp3 and typed audio/mpeg) is an octet-stream attachment', async () => {
    const up = await upload(t.port, { type: 'audio/mpeg', name: 'track.mp3', body: HTML })
    expect(up.status).toBe(201)
    const meta = up.json<AssetVersionMeta>()
    expect(meta).toMatchObject({ kind: 'other', mimeType: 'application/octet-stream' })
    const got = await req(t.port, { path: original(meta) })
    expect(got.status).toBe(200)
    expect(got.headers['content-type']).toBe('application/octet-stream')
    expect(got.headers['content-disposition']).toMatch(/^attachment/)
    expect(got.headers['x-content-type-options']).toBe('nosniff')
  })

  it('bytes of the wrong audio type, an empty file and a file shorter than the header are attachments too', async () => {
    for (const [type, name, body] of [
      ['audio/ogg', 'vo.ogg', WAV],
      ['audio/mpeg', 'empty.mp3', Buffer.alloc(0)],
      ['audio/wav', 'short.wav', Buffer.from('RIFF')],
    ] as const) {
      const up = await upload(t.port, { type, name, body })
      expect(up.status, name).toBe(201)
      expect(up.json<AssetVersionMeta>(), name).toMatchObject({
        kind: 'other',
        mimeType: 'application/octet-stream',
      })
    }
  })

  it('other attachments are unchanged: a zip stays an octet-stream attachment', async () => {
    const up = await upload(t.port, { type: 'application/zip', name: 'x.zip', body: OGG })
    expect(up.json<AssetVersionMeta>()).toMatchObject({ kind: 'other', mimeType: 'application/octet-stream' })
  })
})
