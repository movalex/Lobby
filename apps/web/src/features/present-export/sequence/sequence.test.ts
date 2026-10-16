// Wave T (WS3): the image sequence's files in Node: the store-only ZIP (read back by an independent reader with Node's
// own CRC-32, and by `unzip -t` when the machine has it), the frame spans (cumulative, never drifting), timings.csv and
// animatic.edl golden files.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 as nodeCrc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { storyboardById } from '../../storyboard-play/model.ts'
import { sceneOf, storyboardEls } from '../../storyboard-play/test-kit.ts'
import { frameSize } from './build.ts'
import { animaticEdl, frameName, frameSpans, timecode, timingsCsv } from './timings.ts'
import { crc32, dosDateTime, StoreZip, ZipError } from './zip.ts'

interface Entry {
  name: string
  data: Buffer
  crc: number
  flags: number
  method: number
}

/** An independent reader: the end record, the central directory, each local header and its bytes. */
function readZip(buf: Buffer): Entry[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(eocd).toBe(buf.length - 22)
  const count = buf.readUInt16LE(eocd + 10)
  const dirSize = buf.readUInt32LE(eocd + 12)
  let at = buf.readUInt32LE(eocd + 16)
  expect(at + dirSize).toBe(eocd)
  const out: Entry[] = []
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50)
    const method = buf.readUInt16LE(at + 10)
    const crc = buf.readUInt32LE(at + 16)
    const size = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const flags = buf.readUInt16LE(at + 8)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    expect(buf.readUInt32LE(local)).toBe(0x04034b50)
    expect(buf.readUInt32LE(local + 14)).toBe(crc)
    expect(buf.readUInt32LE(local + 18)).toBe(size)
    const localName = buf.readUInt16LE(local + 26)
    const extra = buf.readUInt16LE(local + 28)
    const start = local + 30 + localName + extra
    out.push({ name, data: buf.subarray(start, start + size), crc, flags, method })
    at += 46 + nameLen
  }
  return out
}

