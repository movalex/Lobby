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
