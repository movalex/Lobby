// OWNER: 3h. Helpers for the ported AI specs (ai-*.spec.ts) on the Excalidraw board page: the fake OpenAI
// on a port of this run's own range, a template placed as a person's push (the scene templates of
// packages/templates, pushed over a raw socket with the page's ticket, as 2D's templates-scenes spec does:
// the in-app template insert is 3b's and waits for CR-2D-2), a frame's contents with bounds, words and
// AI kinds read in the page, and the AI UI.
//
// Wave L: W2 owns this kit. The fake's canned answers for the six new actions (recap, ask, command, diagram,
// sort, score) are in ../tests/support/ai.ts `waveLAnswer` (the fake server's own file; re-exported here),
// keyed by the response schema names below.
//
// Wave M: W4 owns this kit. Its m4 specs' page measures (contrastOf, hitTestable, elementAt) and the foundation's
// Ask-across-boards fakes (fakeWorkspaceAsk, cannedWorkspaceAsk, forceWorkspaceAsk) are at the end.
//
// Wave N: WS5 owns this kit. The foundation's Capture the room canned outputs and route fake (CANNED_CAPTURE,
// fakeCapture) are at the very end.
import { expect, type Locator, type Page, type Route } from '@playwright/test'
import type { WorkspaceAskHookOutcome } from '../../apps/web/src/features/ai/workspace-ask/dev-hook-types.ts'
import { installServerTextMetrics } from '../../packages/canvas-schema/src/engine/index.ts'
import type { Ack, Welcome } from '../../packages/canvas-schema/src/protocol.ts'
import {
  AI_RUN_ID_PATTERN,
  AiResult,
  AiRunInput,
  CAPTURE_PHOTO_MAX_BYTES,
  CaptureResponse,
  type CaptureResult,
  CaptureTranscriptRequest,
  WorkspaceAskRequest,
  WorkspaceAskResponse,
} from '../../packages/contracts/src/ai.ts'
import { instantiateSceneTemplate } from '../../packages/templates/src/scene/index.ts'
import { FAKE_KEY } from '../tests/support/ai.ts'
import { items, select, setViewport, viewport } from '../tests/support/canvas.ts'
import { forgeSession } from '../tests/support/excalidraw.ts'
import { API_URL, HOST, PORT_BASE, WEB_URL } from '../tests/support/ports.ts'

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
  // 'actions' with a voteSessionId (W1, L1-7): its own model schema
  votedActions: 'lobby_voted_actions',
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

/** Wave L (L2-1b): the AI preview of a plan (outlines over the board, the panel with Apply, Try again, Discard). */
export const aiPreviewPanel = (page: Page) => page.getByTestId('ai-preview-panel')

/**
 * Waits for the AI preview (Group into themes and the other plans that move or recolour notes show one before
 * anything is written), checks its count line when `summary` is given, and presses `choice` (Apply by default).
 */
export async function applyPreview(
  page: Page,
  opts: { summary?: string | RegExp; choice?: 'apply' | 'retry' | 'discard' } = {},
) {
  const panel = aiPreviewPanel(page)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  if (opts.summary !== undefined)
    await expect(panel.getByTestId('ai-preview-summary')).toContainText(opts.summary)
  await panel.getByTestId(`ai-preview-${opts.choice ?? 'apply'}`).click()
  await expect(panel).toHaveCount(0)
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

// ---- wave L (W2): the e2e AI run fake, with canned answers for every new action ----------------------------
//
// `fakeAiRuns(page)` stands in front of POST /api/boards/:bid/ai/run in the browser (a Playwright route) for the
// six wave L actions (recap, ask, command, diagram, sort, score). Mode 'auto' (the default) first lets the real
// api answer: an api that runs the action (W1's, with the fake OpenAI's `waveLAnswer`) answers as it does, and
// only an api that refuses the action ("not available on this server yet": the wave L foundation's, or a wave K
// one) is answered from `cannedAiResult` instead. Mode 'canned' never asks the api. The four legacy actions
// always go to the api. Every call is recorded with who answered it (`served`), so a spec can say which path
// it exercised. A canned answer is a valid AiResult (parsed with the contract before it is served), with a
// fresh run id, and names only elements that are on the board (read from the page when the run is made).
//
// W3 (command), W4 (diagram) and W8 (sort, score) use the same fake for their specs.

/** The wave L actions the fake answers (the legacy four always go to the api). */
export const WAVE_L_ACTIONS = ['recap', 'ask', 'command', 'diagram', 'sort', 'score'] as const
export type WaveLAction = (typeof WAVE_L_ACTIONS)[number]

/** One item of the board as the canned answers read it (frames stand for what is inside them). */
export interface CannedItem {
  /** the api's object ref, `shape:<element id>` */
  ref: string
  id: string
  type: string
  text: string
  frameId: string | null
  /** customData.lobbyServer createdAt, and the later of its own and its label's lastEditedAt (server-stamped) */
  createdAt: number | null
  lastEditedAt: number | null
}

/** A revealed vote's results as the workshop state has them (what W1's api turns into `topVoted`). */
export interface CannedVoteResult {
  ref: string
  count: number
  rank: number
}

export interface CannedContext {
  items: readonly CannedItem[]
  /** the last revealed vote's results on the board, if any */
  revealed?: readonly CannedVoteResult[]
  now?: number
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
/** A run id the way the api mints them (`air_` and 20 base62 characters). */
export function fakeRunId(): string {
  let s = 'air_'
  for (let i = 0; i < 20; i++) s += BASE62[Math.floor(Math.random() * 62)]
  if (!AI_RUN_ID_PATTERN.test(s)) throw new Error('fakeRunId: bad id')
  return s
}

const cutText = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}
const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'which', 'did', 'does', 'about', 'that', 'this'])
const wordsOf = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))

