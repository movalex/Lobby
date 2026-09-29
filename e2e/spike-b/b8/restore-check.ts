// B8's "restoreElements fixed point in the browser" row (docs/EXCALIDRAW-MIGRATION.md §8.3 B8, §5.3):
// the converted elements go through Excalidraw's own `restoreElements(elements, null, { repairBindings,
// refreshDimensions })` in a real Chromium page with Lobby's fonts loaded (the spike A `/spike/engine`
// page, which exposes the engine as `window.__lobbySpike.lib`), and every field is compared.
//
// The comparison returns ids, field names and numeric deltas only, never a value. Engine normalizations
// that are not changes of content are counted apart: `boundElements` null vs [] (restore turns null into
// []), and the server-owned `version`, `versionNonce`, `updated` (only bumped when the engine rewrote the
// element, which then also shows as a changed field).

import { DatabaseSync } from 'node:sqlite'
import type { Page } from '@playwright/test'

export interface RestoreDiff {
  readonly elements: number
  readonly dropped: readonly string[]
  readonly added: readonly string[]
  /** fields that differ by more than 1e-6 (numbers) or at all (anything else) */
  readonly changed: readonly { id: string; field: string; delta: number | null }[]
  /** the largest numeric difference seen (px for geometry) */
  readonly maxDelta: number
  /** elements whose version, nonce or updated time the engine bumped */
  readonly rewritten: number
  /** boundElements null → [] (normalization) */
  readonly boundNormalized: number
}

/** The live elements of a converted board file (read-only). */
export function convertedElements(path: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return (
      db.prepare('SELECT data FROM lb_elements WHERE deleted = 0 ORDER BY idx, id').all() as Array<{
        data: string
      }>
    ).map((r) => JSON.parse(r.data) as Record<string, unknown>)
  } finally {
    db.close()
  }
}

/** Opens the spike engine page (once per page) and waits until the engine and its fonts are ready. */
export async function openEnginePage(page: Page): Promise<void> {
  await page.goto('/spike/engine')
  await page.waitForFunction(() => !!(window as unknown as { __lobbySpike?: unknown }).__lobbySpike)
  await page.evaluate(async () => {
    await (window as unknown as { __lobbySpike: { ready: Promise<unknown> } }).__lobbySpike.ready
  })
}

export async function restoreFixedPoint(
  page: Page,
  elements: readonly Record<string, unknown>[],
): Promise<RestoreDiff> {
  return page.evaluate(
    async (els) => {
      const spike = (
        window as unknown as {
          __lobbySpike: {
            lib: {
              restoreElements: (
                e: unknown[],
                x: null,
                o: Record<string, boolean>,
              ) => Record<string, unknown>[]
            }
          }
        }
      ).__lobbySpike
      const NAMES: Record<number, string> = { 5: 'Excalifont', 6: 'Nunito', 8: 'Comic Shanns' }
      const need = new Map<string, string>()
      for (const e of els)
        if (e.type === 'text') {
          const font = `${e.fontSize}px ${NAMES[e.fontFamily as number] ?? 'Nunito'}`
          need.set(font, `${need.get(font) ?? ''}${String(e.originalText ?? '')}`.slice(0, 4000) || 'x')
        }
      for (const [font, sample] of need) await document.fonts.load(font, sample)
      await document.fonts.ready
      const input = structuredClone(els)
      const out = spike.lib.restoreElements(structuredClone(els), null, {
        repairBindings: true,
        refreshDimensions: true,
      })
      const byId = new Map(out.map((e) => [String(e.id), e]))
      const inIds = new Set(input.map((e) => String(e.id)))
      const changed: { id: string; field: string; delta: number | null }[] = []
      let maxDelta = 0
      let rewritten = 0
      let boundNormalized = 0
      const numericDelta = (a: unknown, b: unknown): number | null => {
        if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b)
        if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
          let m = 0
          for (let i = 0; i < a.length; i++) {
            const d = numericDelta(a[i], b[i])
            if (d === null) return null
            m = Math.max(m, d)
          }
          return m
        }
        if (a && b && typeof a === 'object' && typeof b === 'object') {
          const keys = new Set([...Object.keys(a), ...Object.keys(b)])
          let m = 0
          for (const k of keys) {
            const d = numericDelta((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
            if (d === null) return null
            m = Math.max(m, d)
          }
          return m
        }
        return a === b ? 0 : null
      }
      for (const a of input) {
        const b = byId.get(String(a.id))
        if (!b) continue
        if (a.version !== b.version || a.versionNonce !== b.versionNonce || a.updated !== b.updated)
          rewritten++
        for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
          if (field === 'version' || field === 'versionNonce' || field === 'updated') continue
          const va = a[field]
          const vb = b[field]
          if (field === 'boundElements' && va === null && Array.isArray(vb) && vb.length === 0) {
            boundNormalized++
            continue
          }
          const d = numericDelta(va, vb)
          if (d !== null) maxDelta = Math.max(maxDelta, d)
          if (d === null || d > 1e-6) changed.push({ id: String(a.id), field, delta: d })
        }
      }
      return {
        elements: input.length,
        dropped: [...inIds].filter((id) => !byId.has(id)),
        added: [...byId.keys()].filter((id) => !inIds.has(id)),
        changed,
        maxDelta,
        rewritten,
        boundNormalized,
      }
    },
    elements as Record<string, unknown>[],
  )
}

