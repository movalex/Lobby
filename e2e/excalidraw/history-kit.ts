// OWNER: 3h. Helpers for the ported History specs (history-*.spec.ts) on the Excalidraw board page: the
// board content the tldraw suite drew (support/history.ts `drawFrameBoard`) as elements, deleting with
// the real keyboard, reading placements, bindings and labels, and the server's own copy (the test
// snapshot). The dock panel helpers (openHistory, rows, the api reads) are engine-neutral and come from
// ../tests/support/history.ts.
import { expect, type Page } from '@playwright/test'
import {
  type CanvasElement,
  createItem,
  createNote,
  expectSaved,
  item,
  items,
  select,
  selectNone,
  updateItem,
} from '../tests/support/canvas.ts'
import { serverSnapshot } from '../tests/support/excalidraw.ts'
import type { Stack } from '../tests/support/stack.ts'
import { focusBoard, settled } from './board-kit.ts'

/** api object refs (Recently deleted rows, restore ids) are `shape:<elementId>`. */
export const ref = (id: string) => `shape:${id}`

type Any = Record<string, unknown>
const bound = (el: CanvasElement | null | undefined) =>
  ((el as { boundElements?: { id: string; type: string }[] | null } | null)?.boundElements ?? []) as {
    id: string
    type: string
  }[]

/** Lobby's note fills (board-ops elements/palette.ts), for the notes this suite draws. */
export const NOTE_FILL = { yellow: '#f6c453', blue: '#a7b7f6', green: '#93cfa6' } as const

/** Frame membership of `ids` (their labels too) through the page's canvas: one undo step. */
export async function setFrame(page: Page, ids: string[], frameId: string | null): Promise<void> {
  await page.evaluate(
    ({ ids, frameId }) => {
      const b = (
        window as unknown as {
          __lobbyBoard?: {
            canvas: {
              transact(l: string, fn: (tx: { setFrame(i: string[], f: string | null): void }) => void): void
            }
          }
        }
      ).__lobbyBoard
      if (!b) throw new Error('no window.__lobbyBoard (not the Excalidraw board page?)')
      b.canvas.transact('e2e: frame', (tx) => tx.setFrame(ids, frameId))
    },
    { ids, frameId },
  )
}

export interface FrameBoard {
  frame: string
  note1: string
  note2: string
  box: string
  arrow: string
}

/**
 * A frame "Sprint ideas" holding two notes, a box outside it, and a connector on the page from the
 * first note to the box (bound at both ends): support/history.ts `drawFrameBoard` as elements. Each
 * write waits for Saved (spike B's open O2 race, board-kit.ts `settled`).
 */
export async function drawFrameBoard(page: Page, prefix: string): Promise<FrameBoard> {
  const ids: FrameBoard = {
    frame: `${prefix}-frame`,
    note1: `${prefix}-note-1`,
    note2: `${prefix}-note-2`,
    box: `${prefix}-box`,
    arrow: `${prefix}-arrow`,
  }
  await settled(
    page,
    createItem(page, 'frame', { id: ids.frame, x: 60, y: 60, width: 460, height: 300, name: 'Sprint ideas' }),
  )
  await settled(
    page,
    createItem(page, 'note', {
      id: ids.note1,
      x: 90,
      y: 120,
      text: 'Ship the moodboard',
      backgroundColor: NOTE_FILL.yellow,
    }),
  )
  await settled(
    page,
    createItem(page, 'note', {
      id: ids.note2,
      x: 300,
      y: 120,
      text: 'Record the voiceover',
      backgroundColor: NOTE_FILL.blue,
    }),
  )
  await settled(page, setFrame(page, [ids.note1, ids.note2], ids.frame))
  await settled(
    page,
    createItem(page, 'rectangle', {
      id: ids.box,
      x: 640,
      y: 380,
      width: 160,
      height: 110,
      backgroundColor: NOTE_FILL.green,
      fillStyle: 'solid',
    }),
  )
  await settled(
    page,
    createItem(page, 'arrow', {
      id: ids.arrow,
      x: 190,
      y: 330,
      points: [
        [0, 0],
        [450, 110],
      ],
    }),
  )
  await settled(
    page,
    updateItem(page, ids.arrow, {
      startBinding: { elementId: ids.note1, fixedPoint: [0.5, 1], mode: 'orbit' },
      endBinding: { elementId: ids.box, fixedPoint: [0, 0.5], mode: 'orbit' },
    }),
  )
  await expect.poll(() => boundEnds(page, ids.arrow)).toEqual([`end->${ids.box}`, `start->${ids.note1}`])
  return ids
}

/** New words for an existing element through the text lease (LobbyCanvas.text.replace), then Saved. */
export async function replaceText(page: Page, id: string, text: string): Promise<boolean> {
  const ok = await page.evaluate(
    ({ id, text }) => {
      const b = (
        window as unknown as {
          __lobbyBoard?: { canvas: { text: { replace(i: string, t: string): Promise<boolean> } } }
        }
      ).__lobbyBoard
      if (!b) throw new Error('no window.__lobbyBoard (not the Excalidraw board page?)')
      return b.canvas.text.replace(id, text)
    },
    { id, text },
  )
  if (ok) await expectSaved(page)
  return ok
}