/** The items a request names (frames stand for their children), else every item of the board. */
function scoped(items: readonly CannedItem[], refs: readonly string[] | undefined): CannedItem[] {
  const content = items.filter((i) => i.type !== 'frame' && i.text.trim())
  if (!refs?.length) return content
  const wanted = new Set(refs)
  const frames = new Set(items.filter((i) => i.type === 'frame' && wanted.has(i.ref)).map((i) => i.id))
  return content.filter((i) => wanted.has(i.ref) || (i.frameId !== null && frames.has(i.frameId)))
}

const COLOR_WORDS = [
  'light-blue',
  'light-green',
  'light-red',
  'light-violet',
  'yellow',
  'orange',
  'green',
  'blue',
  'red',
  'violet',
  'grey',
  'black',
  'white',
] as const

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The canned answer of a wave L action, as the api would send it (an AiResult: run id, truncated, budget), for
 * the board `ctx.items`. Deterministic but for the run id. Throws for a legacy action (the api answers those).
 */
export function cannedAiResult(input: AiRunInput, ctx: CannedContext): AiResult {
  const common = { truncated: false, budget: null, runId: fakeRunId() }
  const now = ctx.now ?? Date.now()
  let out: unknown
  switch (input.action) {
    case 'ask': {
      const pool = scoped(ctx.items, input.shapeIds)
      const words = wordsOf(input.question)
      const hits = pool.filter((i) => {
        const own = wordsOf(i.text)
        return words.some((q) => own.some((t) => t === q || t.startsWith(q) || q.startsWith(t)))
      })
      const first = cutText(hits[0]?.text ?? '', 80)
      out = hits.length
        ? {
            action: 'ask',
            answer: `The board mentions it in ${hits.length === 1 ? 'one place' : `${Math.min(hits.length, 5)} places`} [1]. The first is “${first}”.`,
            found: hits.length >= 2 ? 'yes' : 'partial',
            citations: [{ ids: hits.slice(0, 5).map((i) => i.ref) }],
            ...common,
          }
        : { action: 'ask', answer: '', found: 'no', citations: [], ...common }
      break
    }
    case 'recap': {
      const scope = input.scope
      const from = scope.kind === 'since' ? Math.max(scope.since, now - 14 * DAY_MS) : null
      const pool =
        scope.kind === 'shapes'
          ? scoped(ctx.items, scope.shapeIds)
          : scoped(ctx.items, undefined).filter(
              (i) => Math.max(i.createdAt ?? 0, i.lastEditedAt ?? 0) >= (from ?? 0),
            )
      const line = (i: CannedItem, prefix: string) => ({
        text: cutText(`${prefix}${i.text}`, 150),
        ids: [i.ref],
      })
      const known = new Set(ctx.items.map((i) => i.ref))
      const topVoted = (ctx.revealed ?? [])
        .filter((r) => known.has(r.ref) && r.count > 0)
        .sort((a, b) => a.rank - b.rank || b.count - a.count)
        .slice(0, 20)
        .map((r) => ({ id: r.ref, votes: r.count, rank: r.rank }))
      out = {
        action: 'recap',
        title: 'Workshop recap',
        summary: pool.length
          ? `The session covered ${pool.length} ${pool.length === 1 ? 'item' : 'items'} and agreed the next steps.`
          : 'Nothing on the board changed in this window.',
        decisions: pool.slice(0, 2).map((i) => line(i, 'Decided: ')),
        actions: pool.slice(2, 5).map((i) => ({
          task: cutText(`Follow up on ${i.text}`, 150),
          owner: null,
          ids: [i.ref],
        })),
        questions: pool.slice(5, 6).map((i) => line(i, 'Still open: ')),
        topVoted,
        windowFrom: from,
        ...common,
      }
      break
    }
    case 'command': {
      const pool = scoped(ctx.items, input.shapeIds)
      const words = wordsOf(input.instruction)
      const matched = pool.filter((i) => wordsOf(i.text).some((w) => words.includes(w)))
      const ids = (matched.length ? matched : pool).slice(0, 12).map((i) => i.ref)
      const said = input.instruction.toLowerCase()
      const color = COLOR_WORDS.find((c) => said.includes(c.replace('-', ' ')))
      const ops = !ids.length
        ? []
        : input.mode === 'find'
          ? [{ op: 'select', ids }]
          : color
            ? [{ op: 'recolor', ids, color }]
            : [{ op: 'arrangeGrid', ids }]
      out = {
        action: 'command',
        mode: input.mode,
        ops,
        explain: ids.length
          ? `Found ${ids.length} ${ids.length === 1 ? 'item' : 'items'}`
          : 'Nothing matched',
        ...common,
      }
      break
    }
    case 'diagram': {
      const pool = scoped(ctx.items, input.shapeIds).slice(0, 12)
      const labels = pool.length
        ? pool.map((i) => cutText(i.text, 58))
        : ['Start', 'Write the brief', 'Approved?', 'Ship']
      const nodes = labels.map((label, k) => ({
        id: `n${k + 1}`,
        label,
        kind: k === 0 || k === labels.length - 1 ? 'terminal' : label.endsWith('?') ? 'decision' : 'process',
      }))
      const edges = nodes.slice(1).map((n, k) => ({ from: `n${k + 1}`, to: n.id, label: '' }))
      out = { action: 'diagram', direction: input.direction, nodes, edges, ...common }
      break
    }
    case 'sort': {
      const refs = scoped(ctx.items, input.shapeIds).map((i) => i.ref)
      const half = Math.ceil(refs.length / 2)
      out = {
        action: 'sort',
        lens: input.lens,
        themes: [
          { name: 'Sooner', noteIds: refs.slice(0, half) },
          { name: 'Later', noteIds: refs.slice(half) },
        ].filter((t) => t.noteIds.length),
        ...common,
      }
      break
    }
    case 'score': {
      const refs = scoped(ctx.items, input.shapeIds).map((i) => i.ref)
      out = {
        action: 'score',
        axes: input.axes,
        scores: refs.map((id, k) => ({ id, x: k % 2 ? 3 : -3, y: k % 4 < 2 ? 3 : -3 })),
        ...common,
      }
      break
    }
    default:
      throw new Error(`cannedAiResult: ${input.action} is answered by the api`)
  }
  return AiResult.parse(out)
}