/** A board's result as B8 reports it: counts, field names, the maximum delta, and what exceeds the tolerance (ids and field names). */
export function summarize(d: RestoreDiff, tolerance: number) {
  const fields: Record<string, number> = {}
  for (const c of d.changed) fields[c.field] = (fields[c.field] ?? 0) + 1
  return {
    elements: d.elements,
    dropped: d.dropped.length,
    added: d.added.length,
    changedBeyond1e6: d.changed.length,
    fields,
    maxDelta: d.maxDelta,
    rewritten: d.rewritten,
    boundNormalized: d.boundNormalized,
    beyondTolerance: d.changed
      .filter((c) => c.delta === null || c.delta > tolerance)
      .slice(0, 50)
      .map((c) => ({ id: c.id, field: c.field })),
  }
}

/**
 * Draws converted elements on the engine page and saves a screenshot (the owner's visual verdict, §8.4).
 * Staging boards: only into SPIKE_B8_DIR/owner-screens/, which agents never open.
 */
export async function screenshotBoard(
  page: Page,
  elements: readonly Record<string, unknown>[],
  file: string,
): Promise<void> {
  await page.evaluate(
    async (els) => {
      const spike = (window as unknown as { __lobbySpike: { api: { updateScene(s: unknown): void } } })
        .__lobbySpike
      const NAMES: Record<number, string> = { 5: 'Excalifont', 6: 'Nunito', 8: 'Comic Shanns' }
      for (const e of els)
        if (e.type === 'text')
          await document.fonts.load(
            `${e.fontSize}px ${NAMES[e.fontFamily as number] ?? 'Nunito'}`,
            String(e.originalText ?? 'x').slice(0, 2000) || 'x',
          )
      await document.fonts.ready
      // fit the whole board (the engine's own fit is not on this API; Lobby fits with its own camera, §4.2)
      let minX = Number.POSITIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY
      let maxY = Number.NEGATIVE_INFINITY
      for (const e of els) {
        minX = Math.min(minX, Number(e.x))
        minY = Math.min(minY, Number(e.y))
        maxX = Math.max(maxX, Number(e.x) + Number(e.width))
        maxY = Math.max(maxY, Number(e.y) + Number(e.height))
      }
      const W = window.innerWidth
      const H = window.innerHeight
      const zoom = Math.max(0.01, Math.min(W / Math.max(1, maxX - minX), H / Math.max(1, maxY - minY)) * 0.92)
      spike.api.updateScene({
        elements: structuredClone(els),
        appState: {
          zoom: { value: zoom },
          scrollX: W / (2 * zoom) - (minX + maxX) / 2,
          scrollY: H / (2 * zoom) - (minY + maxY) / 2,
        },
      })
    },
    elements as Record<string, unknown>[],
  )
  await page.waitForTimeout(700)
  await page.screenshot({ path: file })
}
