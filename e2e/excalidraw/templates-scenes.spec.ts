// Wave 2D: the templates on the new canvas (packages/templates/src/scene), against the real engine and the
// real server (docs/EXCALIDRAW-MIGRATION.md §4.2 "Templates", §6.5 "restoreElements leaves templates
// untouched").
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- templates-scenes
//
// 1. Every template scene is a fixed point of Excalidraw's own `restoreElements(…, {repairBindings,
//    refreshDimensions})` in Chromium with Lobby's fonts (spike A's /spike/engine page; B8's check).
// 2. Every template scene, pushed as `create` ops exactly as the builder made it (a raw socket with the
//    page's own ticket, so no client code is in the way), is accepted op by op with no server rewrite of
//    its geometry, reaches a second tab unchanged, converges, and is still there after a reload.
// The scenes are built in Node with the server's text metrics (the table apps/sync installs), which is
// how a server-made template is laid out; (1) shows the browser's own measurements agree.
import { writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { exportElementArchive, importElementArchive } from '../../packages/board-ops/src/elements/index.ts'
import { installServerTextMetrics } from '../../packages/canvas-schema/src/engine/index.ts'
import { GEOMETRY_TOLERANCE_PX } from '../../packages/canvas-schema/src/limits.ts'
import type { Ack, Welcome } from '../../packages/canvas-schema/src/protocol.ts'
import { TEMPLATE_INFOS } from '../../packages/templates/src/plan.ts'
import { instantiateSceneTemplate } from '../../packages/templates/src/scene/index.ts'
import { forgeSession } from '../spike-b/support/forge.ts'
import {
  openEnginePage,
  restoreFixedPoint,
  screenshotBoard,
  summarize,
} from '../spike-b/support/restore-check.ts'
import { expect, expectConverged, items, test, waitForCanvas } from '../tests/support/canvas.ts'

installServerTextMetrics()

type Any = Record<string, unknown>

/** Every template once, stacked top to bottom on one board, each above the one before in z-order. */
function allScenes() {
  let y = 0
  let top: string | null = null
  return TEMPLATE_INFOS.map((t) => {
    const scene = instantiateSceneTemplate(t.id, { origin: { x: 0, y }, indexAbove: top })
    y += scene.bounds.h + 600
    top = scene.elements.at(-1)?.index ?? top
    return { id: t.id, elements: scene.elements as unknown as Any[] }
  })
}

/** What the server owns or the engine keeps locally: never compared. */
const SERVER_OWNED = new Set(['version', 'versionNonce', 'updated', 'created', 'seed', 'status'])

/** Field differences beyond the tolerance between what was pushed and what a tab holds (customData.lobby only). */
function stored(pushed: Any, got: Any): string[] {
  const out: string[] = []
  for (const k of new Set([...Object.keys(pushed), ...Object.keys(got)])) {
    if (SERVER_OWNED.has(k)) continue
    const a = k === 'customData' ? ((pushed.customData as Any | undefined)?.lobby ?? null) : pushed[k]
    const b = k === 'customData' ? ((got.customData as Any | undefined)?.lobby ?? null) : got[k]
    if (k === 'boundElements') {
      const norm = (v: unknown) =>
        JSON.stringify(
          ((v as { id: string; type: string }[] | null) ?? []).map((r) => `${r.type}:${r.id}`).sort(),
        )
      if (norm(a) !== norm(b)) out.push(k)
      continue
    }
    const close = (x: unknown, y: unknown): boolean => {
      if (typeof x === 'number' && typeof y === 'number') return Math.abs(x - y) <= GEOMETRY_TOLERANCE_PX
      if (Array.isArray(x) && Array.isArray(y))
        return x.length === y.length && x.every((v, i) => close(v, y[i]))
      if (x && y && typeof x === 'object' && typeof y === 'object')
        return [...new Set([...Object.keys(x), ...Object.keys(y)])].every((kk) =>
          close((x as Any)[kk], (y as Any)[kk]),
        )
      return x === y || (x === undefined && y === null) || (x === null && y === undefined)
    }
    if (!close(a, b)) out.push(k)
  }
  return out
}

/** Containers that are locked and hold a label (the templates' image slots). */
function lockedContainers(elements: readonly Any[]): Set<string> {
  const out = new Set<string>()
  for (const e of elements) {
    const bound = (e.boundElements as { type: string }[] | null) ?? []
    if (e.locked === true && bound.some((r) => r.type === 'text')) out.add(e.id as string)
  }
  return out
}

/**
 * Pushes each scene as `create` ops (one push per template, so every label travels with its container and
 * every arrow with its targets) over a raw socket with the page's own ticket. `lockAfter`: locked
 * containers are created unlocked and locked by a `meta` patch in the next push (the workaround for the
 * room refusing a label whose new container is locked, CR-2D-1). Returns the per-op answers.
 */
async function pushScenes(
  page: Page,
  board: string,
  scenes: readonly { readonly id: string; readonly elements: readonly Any[] }[],
  opts: { lockAfter: boolean },
) {
  const { socket, welcome } = await forgeSession(page, board)
  expect((welcome as Welcome).readonly).toBe(false)
  let clock = (welcome as Welcome).clock
  const fixes: Record<string, string[]> = {}
  const rejected: { id: string; code: string }[] = []
  let seq = 0
  const push = async (ops: unknown[]): Promise<Ack> => {
    seq++
    await socket.send(JSON.stringify({ type: 'push', seq, base: clock, ops }))
    const ack = (await socket.next('ack', 30_000)) as Ack
    expect(ack.seq).toBe(seq)
    expect(ack.r).toHaveLength(ops.length)
    for (const r of ack.r) {
      if (!r.ok) rejected.push({ id: r.id, code: r.code })
      else if (r.fix) fixes[r.id] = Object.keys(r.fix).sort()
    }
    for (const d of ack.derived ?? []) fixes[`${d.id} (derived)`] = Object.keys(d.fix).sort()
    clock = ack.clock
    return ack
  }
  for (const scene of scenes) {
    const locked = opts.lockAfter ? lockedContainers(scene.elements) : new Set<string>()
    const ops = scene.elements.map((el) => ({
      k: 'c' as const,
      el: locked.has(el.id as string) ? { ...el, locked: false } : el,
    }))
    const ack = await push(ops)
    if (locked.size) {
      const v = new Map<string, number>()
      for (const r of ack.r) if (r.ok) v.set(r.id, r.v)
      await push([...locked].map((id) => ({ k: 'p', id, pv: v.get(id), g: { meta: { locked: true } } })))
    }
  }
  await socket.close()
  return { fixes, rejected }
}

test('every template scene is a fixed point of restoreElements in the browser (repairBindings, refreshDimensions)', async ({
  page,
}, info) => {
  test.setTimeout(240_000)
  await openEnginePage(page)
  const out: Record<string, ReturnType<typeof summarize>> = {}
  for (const t of TEMPLATE_INFOS) {
    const { elements } = instantiateSceneTemplate(t.id, { origin: { x: 0, y: 0 } })
    const d = await restoreFixedPoint(page, elements as unknown as Record<string, unknown>[])
    out[t.id] = summarize(d, GEOMETRY_TOLERANCE_PX)
    await screenshotBoard(
      page,
      elements as unknown as Record<string, unknown>[],
      info.outputPath(`${t.id}.png`),
    )
  }
  writeFileSync(info.outputPath('restore.json'), `${JSON.stringify(out, null, 1)}\n`)
  for (const [id, s] of Object.entries(out))
    expect({ id, dropped: s.dropped, added: s.added, beyondTolerance: s.beyondTolerance }).toEqual({
      id,
      dropped: 0,
      added: 0,
      beyondTolerance: [],
    })
})

// CR-2D-1 (room, apps/sync/src/room/invariants.ts rejectPass): a label created in the same push as its NEW
// locked container is refused (LOCKED), so a template's labelled image slots, an imported board's locked
// cards or a pasted locked card lose their labels when a client creates them. The lock should protect
// existing content only. Expected to fail until the room's owner changes the rule; the next test shows the
// rest of every scene is accepted as authored.
test('a template pushed as authored keeps the labels of its locked image slots (CR-2D-1)', async ({
  canvasSession,
  board,
}) => {
  const scenes = allScenes().filter((s) => s.id === 'mood-board')
  const alice = await canvasSession('alice')
  const { rejected } = await pushScenes(alice.page, board, scenes, { lockAfter: false })
  expect(rejected).toEqual([])
})

test('every template scene, pushed as authored (locks applied after the labels), is accepted with no geometry rewrite, reaches a second tab unchanged and survives a reload', async ({
  canvasSession,
  board,
}, info) => {
  test.setTimeout(180_000)
  const scenes = allScenes()
  const pushed = scenes.flatMap((s) => s.elements)
  const alice = await canvasSession('alice')
  const { fixes, rejected } = await pushScenes(alice.page, board, scenes, { lockAfter: true })
  writeFileSync(info.outputPath('fixes.json'), `${JSON.stringify(fixes, null, 1)}\n`)
  expect(rejected).toEqual([])
  // the server rewrote no geometry: the arrows were already where its re-snap puts them
  const geometry = Object.entries(fixes).filter(([, f]) =>
    f.some((k) => ['x', 'y', 'points', 'width', 'height', 'angle', 'fixedSegments'].includes(k)),
  )
  expect(geometry).toEqual([])

  const bob = await canvasSession('bob')
  await expect.poll(async () => (await items(bob.page)).length, { timeout: 30_000 }).toBe(pushed.length)
  await expectConverged(alice.page, [bob.page])
  const held = new Map((await items(bob.page)).map((e) => [e.id, e as unknown as Any]))
  const changed: Record<string, string[]> = {}
  for (const el of pushed) {
    const got = held.get(el.id as string)
    if (!got) {
      changed[el.id as string] = ['missing']
      continue
    }
    // an index the server re-assigned (reported in its ack) is the server's to choose
    const d = stored(el, got).filter((k) => k !== 'index' || !fixes[el.id as string]?.includes('index'))
    if (d.length) changed[el.id as string] = d
  }
  expect(changed).toEqual({})

  await bob.page.reload()
  await waitForCanvas(bob.page)
  await expect.poll(async () => (await items(bob.page)).length, { timeout: 30_000 }).toBe(pushed.length)
  await expectConverged(alice.page, [bob.page])
})

test('a board exported as an archive v2 and imported again is accepted by the server and converges', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(120_000)
  const tour = allScenes().filter((s) => s.id === 'lobby-tour')
  const alice = await canvasSession('alice')
  expect((await pushScenes(alice.page, board, tour, { lockAfter: true })).rejected).toEqual([])
  const n = (tour[0]?.elements ?? []).length
  await expect.poll(async () => (await items(alice.page)).length, { timeout: 30_000 }).toBe(n)

  // what a tab holds, as a portable file, and back: fresh ids, above the board's top, below the original
  const held = await items(alice.page)
  const file = JSON.parse(JSON.stringify(exportElementArchive(held, {}, [])))
  const top =
    held
      .map((e) => (e as unknown as { index: string }).index)
      .sort()
      .at(-1) ?? null
  const imported = importElementArchive(file, { indexAbove: top, offset: { x: 0, y: 1400 } })
  expect(imported.warnings).toEqual([])
  expect(imported.elements).toHaveLength(n)
  const again = [{ id: 'lobby-tour', elements: imported.elements as unknown as Any[] }]
  const { fixes, rejected } = await pushScenes(alice.page, board, again, { lockAfter: true })
  expect(rejected).toEqual([])
  const geometry = Object.entries(fixes).filter(([, f]) =>
    f.some((k) => ['x', 'y', 'points', 'width', 'height', 'angle', 'fixedSegments'].includes(k)),
  )
  expect(geometry).toEqual([])

  const bob = await canvasSession('bob')
  await expect.poll(async () => (await items(bob.page)).length, { timeout: 30_000 }).toBe(2 * n)
  await expectConverged(alice.page, [bob.page])
  const frames = (await items(bob.page))
    .filter((e) => e.type === 'frame')
    .map((e) => (e as unknown as { name: string }).name)
  expect(frames.sort()).toEqual(
    [
      ...(TEMPLATE_INFOS.find((t) => t.id === 'lobby-tour')?.sections ?? []),
      ...(TEMPLATE_INFOS.find((t) => t.id === 'lobby-tour')?.sections ?? []),
    ].sort(),
  )
})
