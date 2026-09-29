// Shared helpers for the host/input owner's spike A specs (host-*.spec.ts). They drive
// /spike/host-lab (apps/web/src/canvas/spike/pages/host-lab.tsx) only through window.__lobbySpike.
import { expect, type Page } from '@playwright/test'
import { type OpenSpikeOptions, openSpike } from '../support/page.ts'
import type { SpikeElement } from '../support/spike-global.ts'

export interface LabQuery {
  grant?: number | 'manual'
  allowlist?: 'on' | 'off'
  dbl?: 'on' | 'off'
  dup?: 'on' | 'off'
  copy?: 'allow' | 'deny'
  toolbar?: boolean
}

export async function openLab(page: Page, q: LabQuery = {}, opts: OpenSpikeOptions = {}): Promise<void> {
  const query: Record<string, string> = { ...(opts.query ?? {}) }
  if (q.grant !== undefined) query.grant = String(q.grant)
  if (q.allowlist) query.allowlist = q.allowlist
  if (q.dbl) query.dbl = q.dbl
  if (q.dup) query.dup = q.dup
  if (q.copy) query.copy = q.copy
  if (q.toolbar) query.toolbar = '1'
  await openSpike(page, 'host-lab', { ...opts, query })
}

/**
 * Runs `fn(extra, arg)` in the page, where `extra` is host-lab's handle (untyped on the e2e side).
 * Playwright evaluates the expression string in the page, as it does for a function; `arg` must be
 * JSON-serialisable.
 */
export function lab<T, A = undefined>(
  page: Page,
  // biome-ignore lint/suspicious/noExplicitAny: the page-side handle is typed in apps/web, not here
  fn: (x: any, arg: A) => T | Promise<T>,
  arg?: A,
): Promise<T> {
  const expr = `(async () => {
    const spike = window.__lobbySpike
    if (!spike || !spike.api) throw new Error('host-lab not ready')
    return await (${fn.toString()})(spike.extra, ${JSON.stringify(arg ?? null)})
  })()`
  return page.evaluate(expr) as Promise<T>
}

export interface NoteIds {
  note: string
  label: string | null
}

export async function addNote(
  page: Page,
  o: { id?: string; x?: number; y?: number; text?: string; size?: number; created?: number | null } = {},
): Promise<NoteIds> {
  return lab(page, (x, a) => x.fixture.note(a), o)
}

export async function elements(page: Page): Promise<SpikeElement[]> {
  return lab(page, (x) => x.elements())
}

export async function element(page: Page, id: string): Promise<SpikeElement | undefined> {
  return (await elements(page)).find((e) => e.id === id)
}

export async function versions(page: Page): Promise<Record<string, [number, number]>> {
  return lab(page, (x) => x.versions())
}

export interface EditorState {
  phase: 'idle' | 'pending' | 'opening' | 'open'
  origin: string | null
  leaseId: string | null
  editingId: string | null
  /** Excalidraw text editors in the DOM (textarea.excalidraw-wysiwyg). */
  textareas: number
  textarea: null | {
    readOnly: boolean
    value: string
    selectionStart: number
    selectionEnd: number
    focused: boolean
    left: number
    top: number
    width: number
    height: number
  }
}

export async function editor(page: Page): Promise<EditorState> {
  return lab(page, (x) => x.editor())
}

/** Scene point -> page (client) point, through Excalidraw's own transform. */
export async function toClient(
  page: Page,
  sceneX: number,
  sceneY: number,
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ sx, sy }) => {
      const spike = window.__lobbySpike
      if (!spike?.api) throw new Error('not ready')
      return spike.lib.sceneCoordsToViewportCoords({ sceneX: sx, sceneY: sy }, spike.api.getAppState())
    },
    { sx: sceneX, sy: sceneY },
  )
}

/** The center of an element, in client coordinates. */
export async function centerOf(page: Page, id: string): Promise<{ x: number; y: number }> {
  const el = await element(page, id)
  if (!el) throw new Error(`no element ${id}`)
  return toClient(page, el.x + el.width / 2, el.y + el.height / 2)
}

export async function resetLab(page: Page): Promise<void> {
  await lab(page, (x) => x.reset())
  await page.keyboard.press('Escape').catch(() => {})
  await expect.poll(() => editor(page).then((e) => e.phase)).toBe('idle')
  await lab(page, (x) => x.reset())
}