/** The board's items as the canned answers read them (labels are their containers' text), in reading order. */
export const cannedItems = (page: Page): Promise<CannedItem[]> =>
  page.evaluate(() => {
    type El = Record<string, unknown> & { id: string; type: string; x: number; y: number }
    type Stamp = { createdAt?: number; lastEditedAt?: number } | null
    const c = (
      window as unknown as {
        __lobbyBoard?: { canvas: { items(): El[]; text: { of(id: string): string } } }
      }
    ).__lobbyBoard?.canvas
    if (!c) throw new Error('no window.__lobbyBoard')
    const all = c.items()
    const byId = new Map(all.map((e) => [e.id, e]))
    const stamp = (e: El | undefined): Stamp =>
      ((e?.customData as { lobbyServer?: Stamp } | null)?.lobbyServer ?? null) as Stamp
    return all
      .filter((e) => !(e.type === 'text' && e.containerId))
      .sort((a, b) => Math.floor(a.y / 120) - Math.floor(b.y / 120) || a.x - b.x)
      .map((e) => {
        const bound = (e.boundElements as { id: string; type: string }[] | null) ?? []
        const label = bound.find((b) => b.type === 'text')
        const own = stamp(e)
        const lab = label ? stamp(byId.get(label.id)) : null
        return {
          ref: `shape:${e.id}`,
          id: e.id,
          type: e.type,
          text: e.type === 'frame' ? String(e.name ?? '') : c.text.of(e.id),
          frameId: (e.frameId as string | null) ?? null,
          createdAt: own?.createdAt ?? null,
          lastEditedAt: Math.max(own?.lastEditedAt ?? 0, lab?.lastEditedAt ?? 0) || null,
        }
      })
  })

/** The board's last revealed vote results (GET /api/boards/:bid/workshop as `page`'s person). */
export async function revealedResults(page: Page, board: string): Promise<CannedVoteResult[]> {
  const res = await page.request.get(`${WEB_URL}/api/boards/${encodeURIComponent(board)}/workshop`)
  if (!res.ok()) return []
  const body = (await res.json()) as {
    vote?: {
      session?: { status?: string }
      results?: { shapeId: string; count: number; rank: number }[] | null
    } | null
  }
  if (body.vote?.session?.status !== 'revealed') return []
  return (body.vote.results ?? []).map((r) => ({ ref: r.shapeId, count: r.count, rank: r.rank }))
}

export interface AiRunCall {
  action: string
  body: Record<string, unknown>
  /** 'api': the real api answered (its status in `status`); 'canned': the fake did */
  served: 'api' | 'canned'
  status: number
  /** the answer's run id (null for an error) */
  runId: string | null
  result: unknown
}

export interface AiRunFake {
  readonly calls: AiRunCall[]
  /** Answers the next run of `action` with this result (or a function of the request) instead. */
  next(action: WaveLAction, answer: AiResult | ((input: AiRunInput) => AiResult)): void
  /** The calls of `action` (or every call). */
  of(action?: string): AiRunCall[]
  dispose(): Promise<void>
}

const RUN_ROUTE = /\/api\/boards\/([^/]+)\/ai\/run$/
const NOT_RUN_HERE = /not available on this server yet/
const runIdOf = (json: unknown) => (json as { runId?: string } | null)?.runId ?? null

/**
 * Installs the AI run fake on `page` (see the section header). `mode` 'auto': the api first, the canned answer
 * where the api refuses the action; 'canned': never the api for a wave L action.
 */
