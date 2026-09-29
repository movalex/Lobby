// What a non-converged browser holds, for the evidence of a failed convergence (B11 and any spec that
// wants more than explainDivergence's ids and keys): for each element that differs from the test
// snapshot, the differing keys' values in the page's scene, in its engine core's confirmed copy and in
// the snapshot, the core's dirty and unsent flags for it, and the tail of the board session's own log
// (`window.__lobbyBoardLog`, on when the page was prepared with `enableBoardLog` before it opened the
// board). Text fields are never copied (only "differs"): ids, versions, index keys, numbers and flags.
import type { Page } from '@playwright/test'
import { canvasOf } from './facade.ts'
import { divergence, readSnapshot } from './snapshot.ts'
import type { BrowserProcess, SpikeBStack } from './types.ts'

const TEXT_KEYS = new Set(['text', 'originalText', 'link', 'customData'])
const ALWAYS = ['version', 'versionNonce', 'index', 'isDeleted', 'updated'] as const

/** Turns on the board session's log in `page` (call before the page opens the board). */
export async function enableBoardLog(page: Page): Promise<void> {
  await page.addInitScript(() => {
    ;(window as unknown as { __lobbyBoardLog?: unknown[] }).__lobbyBoardLog = []
  })
}

export interface ElementDetail {
  readonly id: string
  readonly keys: readonly string[]
  readonly scene: Record<string, unknown> | null
  readonly confirmed: Record<string, unknown> | null
  readonly snapshot: Record<string, unknown> | null
  readonly dirty: boolean | null
  readonly unsent: boolean | null
}

export interface BrowserDivergence {
  readonly name: string
  readonly onlyInSnapshot: readonly string[]
  readonly onlyInMap: readonly string[]
  readonly elements: readonly ElementDetail[]
  readonly save: unknown
  readonly boardLog: readonly unknown[]
}

const pick = (el: Record<string, unknown> | null | undefined, keys: readonly string[]) => {
  if (!el) return null
  const out: Record<string, unknown> = {}
  for (const k of new Set([...ALWAYS, ...keys])) out[k] = TEXT_KEYS.has(k) ? '(text: not copied)' : el[k]
  return out
}

/** Every browser whose map differs from the snapshot, in detail (at most `max` elements each). */
export async function divergenceDetail(
  stack: SpikeBStack,
  boardId: string,
  browsers: readonly BrowserProcess[],
  max = 20,
): Promise<BrowserDivergence[]> {
  const snap = await readSnapshot(stack, boardId)
  const byId = new Map(snap.elements.map((e) => [e.id, e as unknown as Record<string, unknown>]))
  const out: BrowserDivergence[] = []
  for (const b of browsers) {
    const d = divergence(b.name, await canvasOf(b.page).allElements(), snap)
    if (!d.differ.length && !d.onlyInMap.length && !d.onlyInSnapshot.length) continue
    const differ = d.differ.slice(0, max)
    const page = await b.page.evaluate(
      (ids) => {
        const w = window as unknown as {
          __lobbyBoard?: {
            core: {
              confirmed(id: string): Record<string, unknown> | undefined
              dirtyIds?(): string[]
              unsentIds?(): string[]
            }
          }
          __lobbyBoardLog?: unknown[]
        }
        const core = w.__lobbyBoard?.core
        const dirty = new Set(core?.dirtyIds?.() ?? [])
        const unsent = new Set(core?.unsentIds?.() ?? [])
        return {
          rows: ids.map((id) => ({
            id,
            scene: (window.lobbyCanvas?.get(id) as Record<string, unknown> | null | undefined) ?? null,
            confirmed: core?.confirmed(id) ?? null,
            dirty: core?.dirtyIds ? dirty.has(id) : null,
            unsent: core?.unsentIds ? unsent.has(id) : null,
          })),
          save: window.lobbyCanvas?.saveState() ?? null,
          log: (w.__lobbyBoardLog ?? []).slice(-60),
        }
      },
      differ.map((x) => x.id),
    )
    out.push({
      name: b.name,
      onlyInSnapshot: d.onlyInSnapshot.slice(0, max),
      onlyInMap: d.onlyInMap.slice(0, max),
      elements: differ.map((x, i) => {
        const row = page.rows[i]
        return {
          id: x.id,
          keys: x.keys,
          scene: pick(row?.scene, x.keys),
          confirmed: pick(row?.confirmed, x.keys),
          snapshot: pick(byId.get(x.id), x.keys),
          dirty: row?.dirty ?? null,
          unsent: row?.unsent ?? null,
        }
      }),
      save: page.save,
      boardLog: page.log,
    })
  }
  return out
}