/** Selects exactly these ids (a selection change, as a click would make). */
export async function select(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((sel) => {
    const api = window.__lobbySpike?.api
    if (!api) throw new Error('not ready')
    api.updateScene({
      appState: { selectedElementIds: Object.fromEntries(sel.map((id) => [id, true])), selectedGroupIds: {} },
    })
  }, ids)
  await page.waitForFunction((sel) => {
    const s = window.__lobbySpike?.api?.getAppState()
    const ids = (s?.selectedElementIds ?? {}) as Record<string, boolean>
    return sel.every((id) => ids[id]) && Object.keys(ids).filter((k) => ids[k]).length === sel.length
  }, ids)
}

/** Puts the keyboard focus on Excalidraw's container (as a click on the canvas does). */
export async function focusCanvas(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.excalidraw')?.focus()
  })
}

/** Waits until the editor state matches. */
export async function waitEditor(
  page: Page,
  pred: (e: EditorState) => boolean,
  timeout = 5000,
): Promise<EditorState> {
  let last: EditorState | null = null
  await expect
    .poll(
      async () => {
        last = await editor(page)
        return pred(last)
      },
      { timeout },
    )
    .toBe(true)
  if (!last) throw new Error('unreachable')
  return last
}

/** host-lab's A6/A16 regression monitor (apps/web/src/canvas/spike/pages/host-lab.tsx). */
export interface MonitorReport {
  /** writable-editor-without-lease, input-into-unleased-editor, disagree (Lobby vs Excalidraw). */
  violations: { kind: string; [key: string]: unknown }[]
  releases: { id: string; text: string | null; at: number }[]
  textWrites: { id: string; text: string; held: boolean; at: number }[]
  reached: {
    probe: string
    key: string
    code: string
    ctrl: boolean
    meta: boolean
    alt: boolean
    shift: boolean
  }[]
  inputs: { probe: string; type: string; inputType: string; leased: boolean; value: string }[]
}

export interface Agreement {
  ok: boolean
  issues: string[]
  phase: string
  origin: string | null
  leaseId: string | null
  editing: string | null
  textareas: number
}

export const monitorStart = (page: Page) => lab(page, (x) => x.monitor.start())
export const monitorReport = (page: Page): Promise<MonitorReport> => lab(page, (x) => x.monitor.report())
export const agreement = (page: Page): Promise<Agreement> => lab(page, (x) => x.agreement())

/** Two animation frames, then `ms`. */
export const settle = (page: Page, ms = 120) =>
  page.evaluate(
    (t) =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(), t))),
      ),
    ms,
  )

/** The lease ids this session asked for (lease.acquire messages), in order. */
export async function acquires(page: Page): Promise<string[]> {
  return lab(page, (x) =>
    x.lease
      .log()
      .filter(
        (l: { dir: string; message: { type: string } }) =>
          l.dir === 'up' && l.message.type === 'lease.acquire',
      )
      .map((l: { message: { id: string } }) => l.message.id),
  )
}

/** A point on a note's body, away from its centered label. */
export async function bodyPoint(page: Page, id: string): Promise<{ x: number; y: number }> {
  const el = await element(page, id)
  if (!el) throw new Error('no note')
  return toClient(page, el.x + 24, el.y + 24)
}

/** Deterministic pseudo-random strings for repeated cases. */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** Counts (and rejects) navigator.clipboard writes; call BEFORE openLab. */
export async function instrumentClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const counts = { write: 0, writeText: 0, copyEvents: 0 }
    Object.defineProperty(window, '__spikeClipboard', { value: counts })
    const clip = navigator.clipboard
    if (clip) {
      clip.write = () => {
        counts.write++
        return Promise.reject(new DOMException('blocked by the spike', 'NotAllowedError'))
      }
      clip.writeText = () => {
        counts.writeText++
        return Promise.reject(new DOMException('blocked by the spike', 'NotAllowedError'))
      }
    }
    window.addEventListener('copy', () => counts.copyEvents++, true)
  })
}

export const clipboardCalls = (page: Page) =>
  page.evaluate(() => ({
    ...(window as unknown as { __spikeClipboard: Record<string, number> }).__spikeClipboard,
  }))
