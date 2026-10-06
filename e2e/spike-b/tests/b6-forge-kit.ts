// O1's helpers for the forged-frame specs (b3-l8-*, b4-server-*, b5-r1-*, b5-r4-*, b6-*): a raw socket
// opened INSIDE a page with the page's own ticket (O3's `harness.forgeSocket`), a hello, pushes with the
// socket's current clock as `base`, and element reads from the test snapshot. Not a spec (Playwright runs
// only *.spec.ts); owned by O1 with the b6-* specs.

import type { Page } from '@playwright/test'
import type { Ack, ClientMessage, Welcome } from '../../../packages/canvas-schema/src/protocol.ts'
import { harness } from '../support/harness.ts'
import type { ForgeSocket, SpikeBStack } from '../support/types.ts'

export interface Forged {
  readonly socket: ForgeSocket
  readonly welcome: Welcome
  /** the latest clock this socket has seen (welcome, changes, acks) */
  clock(): Promise<number>
  /** sends a push (base = the socket's clock unless given) and returns its ack */
  push(ops: readonly unknown[], extra?: { base?: number; doc?: unknown }): Promise<Ack>
  send(frame: ClientMessage | string): Promise<void>
}

let seq = 0

/** A forged socket that said hello (the page's own ticket; nothing of the page's client code runs on it). */
export async function forge(page: Page, boardId: string): Promise<Forged> {
  const socket = await harness.forgeSocket(page, boardId)
  await socket.send({
    type: 'hello',
    proto: 1,
    schema: 1,
    since: 0,
    epoch: null,
    tab: `forge-${Math.random().toString(36).slice(2, 10)}`,
  })
  const welcome = await socket.next('welcome', 20_000)
  const clock = async () => {
    let c = welcome.clock
    for (const m of await socket.messages())
      if (m.type === 'changes' || m.type === 'ack' || m.type === 'welcome') c = Math.max(c, m.clock)
    return c
  }
  return {
    socket,
    welcome,
    clock,
    send: (f) => socket.send(f),
    async push(ops, extra = {}) {
      const s = ++seq
      await socket.send({
        type: 'push',
        seq: s,
        base: extra.base ?? (await clock()),
        ops,
        ...(extra.doc !== undefined ? { doc: extra.doc } : {}),
      } as unknown as ClientMessage)
      // read acks without consuming them, so concurrent pushes on one socket each find their own
      const deadline = Date.now() + 30_000
      for (;;) {
        const ack = (await socket.messages()).find((m) => m.type === 'ack' && m.seq === s)
        if (ack) return ack as Ack
        if (Date.now() > deadline) throw new Error(`no ack for push ${s}`)
        await new Promise((r) => setTimeout(r, 25))
      }
    },
  }
}

/** One element of the board as stored now (the test snapshot), or null. */
export async function storedElement(
  stack: SpikeBStack,
  boardId: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const snap = await harness.readSnapshot(stack, boardId)
  return (snap.elements.find((e) => e.id === id) as Record<string, unknown> | undefined) ?? null
}

/** Result codes of an ack, in op order (`ok` for accepted ops). */
export const codes = (ack: Ack): string[] => ack.r.map((r) => (r.ok ? 'ok' : r.code))

/** A plain rectangle of the strict schema (roughness 0, index left to the server). */
export function rectEl(id: string, o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roundness: null,
    roughness: 0,
    opacity: 100,
    seed: 1,
    version: 1,
    versionNonce: 1,
    index: null,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: 1,
    created: 1,
    link: null,
    locked: false,
    ...o,
  }
}

/** A text element (free, or a label when `containerId` is set). */
export function textEl(id: string, o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...rectEl(id),
    type: 'text',
    width: 60,
    height: 25,
    fontSize: 20,
    fontFamily: 5,
    baseFontSize: null,
    text: 'forged',
    originalText: 'forged',
    textAlign: 'left',
    verticalAlign: 'top',
    containerId: null,
    autoResize: true,
    lineHeight: 1.25,
    ...o,
  }
}

/**
 * A raw socket inside `page` (the page's own ticket, from the api like harness.forgeSocket) that can send
 * MANY frames in one page task, so a burst of pushes reaches sync together and the drain commits it in
 * 64-push batches (B4 D3). Acks are collected in the page; nothing of the page's client runs on it.
 */
export interface BurstSocket {
  /** sends every frame of `frames` in one task (after the hello's welcome) */
  burst(frames: readonly unknown[]): Promise<void>
  /** the ids of every op acked `ok` so far */
  acked(): Promise<string[]>
  /** the socket's server clock at the welcome */
  readonly clock: number
}

let burstSeq = 0

export async function burstSocket(page: Page, boardId: string): Promise<BurstSocket> {
  const key = `o1burst${++burstSeq}${Date.now().toString(36)}`
  const clock = await page.evaluate(
    async ({ boardId, key }) => {
      const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/ticket`, {
        method: 'POST',
        credentials: 'same-origin',
      })
      if (res.status !== 200) throw new Error(`ticket: ${res.status}`)
      const { ticket } = (await res.json()) as { ticket: string }
      // the ticket in the offered subprotocol, as the board page sends it (L7), never in the URL
      const url = `${location.origin.replace(/^http/, 'ws')}/connect/${encodeURIComponent(boardId)}?${new URLSearchParams(
        { sessionId: `forge-${key}` },
      )}`
      const w = window as unknown as { __o1Burst?: Record<string, { ws: WebSocket; acked: string[] }> }
      w.__o1Burst ??= {}
      const ws = new WebSocket(url, ['lobby.board.v1', `lobby.ticket.${ticket}`])
      const st = { ws, acked: [] as string[] }
      w.__o1Burst[key] = st
      return await new Promise<number>((resolve, reject) => {
        let welcomeClock = -1
        ws.onmessage = (e) => {
          if (typeof e.data !== 'string') {
            if (welcomeClock >= 0) resolve(welcomeClock)
            return
          }
          const m = JSON.parse(e.data) as {
            type: string
            reset?: boolean
            clock?: number
            r?: { ok: boolean; id: string }[]
          }
          if (m.type === 'welcome') {
            welcomeClock = m.clock ?? 0
            if (!m.reset) resolve(welcomeClock)
          } else if (m.type === 'ack') for (const r of m.r ?? []) if (r.ok) st.acked.push(r.id)
        }
        ws.onclose = (e) => reject(new Error(`closed ${e.code} ${e.reason}`))
        ws.onopen = () =>
          ws.send(
            JSON.stringify({
              type: 'hello',
              proto: 1,
              schema: 1,
              since: 0,
              epoch: null,
              tab: `forge-${key}`,
            }),
          )
      })
    },
    { boardId, key },
  )
  return {
    clock,
    burst: (frames) =>
      page.evaluate(
        ({ key, frames }) => {
          const st = (window as unknown as { __o1Burst: Record<string, { ws: WebSocket }> }).__o1Burst[key]
          for (const f of frames) st?.ws.send(JSON.stringify(f))
        },
        { key, frames },
      ),
    acked: () =>
      page.evaluate(
        (key) => [
          ...((window as unknown as { __o1Burst: Record<string, { acked: string[] }> }).__o1Burst[key]
            ?.acked ?? []),
        ],
        key,
      ),
  }
}