export async function fakeAiRuns(page: Page, opts: { mode?: 'auto' | 'canned' } = {}): Promise<AiRunFake> {
  const mode = opts.mode ?? 'auto'
  const calls: AiRunCall[] = []
  const queued = new Map<string, (AiResult | ((input: AiRunInput) => AiResult))[]>()
  const handler = async (route: Route) => {
    const req = route.request()
    const m = RUN_ROUTE.exec(new URL(req.url()).pathname)
    if (req.method() !== 'POST' || !m) return route.fallback()
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
    } catch {
      // the api answers a malformed body itself
    }
    const action = String(body.action ?? '')
    const own = queued.get(action)?.shift()
    if (!(WAVE_L_ACTIONS as readonly string[]).includes(action) || (mode === 'auto' && !own)) {
      const res = await route.fetch()
      const text = await res.text()
      const refused = res.status() === 400 && NOT_RUN_HERE.test(text)
      if (!(WAVE_L_ACTIONS as readonly string[]).includes(action) || !refused) {
        let json: unknown = null
        try {
          json = JSON.parse(text)
        } catch {}
        calls.push({ action, body, served: 'api', status: res.status(), runId: runIdOf(json), result: json })
        return route.fulfill({ response: res, body: text })
      }
    }
    const input = AiRunInput.safeParse(body)
    if (!input.success) {
      calls.push({ action, body, served: 'canned', status: 400, runId: null, result: null })
      return route.fulfill({
        status: 400,
        json: { error: { code: 'BAD_REQUEST', message: 'The request was not a valid AI run.' } },
      })
    }
    const board = decodeURIComponent(m[1] ?? '')
    const result = own
      ? typeof own === 'function'
        ? own(input.data)
        : own
      : cannedAiResult(input.data, {
          items: await cannedItems(page),
          revealed: input.data.action === 'recap' ? await revealedResults(page, board) : [],
        })
    calls.push({ action, body, served: 'canned', status: 200, runId: result.runId, result })
    return route.fulfill({ status: 200, json: result })
  }
  await page.route('**/api/boards/*/ai/run', handler)
  return {
    calls,
    next(action, answer) {
      const q = queued.get(action) ?? []
      q.push(answer)
      queued.set(action, q)
    },
    of: (action) => (action ? calls.filter((c) => c.action === action) : [...calls]),
    dispose: () => page.unroute('**/api/boards/*/ai/run', handler),
  }
}

// ---- wave L (W2): board events for a tab, the network assertion -------------------------------------------

/**
 * Lets a spec hand `page` one board event as the api's event stream would (the cookie transport's EventSource,
 * the one the e2e stack uses). Install before the board opens: an init script wraps EventSource and keeps the
 * instances. Used only where this build's api does not publish an event yet (W1's `ai.working` and `ai.done`):
 * the spec says so in an annotation, and takes the api's own event whenever it arrives.
 */
export async function captureEventStreams(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { EventSource: typeof EventSource; __lobbyEventSources?: EventSource[] }
    if (w.__lobbyEventSources) return
    const Real = w.EventSource
    const open: EventSource[] = []
    w.__lobbyEventSources = open
    class Kept extends Real {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init)
        open.push(this)
      }
    }
    w.EventSource = Kept
  })
}

/**
 * How many of `page`'s kept board event streams are open (see captureEventStreams). Only the cookie
 * transport's EventSource is kept: on the direct transport (the api has DRAFTROOM_EVENTS_ORIGIN, as under
 * E2E_DIRECT_EVENTS=1) the stream is a fetch and this stays 0, so a spec that injects pins the cookie
 * stream (l2-ai-pills.spec.ts).
 */
export const openEventStreams = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      ((window as unknown as { __lobbyEventSources?: EventSource[] }).__lobbyEventSources ?? []).filter(
        (es) => es.readyState === 1,
      ).length,
  )

/** Delivers `{type, data}` to `page`'s open board event streams (see captureEventStreams). Returns how many. */
export const injectBoardEvent = (page: Page, type: string, data: unknown): Promise<number> =>
  page.evaluate(
    ({ type, data }) => {
      const list = (window as unknown as { __lobbyEventSources?: EventSource[] }).__lobbyEventSources ?? []
      let n = 0
      for (const es of list) {
        if (es.readyState !== 1) continue
        es.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type, data, seq: 0 }) }))
        n++
      }
      return n
    },
    { type, data },
  )

/** Every request of `page` that leaves Lobby's own origins (none may: the e2e network assertion). */
export function foreignRequests(page: Page): string[] {
  const own = new Set([new URL(WEB_URL).origin, new URL(API_URL).origin])
  const foreign: string[] = []
  page.on('request', (r) => {
    const url = new URL(r.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return
    if (!own.has(url.origin)) foreign.push(r.url())
  })
  return foreign
}

/** POST /api/boards/:bid/ai/run requests `page` made, counted from the network (whatever answered them). */
export function aiRunRequests(page: Page): string[] {
  const seen: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && RUN_ROUTE.test(new URL(r.url()).pathname)) seen.push(r.url())
  })
  return seen
}

