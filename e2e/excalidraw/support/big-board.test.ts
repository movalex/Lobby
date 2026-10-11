// OWNER: WS1 (wave N; landed by the wave N foundation). The 10k fixture (./big-board.ts): its size and parts, the
// element schema, determinism and the pinned hash.
import { describe, expect, it } from 'vitest'
import {
  SPEED_FLAGS,
  SPEED_FLAGS_KEY as WEB_SPEED_FLAGS_KEY,
} from '../../../apps/web/src/canvas/sync/flags.ts'
import { checkElement } from '../../../packages/canvas-schema/src/elements.ts'
import {
  BIG_BOARD_ELEMENTS,
  BIG_BOARD_HASH,
  BIG_BOARD_ID,
  BIG_BOARD_SPEC,
  bigBoard,
  bigBoardHash,
  SPEED_FLAGS_KEY,
  type SpeedFlags,
} from './big-board.ts'

describe('the 10k big board fixture', () => {
  it('has exactly 10,000 elements of the planned parts, each valid, ids unique, indices increasing', () => {
    const b = bigBoard(BIG_BOARD_ID)
    expect(BIG_BOARD_ELEMENTS).toBe(10_000)
    expect(b.elements).toHaveLength(10_000)
    const count = (t: string) => b.elements.filter((e) => e.type === t).length
    expect(count('frame')).toBe(BIG_BOARD_SPEC.frames)
    expect(count('stickynote')).toBe(BIG_BOARD_SPEC.notes)
    expect(count('text')).toBe(BIG_BOARD_SPEC.notes)
    expect(count('arrow')).toBe(BIG_BOARD_SPEC.arrows)
    expect(count('image')).toBe(BIG_BOARD_SPEC.images)
    expect(count('rectangle') + count('ellipse') + count('diamond')).toBe(BIG_BOARD_SPEC.shapes)
    expect(b.shapeIds).toHaveLength(BIG_BOARD_SPEC.shapes)
    expect(new Set(b.elements.map((e) => e.id)).size).toBe(10_000)
    for (const el of b.elements) expect(checkElement(el).ok, el.id).toBe(true)
    const idx = b.elements.map((e) => e.index as string)
    for (let i = 1; i < idx.length; i++)
      expect((idx[i - 1] as string) < (idx[i] as string), String(i)).toBe(true)
    // the loose shapes are outside every frame
    for (const id of b.shapeIds) expect(b.elements.find((e) => e.id === id)?.frameId).toBeNull()
  }, 60_000)

  it('is deterministic, and its hash is pinned', async () => {
    const one = bigBoard(BIG_BOARD_ID)
    const two = bigBoard(BIG_BOARD_ID)
    expect(JSON.stringify(two.elements)).toBe(JSON.stringify(one.elements))
    const hash = await bigBoardHash(one)
    expect(hash).toBe(BIG_BOARD_HASH)
    // another board id is another board
    expect(await bigBoardHash(bigBoard('b-big10k0002'))).not.toBe(hash)
  }, 60_000)

  it('the speed-part overrides the specs set are the web page’s own key and names (sync/flags.ts)', () => {
    expect(SPEED_FLAGS_KEY).toBe(WEB_SPEED_FLAGS_KEY)
    const names: (keyof SpeedFlags)[] = ['WORKER_DECODE', 'DIFF_APPLY', 'CHUNKED_APPLY', 'SIZE_AWARE_LOD']
    expect(Object.keys(SPEED_FLAGS).sort()).toEqual([...names].sort())
  })
})
