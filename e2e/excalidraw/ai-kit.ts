// OWNER: 3h. Helpers for the ported AI specs (ai-*.spec.ts) on the Excalidraw board page: the fake OpenAI
// on a port of this run's own range, a template placed as a person's push (the scene templates of
// packages/templates, pushed over a raw socket with the page's ticket, as 2D's templates-scenes spec does:
// the in-app template insert is 3b's and waits for CR-2D-2), a frame's contents with bounds, words and
// AI kinds read in the page, and the AI UI.
//
// Wave L: W2 owns this kit. The fake's canned answers for the six new actions (recap, ask, command, diagram,
// sort, score) are in ../tests/support/ai.ts `waveLAnswer` (the fake server's own file; re-exported here),
// keyed by the response schema names below.
import { expect, type Page } from '@playwright/test'
import { installServerTextMetrics } from '../../packages/canvas-schema/src/engine/index.ts'
import type { Ack, Welcome } from '../../packages/canvas-schema/src/protocol.ts'
import { instantiateSceneTemplate } from '../../packages/templates/src/scene/index.ts'
import { FAKE_KEY } from '../tests/support/ai.ts'
import { items, select, setViewport, viewport } from '../tests/support/canvas.ts'
import { forgeSession } from '../tests/support/excalidraw.ts'
import { HOST, PORT_BASE } from '../tests/support/ports.ts'

installServerTextMetrics()

export { waveLAnswer } from '../tests/support/ai.ts'
/** The response schema names of the wave L actions (W1's prompt.ts uses these; the fake answers them). */
export const WAVE_L_SCHEMA_NAMES = {
  recap: 'lobby_recap',
  ask: 'lobby_answer',
  command: 'lobby_command',
  diagram: 'lobby_diagram',
  sort: 'lobby_sort',
  score: 'lobby_score',
} as const

/**
 * base + 10: inside this run's own extra range (the default suite's fake sits on base + 3, which a
 * parallel run's range may hold).
 */
export const FAKE_OPENAI_PORT_3H = PORT_BASE === null ? 5899 : PORT_BASE + 10
export const AI_API_ENV_3H: Record<string, string> = {
  OPENAI_API_KEY: FAKE_KEY,
  OPENAI_BASE_URL: `http://${HOST}:${FAKE_OPENAI_PORT_3H}/v1`,
  OPENAI_MODEL: 'gpt-5.4-mini',
  DRAFTROOM_AI: 'on',
}

type Any = Record<string, unknown>

/** Containers that are locked and hold a label (created unlocked, then locked: CR-2D-1). */
function lockedContainers(elements: readonly Any[]): Set<string> {
  const out = new Set<string>()
  for (const e of elements) {
    const bound = (e.boundElements as { type: string }[] | null) ?? []
    if (e.locked === true && bound.some((r) => r.type === 'text')) out.add(e.id as string)
  }
  return out
}

/**
 * Places template `id` on `board` as one push of `page`'s user (a raw socket with its ticket), as a
 * person placing it would; returns the element count. Locked labelled containers are locked in a
 * second push (CR-2D-1).
 */
export async function placeTemplate(
  page: Page,
  board: string,
  id: Parameters<typeof instantiateSceneTemplate>[0],
): Promise<number> {
  const scene = instantiateSceneTemplate(id, { origin: { x: 0, y: 0 } })
  const elements = scene.elements as unknown as Any[]
  const { socket, welcome } = await forgeSession(page, board)
  try {
    const locked = lockedContainers(elements)
    const ops = elements.map((el) => ({
      k: 'c' as const,
      el: locked.has(el.id as string) ? { ...el, locked: false } : el,
    }))
    await socket.send(JSON.stringify({ type: 'push', seq: 1, base: (welcome as Welcome).clock, ops }))
    const ack = (await socket.next('ack', 30_000)) as Ack
    expect(ack.r.filter((r) => !r.ok)).toEqual([])
    if (locked.size) {
      const v = new Map<string, number>()
      for (const r of ack.r) if (r.ok) v.set(r.id, r.v)
      await socket.send(
        JSON.stringify({
          type: 'push',
          seq: 2,
          base: ack.clock,
          ops: [...locked].map((lid) => ({ k: 'p', id: lid, pv: v.get(lid), g: { meta: { locked: true } } })),
        }),
      )
      const second = (await socket.next('ack', 30_000)) as Ack
      expect(second.r.filter((r) => !r.ok)).toEqual([])
    }
  } finally {
    await socket.close()
  }
  await expect.poll(async () => (await items(page)).length, { timeout: 30_000 }).toBe(elements.length)
  return elements.length
}

