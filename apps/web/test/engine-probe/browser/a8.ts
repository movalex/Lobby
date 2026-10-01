/**
 * A8, browser confirmation: the same collision through the real `api.updateScene` of a mounted
 * <Excalidraw> (the Node test drives `Scene.replaceAllElements`, which is what `updateScene` calls,
 * excalidraw `dist/dev/index.js:43825-43846`).
 */

import { newElement } from '@excalidraw/element'
import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import {
  assertConfirmedUntouched,
  confirmedVersionChanges,
  confirmedVersions,
  indexPrePass,
} from '../../../src/canvas/sync/index-keys.ts'

type Api = {
  updateScene: (data: { elements: readonly unknown[]; captureUpdate: unknown }) => void
  getSceneElementsIncludingDeleted: () => readonly Record<string, unknown>[]
  history: { clear: () => void }
}

const base = {
  x: 0,
  y: 0,
  width: 40,
  height: 40,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 1,
  strokeStyle: 'solid',
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  link: null,
  locked: false,
} as const

const rect = (id: string, index: string, version = 3) =>
  ({
    ...newElement({ ...base, type: 'rectangle', id, index, version } as never),
    id,
    index,
    version,
  }) as unknown as {
    id: string
    type: string
    index: string
    version: number
    versionNonce: number
    isDeleted: boolean
  }

export const runA8InBrowser = async (apiIn: unknown) => {
  const api = apiIn as Api
  const install = (els: readonly unknown[]) =>
    api.updateScene({ elements: els, captureUpdate: CaptureUpdateAction.NEVER })
  const scene = () => api.getSceneElementsIncludingDeleted() as unknown as ReturnType<typeof rect>[]

  // confirmed from the server; X is this client's new element, created at the top when the top was
  // 'a0', so it got 'a1', which the server meanwhile gave to Bob's C2
  const confirmed = () => [rect('c1', 'a0'), rect('c2', 'a1'), rect('c3', 'a2')]
  const mine = () => rect('X0', 'a1', 1)

  // (1) without the pre-pass, in (index, id) order: 'X0' < 'c2', so C2 follows X0 with the same key
  install([])
  const raw = [...confirmed(), mine()].sort((a, b) =>
    a.index === b.index ? (a.id < b.id ? -1 : 1) : a.index < b.index ? -1 : 1,
  )
  const before1 = confirmedVersions(raw, (e) => e.id !== 'X0')
  install(raw)
  const after1 = scene()
  const changes1 = confirmedVersionChanges(before1, after1)

  // (2) with the pre-pass
  install([])
  const input = [...confirmed(), mine()]
  const pre = indexPrePass(input, { isOwnUnacked: (e) => e.id === 'X0' })
  const before2 = confirmedVersions(pre.elements, (e) => e.id !== 'X0')
  install(pre.elements)
  const after2 = scene()
  const changes2 = confirmedVersionChanges(before2, after2)
  let assertion2: string | null = null
  try {
    assertConfirmedUntouched(before2, after2)
  } catch (e) {
    assertion2 = String(e)
  }
  let assertion1: string | null = null
  try {
    assertConfirmedUntouched(before1, after1)
  } catch (e) {
    assertion1 = String(e)
  }
  install([])
  api.history.clear()
  const pick = (els: ReturnType<typeof rect>[]) =>
    els.map((e) => ({ id: e.id, index: e.index, version: e.version }))
  return {
    withoutPrePass: { scene: pick(after1), confirmedChanges: changes1, assertion: assertion1 },
    withPrePass: {
      scene: pick(after2),
      rekeys: pre.rekeys,
      confirmedChanges: changes2,
      assertion: assertion2,
    },
  }
}
