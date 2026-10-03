// CR-3D-2 (the person's own keys come from the input stream, marked `synthetic` for Lobby's own) and
// CR-3D-3 (a printable key on a selected topic starts editing it): the pure state of MindmapKeyboard against a
// fake canvas and runtime. The browser paths are e2e/excalidraw/mindmap-keyboard.spec.ts and
// c3-polish.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFeatureRegistries } from '../../../canvas/api/index.ts'
import { MindmapKeyboard } from './keyboard.ts'
import type { MindmapRuntime } from './runtime.ts'

type Listener = (...args: never[]) => void

function fakes(opts: { topics?: string[]; readOnly?: boolean; locked?: string[]; hidden?: string[] } = {}) {
  const listeners = new Map<string, Set<Listener>>()
  const edits: { id: string; opts: unknown }[] = []
  let editing: string | null = null
  const canvas = {
    on(type: string, fn: Listener) {
      const set = listeners.get(type) ?? new Set<Listener>()
      listeners.set(type, set)
      set.add(fn)
      return () => set.delete(fn)
    },
    selection: [] as string[],
    editingId: () => editing,
    readOnly: () => opts.readOnly ?? false,
    isLocked: (id: string) => opts.locked?.includes(id) ?? false,
    isHidden: (id: string) => opts.hidden?.includes(id) ?? false,
    text: {
      canEdit: () => true,
      of: () => 'Idea',
      editorElement: () => null,
      stop: () => {},
      edit(id: string, o: unknown) {
        edits.push({ id, opts: o })
        return new Promise<boolean>(() => {})
      },
    },
  }
  const topics = new Set(opts.topics ?? ['t1'])
  const rt = {
    canvas,
    isTopic: (id: string | null | undefined) => !!id && topics.has(id),
    fresh: null,
    editorNeverOpened: () => {},
    whenEditorClosed: (cb: () => void) => cb,
    addChild: () => null,
    addSibling: () => null,
  } as unknown as MindmapRuntime
  const emit = (type: string, ...args: unknown[]) => {
    for (const fn of [...(listeners.get(type) ?? [])]) (fn as (...a: unknown[]) => void)(...args)
  }
  const keyDown = (key: string, over: { synthetic?: boolean; composing?: boolean } = {}) => {
    const taken = { value: false }
    emit('input', {
      type: 'key-down',
      key,
      code: key,
      shift: false,
      alt: false,
      ctrl: false,
      meta: false,
      synthetic: over.synthetic ?? false,
      composing: over.composing ?? false,
      handled: () => {
        taken.value = true
      },
    })
    return taken.value
  }
  return {
    canvas,
    rt,
    edits,
    emit,
    keyDown,
    setEditing: (id: string | null) => {
      editing = id
      emit('editingChanged', id)
    },
    listeners,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('type-to-edit on a selected topic (CR-3D-3)', () => {
  it('registers itself with the page and applies to an editable, unlocked, visible topic only', () => {
    const f = fakes({ topics: ['t1', 'locked', 'hidden'], locked: ['locked'], hidden: ['hidden'] })
    const registries = createFeatureRegistries()
    const keys = new MindmapKeyboard(f.rt)
    const off = keys.install(registries)
    const spec = registries.typeToEdit.get('mindmap.type-to-edit')
    expect(spec).toBeDefined()
    expect(spec?.applies('t1')).toBe(true)
    expect(spec?.applies('plain-rectangle')).toBe(false)
    expect(spec?.applies('locked')).toBe(false)
    expect(spec?.applies('hidden')).toBe(false)
    off()
    expect(registries.typeToEdit.get('mindmap.type-to-edit')).toBeUndefined()
  })

  it('never for a read-only person', () => {
    const f = fakes({ readOnly: true })
    const keys = new MindmapKeyboard(f.rt)
    keys.install()
    expect(keys.typesInto('t1')).toBe(false)
    expect(keys.typeInto('t1', 'a')).toBe(false)
    expect(f.edits).toEqual([])
  })

  it('starts the topic’s editor through the lease with the key as the first typed word', () => {
    const f = fakes()
    const keys = new MindmapKeyboard(f.rt)
    keys.install()
    expect(keys.typeInto('t1', 'x')).toBe(true)
    expect(f.edits).toEqual([{ id: 't1', opts: { via: 'enter', caret: 'end' } }])
    // the editor is on its way: the keys that follow are kept for it, and a second start is refused
    expect(keys.waiting).toBe(true)
    expect(keys.typesInto('t1')).toBe(false)
  })

  it('not right after an edit left the topic selected (RETRO-02), until the selection moves or it is clicked', () => {
    const f = fakes({ topics: ['t1', 't2'] })
    const keys = new MindmapKeyboard(f.rt)
    keys.install()
    f.setEditing('t1')
    f.setEditing(null) // Esc: the topic stays selected
    expect(keys.typesInto('t1')).toBe(false)
    f.emit('selectionChanged', ['t1']) // the same single selection: still just left
    expect(keys.typesInto('t1')).toBe(false)
    f.emit('selectionChanged', ['t2'])
    expect(keys.typesInto('t1')).toBe(true)
    f.setEditing('t1')
    f.setEditing(null)
    expect(keys.typesInto('t1')).toBe(false)
    f.emit('input', { type: 'pointer-down' })
    expect(keys.typesInto('t1')).toBe(true)
  })

  it('an editor that is not a topic’s leaves nothing behind', () => {
    const f = fakes()
    const keys = new MindmapKeyboard(f.rt)
    keys.install()
    f.setEditing('some-note')
    f.setEditing(null)
    expect(keys.typesInto('t1')).toBe(true)
  })
})

describe('keys typed while a topic’s editor is on its way (CR-3D-2)', () => {
  it('only the person’s own keys are kept: the lease’s synthetic Enter and an IME’s keys are not', () => {
    const f = fakes()
    const keys = new MindmapKeyboard(f.rt)
    keys.install()
    keys.expectEditor('t1', 'append')
    expect(keys.waiting).toBe(true)
    // observed, not taken (the lease keeps the keys once its request is out)
    expect(f.keyDown('a')).toBe(false)
    expect(f.keyDown('Enter', { synthetic: true })).toBe(false)
    expect(f.keyDown('b', { composing: true })).toBe(false)
    expect(f.keyDown('Shift')).toBe(false)
  })

  it('between two topics’ editors a key is the next topic’s alone: the stream is told to take it', () => {
    const f = fakes()
    const keys = new MindmapKeyboard(f.rt)
    keys.install()
    keys.fromEditor('sibling', 't1') // the editor closes; the new topic's lease is not requested yet
    expect(f.keyDown('x')).toBe(true)
    expect(f.keyDown('Enter', { synthetic: true })).toBe(false)
    expect(f.keyDown('Control')).toBe(false) // a modifier means nothing to a topic
  })

  it('does not listen to anything after it is uninstalled, and nothing stays registered', () => {
    const f = fakes()
    const keys = new MindmapKeyboard(f.rt)
    const off = keys.install(createFeatureRegistries())
    off()
    for (const set of f.listeners.values()) expect(set.size).toBe(0)
  })
})