describe('the store-only ZIP', () => {
  it('CRC-32 matches Node’s', () => {
    for (const s of ['', 'a', 'hello world', 'é'.repeat(1000)]) {
      const b = Buffer.from(s)
      expect(crc32(b)).toBe(nodeCrc32(b))
    }
    const big = Buffer.alloc(300_000)
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff
    expect(crc32(big)).toBe(nodeCrc32(big))
  })

  it('stored entries (bytes and Blobs), UTF-8 names flagged, read back whole with their CRCs', async () => {
    const zip = new StoreZip(new Date('2026-10-16T12:34:56Z'))
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    await zip.add('Spot 30_0001.png', png)
    await zip.add('Café_0002.png', new Blob([new Uint8Array([9, 8, 7])]))
    await zip.add('timings.csv', new TextEncoder().encode('Shot\r\n1\r\n'))
    const buf = Buffer.from(await zip.finish().arrayBuffer())
    const entries = readZip(buf)
    expect(entries.map((e) => e.name)).toEqual(['Spot 30_0001.png', 'Café_0002.png', 'timings.csv'])
    for (const e of entries) {
      expect(e.method).toBe(0)
      expect(e.crc).toBe(nodeCrc32(e.data))
    }
    expect([...(entries[0]?.data ?? [])]).toEqual([...png])
    expect(entries[1]?.flags).toBe(0x0800)
    expect(entries[0]?.flags).toBe(0)
    expect(dosDateTime(new Date('2026-10-16T12:34:56Z'))).toEqual({
      time: (12 << 11) | (34 << 5) | 28,
      date: ((2026 - 1980) << 9) | (10 << 5) | 16,
    })

    // a second opinion when this machine has Info-ZIP's unzip (Git Bash, macOS, Linux)
    let unzip = true
    try {
      execFileSync('unzip', ['-v'], { stdio: 'ignore' })
    } catch {
      unzip = false
    }
    if (unzip) {
      const dir = mkdtempSync(join(tmpdir(), 'lobby-zip-'))
      try {
        const file = join(dir, 'seq.zip')
        writeFileSync(file, buf)
        const report = execFileSync('unzip', ['-t', file], { encoding: 'utf8' })
        expect(report).toMatch(/No errors detected/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('refuses unsafe and duplicate names', async () => {
    const zip = new StoreZip()
    for (const bad of ['', '/abs.png', '../up.png', 'a//b.png', 'a\\b.png', 'nul\0.png'])
      await expect(zip.add(bad, new Uint8Array())).rejects.toBeInstanceOf(ZipError)
    await zip.add('a.png', new Uint8Array([1]))
    await expect(zip.add('a.png', new Uint8Array([1]))).rejects.toBeInstanceOf(ZipError)
  })
})

describe('frames and timecodes', () => {
  it('cumulative boundaries: a panel’s frames never drift from the running time; at least one frame each', () => {
    const panels = [
      { startMs: 0, durationMs: 1010 },
      { startMs: 1010, durationMs: 1010 },
      { startMs: 2020, durationMs: 1010 },
      { startMs: 3030, durationMs: 10 },
    ]
    expect(frameSpans(panels, 24)).toEqual([
      { first: 0, end: 24 },
      { first: 24, end: 48 },
      { first: 48, end: 73 },
      { first: 73, end: 74 },
    ])
    expect(timecode(0, 24)).toBe('00:00:00:00')
    expect(timecode(24 * 3661 + 5, 24)).toBe('01:01:01:05')
    expect(timecode(29, 30)).toBe('00:00:00:29')
    expect(frameName('Spot 30', 7)).toBe('Spot 30_0007.png')
    expect(frameName('x', 12345)).toBe('x_12345.png')
    expect(frameSize(1920, 16 / 9)).toEqual({ w: 1920, h: 1080 })
    expect(frameSize(1280, 2.39)).toEqual({ w: 1280, h: 536 })
    expect(frameSize(1280, 9 / 16)).toEqual({ w: 1280, h: 2276 })
  })
})

describe('timings.csv and animatic.edl (golden)', () => {
  const scene = sceneOf([
    ...storyboardEls(
      'h1',
      [
        {
          id: 'p1',
          pos: 'a0',
          dur: 2000,
          name: 'Open',
          fields: { camera: 'WIDE', dialogue: 'Hello, "you"' },
        },
        { id: 'p2', pos: 'a1', dur: 1500, fields: { action: '=SUM(A1)', sfx: 'Door' } },
        { id: 'p3', pos: 'a2', dur: 2500, fields: { music: 'Strings', dialogue: 'Line\nbreak' } },
      ],
      { aspect: '16:9', fps: 25, audio: 'snd', audioOffsetMs: 500 },
    ),
    {
      ...storyboardEls('x', [])[0],
      id: 'snd',
      type: 'image',
      customData: {
        lobby: {
          file: {
            assetId: 'ast_a',
            versionId: 'ver_a',
            kind: 'other',
            name: 'vo.mp3',
            mimeType: 'audio/mpeg',
            sizeBytes: 1,
          },
        },
      },
    } as never,
  ])
  const view = storyboardById(scene, 'h1')
  if (!view) throw new Error('no storyboard')

  it('timings.csv: one row per panel, escaped, with a BOM and CRLF', () => {
    expect(timingsCsv(view, 'Spot 30', 25)).toBe(
      [
        '﻿Shot,File,Start,End,Duration (s),Duration (frames),Name,Camera,Action,Dialogue,SFX,Music',
        '1,Spot 30_0001.png,00:00:00:00,00:00:02:00,2,50,Open,WIDE,,"Hello, ""you""",,',
        "2,Spot 30_0002.png,00:00:02:00,00:00:03:13,1.5,38,,,'=SUM(A1),,Door,",
        '3,Spot 30_0003.png,00:00:03:13,00:00:06:00,2.5,62,,,,Line break,,Strings',
        '',
      ].join('\r\n'),
    )
  })

  it('animatic.edl: CMX3600, one event per panel back to back, the sound as a note', () => {
    expect(animaticEdl(view, 'Spot 30', 25)).toBe(
      [
        'TITLE: Spot 30',
        'FCM: NON-DROP FRAME',
        '',
        '001  AX       V     C        00:00:00:00 00:00:02:00 00:00:00:00 00:00:02:00',
        '* FROM CLIP NAME: Spot 30_0001.png',
        '* COMMENT: SH 01 - Open - Hello, "you"',
        '',
        '002  AX       V     C        00:00:00:00 00:00:01:13 00:00:02:00 00:00:03:13',
        '* FROM CLIP NAME: Spot 30_0002.png',
        '* COMMENT: SH 02',
        '',
        '003  AX       V     C        00:00:00:00 00:00:02:12 00:00:03:13 00:00:06:00',
        '* FROM CLIP NAME: Spot 30_0003.png',
        '* COMMENT: SH 03 - Line break',
        '',
        '* SOUND: vo.mp3 (starting 0.5 s in)',
        '',
      ].join('\r\n'),
    )
  })

  it('at 24 and 30 fps the record times follow the running time', () => {
    for (const fps of [24, 30] as const) {
      const edl = animaticEdl(view, 'S', fps)
      expect(edl).toContain(`00:00:06:00`)
      expect(edl.split('\r\n').filter((l) => /^\d{3} {2}AX/.test(l))).toHaveLength(3)
    }
  })
})