export interface BoxLike {
  x: number
  y: number
  w: number
  h: number
}

export interface Kid {
  id: string
  type: string
  frameId: string | null
  x: number
  y: number
  text: string
  b: BoxLike
  /** customData.lobby.kind of an AI-made element without its `ai-` prefix, else null */
  ai: string | null
  locked: boolean
}

export interface FrameContents {
  id: string
  w: number
  h: number
  b: BoxLike
  kids: Kid[]
}

/** Every object of the frame named `name` (labels are their containers' text), with scene bounds. */
export const frameContents = (page: Page, name: string): Promise<FrameContents | null> =>
  page.evaluate((frameName) => {
    type El = Record<string, unknown> & { id: string; type: string; x: number; y: number }
    const b = (
      window as unknown as {
        __lobbyBoard?: {
          canvas: {
            items(): El[]
            bounds(id: string): { x: number; y: number; width: number; height: number } | null
            text: { of(id: string): string }
          }
        }
      }
    ).__lobbyBoard
    if (!b) throw new Error('no window.__lobbyBoard')
    const c = b.canvas
    const all = c.items()
    const frame = all.find((e) => e.type === 'frame' && e.name === frameName)
    if (!frame) return null
    const box = (id: string) => {
      const r = c.bounds(id)
      return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : { x: 0, y: 0, w: 0, h: 0 }
    }
    const lobby = (e: El) =>
      ((e.customData as { lobby?: Record<string, unknown> } | null)?.lobby ?? {}) as Record<string, unknown>
    const kids = all
      .filter((e) => e.frameId === frame.id && !(e.type === 'text' && e.containerId))
      .map((e) => {
        const l = lobby(e)
        const kind = typeof l.kind === 'string' && l.ai !== undefined ? l.kind.replace(/^ai-/, '') : null
        return {
          id: e.id,
          type: e.type,
          frameId: (e.frameId as string | null) ?? null,
          x: e.x,
          y: e.y,
          text: c.text.of(e.id),
          b: box(e.id),
          ai: kind,
          locked: e.locked === true,
        }
      })
    return { id: frame.id, w: frame.width as number, h: frame.height as number, b: box(frame.id), kids }
  }, name)

/** Every AI-made object on the board, with its kind and words. */
export const aiObjects = (page: Page) =>
  page.evaluate(() => {
    type El = Record<string, unknown> & { id: string; type: string }
    const c = (
      window as unknown as {
        __lobbyBoard?: { canvas: { items(): El[]; text: { of(id: string): string } } }
      }
    ).__lobbyBoard?.canvas
    if (!c) throw new Error('no window.__lobbyBoard')
    return c
      .items()
      .filter((e) => {
        const l = (e.customData as { lobby?: Record<string, unknown> } | null)?.lobby
        return l?.ai !== undefined && !(e.type === 'text' && e.containerId)
      })
      .map((e) => {
        const l = (e.customData as { lobby: Record<string, unknown> }).lobby
        return {
          id: e.id,
          type: e.type,
          kind: String(l.kind ?? '').replace(/^ai-/, ''),
          by: (l.ai as { by?: string }).by ?? null,
          text: c.text.of(e.id),
          frameId: (e.frameId as string | null) ?? null,
        }
      })
  })

export const countOf = async (page: Page, kind: string) =>
  (await aiObjects(page)).filter((o) => o.kind === kind).length

/** The notes of the frame. */
export async function frameNotes(page: Page, name: string): Promise<Kid[]> {
  const f = await frameContents(page, name)
  if (!f) throw new Error(`no frame ${name}`)
  return f.kids.filter((k) => k.type === 'stickynote')
}

