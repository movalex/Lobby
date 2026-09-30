// The wave-1 freeze of the feature-facing canvas API (docs/EXCALIDRAW-CONTRACTS.md §8): every LobbyCanvas
// member has one owner and is either the C0 port's, composed, or a stub that names its owner; the tldraw
// map covers every `editor.*` member and every tldraw symbol used in apps/web/src (outside canvas/), and
// every target it names exists; every file that uses tldraw has a porting owner; ported code imports no
// engine and no tldraw.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schemaGroups from '@draftroom/canvas-schema/groups'
import * as schemaLimits from '@draftroom/canvas-schema/limits'
import * as schemaRefs from '@draftroom/canvas-schema/refs'
import { describe, expect, it } from 'vitest'
import { CANVAS_FEATURES } from '../../features/canvas-registry.ts'
import * as signals from '../../lib/signals.ts'
import type { CanvasElement, CanvasPort } from '../port.ts'
import * as feature from './feature.ts'
import { CANVAS_FEATURE_CONTEXT_KEYS, type CanvasFeatureContext, installCanvasFeatures } from './feature.ts'
import * as geometry from './geometry.ts'
import { type BoardHandles, createLobbyCanvas, LOBBY_CANVAS_MEMBERS } from './impl.ts'
import * as items from './items.ts'
import * as keys from './keys.ts'
import { isOwner, NotImplementedError, stubOwner } from './owners.ts'
import { createFeatureRegistries } from './registries.ts'
import { EDITOR_MEMBERS, fileOwner, TLDRAW_SYMBOLS } from './tldraw-map.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SRC = fileURLToPath(new URL('../../', import.meta.url))

function fakePort(): CanvasPort {
  const noop = () => {}
  return {
    items: () => [],
    get: () => undefined,
    bounds: () => null,
    selection: [],
    select: noop,
    viewport: { get: () => ({ x: 0, y: 0, width: 100, height: 100, zoom: 1 }), set: noop, fit: noop },
    sceneToScreen: (p) => p,
    screenToScene: (p) => p,
    transact: (_label, fn) => fn({ create: () => 'new', update: noop, delete: noop }),
    setTool: () => true,
    tool: () => 'select',
    on: () => noop,
    editingId: () => null,
    leaseHolder: () => null,
    collaborators: () => [],
    saveStatus: () => ({ state: 'saved', pending: 0, offlineChanges: 0, lastReject: null }),
    engine: null,
  }
}

/** Board handles that do nothing (the board page's engine is not under test here). */
function fakeBoard(): BoardHandles {
  const noop = () => {}
  const off = () => noop
  return {
    subscribe: off,
    on: off,
    readOnly: () => false,
    container: () => null,
    focus: noop,
    hasKeyboard: () => false,
    setCursor: noop,
    theme: () => 'light',
    pointer: () => null,
    gesture: () => 'idle',
    hitTest: () => null,
    hovered: () => null,
    hide: off,
    viewport: {
      set: noop,
      fit: noop,
      stop: noop,
      moving: () => false,
      screenRect: () => ({ x: 0, y: 0, width: 100, height: 100 }),
      remeasure: noop,
    },
    text: {
      edit: async () => false,
      stop: noop,
      editorElement: () => null,
      measure: () => ({ width: 0, height: 0 }),
      replace: async () => false,
    },
    styles: { next: () => ({}), setNext: noop },
    presence: { peers: () => [], peer: () => null },
    history: {
      undo: noop,
      redo: noop,
      canUndo: () => false,
      canRedo: () => false,
      joinPrevious: (write) => write(),
    },
    files: { status: () => null },
    settings: { get: () => ({ grid: false, snap: false, focusMode: false }), set: noop },
    docWritten: noop,
    newId: () => 'fresh',
  }
}

/** Every function (and getter) of the canvas object, by dotted path. */
function walk(obj: object, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const key of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    const desc = Object.getOwnPropertyDescriptor(obj, key)
    if (desc?.get) {
      out.set(path, 'getter')
      continue
    }
    const v = (obj as Record<string, unknown>)[key]
    if (typeof v === 'function') out.set(path, v)
    else if (v && typeof v === 'object') for (const [p, f] of walk(v, path)) out.set(p, f)
  }
  return out
}