// ---- wave M (the foundation; this kit is W4's): canned answers for Ask across boards (M8-2, M4-6) ------------------
//
// POST /api/workspaces/:wid/ai/ask is pending on the foundation's api (404 NOT_FOUND, as any unknown route) until W8
// implements it. These let W4's Ask panel specs run either way: `fakeWorkspaceAsk(page)` answers every ask with a
// canned WorkspaceAskResponse (or `unavailable: true`: the 404 an api without the route gives), and records the
// requests. The answers are checked against the contract, so a canned answer can never be one the api could not send.

export const WORKSPACE_ASK_GLOB = '**/api/workspaces/*/ai/ask'
const WORKSPACE_ASK_ROUTE = /\/api\/workspaces\/([^/]+)\/ai\/ask$/

/** One cited board of a canned answer. */
export interface CannedCitation {
  boardId: string
  boardTitle: string
  elementIds: string[]
}

/** A canned answer citing `citations` (found 'yes' with any, 'no' with none); `exportAllowed` defaults to true. */
export function cannedWorkspaceAsk(
  citations: readonly CannedCitation[],
  opts: { answer?: string; found?: 'yes' | 'partial' | 'no'; exportAllowed?: boolean } = {},
): WorkspaceAskResponse {
  const found = opts.found ?? (citations.length ? 'yes' : 'no')
  const answer =
    opts.answer ??
    (citations.length
      ? `${citations.map((c, i) => `${c.boardTitle} [${i + 1}]`).join(' and ')} say so.`
      : 'Your boards don’t say.')
  return WorkspaceAskResponse.parse({
    answer,
    found,
    citations: citations.map((c) => ({ ...c, elementIds: [...c.elementIds] })),
    exportAllowed: opts.exportAllowed ?? true,
  })
}

/** The "boards don't say" answer. */
export const CANNED_WORKSPACE_ASK_NOTHING: WorkspaceAskResponse = cannedWorkspaceAsk([])

export interface WorkspaceAskCall {
  workspaceId: string
  body: unknown
  status: number
}

export interface WorkspaceAskFake {
  readonly calls: WorkspaceAskCall[]
  /** Answers the next ask with this (or a function of the request) instead of the default. */
  next(answer: WorkspaceAskResponse | ((input: WorkspaceAskRequest) => WorkspaceAskResponse)): void
  dispose(): Promise<void>
}

/**
 * Installs the fake on `page`: every POST /api/workspaces/:wid/ai/ask gets `answer` (default: the nothing answer), a
 * queued `next` one first, a 400 for a body the contract refuses, or with `unavailable` the unknown route's 404.
 */
export async function fakeWorkspaceAsk(
  page: Page,
  opts: { answer?: WorkspaceAskResponse; unavailable?: boolean } = {},
): Promise<WorkspaceAskFake> {
  const calls: WorkspaceAskCall[] = []
  const queued: (WorkspaceAskResponse | ((input: WorkspaceAskRequest) => WorkspaceAskResponse))[] = []
  const handler = async (route: Route) => {
    const req = route.request()
    const m = WORKSPACE_ASK_ROUTE.exec(new URL(req.url()).pathname)
    if (req.method() !== 'POST' || !m) return route.fallback()
    const workspaceId = decodeURIComponent(m[1] ?? '')
    let body: unknown = null
    try {
      body = JSON.parse(req.postData() ?? 'null')
    } catch {
      // refused below
    }
    if (opts.unavailable) {
      calls.push({ workspaceId, body, status: 404 })
      return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found.' } } })
    }
    const input = WorkspaceAskRequest.safeParse(body)
    if (!input.success) {
      calls.push({ workspaceId, body, status: 400 })
      return route.fulfill({
        status: 400,
        json: { error: { code: 'BAD_REQUEST', message: 'Not a valid question.' } },
      })
    }
    const own = queued.shift()
    const answer = own
      ? typeof own === 'function'
        ? own(input.data)
        : own
      : (opts.answer ?? CANNED_WORKSPACE_ASK_NOTHING)
    calls.push({ workspaceId, body, status: 200 })
    return route.fulfill({ status: 200, json: WorkspaceAskResponse.parse(answer) })
  }
  await page.route(WORKSPACE_ASK_GLOB, handler)
  return {
    calls,
    next(answer) {
      queued.push(answer)
    },
    dispose: () => page.unroute(WORKSPACE_ASK_GLOB, handler),
  }
}

/**
 * Forces Ask across boards on (or off; null puts the rule back) for the open board's workspace, through the dev-auth
 * hook `window.__lobbyWorkspaceAsk` (apps/web/src/features/ai/workspace-ask/dev-hook.ts). The client then posts each
 * ask, which fakeWorkspaceAsk answers, and a 404 (`unavailable: true`) still turns it off, as on an api without the
 * route. Waits for the hook (the ai-workspace-ask feature is mounted once the board is).
 */
export async function forceWorkspaceAsk(page: Page, on: boolean | null): Promise<void> {
  await page.waitForFunction(() => !!window.__lobbyWorkspaceAsk, undefined, { timeout: 30_000 })
  await page.evaluate((v) => window.__lobbyWorkspaceAsk?.force(v), on)
}