/** Puts a scene rectangle in view (with `inset` screen px around it), at most 100%. */
export async function showBounds(page: Page, b: BoxLike, inset = 48) {
  // an animated camera move still running (the AI result's, since 3b's zoomTo animates) would overwrite the
  // facade's set, which does not stop it (the wave-3 integration)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __lobbyBoard?: { canvas: { viewport: { moving(): boolean } } } }
          ).__lobbyBoard?.canvas.viewport.moving() ?? false,
      ),
    )
    .toBe(false)
  const v = await viewport(page)
  const sw = v.width * v.zoom
  const sh = v.height * v.zoom
  const zoom = Math.min(1, (sw - 2 * inset) / b.w, (sh - 2 * inset) / b.h)
  await setViewport(page, { x: b.x + b.w / 2 - sw / zoom / 2, y: b.y + b.h / 2 - sh / zoom / 2, zoom })
}

export async function showFrame(page: Page, name: string) {
  const f = await frameContents(page, name)
  if (!f) throw new Error(`no frame ${name}`)
  await showBounds(page, f.b)
}

export const aiButton = (page: Page) => page.getByTestId('selection-ai')
export const aiMenu = (page: Page) => page.getByTestId('ai-menu')

/** Selects `ids` (the selection bar, or the stand-in over the selection, then offers AI). */
export async function selectIds(page: Page, ids: readonly string[]) {
  await select(page, [...ids])
}

export async function openAiMenu(page: Page) {
  await aiButton(page).click()
  await expect(aiMenu(page)).toBeVisible()
  return aiMenu(page)
}

/** Continues past the regroup question and the OpenAI notice when they show. */
export async function continueIfAsked(page: Page) {
  const regroup = aiMenu(page).getByTestId('ai-regroup-go')
  const cont = aiMenu(page).getByTestId('ai-notice-continue')
  const started = page.getByTestId('ai-busy').or(page.getByTestId('ai-done')).or(page.getByTestId('ai-error'))
  await expect(regroup.or(cont).or(started).first()).toBeVisible()
  if (await regroup.isVisible()) {
    await regroup.click()
    await expect(cont.or(started).first()).toBeVisible()
  }
  if (await cont.isVisible()) await cont.click()
}

/**
 * Moves a note (and its label) by `dy` as its own undo step, as a person's drag would: one transact
 * through the page's canvas.
 */
export async function nudge(page: Page, id: string, dy: number) {
  await page.evaluate(
    ({ id, dy }) => {
      type El = { id: string; x: number; y: number; boundElements?: { id: string; type: string }[] | null }
      const c = (
        window as unknown as {
          __lobbyBoard?: {
            canvas: {
              get(id: string): El | undefined
              transact(
                l: string,
                fn: (tx: { update(id: string, p: Record<string, unknown>): void }) => void,
              ): void
            }
          }
        }
      ).__lobbyBoard?.canvas
      if (!c) throw new Error('no window.__lobbyBoard')
      const el = c.get(id)
      if (!el) throw new Error(`no element ${id}`)
      const label = (el.boundElements ?? []).find((b) => b.type === 'text')
      const l = label ? c.get(label.id) : undefined
      c.transact('e2e: nudge', (tx) => {
        tx.update(id, { y: el.y + dy })
        if (l) tx.update(l.id, { y: l.y + dy })
      })
    },
    { id, dy },
  )
}

/** Whether the page has 3a's shell in host slot `slot` (menus, the selection bar). */
export const hasShell = async (page: Page, slot: 'contextMenu' | 'mainMenu' | 'selectionBar') =>
  (await page.locator(`[data-lobby-slot="${slot}"]`).count()) > 0

export const overlap = (a: BoxLike, b: BoxLike) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
export const inside = (o: BoxLike, i: BoxLike) =>
  i.x >= o.x - 0.5 && i.y >= o.y - 0.5 && i.x + i.w <= o.x + o.w + 0.5 && i.y + i.h <= o.y + o.h + 0.5
