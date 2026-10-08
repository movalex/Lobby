// K6-4: cursor chat's '/' is a Lobby key, registered by the cursor-chat feature (a command with kbd '/'),
// run by the board's key registry before the key allowlist (canvas/board/input.ts) and never delegated to
// Excalidraw. It acts only in the canvas scope: never inside the text editor (a '/' typed there is text),
// an overlay's own field or another input, nor while an editor is opening. It steps aside for type-to-edit
// on the one selected note, and for people who may not comment.
//
// Against fake DOM classes (no DOM here), like canvas/board/input-stream.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type CanvasFeatureContext,
  collectKeyClaims,
  createFeatureRegistries,
  installCanvasFeatures,
} from '../../canvas/api/index.ts'
import { classifyKey, classifyTextEditorKey, type KeyContext } from '../../canvas/input/keymap.ts'
import { CANVAS_FEATURES } from '../canvas-registry.ts'

class FakeNode {}
class FakeHTMLElement extends FakeNode {
  isContentEditable = false
}
class FakeInput extends FakeHTMLElement {}
class FakeTextArea extends FakeHTMLElement {
  classList = { contains: (c: string) => c === 'excalidraw-wysiwyg' }
}

beforeEach(() => {
  vi.stubGlobal('Node', FakeNode)
  vi.stubGlobal('HTMLElement', FakeHTMLElement)
  vi.stubGlobal('HTMLInputElement', FakeInput)
  vi.stubGlobal('HTMLTextAreaElement', FakeTextArea)
  vi.stubGlobal('HTMLSelectElement', class extends FakeHTMLElement {})
  vi.stubGlobal('requestAnimationFrame', () => 0)
})
afterEach(() => vi.unstubAllGlobals())

const { BoardInput } = await import('../../canvas/board/input.ts')
const { feature, cursorChatOf } = await import('./ported/index.tsx')

type Handler = (e: unknown) => void

function board(opts: { role?: CanvasFeatureContext['role']; readOnly?: boolean; selected?: string } = {}) {
  const handlers = new Map<string, Handler[]>()
  const inCanvas = new FakeHTMLElement()
  const registries = createFeatureRegistries()
  let editor: 'none' | 'pending' | 'granted' = 'none'
  const canvas = {
    readOnly: () => opts.readOnly ?? false,
    get selection() {
      return opts.selected ? [opts.selected] : []
    },
    get: (id: string) => (id === opts.selected ? { id, type: 'stickynote' } : undefined),
    pointer: () => ({ scene: { x: 100, y: 50 }, screen: { x: 300, y: 200 }, overCanvas: true, down: false }),
    viewport: { get: () => ({ x: 0, y: 0, width: 800, height: 600, zoom: 1 }) },
    focus: vi.fn(),
    tool: () => 'select',
    presence: { peers: () => [], peer: () => null },
    sceneToOverlay: (p: { x: number; y: number }) => p,
  }
  const ctx = {
    canvas,
    registries,
    board: { id: 'b-0123456789', status: 'active' },
    role: opts.role ?? 'editor',
    me: { user: { id: 'usr_alice0000000000', name: 'Alice', color: '#1d4ed8' } },
    workspace: { id: 'wsp_x', name: 'X' },
    api: { request: vi.fn(async () => undefined) },
    events: { on: () => () => {}, onResync: () => () => {}, onAccessLost: () => () => {} },
    notify: vi.fn(),
    dismiss: vi.fn(),
    openPanel: vi.fn(),
    activePanel: null,
  } as unknown as CanvasFeatureContext
  const uninstall = installCanvasFeatures([feature], ctx)
  const root = {
    addEventListener: (type: string, fn: Handler) => handlers.set(type, [...(handlers.get(type) ?? []), fn]),
    removeEventListener: () => {},
    ownerDocument: { addEventListener: () => {}, removeEventListener: () => {}, defaultView: null },
  }
  new BoardInput({
    root: root as never,
    canvasEl: () => ({ contains: (t: unknown) => t === inCanvas }) as never,
    keys: () => registries.keys.list(),
    canvas: () => canvas as never,
    editor: () => editor,
    isGrantedEditor: () => true,
    toScene: (x, y) => ({ x, y }),
    hit: () => null,
    listeners: () => [],
    onPointerChange: () => {},
    onHoverChange: () => {},
  })
  const press = (over: Record<string, unknown> = {}) => {
    const e = {
      key: '/',
      code: 'Slash',
      isTrusted: true,
      isComposing: false,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      target: inCanvas,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...over,
    }
    for (const h of handlers.get('keydown') ?? []) h(e)
    return {
      taken: e.preventDefault.mock.calls.length > 0,
      opened: cursorChatOf(ctx)?.composer.get() !== null,
    }
  }
  return {
    ctx,
    press,
    setEditor: (s: typeof editor) => {
      editor = s
    },
    close: () => cursorChatOf(ctx)?.close({ focusBoard: false }),
    uninstall,
  }
}

