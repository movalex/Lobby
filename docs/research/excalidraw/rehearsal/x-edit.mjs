#!/usr/bin/env node
// Excalidraw-side edits on the rehearsal (runbook R10 "edits on Excalidraw"; the task's step 5): through
// O2's headless client (apps/web/src/canvas/sync/headless, the engine core browsers run) from the a39a1c5
// worktree, over the rehearsal edge's wss, with a ticket from the api's own ticket route (the minted
// session). Adds two notes, moves a frame with its children, moves a child of another frame, and moves a
// third note (the drill's conflict seeds for R0's side). Prints ids, deltas, counts and timings only.
//
//   node x-edit.mjs --base https://192.168.10.1:8443 --sync https://192.168.10.1:8444 --token-file session.token
//        --board b-0gazyr0d3e [--plan plan.json] [--json out.json] [--dry]
//
// Env: NODE_EXTRA_CA_CERTS=edge.crt (the self-signed edge). Run from the worktree root (imports are relative).
import { randomBytes, randomInt } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { compareByIndex, indexKeyBetween } from './packages/canvas-schema/src/engine/fractional.ts'
import { createLobbyHeadlessClient } from './apps/web/src/canvas/sync/headless/index.ts'

const { values: a } = parseArgs({
  options: {
    base: { type: 'string' },
    sync: { type: 'string' },
    'token-file': { type: 'string' },
    board: { type: 'string' },
    plan: { type: 'string' },
    json: { type: 'string' },
    dry: { type: 'boolean', default: false },
  },
})
const BASE = new URL(a.base).origin
const token = readFileSync(a['token-file'], 'utf8').trim()
const boardId = a.board
const t0 = Date.now()
const stamp = () => Date.now() - t0