// ---- wave M (W4): what the m4 specs measure on the page -------------------------------------------------------

/**
 * The WCAG contrast ratio of `locator`'s text against what is painted behind it: its own background, else the
 * first ancestor's that is opaque (a see-through colour is laid over the ones under it). Computed styles only.
 */
export const contrastOf = (locator: Locator): Promise<number> =>
  locator.evaluate((el) => {
    const parse = (s: string): [number, number, number, number] | null => {
      const m = /rgba?\(([^)]+)\)/.exec(s)
      if (!m) return null
      const p = (m[1] ?? '')
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number)
      return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1]
    }
    const over = (top: number[], under: number[]) =>
      [0, 1, 2].map((i) => (top[i] ?? 0) * (top[3] ?? 1) + (under[i] ?? 0) * (1 - (top[3] ?? 1)))
    // the backgrounds from the element up to the first opaque one, then laid over each other
    const layers: number[][] = []
    for (let n: Element | null = el; n; n = n.parentElement) {
      const bg = parse(getComputedStyle(n).backgroundColor)
      if (bg && bg[3] > 0) layers.push(bg)
      if (bg && bg[3] >= 1) break
    }
    let back = [255, 255, 255]
    for (const l of layers.reverse()) back = over(l, back)
    const cs = getComputedStyle(el)
    const fg = parse(cs.color) ?? [0, 0, 0, 1]
    const ink = over(fg, back)
    const lin = (v: number) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    const lum = (c: number[]) => 0.2126 * lin(c[0] ?? 0) + 0.7152 * lin(c[1] ?? 0) + 0.0722 * lin(c[2] ?? 0)
    // an element drawn see-through (opacity) shows the canvas through it: the ratio is that of what is painted
    let alpha = 1
    for (let n: Element | null = el; n; n = n.parentElement) alpha *= Number(getComputedStyle(n).opacity || 1)
    const a = lum(over([...ink, alpha], back))
    const b = lum(back)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  })

/** Whether a press at the middle of `locator` lands on it (document.elementFromPoint is it or inside it). */
export const hitTestable = (locator: Locator): Promise<boolean> =>
  locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!hit && (hit === el || el.contains(hit))
  })

/** The element a press at client point `p` lands on, as `tag#testid.class` (for a failure's message). */
export const elementAt = (page: Page, p: { x: number; y: number }): Promise<string> =>
  page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y)
    if (!hit) return 'nothing'
    const id = hit.getAttribute('data-testid')
    return `${hit.tagName.toLowerCase()}${id ? `#${id}` : ''}${hit.classList.length ? `.${[...hit.classList].join('.')}` : ''}`
  }, p)

/** askWorkspaceAvailable() in the page. */
export const workspaceAskAvailable = (page: Page): Promise<boolean> =>
  page.evaluate(() => window.__lobbyWorkspaceAsk?.available() ?? false)

/** One ask through the page's real client, settled: the parsed answer, or the rejection's code and message. */
export const askWorkspaceInPage = (
  page: Page,
  question: string,
  acknowledged?: boolean,
): Promise<WorkspaceAskHookOutcome> =>
  page.evaluate(
    ({ q, ack }) => {
      const hook = window.__lobbyWorkspaceAsk
      if (!hook) throw new Error('no window.__lobbyWorkspaceAsk')
      return hook.ask(q, ack)
    },
    { q: question, ack: acknowledged },
  )

// ---- wave N (the foundation; this kit is WS5's): canned outputs for Capture the room ------------------------------
//
// POST /api/boards/:bid/ai/capture/{photo,board-image,transcript} are pending on the foundation's api (404 NOT_FOUND,
// as any unknown route) until WS5 implements them. These let WS5's n5 specs run either way: `fakeCapture(page)`
// answers each capture with its canned CaptureResponse (or `unavailable: true`: the 404 an api without the routes
// gives; or `vision: false`: the photo routes' 404 while transcripts work), and records the requests (never their
// bytes or text: only the size and the content type, as the api may log). Every canned answer is parsed with the
// contract, so a canned answer can never be one the api could not send.

const CAPTURE_RUN = 'air_CaptureFoundation000'
const box = (x: number, y: number, w = 0.14, h = 0.14) => ({ x, y, w, h })

