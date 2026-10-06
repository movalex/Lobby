// Raw-socket forging (docs/EXCALIDRAW-MIGRATION.md §6.3 "Forged writes"): a WebSocket opened INSIDE a
// browser page with the page's own ticket (fetched by the page from the api with its own session cookie),
// so the server's refusal is tested with no client code in the way. Frames are sent verbatim (a message
// or any string); server messages are read back and validated against the frozen `ServerMessage` schema
// (a server message that does not match the contract fails the read loudly). The binary snapshot frame
// after a reset `welcome` is counted and decoded on request.
//
// The socket uses its own session id (`forge-…`), so it never replaces the page's own board socket
// (sync's replaced-socket guard is keyed by uid:sessionId), and the relay passes it straight through.
// `forgeSession` also sends `hello` and waits for the `welcome`, which is what most forged writes need.
import type { Page } from '@playwright/test'
import {
  type ClientMessage,
  decodeSnapshotFrame,
  ELEMENT_SCHEMA_VERSION,
  PROTO,
  ServerMessage,
  type SnapshotFrame,
  type Welcome,
} from '../../../packages/canvas-schema/src/protocol.ts'
import { FORGE_SESSION_PREFIX } from './relay.ts'
import type { ForgeSocket } from './types.ts'

type InboxEntry =
  | { t: 'text'; data: string; at: number }
  | { t: 'bin'; b64: string; bytes: number; at: number }

interface ForgeWindowState {
  ws: WebSocket
  inbox: InboxEntry[]
  closed: { code: number; reason: string } | null
  opened: boolean
  error: string | null
}

export interface O3ForgeSocket extends ForgeSocket {
  /** the session id this socket used (`forge-…`) and what the api issued the ticket for */
  readonly tab: string
  readonly role: string
  readonly uid: string
  /** binary frames received (the reset snapshot), decoded */
  snapshots(): Promise<SnapshotFrame[]>
  /** raw text frames received, unparsed (for evidence of what exactly came back) */
  rawText(): Promise<string[]>
}

let seq = 0

