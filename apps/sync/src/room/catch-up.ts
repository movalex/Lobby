// The catch-up half of a welcome, built from the stored row strings (docs/EXCALIDRAW-MIGRATION.md §2.4.5,
// §2.13; B9's reconnect storm): the rows written since a client's clock travel as `c` ops of the stored
// element, so their JSON is the stored `data` string as it is, wrapped once; only a tombstone is parsed,
// redacted (W5-02) and re-stringified. Before, every row of every catch-up was parsed (`parseRow`, gclock
// included) and the whole welcome stringified again, per joiner; after a SIGKILL the 200 sessions of one
// board reconnect within seconds with the same `since`, so the same ops were built 200 times.
//
// `CatchUpCache` keeps the ops JSON of the last few `since` values of one room, valid for one clock: the
// drain clears it after every commit (the rows since `since` changed), so a hit is always the exact bytes
// the store would give now. One entry per distinct `since`, at most `CATCH_UP_CACHE_ENTRIES`.

import { redactTombstone } from '@draftroom/canvas-schema/elements'
import type { El } from './merge.ts'

export const CATCH_UP_CACHE_ENTRIES = 8

/** One stored row as the catch-up reads it: the JSON text and the deleted flag. */
export interface RawRow {
  readonly data: string
  readonly deleted: boolean
}

/** The JSON of one catch-up op: `{"k":"c","el":<row>}`, the row redacted when it is a tombstone. */
export function catchUpOpJson(r: RawRow): string {
  if (!r.deleted && !r.data.includes('"isDeleted":true')) return `{"k":"c","el":${r.data}}`
  const el = JSON.parse(r.data) as El
  const out = r.deleted || el.isDeleted ? redactTombstone(el) : el
  return `{"k":"c","el":${JSON.stringify(out)}}`
}

/** The JSON array of the catch-up ops for `rows`, in the rows' order. */
export function catchUpOpsJson(rows: readonly RawRow[]): string {
  if (!rows.length) return '[]'
  const parts: string[] = new Array(rows.length)
  for (let i = 0; i < rows.length; i++) parts[i] = catchUpOpJson(rows[i] as RawRow)
  return `[${parts.join(',')}]`
}

/** The ops JSON of recent catch-ups of one room, valid for the clock they were built at. */
export class CatchUpCache {
  private clock = -1
  private readonly entries = new Map<number, string>()
  hits = 0
  misses = 0

  /** The ops JSON for the rows since `since` at `clock`, built by `rows` on a miss. */
  get(since: number, clock: number, rows: () => readonly RawRow[]): string {
    if (clock !== this.clock) {
      this.entries.clear()
      this.clock = clock
    }
    const hit = this.entries.get(since)
    if (hit !== undefined) {
      this.hits++
      return hit
    }
    this.misses++
    const json = catchUpOpsJson(rows())
    if (this.entries.size >= CATCH_UP_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(since, json)
    return json
  }

  /** The room committed (or reopened its file): nothing cached describes the rows any more. */
  clear(): void {
    this.entries.clear()
    this.clock = -1
  }

  get size(): number {
    return this.entries.size
  }
}

/**
 * A welcome with a catch-up: the welcome's other fields stringified once, the ops JSON spliced in. The
 * result parses to exactly `{...head, catchUp: <ops>}` (the head is a plain object serialized by
 * JSON.stringify, so it ends with `}`).
 */
export function catchUpWelcomeJson(head: Record<string, unknown>, opsJson: string): string {
  const h = JSON.stringify(head)
  return `${h.slice(0, -1)},"catchUp":${opsJson}}`
}

/** A `changes` frame carrying catch-up rows (the rows since a cached snapshot's clock, §2.4.5). */
export function catchUpChangesJson(clock: number, opsJson: string): string {
  return `{"type":"changes","clock":${clock},"ops":${opsJson}}`
}
