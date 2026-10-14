// K2-2 (wave K, UXD-06): one placement then back to Select, unless the tool lock is on; Q toggles the lock and
// steps aside for type-to-edit on a selected note.
import { afterEach, describe, expect, it } from 'vitest'
import {
  type CanvasFeatureContext,
  createFeatureRegistries,
  type KeyEventLike,
} from '../../../canvas/api/index.ts'
import { CMD, COMMANDS, setToolLock } from './commands.ts'
import { KEYS } from './keys.ts'
import { PLACEMENT_TOOLS, toolAfterPlacement, toolLock, toolLockNotice } from './tool-lock.ts'

const q: KeyEventLike = {
  key: 'q',
  code: 'KeyQ',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
}

function fake(opts: {
  selection?: string[]
  types?: Record<string, string>
  tool?: string
  readOnly?: boolean
}) {
  const registries = createFeatureRegistries()
  const tools: string[] = []
  const notices: string[] = []
  let tool = opts.tool ?? 'select'
  const canvas = {
    selection: opts.selection ?? [],
    get: (id: string) => (opts.types?.[id] ? { id, type: opts.types[id] } : undefined),
    readOnly: () => opts.readOnly ?? false,
    editingId: () => null,
    isLocked: () => false,
    tool: () => tool,
    setTool: (t: string) => {
      tool = t
      tools.push(t)
      return true
    },
  }
  const ctx = {
    canvas,
    registries,
    notify: (n: { text: string }) => notices.push(n.text),
  } as unknown as CanvasFeatureContext
  return { ctx, tools, notices, registries }
}

const lockKey = KEYS.find((k) => k.id === 'canvas-ux.tool-lock-key')

afterEach(() => toolLock.set(false))

describe('toolAfterPlacement', () => {
  it('Note and Text go back to Select after one placement', () => {
    for (const t of PLACEMENT_TOOLS) expect(toolAfterPlacement(t, false)).toBe('select')
  })
  it('with the lock on they stay; other tools are not placement tools', () => {
    for (const t of PLACEMENT_TOOLS) expect(toolAfterPlacement(t, true)).toBeNull()
    expect(toolAfterPlacement('comment', false)).toBeNull()
    expect(toolAfterPlacement('rectangle', false)).toBeNull()
  })
})

describe('setToolLock', () => {
  it('toggles the lock, says so, and picks the tool in use again (an engine tool takes the lock at once)', () => {
    const f = fake({ tool: 'rectangle' })
    setToolLock(f.ctx)
    expect(toolLock.get()).toBe(true)
    expect(f.tools).toEqual(['rectangle'])
    expect(f.notices).toEqual([toolLockNotice(true)])
    setToolLock(f.ctx)
    expect(toolLock.get()).toBe(false)
    expect(f.notices.at(-1)).toBe(toolLockNotice(false))
  })
  it('forcing the state it is in does nothing (a second double-click)', () => {
    const f = fake({ tool: 'text' })
    setToolLock(f.ctx, true)
    setToolLock(f.ctx, true)
    expect(f.notices).toHaveLength(1)
    expect(f.tools).toEqual(['text'])
  })
  it('the board menu command is there for people who can edit only', () => {
    const cmd = COMMANDS.find((c) => c.id === CMD.toolLock)
    expect(cmd?.kbd).toBeUndefined()
    expect(cmd?.enabled?.(fake({ readOnly: true }).ctx)).toBe(false)
    expect(cmd?.enabled?.(fake({}).ctx)).toBe(true)
  })
})

describe('the Q key', () => {
  it('turns the lock on with nothing, an image or a drawing selected', () => {
    expect(lockKey).toBeDefined()
    expect(lockKey?.match?.(q, fake({}).ctx)).toBe(true)
    expect(lockKey?.match?.(q, fake({ selection: ['i'], types: { i: 'image' } }).ctx)).toBe(true)
    expect(lockKey?.match?.(q, fake({ selection: ['d'], types: { d: 'freedraw' } }).ctx)).toBe(true)
  })
  it('steps aside for type-to-edit on one selected note or shape (P-005), a feature’s type-to-edit rule, a read-only role and Shift', () => {
    expect(lockKey?.match?.(q, fake({ selection: ['n'], types: { n: 'stickynote' } }).ctx)).toBe(false)
    expect(lockKey?.match?.(q, fake({ selection: ['r'], types: { r: 'rectangle' } }).ctx)).toBe(false)
    const topic = fake({ selection: ['t'], types: { t: 'rectangle' } })
    topic.registries.typeToEdit.register({ id: 'mindmap', applies: (id) => id === 't', start: () => true })
    expect(lockKey?.match?.(q, topic.ctx)).toBe(false)
    expect(lockKey?.match?.(q, fake({ readOnly: true }).ctx)).toBe(false)
    expect(lockKey?.match?.({ ...q, shiftKey: true }, fake({}).ctx)).toBe(false)
    expect(lockKey?.match?.({ ...q, ctrlKey: true }, fake({}).ctx)).toBe(false)
  })
  it('handling it toggles the lock', () => {
    const f = fake({})
    expect(lockKey?.handle(q, f.ctx)).toBe(true)
    expect(toolLock.get()).toBe(true)
  })
})