function parseServer(text: string): ServerMessage {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`forge socket: a server text frame is not JSON (${text.length} chars)`)
  }
  const r = ServerMessage.safeParse(json)
  if (!r.success) {
    const type = (json as { type?: unknown } | null)?.type
    throw new Error(
      `forge socket: a server "${String(type)}" message does not match the frozen protocol: ${r.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    )
  }
  return r.data
}

/** Opens a raw socket on `boardId` in `page`, with the page's own ticket. Sends nothing. */
export async function forgeSocket(page: Page, boardId: string): Promise<O3ForgeSocket> {
  const key = `f${++seq}-${Date.now().toString(36)}`
  const tab = `${FORGE_SESSION_PREFIX}${key}`
  const opened = await page.evaluate(
    async ({ boardId, key, tab }) => {
      const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}/ticket`, {
        method: 'POST',
        credentials: 'same-origin',
      })
      if (res.status !== 200) return { ok: false as const, status: res.status }
      const body = (await res.json()) as { ticket: string; role: string; user: { id: string } }
      // the ticket in the offered subprotocol, as the board page sends it (L7), never in the URL
      const url = `${location.origin.replace(/^http/, 'ws')}/connect/${encodeURIComponent(boardId)}?${new URLSearchParams(
        { sessionId: tab },
      )}`
      const w = window as unknown as { __o3Forge?: Record<string, ForgeWindowState> }
      w.__o3Forge ??= {}
      const ws = new WebSocket(url, ['lobby.board.v1', `lobby.ticket.${body.ticket}`])
      ws.binaryType = 'arraybuffer'
      const st: ForgeWindowState = { ws, inbox: [], closed: null, opened: false, error: null }
      w.__o3Forge[key] = st
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') st.inbox.push({ t: 'text', data: e.data, at: Date.now() })
        else {
          const bytes = new Uint8Array(e.data as ArrayBuffer)
          let bin = ''
          for (let i = 0; i < bytes.length; i += 0x8000)
            bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          st.inbox.push({ t: 'bin', b64: btoa(bin), bytes: bytes.length, at: Date.now() })
        }
      }
      ws.onclose = (e) => {
        st.closed = { code: e.code, reason: e.reason }
      }
      ws.onerror = () => {
        st.error = 'error'
      }
      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          st.opened = true
          resolve()
        }
        const t = setInterval(() => {
          if (st.closed) {
            clearInterval(t)
            resolve()
          }
        }, 20)
      })
      return { ok: true as const, opened: st.opened, role: body.role, uid: body.user.id }
    },
    { boardId, key, tab },
  )
  if (!opened.ok)
    throw new Error(`forge socket: the api refused a ticket for this page (HTTP ${opened.status})`)

  let cursor = 0 // text messages consumed by next()
  const texts = async (): Promise<string[]> =>
    page.evaluate(
      (key) =>
        (
          (window as unknown as { __o3Forge: Record<string, ForgeWindowState> }).__o3Forge[key]?.inbox ?? []
        ).flatMap((m) => (m.t === 'text' ? [m.data] : [])),
      key,
    )

  const socket: O3ForgeSocket = {
    tab,
    role: opened.role,
    uid: opened.uid,
    async send(frame) {
      const text = typeof frame === 'string' ? frame : JSON.stringify(frame)
      await page.evaluate(
        ({ key, text }) => {
          const st = (window as unknown as { __o3Forge: Record<string, ForgeWindowState> }).__o3Forge[key]
          if (st?.ws.readyState !== 1) throw new Error('forge socket is not open')
          st.ws.send(text)
        },
        { key, text },
      )
    },
    async next(type, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const all = await texts()
        while (cursor < all.length) {
          const msg = parseServer(all[cursor] as string)
          cursor++
          if (msg.type === type) return msg as never
        }
        if (Date.now() > deadline)
          throw new Error(`forge socket: no "${type}" message within ${timeoutMs} ms`)
        await page
          .waitForFunction(
            ({ key, n }) =>
              ((window as unknown as { __o3Forge: Record<string, ForgeWindowState> }).__o3Forge[
                key
              ]?.inbox.filter((m) => m.t === 'text').length ?? 0) > n ||
              (window as unknown as { __o3Forge: Record<string, ForgeWindowState> }).__o3Forge[key]
                ?.closed !== null,
            { key, n: all.length },
            { timeout: Math.max(1, deadline - Date.now()), polling: 20 },
          )
          .catch(() => undefined)
        const closed = await page.evaluate(
          (key) =>
            (window as unknown as { __o3Forge: Record<string, ForgeWindowState> }).__o3Forge[key]?.closed,
          key,
        )
        if (closed && (await texts()).length <= cursor)
          throw new Error(`forge socket closed (${closed.code} ${closed.reason}) before a "${type}" message`)
      }
    },
    async messages() {
      return (await texts()).map(parseServer)
    },
    async closed() {
      await page.waitForFunction(
        (key) =>
          (window as unknown as { __o3Forge: Record<string, ForgeWindowState> }).__o3Forge[key]?.closed !==
          null,
        key,
        { timeout: 0, polling: 50 },
      )
      return page.evaluate(
        (key) =>
          (window as unknown as { __o3Forge: Record<string, ForgeWindowState> }).__o3Forge[key]?.closed as {
            code: number
            reason: string
          },
        key,
      )
    },
    async close() {
      await page.evaluate((key) => {
        const st = (window as unknown as { __o3Forge: Record<string, ForgeWindowState> }).__o3Forge[key]
        if (st && st.ws.readyState <= 1) st.ws.close(1000, 'forge done')
      }, key)
    },
    async snapshots() {
      const bins = await page.evaluate(
        (key) =>
          (
            (window as unknown as { __o3Forge: Record<string, ForgeWindowState> }).__o3Forge[key]?.inbox ?? []
          ).flatMap((m) => (m.t === 'bin' ? [m.b64] : [])),
        key,
      )
      return Promise.all(bins.map((b) => decodeSnapshotFrame(new Uint8Array(Buffer.from(b, 'base64')))))
    },
    rawText: texts,
  }
  if (!opened.opened) {
    const c = await socket.closed()
    throw new Error(`forge socket: the server closed the socket at once (${c.code} ${c.reason})`)
  }
  return socket
}

/** The `hello` a fresh client sends (since 0, no epoch: the server answers with a reset). */
export function freshHello(tab: string): Extract<ClientMessage, { type: 'hello' }> {
  return { type: 'hello', proto: PROTO, schema: ELEMENT_SCHEMA_VERSION, since: 0, epoch: null, tab }
}

/** A forge socket past `hello`: the `welcome` (and, on a reset, the snapshot frame) received. */
export async function forgeSession(
  page: Page,
  boardId: string,
): Promise<{ socket: O3ForgeSocket; welcome: Welcome }> {
  const socket = await forgeSocket(page, boardId)
  await socket.send(freshHello(socket.tab))
  const welcome = (await socket.next('welcome', 30_000)) as Welcome
  return { socket, welcome }
}
