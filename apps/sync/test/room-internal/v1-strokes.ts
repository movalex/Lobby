// A v1 body of freehand strokes, for the tests of the seed's conversion limits (J4). What a conversion HOLDS
// grows with the stroke points (each is an object while the converter works), about 48 MB of heap for every
// MiB of body, where the same bytes of notes take a fifth of that: a flat heap cap sized on the notes refused
// stroke-heavy boards that the in-process conversion imported (300 strokes of 1,500 points, 2.4 MiB).
import { docRecord, draw, nthIndex, pageRecord } from '../migrate/tl-records.ts'

/** `n` strokes of `points` points each, a deterministic random walk (the path is not compressible). */
export function strokes(n: number, points: number): ReturnType<typeof draw>[] {
  let seed = 7
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  return Array.from({ length: n }, (_, i) => {
    let x = 0
    let y = 0
    const path = Array.from({ length: points }, () => {
      x += rnd() * 6 - 3
      y += rnd() * 6 - 3
      return { x, y }
    })
    return draw(`s${i}`, 'page:page', nthIndex(i + 1), (i % 30) * 400, Math.floor(i / 30) * 400, path)
  })
}

/** The document and page records every body starts with, then `n` strokes of `points` points. */
export const strokeBoard = (n: number, points: number) => [
  docRecord(),
  pageRecord('page:page', 'Page 1', 'a1'),
  ...strokes(n, points),
]

/** The JSON bytes of records, as the conversion measures a body (its records and the schema). */
export const bodyMiB = (records: unknown[], schema: unknown) =>
  Buffer.byteLength(JSON.stringify({ records, schema })) / (1024 * 1024)
