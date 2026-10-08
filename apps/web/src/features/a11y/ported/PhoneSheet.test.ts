// K5-3: a phone with a touch screen rests on the Hand tool (a one-finger drag pans instead of moving
// colleagues' notes), after the board loads and when the "All tools" sheet closes without a pick; never on a
// desktop, never over a tool the person picked, and only through the canvas API's setTool. The one-time hint
// is shown once per browser, with every storage access in try/catch.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ALL_TOOLS_LABEL,
  createHandRest,
  type HintStorage,
  PHONE_HAND_HINT,
  PHONE_HINT_KEY,
  PHONE_REST_TOOL,
  type RestCanvas,
  resetPhoneHintMemory,
  restsOnHand,
  takePhoneHint,
} from './PhoneSheet.tsx'

/** A canvas with only the members the rule may use; every call is recorded. */
function fakeCanvas(init: { tool: string; editing?: string | null; refuse?: boolean }) {
  let tool = init.tool
  const calls: string[] = []
  const canvas: RestCanvas = {
    tool: () => tool,
    editingId: () => init.editing ?? null,
    setTool: (t: string) => {
      calls.push(`setTool:${t}`)
      if (init.refuse) return false
      tool = t
      return true
    },
  }
  return {
    canvas,
    calls,
    get tool() {
      return tool
    },
    set tool(t: string) {
      tool = t
    },
  }
}

describe('restsOnHand', () => {
  it('a phone-width board with a touch screen only', () => {
    expect(restsOnHand({ phone: true, coarse: true })).toBe(true)
    // a narrow desktop window (a mouse), a laptop or tablet with a touch screen and a wider board, a desktop
    expect(restsOnHand({ phone: true, coarse: false })).toBe(false)
    expect(restsOnHand({ phone: false, coarse: true })).toBe(false)
    expect(restsOnHand({ phone: false, coarse: false })).toBe(false)
  })
})

describe('createHandRest', () => {
  it('after load, a board on Select goes to Hand through setTool', () => {
    const f = fakeCanvas({ tool: 'select' })
    const rest = createHandRest(f.canvas)
    expect(rest.afterLoad()).toBe(true)
    expect(f.calls).toEqual([`setTool:${PHONE_REST_TOOL}`])
    expect(f.tool).toBe('hand')
  })

  it('never over another tool, nor while a text editor is open', () => {
    const note = fakeCanvas({ tool: 'note' })
    expect(createHandRest(note.canvas).afterLoad()).toBe(false)
    const editing = fakeCanvas({ tool: 'select', editing: 'n1' })
    expect(createHandRest(editing.canvas).afterLoad()).toBe(false)
    expect([...note.calls, ...editing.calls]).toEqual([])
  })

  it('when the sheet closes without a pick, a board back on Select (after placing a note) rests on Hand again', () => {
    const f = fakeCanvas({ tool: 'select' })
    const rest = createHandRest(f.canvas)
    rest.afterLoad()
    rest.picked('note')
    f.tool = 'select' // the engine returns to Select as the note's editor opens
    expect(rest.dismissed()).toBe(true)
    expect(f.tool).toBe('hand')
  })

  it('Select picked by the person stays Select, after a dismissal too', () => {
    const f = fakeCanvas({ tool: 'hand' })
    const rest = createHandRest(f.canvas)
    rest.picked('select')
    f.tool = 'select'
    expect(rest.dismissed()).toBe(false)
    expect(f.tool).toBe('select')
    expect(f.calls).toEqual([])
    // a later pick of another tool makes the rest rule apply again
    rest.picked('hand')
    expect(rest.chosen()).toBe('hand')
  })

  it('a refused setTool (a role without Hand) says so', () => {
    const f = fakeCanvas({ tool: 'select', refuse: true })
    expect(createHandRest(f.canvas).afterLoad()).toBe(false)
  })

  it('uses the canvas API only: PhoneSheet.tsx never reaches into the engine', () => {
    const src = readFileSync(new URL('./PhoneSheet.tsx', import.meta.url), 'utf8')
    expect(src).not.toMatch(/@excalidraw\//)
    expect(src).not.toMatch(/updateScene|setActiveTool|excalidrawAPI|getAppState/)
  })
})

describe('the one-time hint', () => {
  afterEach(() => resetPhoneHintMemory())

  const memory = (): HintStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>()
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    }
  }

  it('is shown once per browser: marked when shown, never again after a reload', () => {
    const s = memory()
    expect(takePhoneHint(s)).toBe(true)
    expect(s.data.get(PHONE_HINT_KEY)).toBe('1')
    expect(takePhoneHint(s)).toBe(false)
    resetPhoneHintMemory() // a reload: only storage remembers
    expect(takePhoneHint(s)).toBe(false)
  })

  it('storage that throws (a private window, blocked site data): shown once in this page, nothing thrown', () => {
    const throwing: HintStorage = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
    }
    expect(takePhoneHint(throwing)).toBe(true)
    expect(takePhoneHint(throwing)).toBe(false)
  })

  it('a write that throws (storage full) still shows it once', () => {
    const s: HintStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError')
      },
    }
    expect(takePhoneHint(s)).toBe(true)
    expect(takePhoneHint(s)).toBe(false)
  })

  it('no storage at all: once per page', () => {
    expect(takePhoneHint(null)).toBe(true)
    expect(takePhoneHint(null)).toBe(false)
  })

  it('says how Hand and Select work', () => {
    expect(PHONE_HAND_HINT.lead).toBe('Drag to look around the board.')
    expect(PHONE_HAND_HINT.rest).toContain('tap to select, drag to move')
    expect(PHONE_HAND_HINT.rest).toContain('Select (the arrow)')
  })
})

describe('the floating button', () => {
  it('is "All tools" (the board menu at the top left is the other ≡ button)', () => {
    expect(ALL_TOOLS_LABEL).toBe('All tools')
    const src = readFileSync(new URL('./PhoneSheet.tsx', import.meta.url), 'utf8')
    // not the hamburger it used to share with the board menu
    expect(src).not.toContain('M4 7h16M4 12h16M4 17h16')
    expect(src).toContain('data-icon="all-tools"')
  })
})