async function ticket() {
  const r = await fetch(`${BASE}/api/boards/${boardId}/ticket`, {
    method: 'POST',
    headers: { cookie: `dr_session=${token}`, origin: BASE, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!r.ok) throw new Error(`ticket ${r.status}: ${(await r.text()).slice(0, 120)}`)
  const j = await r.json()
  return { ticket: j.ticket, role: j.role }
}

const tk = await ticket()
console.log(`ticket ok (role ${tk.role}) at ${stamp()} ms`)
// The sync refuses an upgrade without the web Origin (ALLOWED_ORIGINS; browsers always send it), and
// Node's built-in WebSocket cannot set one: `ws` (the sync's own dependency) can, and takes the edge's
// self-signed certificate as its CA.
const WsImpl = (await import(pathToFileURL(createRequire(pathToFileURL(process.cwd() + '/apps/sync/package.json')).resolve('ws')).href)).default
const ca = process.env.NODE_EXTRA_CA_CERTS ? [readFileSync(process.env.NODE_EXTRA_CA_CERTS)] : undefined
class OriginWebSocket extends WsImpl {
  constructor(url) {
    super(url, { headers: { origin: BASE }, ca })
  }
}
const client = createLobbyHeadlessClient({
  syncUrl: a.sync,
  boardId,
  tab: `reh-x-${randomBytes(3).toString('hex')}`,
  ticket: tk.ticket,
  WebSocketImpl: OriginWebSocket,
  refreshTicket: async () => (await ticket()).ticket,
})
const welcome = await client.connect()
console.log(`welcome: uid ${welcome.you.uid} role ${welcome.you.role} readonly ${welcome.readonly} clock ${welcome.clock} at ${stamp()} ms`)

const live = () => [...client.scene.values()].filter((e) => !e.isDeleted)
const byType = (list) => {
  const c = {}
  for (const e of list) c[e.type] = (c[e.type] ?? 0) + 1
  return c
}
console.log('scene before:', JSON.stringify(byType(live())), 'elements', live().length)

const frames = live().filter((e) => e.type === 'frame')
const notes = live().filter((e) => e.type === 'stickynote')
const labels = live().filter((e) => e.type === 'text' && e.containerId)
const labelOf = (id) => labels.find((l) => l.containerId === id) ?? null
const childrenOf = (fid) => live().filter((e) => e.frameId === fid && e.type !== 'frame')
const notesIn = (fid) => notes.filter((n) => n.frameId === fid)

let plan
if (a.plan) plan = JSON.parse(readFileSync(a.plan, 'utf8'))
else {
  const ranked = frames.map((f) => ({ f, n: notesIn(f.id).length })).sort((x, y) => y.n - x.n)
  const F1 = ranked[0]?.f
  const F2 = ranked.find((r) => r.f.id !== F1?.id && r.n > 0)?.f
  const C2 = F2 ? notesIn(F2.id)[0] : null
  const freeNotes = notes.filter((n) => !n.frameId)
  const N3 = freeNotes[0] ?? notes.find((n) => n.frameId && n.frameId !== F1?.id && n.frameId !== F2?.id) ?? notes.find((n) => n.id !== C2?.id && n.frameId !== F1?.id) ?? null
  if (!F1 || !F2 || !C2 || !N3) throw new Error(`cannot pick elements: frames ${frames.length}, notes ${notes.length}`)
  plan = { F1: F1.id, F2: F2.id, C2: C2.id, N3: N3.id, dF1: { x: 40, y: 30 }, dC2: { x: 25, y: 15 }, dN3: { x: 30, y: 30 } }
}
console.log('plan:', JSON.stringify(plan))
const F1 = client.scene.get(plan.F1)
const template = notesIn(plan.F1)[0] ?? notes[0]
const tLabel = labelOf(template.id)
if (!template || !tLabel) throw new Error('no note template with a label')

const newId = (p) => `reh-${p}-${randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9_-]/g, 'x')}`
const sortedKeys = () => live().map((e) => e.index).filter((k) => typeof k === 'string').sort((x, y) => compareByIndex({ index: x }, { index: y }))
let lastKey = sortedKeys().at(-1) ?? null
const nextKey = () => (lastKey = indexKeyBetween(lastKey, null))
const nonce = () => randomInt(0, 2 ** 31 - 1)
const mkNote = (x, y, frameId, text) => {
  const id = newId('note')
  const lid = newId('label')
  const now = Date.now()
  const note = {
    ...template,
    id,
    x,
    y,
    frameId,
    groupIds: [],
    boundElements: [{ id: lid, type: 'text' }],
    version: 1,
    versionNonce: nonce(),
    seed: nonce(),
    index: nextKey(),
    updated: now,
    created: null,
    isDeleted: false,
    link: null,
  }
  const label = {
    ...tLabel,
    id: lid,
    x: x + (tLabel.x - template.x),
    y: y + (tLabel.y - template.y),
    frameId,
    groupIds: [],
    containerId: id,
    boundElements: null,
    text,
    originalText: text,
    version: 1,
    versionNonce: nonce(),
    seed: nonce(),
    index: nextKey(),
    updated: now,
    created: null,
    isDeleted: false,
    link: null,
  }
  return { note, label }
}
const moveBy = (m, id, d) => {
  const el = m.get(id)
  if (!el) throw new Error(`no element ${id}`)
  m.set(id, { ...el, x: el.x + d.x, y: el.y + d.y, updated: Date.now() })
}

const result = { boardId, plan, clockBefore: welcome.clock, steps: [], before: byType(live()) }
const step = async (name, fn) => {
  const s0 = Date.now()
  if (!a.dry) {
    client.edit(fn)
    await client.saved(20_000)
  }
  const row = { name, ms: Date.now() - s0, saveStatus: client.core.saveStatus.state, pending: client.core.saveStatus.pending }
  result.steps.push(row)
  console.log('step', JSON.stringify(row))
}

// 1. a note inside F1
const na = mkNote(F1.x + 24, F1.y + 48, plan.F1, 'Rehearsal note A (Excalidraw side)')
result.NA = na.note.id
await step('add note NA in F1', (m) => {
  m.set(na.note.id, na.note)
  m.set(na.label.id, na.label)
})
// 2. a free note outside every frame (right of F1)
const nb = mkNote(F1.x + F1.width + 80, F1.y, null, 'Rehearsal note B (free, Excalidraw side)')
result.NB = nb.note.id
await step('add note NB free', (m) => {
  m.set(nb.note.id, nb.note)
  m.set(nb.label.id, nb.label)
})
// 3. move F1 with every child (and the children's labels), as Excalidraw's drag does
const f1Children = childrenOf(plan.F1).map((e) => e.id)
result.F1children = f1Children.length
await step(`move F1 by ${plan.dF1.x},${plan.dF1.y} with ${f1Children.length} children`, (m) => {
  moveBy(m, plan.F1, plan.dF1)
  for (const id of f1Children) moveBy(m, id, plan.dF1)
})
// 4. move C2, a child of F2 (R0 will move F2 itself: the drill's parent-moved case)
const c2Label = labelOf(plan.C2)
await step(`move C2 by ${plan.dC2.x},${plan.dC2.y}`, (m) => {
  moveBy(m, plan.C2, plan.dC2)
  if (c2Label) moveBy(m, c2Label.id, plan.dC2)
})
// 5. move N3 (R0 will move the same note: the same-group conflict)
const n3Label = labelOf(plan.N3)
await step(`move N3 by ${plan.dN3.x},${plan.dN3.y}`, (m) => {
  moveBy(m, plan.N3, plan.dN3)
  if (n3Label) moveBy(m, n3Label.id, plan.dN3)
})

result.after = byType(live())
result.elementsAfter = live().length
result.clockAfter = client.core.clock ?? null
result.pushes = client.core.pushLog?.()?.length ?? null
result.ms = stamp()
console.log('scene after:', JSON.stringify(result.after), 'elements', result.elementsAfter, 'total ms', result.ms)
await client.close()
if (a.json) writeFileSync(a.json, JSON.stringify(result, null, 2) + '\n')
process.exit(0)