/** A note with its words, waited for Saved. */
export const putNote = (page: Page, id: string, text: string, x = 120, y = 120) =>
  settled(page, createItem(page, 'note', { id, x, y, text, backgroundColor: NOTE_FILL.yellow }))

export { createNote }

/** "start->x" / "end->y" for an arrow's bound ends, sorted (the same on every client when bound). */
export async function boundEnds(page: Page, arrowId: string): Promise<string[]> {
  const a = (await item(page, arrowId)) as {
    isDeleted?: boolean
    startBinding?: { elementId: string } | null
    endBinding?: { elementId: string } | null
  } | null
  if (!a || a.isDeleted) return []
  const out: string[] = []
  if (a.startBinding?.elementId) out.push(`start->${a.startBinding.elementId}`)
  if (a.endBinding?.elementId) out.push(`end->${a.endBinding.elementId}`)
  return out.sort()
}

/** Where an element sits: its frame and its scene position (null when it is not on the board). */
export async function placement(
  page: Page,
  id: string,
): Promise<{ frameId: string | null; x: number; y: number } | null> {
  const e = (await item(page, id)) as (Any & { isDeleted?: boolean }) | null
  if (!e || e.isDeleted) return null
  return { frameId: (e.frameId as string | null) ?? null, x: e.x as number, y: e.y as number }
}

/** Whether `id` is live on this tab. */
export const onBoard = async (page: Page, id: string) => (await placement(page, id)) !== null

/** Live ids of the page. */
export const liveIds = async (page: Page) => (await items(page)).map((e) => e.id)

/** A note's (or any container's) label text, or null. */
export async function labelOf(page: Page, id: string): Promise<string | null> {
  const el = await item(page, id)
  const labelId = bound(el).find((b) => b.type === 'text')?.id
  if (!labelId) return null
  const label = (await item(page, labelId)) as { originalText?: string } | null
  return label?.originalText ?? null
}

/** Selects `ids` and presses Delete on the focused board, as a person deleting a selection does. */
export async function deleteWithKeyboard(page: Page, ids: string[]): Promise<void> {
  await focusBoard(page)
  await select(page, ids)
  await page.keyboard.press('Delete')
  await expect
    .poll(async () => {
      const live = new Set(await liveIds(page))
      return ids.filter((id) => live.has(id)).length
    })
    .toBe(0)
}

/**
 * Deletes `ids` (labels with their containers) in one step through the page's canvas: a frame with the
 * objects inside it, as Lobby's delete does on the tldraw page. Excalidraw's own Delete on a frame keeps
 * the frame's children (actionDeleteSelected), a canvas-UX difference reported to 3a.
 */
export async function deleteTogether(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((list) => {
    const b = (
      window as unknown as {
        __lobbyBoard?: {
          canvas: { transact(l: string, fn: (tx: { delete(id: string): void }) => void): void }
        }
      }
    ).__lobbyBoard
    if (!b) throw new Error('no window.__lobbyBoard (not the Excalidraw board page?)')
    b.canvas.transact('e2e: delete', (tx) => {
      for (const id of list) tx.delete(id)
    })
  }, ids)
  await expect
    .poll(async () => {
      const live = new Set(await liveIds(page))
      return ids.filter((id) => live.has(id)).length
    })
    .toBe(0)
}

/** Ctrl/Cmd+Z on the focused board. */
export async function undoWithKeyboard(page: Page): Promise<void> {
  await focusBoard(page)
  await selectNone(page)
  await page.keyboard.press('ControlOrMeta+z')
}

/** The board's live elements as the sync server stored them (the test snapshot, tombstones dropped). */
export async function serverElements(stack: Stack, board: string): Promise<CanvasElement[]> {
  const snap = await serverSnapshot(stack, board)
  return snap.elements.filter((e) => !(e as { isDeleted?: boolean }).isDeleted) as CanvasElement[]
}

/** A comparable summary of a board: every live object with its kind, place, frame and words. */
export async function describeServerBoard(stack: Stack, board: string): Promise<string[]> {
  return describeElements(await serverElements(stack, board))
}

export async function describeTab(page: Page): Promise<string[]> {
  return describeElements(await items(page))
}

export function describeElements(all: readonly CanvasElement[]): string[] {
  const byId = new Map(all.map((e) => [e.id, e as unknown as Any]))
  const out: string[] = []
  for (const raw of all) {
    const e = raw as unknown as Any
    if (e.isDeleted || (e.type === 'text' && e.containerId)) continue
    const labelId = bound(raw).find((b) => b.type === 'text')?.id
    const text =
      e.type === 'text'
        ? String(e.originalText ?? '')
        : e.type === 'frame'
          ? String(e.name ?? '')
          : labelId
            ? String(byId.get(labelId)?.originalText ?? '')
            : ''
    out.push(
      `${e.id}|${e.type}|${Math.round(e.x as number)},${Math.round(e.y as number)}|${e.frameId ?? ''}|${text}`,
    )
  }
  return out.sort()
}

/** The board id a history-open-board link points at. */
export async function openBoardTarget(page: Page): Promise<string> {
  const href = (await page.getByTestId('history-open-board').getAttribute('href')) ?? ''
  const id = /^\/b\/(b-[0-9a-z]{10})$/.exec(href)?.[1]
  if (!id) throw new Error(`unexpected open-board href ${href}`)
  return id
}

/** Every write of this tab has reached the server. */
export const allSaved = (page: Page) => expectSaved(page)
