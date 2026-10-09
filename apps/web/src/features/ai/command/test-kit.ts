// W3 (wave L, L3-3): a small board for the command compiler's and runner's tests: plain elements, a canvas
// with the reads compile.ts uses, and a transact that records every write of each step.
import type { CanvasElement, LobbyCanvas } from '../../../canvas/api/index.ts'

export type El = Record<string, unknown> & {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
}

export interface Step {
  readonly label: string
  readonly ops: readonly (readonly unknown[])[]
}

export interface FakeBoard {
  readonly canvas: LobbyCanvas
  readonly steps: Step[]
  readonly selected: string[][]
  readonly zoomed: unknown[]
  readonly docSets: Record<string, unknown>[]
  readonly notices: string[]
}

const base = (over: Partial<El> & Pick<El, 'id' | 'type'>): El => ({
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  angle: 0,
  groupIds: [],
  frameId: null,
  locked: false,
  isDeleted: false,
  boundElements: null,
  strokeColor: '#1d1d1d',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  ...over,
})

/** A sticky note with its bound label (the label's id: `<id>-label`). */
export function note(id: string, over: Partial<El> = {}): El[] {
  const n = base({
    id,
    type: 'stickynote',
    backgroundColor: '#ef8c82',
    boundElements: [{ id: `${id}-label`, type: 'text' }],
    ...over,
  })
  const label = base({
    id: `${id}-label`,
    type: 'text',
    containerId: id,
    originalText: `${id} words`,
    x: n.x + 10,
    y: n.y + 10,
    width: 180,
    height: 40,
    frameId: n.frameId,
  })
  return [n, label]
}

export const shape = (id: string, over: Partial<El> = {}): El => base({ id, type: 'rectangle', ...over })
export const frame = (id: string, over: Partial<El> = {}): El =>
  base({ id, type: 'frame', name: id, width: 1000, height: 800, ...over })
export const arrow = (id: string, over: Partial<El> = {}): El =>
  base({
    id,
    type: 'arrow',
    width: 300,
    height: 2,
    points: [
      [0, 0],
      [300, 0],
    ],
    startBinding: null,
    endBinding: null,
    ...over,
  })

/** A board of `els`; `leases`: element id → the session holding its text lease (this tab is 'me'). */
export function fakeBoard(
  els: El[],
  opts: {
    leases?: Record<string, string>
    readOnly?: boolean
    selection?: string[]
    tagDefs?: Record<string, unknown>
  } = {},
): FakeBoard {
  const byId = new Map(els.map((e) => [e.id, e]))
  const steps: Step[] = []
  const selected: string[][] = []
  const zoomed: unknown[] = []
  const docSets: Record<string, unknown>[] = []
  const notices: string[] = []
  const live = () => els.filter((e) => !e.isDeleted)
  const get = (id: string) => byId.get(id) as unknown as CanvasElement | undefined
  const bounds = (id: string) => {
    const e = byId.get(id)
    return e ? { x: e.x, y: e.y, width: e.width, height: e.height } : null
  }
  const canvas = {
    items: () => live() as unknown as CanvasElement[],
    get,
    bounds,
    boundsOf: (ids: readonly string[]) => {
      const bs = ids.map(bounds).filter((b): b is NonNullable<typeof b> => !!b)
      if (!bs.length) return null
      const x = Math.min(...bs.map((b) => b.x))
      const y = Math.min(...bs.map((b) => b.y))
      return {
        x,
        y,
        width: Math.max(...bs.map((b) => b.x + b.width)) - x,
        height: Math.max(...bs.map((b) => b.y + b.height)) - y,
      }
    },
    isLocked: (id: string) => {
      const e = byId.get(id)
      if (!e) return false
      if (e.locked) return true
      return e.type === 'text' && typeof e.containerId === 'string'
        ? !!byId.get(e.containerId)?.locked
        : false
    },
    isHidden: () => false,
    leaseHolder: (id: string) => {
      const sid = opts.leases?.[id]
      return sid ? { sid, uid: `usr_${sid}`, name: 'Someone' } : null
    },
    doc: {
      get: () => undefined,
      entries: (prefix?: string) =>
        new Map(Object.entries(opts.tagDefs ?? {}).filter(([k]) => !prefix || k.startsWith(prefix))),
      set: (entries: Record<string, unknown>) => void docSets.push(entries),
    },
    engine: { welcome: { sid: 'me' } },
    selection: opts.selection ?? [],
    select: (ids: readonly string[]) => void selected.push([...ids]),
    viewport: {
      zoomTo: (b: unknown) => void zoomed.push(b),
      get: () => ({ x: 0, y: 0, width: 1000, height: 800, zoom: 1 }),
    },
    readOnly: () => opts.readOnly === true,
    focus: () => {},
    transact: (label: string, fn: (tx: unknown) => unknown) => {
      const ops: unknown[][] = []
      let made = 0
      const tx = {
        create: (kind: string, props: unknown) => {
          ops.push(['create', kind, props])
          return `new-${kind}-${++made}`
        },
        update: (id: string, patch: unknown) => void ops.push(['update', id, patch]),
        delete: (id: string) => void ops.push(['delete', id]),
        setFrame: (ids: readonly string[], f: string | null) => void ops.push(['setFrame', [...ids], f]),
        reorder: (ids: readonly string[], to: string) => void ops.push(['reorder', [...ids], to]),
      }
      const r = fn(tx)
      steps.push({ label, ops })
      return r
    },
  }
  return { canvas: canvas as unknown as LobbyCanvas, steps, selected, zoomed, docSets, notices }
}

/** The ids a step updates. */
export const updatedIds = (s: Step | undefined): string[] =>
  (s?.ops ?? []).filter((o) => o[0] === 'update').map((o) => o[1] as string)
