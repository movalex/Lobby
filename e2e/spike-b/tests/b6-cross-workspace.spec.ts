// B6 F9 on the REAL stack (the real api's A1 file-refs, not the protocol suite's fake): a version uploaded
// in another workspace, and one of another board of the same workspace, forged into a board through a raw
// socket with the forger's own ticket: INVALID; the board's own: ok; then the api killed (unknown ids fail
// closed: UNAVAILABLE) and restarted (INVALID again). b6-forged's F9 sends a made-up id only; this is the
// spike B verifier V2's real-stack probe (part-3 round), adopted as its regression. SPIKE_B6_XWS_REPS
// repetitions (default 3; V2 ran 20).
import { expect, type Page, test } from '@playwright/test'
import { forgeSession, harness } from '../support/harness.ts'
import { stackFromEnv } from '../support/ports.ts'
import type { O3Stack } from '../support/stack.ts'
import type { BrowserProcess } from '../support/types.ts'
import { solidPng } from './b7-b12-kit.ts'

const N = Number(process.env.SPIKE_B6_XWS_REPS ?? 3)
const PORTS = stackFromEnv()
test.describe.configure({ mode: 'serial' })
test.setTimeout(60 * 60_000)

let stack: O3Stack
let A: BrowserProcess
let M: BrowserProcess
let b1: string

