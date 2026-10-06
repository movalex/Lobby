// J4: the worker helpers of the api (checkpoint previews) and of the sync server (seeded v1 bodies) are the
// same code in two places on purpose, since the apps do not import each other: the gate with its bounded
// queue, the conversion worker's entry, and the helper that starts the worker and holds it to its limits. A
// fix to one that is not made to the other would leave one app with the old behaviour, so this test fails
// when they drift apart (comments and blank lines aside).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(new URL(`../../../../../${rel}`, import.meta.url), 'utf8')

/** Code only: doc comments on one line, line comments and blank lines gone, from `from` up to `to` (or the end). */
function code(source: string, from: string, to?: string): string {
  const start = source.indexOf(from)
  if (start < 0) throw new Error(`no "${from}" in the file`)
  const end = to ? source.indexOf(to, start) : source.length
  if (to && end < 0) throw new Error(`no "${to}" in the file`)
  return source
    .slice(start, end)
    .split('\n')
    .filter(
      (line) => line.trim() !== '' && !/^\s*\/\*\*.*\*\/\s*$/.test(line) && !/^\s*\/\/(?!\s*---)/.test(line),
    )
    .join('\n')
}

describe('the api’s and the sync server’s worker helpers are the same code', () => {
  it('the gate with its bounded queue', () => {
    const api = read('apps/api/src/features/link-preview/gate.ts')
    const sync = read('apps/sync/src/room-internal/gate.ts')
    expect(code(sync, 'export type GateRefusal')).toBe(code(api, 'export type GateRefusal'))
  })

  it('the conversion worker’s entry', () => {
    const api = read('apps/api/src/features/history/convert-v1-worker.ts')
    const sync = read('apps/sync/src/room-internal/convert-v1-worker.ts')
    expect(code(sync, 'import {')).toBe(code(api, 'import {'))
  })

  it('the helper that runs a conversion in a worker under its limits', () => {
    const api = read('apps/api/src/features/history/convert-v1.ts')
    const sync = read('apps/sync/src/room-internal/convert-v1.ts')
    expect(code(sync, 'export interface ConvertV1Limits', '// ---- the seed')).toBe(
      code(api, 'export interface ConvertV1Limits'),
    )
  })
})