function sourceFiles(dir: string, skip: (rel: string) => boolean): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const rel = relative(SRC, p).replace(/\\/g, '/')
    if (skip(rel)) continue
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p, skip))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const FILES = sourceFiles(SRC, (rel) => rel === 'canvas')
const rel = (p: string) => relative(SRC, p).replace(/\\/g, '/')
const TLDRAW_IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'(tldraw|@tldraw\/[a-z-]+)'/g
const TLDRAW_STAR = /import\s+\*\s+as\s+(\w+)\s+from\s+'(tldraw|@tldraw\/[a-z-]+)'/g

function importedSymbols(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(TLDRAW_IMPORT)) {
    for (const s of (m[2] ?? '').split(',')) {
      const name = s
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        ?.trim()
      if (name) out.push(name)
    }
  }
  for (const m of src.matchAll(TLDRAW_STAR)) out.push(`* as ${m[1]}`)
  return out
}
const editorMembers = (src: string) =>
  [...src.matchAll(/\beditor\??\.([a-zA-Z_]+)/g)].map((m) => m[1] as string)

const MEMBER_PATHS = new Set(LOBBY_CANVAS_MEMBERS.map((m) => m.path))
const REGISTRY_KEYS = new Set(Object.keys(createFeatureRegistries()))
const HELPERS: Record<string, Record<string, unknown>> = { items, geometry, keys, feature, signals }
const SCHEMA: Record<string, Record<string, unknown>> = {
  limits: schemaLimits,
  refs: schemaRefs,
  groups: schemaGroups,
}
const INDEX_SRC = readFileSync(join(HERE, 'index.ts'), 'utf8')

/** null when `target` resolves, else why not. */
function targetProblem(target: string): string | null {
  if (target === 'dropped') return null
  const [kind, rest = ''] = target.split(/:(.*)/s)
  switch (kind) {
    case 'canvas':
      return MEMBER_PATHS.has(rest) ? null : `no LobbyCanvas member ${rest}`
    case 'registry':
      return REGISTRY_KEYS.has(rest) ? null : `no registry ${rest}`
    case 'context':
      return (CANVAS_FEATURE_CONTEXT_KEYS as readonly string[]).includes(rest)
        ? null
        : `no context key ${rest}`
    case 'helper': {
      const [mod = '', fn = ''] = rest.split('.')
      return typeof HELPERS[mod]?.[fn] === 'function' ? null : `no helper ${rest}`
    }
    case 'schema': {
      const [mod = '', x = ''] = rest.split('.')
      return SCHEMA[mod] && x in (SCHEMA[mod] as object) ? null : `no canvas-schema export ${rest}`
    }
    case 'type':
      return new RegExp(`\\b${rest}\\b`).test(INDEX_SRC)
        ? null
        : `canvas/api/index.ts exports no type ${rest}`
    case 'feature':
      return isOwner(rest) ? null : `unknown owner ${rest}`
    default:
      return `unknown target kind in ${target}`
  }
}