/** The three canned results: notes from a photo of a wall, a 5-node diagram, and a meeting's themes. */
export const CANNED_CAPTURE: {
  readonly notes: CaptureResult
  readonly diagram: CaptureResult
  readonly transcript: CaptureResult
} = {
  // a sticky wall in two columns: six notes, two groups
  notes: {
    kind: 'notes',
    notes: [
      { text: 'Shorter stand-ups', color: 'yellow', box: box(0.06, 0.08) },
      { text: 'Demo every Friday', color: 'yellow', box: box(0.06, 0.28) },
      { text: 'Pair on reviews', color: 'light-green', box: box(0.06, 0.48) },
      { text: 'Too many meetings', color: 'light-red', box: box(0.55, 0.08) },
      { text: 'Unclear priorities', color: 'light-red', box: box(0.55, 0.28) },
      { text: 'Slow builds', color: 'orange', box: box(0.55, 0.48) },
    ],
    groups: [
      { name: 'Keep', notes: [0, 1, 2] },
      { name: 'Change', notes: [3, 4, 5] },
    ],
  },
  // a whiteboard flow: start, two steps, a decision, an end; one labelled branch and one plain line
  diagram: {
    kind: 'diagram',
    nodes: [
      { id: 'n1', label: 'Brief in', shape: 'ellipse', box: box(0.05, 0.4, 0.14, 0.12) },
      { id: 'n2', label: 'Sketch ideas', shape: 'rect', box: box(0.25, 0.4, 0.14, 0.12) },
      { id: 'n3', label: 'Client happy?', shape: 'diamond', box: box(0.45, 0.38, 0.16, 0.16) },
      { id: 'n4', label: 'Final art', shape: 'rect', box: box(0.68, 0.4, 0.14, 0.12) },
      { id: 'n5', label: 'Ship', shape: 'ellipse' },
    ],
    edges: [
      { from: 'n1', to: 'n2', kind: 'arrow' },
      { from: 'n2', to: 'n3', kind: 'arrow' },
      { from: 'n3', to: 'n4', kind: 'arrow', label: 'yes' },
      { from: 'n3', to: 'n2', kind: 'arrow', label: 'no' },
      { from: 'n4', to: 'n5', kind: 'line' },
    ],
  },
  // a meeting: 3 themes, 2 decisions, 3 actions (one without an owner)
  transcript: {
    kind: 'transcript',
    themes: [
      { name: 'Schedule', notes: ['Shoot moves to the 14th', 'Edit needs two more days'] },
      { name: 'Budget', notes: ['Travel is over by 10%', 'Drop the second location'] },
      { name: 'Team', notes: ['Sam joins as editor'] },
    ],
    decisions: ['We shoot on the 14th', 'One location only'],
    actions: [
      { text: 'Book the studio for the 14th', owner: 'Ana' },
      { text: 'Send the revised budget', owner: 'Bo' },
      { text: 'Share the shot list' },
    ],
  },
}

/** A whole canned answer (the quota: `photosLeftToday` / `transcriptsLeftToday`, default 7 and 9). */
export function cannedCaptureResponse(
  result: CaptureResult,
  quota: { photosLeftToday?: number | null; transcriptsLeftToday?: number | null } = {},
): CaptureResponse {
  return CaptureResponse.parse({
    runId: CAPTURE_RUN,
    result,
    quota: {
      photosLeftToday: quota.photosLeftToday ?? 7,
      transcriptsLeftToday: quota.transcriptsLeftToday ?? 9,
    },
  })
}

export const CAPTURE_GLOB = '**/api/boards/*/ai/capture/*'
const CAPTURE_ROUTE = /\/api\/boards\/([^/]+)\/ai\/capture\/(photo|board-image|transcript)$/

export interface CaptureCall {
  boardId: string
  /** the request body as sent: kept only when the fake was made with `keepBodies` (test data, never logged) */
  body?: Buffer
  kind: 'photo' | 'board-image' | 'transcript'
  /** the photo's `mode` query, or the board-image body's mode */
  mode: string | null
  contentType: string | null
  bytes: number
  status: number
}

export interface CaptureFake {
  readonly calls: CaptureCall[]
  /** Answers the next capture with this instead of the default for its kind. */
  next(answer: CaptureResponse): void
  dispose(): Promise<void>
}

const NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'Not found.' } }

/**
 * Installs the fake on `page`: a photo or board image answers CANNED_CAPTURE.notes (mode notes or auto) or .diagram
 * (mode diagram), a transcript answers .transcript; a queued `next` answer first. A photo over the contract's size, or
 * a transcript the contract refuses, gets the api's 413 or 400. `unavailable`: every capture is the unknown route's
 * 404; `vision: false`: only the photo routes are.
 */
export async function fakeCapture(
  page: Page,
  opts: { unavailable?: boolean; vision?: boolean; keepBodies?: boolean } = {},
): Promise<CaptureFake> {
  const calls: CaptureCall[] = []
  const queued: CaptureResponse[] = []
  const handler = async (route: Route) => {
    const req = route.request()
    const url = new URL(req.url())
    const m = CAPTURE_ROUTE.exec(url.pathname)
    if (req.method() !== 'POST' || !m) return route.fallback()
    const kind = m[2] as CaptureCall['kind']
    const body = req.postDataBuffer()
    let mode = url.searchParams.get('mode')
    let json: unknown = null
    if (kind !== 'photo') {
      try {
        json = JSON.parse(body?.toString('utf8') ?? 'null')
      } catch {
        // refused below
      }
      if (kind === 'board-image') mode = String((json as { mode?: unknown } | null)?.mode ?? 'auto')
    }
    const call: CaptureCall = {
      boardId: decodeURIComponent(m[1] ?? ''),
      kind,
      mode,
      contentType: req.headers()['content-type'] ?? null,
      bytes: body?.length ?? 0,
      status: 200,
      ...(opts.keepBodies && body ? { body: Buffer.from(body) } : {}),
    }
    calls.push(call)
    const fulfil = (status: number, payload: unknown) => {
      call.status = status
      return route.fulfill({ status, json: payload })
    }
    if (opts.unavailable || (opts.vision === false && kind !== 'transcript')) return fulfil(404, NOT_FOUND)
    if (kind === 'photo' && call.bytes > CAPTURE_PHOTO_MAX_BYTES)
      return fulfil(413, {
        error: { code: 'AI_CAPTURE_IMAGE_TOO_LARGE', message: 'This photo is too large.' },
      })
    if (kind === 'transcript' && !CaptureTranscriptRequest.safeParse(json).success)
      return fulfil(400, { error: { code: 'BAD_REQUEST', message: 'Not a valid transcript.' } })
    const own = queued.shift()
    const result =
      kind === 'transcript'
        ? CANNED_CAPTURE.transcript
        : mode === 'diagram'
          ? CANNED_CAPTURE.diagram
          : CANNED_CAPTURE.notes
    return fulfil(200, CaptureResponse.parse(own ?? cannedCaptureResponse(result)))
  }
  await page.route(CAPTURE_GLOB, handler)
  return {
    calls,
    next(answer) {
      queued.push(CaptureResponse.parse(answer))
    },
    dispose: () => page.unroute(CAPTURE_GLOB, handler),
  }
}