async function newBoard(page: Page, workspaceId: string, title: string): Promise<string> {
  return page.evaluate(
    async ({ wid, title }) => {
      const res = await fetch(`/api/workspaces/${wid}/boards`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      if (res.status !== 201) throw new Error(`board: ${res.status}`)
      return ((await res.json()) as { id: string }).id
    },
    { wid: workspaceId, title },
  )
}
async function upload(page: Page, boardId: string, b64: string): Promise<string> {
  return page.evaluate(
    async ({ bid, b64 }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const res = await fetch(`/api/boards/${encodeURIComponent(bid)}/assets`, {
        method: 'POST',
        body: new Blob([bytes], { type: 'image/png' }),
        credentials: 'same-origin',
        headers: { 'Content-Type': 'image/png', 'X-File-Name': 'x.png' },
      })
      if (!res.ok) throw new Error(`upload ${res.status}`)
      return ((await res.json()) as { versionId: string }).versionId
    },
    { bid: boardId, b64 },
  )
}
const imageEl = (id: string, fileId: string, x: number) => ({
  id,
  type: 'image',
  x,
  y: 0,
  width: 64,
  height: 48,
  angle: 0,
  strokeColor: 'transparent',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 1,
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
  fileId,
  scale: [1, 1],
  crop: null,
})

test.beforeAll(async () => {
  stack = (await harness.startStack({ base: PORTS.base })) as O3Stack
  const alice = harness.devUser('b6x-alice')
  const mallory = harness.devUser('b6x-mallory')
  ;({ boardId: b1 } = await stack.createBoard({ owner: alice, members: [{ user: mallory, role: 'editor' }] }))
  A = await harness.launchBrowser(stack, alice, { name: 'A' })
  M = await harness.launchBrowser(stack, mallory, { name: 'M' })
  await A.openBoard(b1)
  await M.openBoard(b1)
})
test.afterAll(async () => {
  await M?.close()
  await A?.close()
  await stack?.stop()
})

test('B6 F9: a cross-workspace fileId on the real api: INVALID; same-workspace other board: INVALID; own: ok; api down: UNAVAILABLE', async () => {
  const me = await M.page.evaluate(
    async () =>
      (await (await fetch('/api/me', { credentials: 'same-origin' })).json()) as {
        workspaces: { id: string; name: string; role: string }[]
      },
  )
  const personal = me.workspaces.find((w) => w.role === 'owner' && w.id !== 'wsp_DevStudio00000000000')
  if (!personal) throw new Error(`no personal workspace: ${JSON.stringify(me.workspaces.map((w) => w.role))}`)
  const b2 = await newBoard(M.page, personal.id, 'mallory private')
  const b3 = await newBoard(M.page, 'wsp_DevStudio00000000000', 'mallory other board')
  const png = await solidPng(A.page, [10, 200, 30], 16, 12)
  let { socket } = await forgeSession(M.page, b1)
  // the abuse close (F14: more than 50 INVALID in a minute) is honoured: a fresh socket every 10 repetitions
  const fresh = async () => {
    await socket.close()
    ;({ socket } = await forgeSession(M.page, b1))
  }
  let seq = 1000
  const push = async (ops: unknown[]) => {
    const s = ++seq
    const cl = await Promise.race([
      socket.closed().then((c) => `${c.code}/${c.reason}`),
      new Promise<string>((r) => setTimeout(() => r('open'), 50)),
    ])
    if (cl !== 'open')
      throw new Error(
        `forge closed before push ${s}: ${cl}; msgs=${(await socket.messages()).map((m) => m.type).join(',')}`,
      )
    await socket.send(JSON.stringify({ type: 'push', seq: s, base: 0, ops }))
    for (;;) {
      const ack = (await socket.next('ack', 20_000)) as { seq: number; r: { ok: boolean; code?: string }[] }
      if (ack.seq === s) return ack.r.map((r) => (r.ok ? 'ok' : r.code))
    }
  }
  const rows: Record<string, unknown>[] = []
  const own: string[] = []
  for (let i = 0; i < N; i++) {
    if (i > 0 && i % 10 === 0) await fresh()
    const vF = await upload(M.page, b2, png) // another workspace (mallory's own)
    const vS = await upload(M.page, b3, png) // same workspace, another board, no history link
    const vO = await upload(A.page, b1, png) // this board
    own.push(vO)
    const r = await push([
      { k: 'c', el: imageEl(`x-f-${i}`, vF, i * 100) },
      { k: 'c', el: imageEl(`x-s-${i}`, vS, i * 100) },
      { k: 'c', el: imageEl(`x-o-${i}`, vO, i * 100) },
      { k: 'c', el: imageEl(`x-p-${i}`, `${vF}.p1`, i * 100) },
    ])
    // an own image re-pointed at the foreign version
    const p = await push([{ k: 'p', id: `x-o-${i}`, pv: 2, g: { file: { fileId: vF } } }])
    rows.push({ i, foreign: r[0], sameWsOtherBoard: r[1], own: r[2], foreignPdfPage: r[3], repoint: p[0] })
  }
  // the api goes down: unknown ids fail closed, a cached positive one is still served
  await stack.e2e.api.kill()
  const down: string[] = []
  const unknown = Array.from({ length: N }, (_, k) => `ver_b6down${String(k).padStart(8, '0')}x`)
  for (let k = 0; k < N; k++) {
    const r = await push([{ k: 'c', el: imageEl(`d-${k}`, unknown[k] as string, 5000 + k * 10) }])
    down.push(r[0] as string)
  }
  const cachedWhileDown = await push([{ k: 'c', el: imageEl('d-cached', own[0] as string, 9000) }])
  await stack.e2e.api.restart()
  await fresh()
  const afterUp: string[] = []
  for (let k = 0; k < N; k++) {
    if (k === 10) await fresh()
    const r = await push([{ k: 'c', el: imageEl(`u-${k}`, unknown[k] as string, 7000 + k * 10) }])
    afterUp.push(r[0] as string)
  }
  const snap = await harness.readSnapshot(stack, b1)
  const text = JSON.stringify(snap.elements)
  const imgs = snap.elements.filter((e) => e.type === 'image') as { id: string; fileId: string }[]
  const summary = {
    n: rows.length,
    foreign: [...new Set(rows.map((r) => r.foreign))],
    sameWsOtherBoard: [...new Set(rows.map((r) => r.sameWsOtherBoard))],
    own: [...new Set(rows.map((r) => r.own))],
    foreignPdfPage: [...new Set(rows.map((r) => r.foreignPdfPage))],
    repoint: [...new Set(rows.map((r) => r.repoint))],
    down: [...new Set(down)],
    cachedWhileDown,
    afterUp: [...new Set(afterUp)],
    storedImages: imgs.length,
    storedForeign: imgs.filter((e) => !own.some((v) => e.fileId.startsWith(v))).map((e) => e.id),
    snapshotHasDataBlobSigned: /data:|blob:|X-Amz-|Signature=|\/files\//.test(text),
    socketClosed: await Promise.race([
      socket.closed().then((c) => `${c.code}/${c.reason}`),
      new Promise((r) => setTimeout(() => r('open'), 200)),
    ]),
  }
  console.log('B6-XWS', JSON.stringify(summary))
  await socket.close()
  expect(summary.foreign).toEqual(['INVALID'])
  expect(summary.sameWsOtherBoard).toEqual(['INVALID'])
  expect(summary.own).toEqual(['ok'])
  expect(summary.foreignPdfPage).toEqual(['INVALID'])
  expect(summary.repoint).toEqual(['INVALID'])
  expect(summary.down).toEqual(['UNAVAILABLE'])
  expect(summary.afterUp).toEqual(['INVALID'])
  expect(summary.storedForeign).toEqual([])
  expect(summary.snapshotHasDataBlobSigned).toBe(false)
})