describe('the LobbyCanvas member table', () => {
  it('lists each member once, with a known owner', () => {
    const paths = LOBBY_CANVAS_MEMBERS.map((m) => m.path)
    expect(paths.length).toBe(new Set(paths).size)
    for (const m of LOBBY_CANVAS_MEMBERS) expect(isOwner(m.owner), m.path).toBe(true)
  })

  it('matches the built canvas: core and composed members are real, stubs name their owner', () => {
    const { canvas, dispose } = createLobbyCanvas({ port: fakePort(), registries: createFeatureRegistries() })
    const built = walk(canvas)
    for (const [path, fn] of built) {
      const m = LOBBY_CANVAS_MEMBERS.find((x) => x.path === path)
      expect(m, `member ${path} is not in LOBBY_CANVAS_MEMBERS`).toBeDefined()
      if (!m) continue
      const s = stubOwner(fn)
      // on a bare port (no board handles, no engine) the board page's members are stubs naming 2C, and a
      // landed part that needs the engine (board-part) a stub naming its owner
      if (m.status === 'stub' || m.status === 'board' || m.status === 'board-part')
        expect(s?.owner, path).toBe(m.owner)
      else expect(s, `${path} should not be a stub`).toBeNull()
    }
    for (const m of LOBBY_CANVAS_MEMBERS) {
      if (m.path.startsWith('on:') || m.path.startsWith('tx.') || m.path === 'transact.joinPrevious') continue
      expect(built.has(m.path), `LOBBY_CANVAS_MEMBERS lists ${m.path} but the canvas has none`).toBe(true)
    }
    dispose()
  })

  it('stubs throw NotImplementedError naming the owner; tx and event stubs too', () => {
    const { canvas } = createLobbyCanvas({ port: fakePort(), registries: createFeatureRegistries() })
    expect(() => canvas.text.edit('x', { via: 'api' })).toThrow(NotImplementedError)
    // every member still a stub in the table throws, naming its owner (CR 3b-1: whichever parts have landed)
    const built = walk(canvas)
    for (const m of LOBBY_CANVAS_MEMBERS.filter((x) => x.status === 'stub' && built.has(x.path))) {
      const fn = built.get(m.path) as (...a: unknown[]) => unknown
      expect(() => fn(), m.path).toThrow(new RegExp(`not implemented \\(${m.owner}\\): ${m.path}`))
    }
    // a landed part composed from other members is real (3b's camera members on a bare port)
    canvas.viewport.zoomTo({ x: 0, y: 0, width: 1, height: 1 })
    expect(canvas.viewport.limits().min).toBeGreaterThan(0)
    expect(() => canvas.on('change', () => {})).toThrow(/not implemented \(2C\): on:change/)
    expect(() => canvas.transact('x', () => 1, { joinPrevious: true })).toThrow(/transact.joinPrevious/)
    // 3c's follow part has landed (impl.ts LANDED_PARTS): its event subscribes on a bare port too
    expect(typeof canvas.on('followChanged', () => {})).toBe('function')
    expect(canvas.transact('x', (tx) => tx.createMany([{ kind: 'note', props: {} }]))).toEqual(['new'])
    const off = canvas.on('changed', () => {})
    expect(typeof off).toBe('function')
  })

  it('with the board handles, the board page members are real and board events subscribe', () => {
    const { canvas, dispose } = createLobbyCanvas({
      port: fakePort(),
      registries: createFeatureRegistries(),
      board: fakeBoard(),
    })
    const built = walk(canvas)
    for (const m of LOBBY_CANVAS_MEMBERS.filter((x) => x.status === 'board')) {
      // events, joinPrevious and tx.insert (the port transaction's, below) are not canvas properties
      if (m.path.startsWith('on:') || m.path.startsWith('tx.') || m.path === 'transact.joinPrevious') continue
      expect(built.has(m.path), m.path).toBe(true)
      expect(stubOwner(built.get(m.path)), `${m.path} should be real on the board page`).toBeNull()
    }
    for (const e of ['change', 'input', 'toolChanged', 'editingChanged', 'resize', 'docChanged'] as const)
      expect(typeof canvas.on(e, () => {})).toBe('function')
    expect(canvas.transact('x', () => 7, { joinPrevious: true })).toBe(7)
    expect(canvas.readOnly()).toBe(false)
    dispose()
  })

  it("2C's composed tx writes run on a bare port (group, reorder, frames)", () => {
    const writes: [string, Record<string, unknown>][] = []
    const els = new Map<string, CanvasElement>(
      ['a', 'b', 'c'].map((id, i) => [
        id,
        {
          id,
          type: 'rectangle',
          x: i * 10,
          y: 0,
          width: 10,
          height: 10,
          angle: 0,
          groupIds: [],
          frameId: null,
          locked: false,
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          index: `a${i}`,
        } as unknown as CanvasElement,
      ]),
    )
    const port: CanvasPort = {
      ...fakePort(),
      items: () => [...els.values()],
      get: (id) => els.get(id),
      transact: (_label, fn) =>
        fn({
          create: () => 'new',
          update: (id, patch) => void writes.push([id, { ...patch }]),
          delete: () => {},
        }),
    }
    const { canvas } = createLobbyCanvas({ port, registries: createFeatureRegistries() })
    const gid = canvas.transact('g', (tx) => tx.group(['a', 'b']))
    expect(writes.map(([id, p]) => [id, p.groupIds])).toEqual([
      ['a', [gid]],
      ['b', [gid]],
    ])
    writes.length = 0
    canvas.transact('r', (tx) => tx.reorder(['a'], 'front'))
    expect(writes).toHaveLength(1)
    expect(String(writes[0]?.[1].index) > 'a2').toBe(true)
    writes.length = 0
    canvas.transact('f', (tx) => tx.setFrame(['c'], 'frame-1'))
    expect(writes).toEqual([['c', { frameId: 'frame-1' }]])
    expect(canvas.text.of('a')).toBe('')
    expect(canvas.sceneToOverlay({ x: 10, y: 20 })).toEqual({ x: 10, y: 20 })
  })

  it('tx.insert delegates to the board page port transaction and names 2C on a bare port (CR-2D-2, W3-9)', () => {
    const bare = createLobbyCanvas({ port: fakePort(), registries: createFeatureRegistries() })
    expect(() => bare.canvas.transact('t', (tx) => tx.insert([{ id: 'n1', type: 'rectangle' }]))).toThrow(
      /not implemented \(2C\): tx.insert/,
    )
    const got: unknown[] = []
    const port = fakePort()
    const withInsert = {
      ...port,
      transact: <T>(label: string, fn: (tx: never) => T) =>
        port.transact(label, (tx) =>
          fn({
            ...tx,
            insert: (els: readonly Record<string, unknown>[]) => {
              got.push(...els)
              return els.map((e) => e.id as string)
            },
          } as never),
        ),
    } as typeof port
    const real = createLobbyCanvas({ port: withInsert, registries: createFeatureRegistries() })
    expect(real.canvas.transact('t', (tx) => tx.insert([{ id: 'n1', type: 'rectangle' }]))).toEqual(['n1'])
    expect(got).toHaveLength(1)
  })

  it('the @owner annotations in lobby-canvas.ts agree with the table', () => {
    const src = readFileSync(join(HERE, 'lobby-canvas.ts'), 'utf8')
    const NS: Record<string, string> = {
      LobbyViewport: 'viewport.',
      LobbyText: 'text.',
      LobbyStyles: 'styles.',
      LobbyTx: 'tx.',
      LobbyPresence: 'presence.',
      LobbyFollow: 'follow.',
      LobbyHistory: 'history.',
      LobbyDoc: 'doc.',
      LobbyExport: 'export.',
      LobbyFiles: 'files.',
      LobbySettings: 'settings.',
      LobbyCanvas: '',
      TransactOptions: 'transact.',
    }
    let ns: string | null = null
    let events = false
    let pending: string | null = null
    const checked = new Set<string>()
    for (const line of src.split('\n')) {
      const iface = /^export (?:interface|type) (\w+)/.exec(line)
      if (iface) {
        ns = NS[iface[1] as string] ?? null
        events = iface[1] === 'LobbyCanvasEventMap'
        continue
      }
      const owner = /@owner (\w+)/.exec(line)
      if (owner) pending = owner[1] as string
      if (!pending || line.includes('/**') || line.trim().startsWith('*')) continue
      const member = /^\s+(?:readonly\s+)?(\w+)[<(:?]/.exec(line)
      if (member && (ns !== null || events)) {
        const path = events ? `on:${member[1]}` : `${ns}${member[1]}`
        const m = LOBBY_CANVAS_MEMBERS.find((x) => x.path === path)
        expect(m, `annotated ${path} is not in the table`).toBeDefined()
        expect(m?.owner, path).toBe(pending)
        checked.add(path)
      }
      pending = null
    }
    const unannotated = LOBBY_CANVAS_MEMBERS.filter((m) => m.status !== 'core' && !checked.has(m.path)).map(
      (m) => m.path,
    )
    expect(unannotated, 'members with no @owner annotation in lobby-canvas.ts').toEqual([])
  })
})

describe('the tldraw map (apps/web/src outside canvas/)', () => {
  it('maps every editor.* member in use', () => {
    const used = new Set<string>()
    for (const f of FILES) for (const m of editorMembers(readFileSync(f, 'utf8'))) used.add(m)
    const missing = [...used].filter((m) => !(m in EDITOR_MEMBERS)).sort()
    expect(missing, 'editor members with no mapping in tldraw-map.ts').toEqual([])
    expect(used.size).toBeGreaterThanOrEqual(137)
  })

  it('maps every imported tldraw symbol exactly once', () => {
    const used = new Set<string>()
    for (const f of FILES) for (const s of importedSymbols(readFileSync(f, 'utf8'))) used.add(s)
    const groupOf = new Map<string, string>()
    for (const g of TLDRAW_SYMBOLS) {
      for (const s of g.symbols) {
        expect(groupOf.get(s), `${s} is in two groups`).toBeUndefined()
        groupOf.set(s, g.id)
      }
    }
    expect([...used].filter((s) => !groupOf.has(s)).sort(), 'tldraw symbols with no group').toEqual([])
  })

  it('every target exists (and a dropped member says why)', () => {
    const problems: string[] = []
    for (const [member, m] of Object.entries(EDITOR_MEMBERS)) {
      for (const t of m.to) {
        const p = targetProblem(t)
        if (p) problems.push(`${member}: ${p}`)
      }
      if (m.to.includes('dropped') && !m.note) problems.push(`${member}: dropped without a note`)
    }
    for (const g of TLDRAW_SYMBOLS) {
      if (!isOwner(g.owner)) problems.push(`${g.id}: owner ${g.owner}`)
      for (const t of g.to) {
        const p = targetProblem(t)
        if (p) problems.push(`${g.id}: ${p}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('every file that uses tldraw has a porting owner', () => {
    const orphans = FILES.filter((f) => {
      const src = readFileSync(f, 'utf8')
      return (importedSymbols(src).length > 0 || editorMembers(src).length > 0) && fileOwner(rel(f)) === null
    }).map(rel)
    expect(orphans).toEqual([])
  })

  it('ported code (features/**/ported/**) imports no tldraw, no engine and only canvas/api from the canvas', () => {
    const bad: string[] = []
    for (const f of FILES.filter((p) => /\/ported\//.test(rel(p)))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1] as string
        if (/^(tldraw|@tldraw\/|@excalidraw\/)/.test(spec)) bad.push(`${rel(f)}: ${spec}`)
        if (
          /\/canvas\//.test(spec) &&
          !/\/canvas\/api(\/index\.ts|\.ts)?$|\/canvas\/api\/index\.ts$/.test(spec)
        ) {
          bad.push(`${rel(f)}: ${spec} (import canvas/api/index.ts)`)
        }
      }
    }
    expect(bad).toEqual([])
  })
})

describe('feature registries and installation', () => {
  it('CANVAS_FEATURES lists each ported feature once, each file naming a known owner', () => {
    const ids = CANVAS_FEATURES.map((f) => f.id)
    expect(ids.length).toBe(new Set(ids).size)
    const reg = readFileSync(join(SRC, 'features/canvas-registry.ts'), 'utf8')
    const files = [...reg.matchAll(/from '(\.[^']+\/ported\/[^']*index\.tsx)'/g)].map((m) => m[1] as string)
    expect(files).toHaveLength(CANVAS_FEATURES.length)
    for (const f of files) {
      const src = readFileSync(join(SRC, 'features', f), 'utf8')
      const owner = /^\/\/ OWNER: (\w+)/.exec(src)?.[1] ?? ''
      expect(isOwner(owner), `${f} names owner ${owner}`).toBe(true)
    }
  })

  const ctxFor = (registries = createFeatureRegistries()): CanvasFeatureContext => {
    const { canvas } = createLobbyCanvas({ port: fakePort(), registries })
    return {
      canvas: { ...canvas, readOnly: () => false } as typeof canvas,
      registries,
      board: {} as CanvasFeatureContext['board'],
      role: 'editor',
      me: {} as CanvasFeatureContext['me'],
      workspace: { id: 'w', name: 'W' },
      api: {} as CanvasFeatureContext['api'],
      events: {} as CanvasFeatureContext['events'],
      notify: () => {},
      dismiss: () => {},
      openPanel: () => {},
      activePanel: null,
    }
  }

  it('a host slot has one provider', () => {
    const r = createFeatureRegistries()
    const A = () => null
    const errors: unknown[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => errors.push(a)
    try {
      const off = r.hostSlots.provide('toolbar', { featureId: 'canvas-ux', component: A })
      r.hostSlots.provide('toolbar', { featureId: 'other', component: A })
      expect(r.hostSlots.get('toolbar')?.featureId).toBe('canvas-ux')
      expect(errors).toHaveLength(1)
      off()
      expect(r.hostSlots.get('toolbar')).toBeNull()
    } finally {
      console.error = orig
    }
  })

  it('the cursor filter combines its providers: a cursor shows only when every provider says yes (W3-4)', () => {
    const r = createFeatureRegistries()
    expect(r.cursorVisible.call('s1')).toBe(true)
    let presenting = false
    const offPresent = r.cursorVisible.provide(() => !presenting)
    const offHide = r.cursorVisible.provide((sid) => sid !== 's2')
    expect(r.cursorVisible.call('s1')).toBe(true)
    expect(r.cursorVisible.call('s2')).toBe(false)
    presenting = true
    expect(r.cursorVisible.call('s1')).toBe(false)
    // removing one provider keeps the other; a second removal is a no-op
    offHide()
    offHide()
    expect(r.cursorVisible.call('s2')).toBe(false)
    presenting = false
    expect(r.cursorVisible.call('s2')).toBe(true)
    offPresent()
    expect(r.cursorVisible.call('s2')).toBe(true)
  })

  it('installs static declarations in feature order, wires kbd commands into the C0 key registry, and undoes it all', () => {
    const r = createFeatureRegistries()
    const ctx = ctxFor(r)
    const ran: string[] = []
    const cleanup = installCanvasFeatures(
      [
        {
          id: 'a',
          commands: [{ id: 'a.search', label: 'Search', kbd: ['mod+f'], run: () => void ran.push('search') }],
          contextMenu: [{ id: 'a.menu', group: 'edit', order: 2, label: 'A' }],
          tools: [{ id: 'comment', label: 'Comment', readOnlyAllowed: true }],
          onMount: () => () => void ran.push('unmount-a'),
        },
        {
          id: 'b',
          contextMenu: [{ id: 'b.menu', group: 'edit', order: 1, label: 'B' }],
          onMount: () => {
            throw new Error('boom')
          },
        },
      ],
      ctx,
    )
    expect(r.sorted(r.contextMenu).map((m) => m.id)).toEqual(['b.menu', 'a.menu'])
    expect(r.pointerTools.get('comment')?.customType).toBe('lobby-comment')
    const key = r.keys.list().find((k) => k.id === 'command:a.search:canvas')
    expect(key).toBeDefined()
    const e = {
      key: 'f',
      code: 'KeyF',
      ctrlKey: keys.currentPlatform() === 'other',
      metaKey: keys.currentPlatform() === 'mac',
      altKey: false,
      shiftKey: false,
    }
    expect(key?.match(e)).toBe(true)
    expect(key?.handle(e, ctx.canvas)).toBe(true)
    expect(ran).toEqual(['search'])
    cleanup()
    expect(ran).toEqual(['search', 'unmount-a'])
    expect(r.contextMenu.list()).toEqual([])
    expect(r.keys.list()).toEqual([])
    expect(r.pointerTools.list()).toEqual([])
  })

  it('reports chords claimed twice in one scope', () => {
    const claims = feature.collectKeyClaims([
      { id: 'a', commands: [{ id: 'a.x', label: 'x', kbd: ['Mod+F'], run: () => {} }] },
      { id: 'b', keys: [{ id: 'b.y', scope: 'canvas', chords: ['mod+f'], handle: () => true }] },
      { id: 'c', keys: [{ id: 'c.z', scope: 'editor', chords: ['mod+f'], handle: () => true }] },
    ])
    expect(feature.keyConflicts(claims)).toEqual([{ chord: 'Mod+F', scope: 'canvas', by: ['a.x', 'b.y'] }])
  })
})
