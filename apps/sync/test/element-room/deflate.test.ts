// Wave M (M7-2, CAP-BANDWIDTH): permessage-deflate on the board WebSocket, through the real server process.
//  - A client that offers the extension gets it (the `ws` client, as browsers do), with the server's options;
//  - a client that does not offer it works uncompressed (every frame's RSV1 bit clear);
//  - the gzip snapshot frame is never deflated again (its RSV1 bit clear) while a text frame is;
//  - DRAFTROOM_WS_DEFLATE=off, or the key unset (the hold fails closed): nothing is negotiated, nothing is compressed;
//  - a compressed client frame that inflates past maxPayload (1 MiB) is refused (1009), as an uncompressed one is.
// The frames are read off a raw TCP socket here, so the RSV1 bit (a compressed message) is visible.

import { randomBytes } from 'node:crypto'
import { request } from 'node:http'
import type { Socket } from 'node:net'
import { constants, createInflateRaw, gunzipSync } from 'node:zlib'
import { ELEMENT_SCHEMA_VERSION, PROTO } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { boardSocketTarget } from '../harness/tickets.ts'
import { ticketFor } from './support/client.ts'
import { rect } from './support/elements.ts'
import { type ElementStack, newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
/** Deflate is off unless the key says on (the hold; round-2 refix): the negotiation cases ask for it. */
const DEFLATE_ON = { DRAFTROOM_WS_DEFLATE: 'on' }

interface Frame {
  fin: boolean
  rsv1: boolean
  opcode: number
  payload: Buffer
  /** a text frame's message, inflated when RSV1 is set (null until it has been) */
  text: string | null
}

/** RFC 7692 §7.2.2: the tail every compressed message lost. */
const DEFLATE_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff])

