// CR 3b-8 (wave 5, 2C): an onChange that only moved the camera costs no element scan.
import { describe, expect, it, vi } from 'vitest'
import type { SceneElement } from '../types.ts'

vi.mock('@excalidraw/excalidraw', () => ({ CaptureUpdateAction: { NEVER: 'NEVER' } }))
const { attachEngine } = await import('./excalidraw.ts')

const el = (id: string, version = 1, versionNonce = 1) =>
  ({ id, type: 'rectangle', version, versionNonce, isDeleted: false }) as unknown as SceneElement

const appState = (o: Record<string, unknown> = {}) => ({
  selectedElementIds: {},
  selectedElementsAreBeingDragged: false,
  isResizing: false,
  isRotating: false,
  isCropping: false,
  resizingElement: null,
  newElement: null,
  multiElement: null,
  selectedLinearElement: null,
  editingTextElement: null,
  scrollX: 0,
  ...o,
})

function fake() {
  let elements: SceneElement[] = [el('a'), el('b')]
  let listener: ((els: unknown, s: unknown) => void) | null = null
  const api = {
    getSceneElementsIncludingDeleted: () => elements,
    onChange(l: (els: unknown, s: unknown) => void) {
      listener = l
      return () => {
        listener = null
      }
    },
  }
  const scans: number[] = []
  const core = { onSceneChange: vi.fn(() => scans.push(1)) }
  const after = vi.fn()
  attachEngine(api as never, core as never, after)
  return {
    fire: (s = appState()) => listener?.(elements, s),
    set: (next: SceneElement[]) => {
      elements = next
    },
    elements: () => elements,
    core,
    after,
  }
}

describe('attachEngine (CR 3b-8)', () => {
  it('skips the core scan when only the camera moved; scans on any element write or gesture change', () => {
    const f = fake()
    f.fire()
    expect(f.core.onSceneChange).toHaveBeenCalledTimes(1)
    // a pan: same elements, same gesture
    f.fire(appState({ scrollX: 100 }))
    f.fire(appState({ scrollX: 200 }))
    expect(f.core.onSceneChange).toHaveBeenCalledTimes(1)
    expect(f.after).toHaveBeenLastCalledWith(expect.anything(), { elements: false, gesture: false })
    // an in-place write (Excalidraw's mutateElement: same array, a new version and nonce)
    const [a] = f.elements() as unknown as { version: number; versionNonce: number }[]
    if (a) {
      a.version++
      a.versionNonce = 99
    }
    f.fire(appState({ scrollX: 200 }))
    expect(f.core.onSceneChange).toHaveBeenCalledTimes(2)
    expect(f.after).toHaveBeenLastCalledWith(expect.anything(), { elements: true, gesture: false })
    // a new array (the core's own apply, a remote change)
    f.set([el('a', 2, 99), el('b'), el('c')])
    f.fire()
    expect(f.core.onSceneChange).toHaveBeenCalledTimes(3)
    // a gesture change with no element change (a drag ends, the editor closes)
    f.fire(appState({ selectedElementsAreBeingDragged: true }))
    f.fire(appState())
    expect(f.core.onSceneChange).toHaveBeenCalledTimes(5)
    expect(f.after).toHaveBeenLastCalledWith(expect.anything(), { elements: false, gesture: true })
  })
})