// ---- wave N (WS5): the Capture the room UI -----------------------------------------------------------------------

/** The capture dialog. */
export const captureDialog = (page: Page) => page.getByTestId('capture-dialog')

/** Right-clicks empty canvas (the view's right part) and opens AI › Capture the room…. */
export async function openCaptureFromMenu(page: Page): Promise<void> {
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no canvas')
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.55, { button: 'right' })
  await expect(page.getByTestId('context-menu-root')).toBeVisible()
  await page.getByRole('menuitem', { name: 'AI', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Capture the room…' }).click()
  await expect(captureDialog(page)).toBeVisible()
}

/** Presses Continue on the first-use notice when it shows (the notice is once per person and kind, per device). */
export async function continueCaptureNotice(page: Page): Promise<boolean> {
  const notice = page.getByTestId('capture-notice')
  const started = page
    .getByTestId('capture-busy')
    .or(page.getByTestId('ai-preview-panel'))
    .or(page.getByTestId('capture-error'))
  await expect(notice.or(started).first()).toBeVisible({ timeout: 20_000 })
  if (!(await notice.isVisible())) return false
  await page.getByTestId('capture-notice-continue').click()
  return true
}

const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff]

/**
 * A phone-like JPEG of `width` × `height`: drawn by the page's own canvas (a sticky wall: coloured squares), then an
 * EXIF APP1 segment with a GPS tag and a comment with a place spliced in after its SOI, as a camera writes them.
 */
export async function phonePhoto(page: Page, width = 3000, height = 2000): Promise<Buffer> {
  const bytes = await page.evaluate(
    async ({ w, h }) => {
      const c = new OffscreenCanvas(w, h)
      const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.fillStyle = '#d9d4c7'
      ctx.fillRect(0, 0, w, h)
      const colours = ['#f8e48f', '#f6bfc4', '#cde7a2', '#f4a874']
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = colours[i % colours.length] as string
        ctx.fillRect((i % 2) * w * 0.5 + w * 0.06, Math.floor(i / 2) * h * 0.2 + h * 0.08, w * 0.14, w * 0.14)
      }
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
      return [...new Uint8Array(await blob.arrayBuffer())]
    },
    { w: width, h: height },
  )
  const ascii = (s: string) => [...s].map((ch) => ch.charCodeAt(0))
  const tiff = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x25, 0x88, 4, 0, 1, 0, 0, 0, 26, 0, 0, 0]
  const exif = [...ascii('Exif'), 0, 0, ...tiff, ...ascii('GPS 51.5072N 0.1276W')]
  const comment = ascii('Taken at the studio, 51.5072N')
  const app1 = [0xff, 0xe1, ...be16(exif.length + 2), ...exif]
  const com = [0xff, 0xfe, ...be16(comment.length + 2), ...comment]
  return Buffer.from([...bytes.slice(0, 2), ...app1, ...com, ...bytes.slice(2)])
}

/** A JPEG's frame size and whether it still carries metadata segments (APP1-APP15, COM). */
export function jpegFacts(b: Buffer): { width: number; height: number; metadata: number[] } {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('not a JPEG')
  const metadata: number[] = []
  let o = 2
  let width = 0
  let height = 0
  while (o + 4 <= b.length) {
    const marker = b[o + 1] ?? 0
    const len = ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) metadata.push(marker)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      height = ((b[o + 5] ?? 0) << 8) | (b[o + 6] ?? 0)
      width = ((b[o + 7] ?? 0) << 8) | (b[o + 8] ?? 0)
    }
    if (marker === 0xda) break
    o += 2 + len
  }
  return { width, height, metadata }
}

/** No element of the scene holds an image, a data or blob URL, or a link (a scan of every element's JSON). */
export function sceneHoldsNoImage(elements: readonly object[]): string[] {
  return elements.flatMap((e) => {
    const json = JSON.stringify(e)
    const bad = ['data:', 'blob:', 'http:', 'https:'].filter((s) => json.includes(s))
    return bad.length ? [`${(e as { id?: string }).id}: ${bad.join(', ')}`] : []
  })
}