/** A board socket on a raw TCP connection: the handshake by hand, frames parsed (and sent masked) by hand. */
class RawFrames {
  readonly frames: Frame[] = []
  private buf = Buffer.alloc(0)
  readonly socket: Socket
  /** the server's Sec-WebSocket-Extensions answer (undefined: nothing negotiated) */
  readonly extensions: string | undefined
  private constructor(socket: Socket, extensions: string | undefined) {
    this.socket = socket
    this.extensions = extensions
    socket.on('error', () => {}) // a reset when the test or the server ends it
    socket.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d])
      this.parse()
    })
  }

  static open(st: ElementStack, boardId: string, user: string, offerDeflate: boolean): Promise<RawFrames> {
    const { url, protocols } = boardSocketTarget(
      `${st.server.url}/connect/${boardId}?sessionId=raw-${user}`,
      ticketFor(boardId, user),
    )
    return new Promise((resolve, reject) => {
      const req = request(url, {
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          'Sec-WebSocket-Protocol': (protocols ?? []).join(', '),
          ...(offerDeflate
            ? { 'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits' }
            : {}),
        },
      })
      req.on('upgrade', (res, socket, head) => {
        const raw = new RawFrames(socket, res.headers['sec-websocket-extensions'] as string | undefined)
        if (head.length) socket.emit('data', head)
        resolve(raw)
      })
      req.on('response', (res) => reject(new Error(`no upgrade: ${res.statusCode}`)))
      req.on('error', reject)
      req.end()
    })
  }

  private parse(): void {
    for (;;) {
      if (this.buf.length < 2) return
      const b0 = this.buf[0] as number
      const b1 = this.buf[1] as number
      let len = b1 & 0x7f
      let off = 2
      if (len === 126) {
        if (this.buf.length < 4) return
        len = this.buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (this.buf.length < 10) return
        len = Number(this.buf.readBigUInt64BE(2))
        off = 10
      }
      if (this.buf.length < off + len) return
      const frame: Frame = {
        fin: (b0 & 0x80) !== 0,
        rsv1: (b0 & 0x40) !== 0,
        opcode: b0 & 0x0f,
        payload: this.buf.subarray(off, off + len),
        text: null,
      }
      this.frames.push(frame)
      this.buf = this.buf.subarray(off + len)
      if (frame.opcode === 1) this.decode(frame)
    }
  }

  /** One masked text frame (uncompressed: RSV1 clear is always allowed). */
  sendText(text: string): void {
    const payload = Buffer.from(text, 'utf8')
    const mask = randomBytes(4)
    const head =
      payload.length < 126
        ? Buffer.from([0x81, 0x80 | payload.length])
        : payload.length < 65_536
          ? Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff])
          : (() => {
              const b = Buffer.alloc(10)
              b[0] = 0x81
              b[1] = 0x80 | 127
              b.writeBigUInt64BE(BigInt(payload.length), 2)
              return b
            })()
    const masked = Buffer.from(payload.map((v, i) => v ^ (mask[i % 4] as number)))
    this.socket.write(Buffer.concat([head, mask, masked]))
  }

  /**
   * The server keeps its deflate context across messages (server_no_context_takeover is not asked), so every
   * compressed message is inflated by ONE stream for the connection, in arrival order.
   */
  private readonly inflater = createInflateRaw()
  private decoding: Promise<void> = Promise.resolve()
  private decode(f: Frame): void {
    if (!f.rsv1) {
      f.text = f.payload.toString('utf8')
      return
    }
    this.decoding = this.decoding.then(
      () =>
        new Promise<void>((resolve) => {
          const chunks: Buffer[] = []
          const onData = (c: Buffer) => chunks.push(c)
          this.inflater.on('data', onData)
          this.inflater.write(Buffer.concat([f.payload, DEFLATE_TAIL]))
          this.inflater.flush(constants.Z_SYNC_FLUSH, () => {
            this.inflater.off('data', onData)
            f.text = Buffer.concat(chunks).toString('utf8')
            resolve()
          })
        }),
    )
  }

  /** A text message's content ('' until it has been inflated). */
  static text(f: Frame): string {
    return f.text ?? ''
  }

  hello(): void {
    this.sendText(
      JSON.stringify({
        type: 'hello',
        proto: PROTO,
        schema: ELEMENT_SCHEMA_VERSION,
        since: 0,
        epoch: null,
        tab: 'raw',
      }),
    )
  }

  async until(test: () => boolean, what: string, ms = 10_000): Promise<void> {
    const end = Date.now() + ms
    while (!test()) {
      if (Date.now() > end)
        throw new Error(
          `no ${what} within ${ms} ms; got ${JSON.stringify(this.frames.map((f) => [f.opcode, f.rsv1, f.payload.length, f.opcode === 8 ? f.payload.toString('utf8') : f.rsv1 ? '' : f.payload.toString('utf8').slice(0, 80)]))}`,
        )
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  close(): void {
    this.socket.destroy()
    this.inflater.close()
  }
}

/**
 * A board with enough content that its gzip snapshot is well over the 1 KiB threshold (random ids do not compress
 * away), so leaving it uncompressed is the `compress: false`, not the threshold. More than SNAPSHOT_REUSE's 500
 * rows are written after the writer's own join, so the next joiner gets a fresh snapshot with all of them (not the
 * writer's cached empty one and a catch-up).
 */
async function boardWithContent(st: ElementStack): Promise<string> {
  const b = newBoardId()
  const writer = await st.client({ boardId: b, user: 'writer' })
  for (let round = 0; round < 2; round++)
    await writer.create(
      Array.from({ length: 260 }, (_, i) =>
        rect(`seed-${randomBytes(8).toString('hex')}`, { x: i * 40, y: round * 50 }),
      ),
    )
  return b
}

describe('M7-2: permessage-deflate on the board socket', () => {
  it('negotiated with a client that offers it (the ws client, as browsers do), with the server’s options', async () => {
    const st = await h.stack({ env: DEFLATE_ON })
    const b = newBoardId()
    const c = await st.client({ boardId: b, user: 'alice' })
    expect(c.ws.extensions).toBe('permessage-deflate') // the ws client lists the names it negotiated
    // the server's answer, as a browser reads it: the client is asked not to keep its context, the server keeps its own
    const raw = await RawFrames.open(st, b, 'header', true)
    expect(raw.extensions).toMatch(/^permessage-deflate/)
    expect(raw.extensions).toContain('client_no_context_takeover')
    expect(raw.extensions).not.toContain('server_no_context_takeover')
    raw.close()
    // and the protocol works over it: an edit round-trips
    expect((await c.create([rect('over-deflate')])).r[0]).toMatchObject({ ok: true })
    expect(st.server.logs()).toContain('[connect] permessage-deflate on')
  })

  it('the gzip snapshot frame goes uncompressed (RSV1 clear) while a large text frame is deflated', async () => {
    const st = await h.stack({ env: DEFLATE_ON })
    const b = await boardWithContent(st)
    const raw = await RawFrames.open(st, b, 'raw', true)
    expect(raw.extensions).toMatch(/^permessage-deflate/)
    raw.hello()
    await raw.until(() => raw.frames.some((f) => f.opcode === 2), 'the snapshot frame')
    const snap = raw.frames.find((f) => f.opcode === 2) as Frame
    expect(snap.rsv1).toBe(false)
    expect(snap.payload.length).toBeGreaterThan(1024) // over the threshold: left alone on purpose
    expect(gunzipSync(snap.payload).toString('utf8')).toMatch(/^\{"type":"snapshot"/)
    // a `changes` frame of 25 new rectangles (well over 1 KiB) reaches the raw socket deflated
    await raw.until(
      () => raw.frames.some((f) => f.opcode === 1 && RawFrames.text(f).includes('"contracts"')),
      'contracts',
    )
    const writer = await st.client({ boardId: b, user: 'writer2' })
    await writer.create(Array.from({ length: 25 }, (_, i) => rect(`more-${i}`, { y: 400 + i * 10 })))
    await raw.until(
      () => raw.frames.some((f) => f.opcode === 1 && RawFrames.text(f).includes('"more-24"')),
      'the changes frame',
    )
    const changes = raw.frames.find((f) => f.opcode === 1 && RawFrames.text(f).includes('"more-24"')) as Frame
    expect(changes.rsv1).toBe(true)
    expect(changes.payload.length).toBeLessThan(RawFrames.text(changes).length)
    // with the server's context kept, `ws` deflates small frames too (its threshold applies only without context
    // takeover: ws/lib/sender.js); every text frame read back is whole JSON
    for (const f of raw.frames.filter((x) => x.opcode === 1))
      expect(() => JSON.parse(RawFrames.text(f))).not.toThrow()
    raw.close()
  })

  it('a client that does not offer it works uncompressed: no extension, no RSV1 bit, edits reach it', async () => {
    const st = await h.stack({ env: DEFLATE_ON })
    const b = await boardWithContent(st)
    const raw = await RawFrames.open(st, b, 'plain', false)
    expect(raw.extensions).toBeUndefined()
    raw.hello()
    await raw.until(() => raw.frames.some((f) => f.opcode === 2), 'the snapshot frame')
    const writer = await st.client({ boardId: b, user: 'writer2' })
    await writer.create(Array.from({ length: 25 }, (_, i) => rect(`plain-${i}`, { y: i * 10 })))
    await raw.until(
      () => raw.frames.some((f) => f.opcode === 1 && RawFrames.text(f).includes('"plain-24"')),
      'the changes frame',
    )
    expect(raw.frames.every((f) => !f.rsv1)).toBe(true)
    // and a ws client without the extension, too
    const ws = new WebSocket(
      `${st.server.wsUrl}/connect/${b}?sessionId=nodeflate`,
      ['lobby.board.v1', `lobby.ticket.${ticketFor(b, 'nd')}`],
      {
        perMessageDeflate: false,
      },
    )
    await new Promise((r, j) => {
      ws.once('open', r)
      ws.once('error', j)
    })
    expect(ws.extensions).toBe('')
    ws.terminate()
    raw.close()
  })

  it.each([
    ['DRAFTROOM_WS_DEFLATE=off', { DRAFTROOM_WS_DEFLATE: 'off' }],
    ['DRAFTROOM_WS_DEFLATE unset (the default is off)', {}],
  ])('%s: nothing is negotiated, nothing is compressed', async (_name, env: Record<string, string>) => {
    const st = await h.stack({ env })
    const b = await boardWithContent(st)
    const c = await st.client({ boardId: b, user: 'alice' })
    expect(c.ws.extensions).toBe('')
    const raw = await RawFrames.open(st, b, 'raw', true)
    expect(raw.extensions).toBeUndefined()
    raw.hello()
    const writer = await st.client({ boardId: b, user: 'writer2' })
    await writer.create(Array.from({ length: 25 }, (_, i) => rect(`off-${i}`, { y: i * 10 })))
    await raw.until(
      () => raw.frames.some((f) => f.opcode === 1 && RawFrames.text(f).includes('"off-24"')),
      'the changes frame',
    )
    expect(raw.frames.every((f) => !f.rsv1)).toBe(true)
    expect(st.server.logs()).toContain('[connect] permessage-deflate off (DRAFTROOM_WS_DEFLATE is not on)')
    raw.close()
  })

  it('a compressed client frame that inflates past 1 MiB is refused (1009), the server stays up', async () => {
    const st = await h.stack({ env: DEFLATE_ON })
    const b = newBoardId()
    const c = await st.client({ boardId: b, user: 'bomber' })
    // 2 MiB of one byte compresses to a few KiB on the wire
    c.ws.send(`{"type":"ping","pad":"${'a'.repeat(2 * 1024 * 1024)}"}`, { compress: true })
    expect((await c.untilClosed(10_000)).code).toBe(1009)
    const ok = await st.client({ boardId: b, user: 'after' })
    expect((await ok.create([rect('still-up')])).r[0]).toMatchObject({ ok: true })
  })
})