describe('K6-4: the cursor-chat key', () => {
  it('is the cursor-chat feature’s own claim: / in the canvas scope, and no other feature claims it', () => {
    expect(collectKeyClaims([feature])).toEqual([
      { chord: '/', scope: 'canvas', by: 'cursor-chat.open', featureId: 'cursor-chat' },
    ])
    const all = collectKeyClaims(CANVAS_FEATURES).filter((c) => c.chord === '/')
    expect(all.map((c) => c.featureId)).toEqual(['cursor-chat'])
  })

  it('is never delegated to Excalidraw: the allowlist alone keeps / from the engine; in the text editor / is typing', () => {
    const slash = { key: '/', code: 'Slash', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }
    const editor: KeyContext = {
      role: 'editor',
      editor: 'none',
      inTextEditor: false,
      singleTextTarget: false,
      singleNote: false,
    }
    expect(classifyKey(slash, editor).kind).not.toBe('delegate')
    expect(classifyKey(slash, { ...editor, role: 'readonly' }).kind).not.toBe('delegate')
    // a slash typed in a note's editor stays a character of the note
    expect(classifyTextEditorKey(slash, {})).toEqual({ kind: 'delegate' })
  })

  it('opens the composer from the canvas, and the key goes no further', () => {
    const b = board()
    expect(b.press()).toEqual({ taken: true, opened: true })
    b.uninstall()
  })

  it('does nothing inside the text editor, an overlay field or another input, or while an editor opens', () => {
    const b = board()
    b.setEditor('granted')
    expect(b.press({ target: new FakeTextArea() })).toEqual({ taken: false, opened: false })
    b.setEditor('pending')
    expect(b.press()).toEqual({ taken: false, opened: false })
    b.setEditor('none')
    expect(b.press({ target: new FakeInput() })).toEqual({ taken: false, opened: false })
    const editable = Object.assign(new FakeHTMLElement(), { isContentEditable: true })
    expect(b.press({ target: editable })).toEqual({ taken: false, opened: false })
    // outside the canvas (the top bar, a panel): not the board's key
    expect(b.press({ target: new FakeHTMLElement() })).toEqual({ taken: false, opened: false })
    // composing (an IME) never opens it
    expect(b.press({ isComposing: true })).toEqual({ taken: false, opened: false })
    b.uninstall()
  })

  it('only the plain / : Shift+/ (?, the shortcuts) and Ctrl+/ are not it', () => {
    const b = board()
    expect(b.press({ key: '?', shiftKey: true })).toEqual({ taken: false, opened: false })
    expect(b.press({ ctrlKey: true })).toEqual({ taken: false, opened: false })
    b.uninstall()
  })

  it('commenters chat (their board is read-only); viewers do not; an editor’s / on the one selected note types into it', () => {
    const commenter = board({ role: 'commenter', readOnly: true })
    expect(commenter.press()).toEqual({ taken: true, opened: true })
    commenter.uninstall()
    const viewer = board({ role: 'viewer', readOnly: true })
    expect(viewer.press()).toEqual({ taken: false, opened: false })
    viewer.uninstall()
    const onNote = board({ selected: 'note-1' })
    expect(onNote.press()).toEqual({ taken: false, opened: false })
    onNote.uninstall()
    // a commenter cannot type into a note: their / chats
    const commenterOnNote = board({ role: 'commenter', readOnly: true, selected: 'note-1' })
    expect(commenterOnNote.press()).toEqual({ taken: true, opened: true })
    commenterOnNote.uninstall()
  })

  it('a second / while the composer is open is not taken again', () => {
    const b = board()
    expect(b.press().opened).toBe(true)
    expect(b.press().taken).toBe(false)
    b.close()
    expect(b.press()).toEqual({ taken: true, opened: true })
    b.uninstall()
  })
})
