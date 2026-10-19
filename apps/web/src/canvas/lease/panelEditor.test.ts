// The doc card panel's lease client (./panelEditor.ts) against spike A's fake lease server (./fakeServer.ts) and a
// fake board: the guard's rule for a text editor that is not Excalidraw's (AGENTS.md: never writable unless its
// element is that of a lease this tab holds), the writes it makes and the lease it gives back.
import { describe, expect, it } from 'vitest'
import { LeaseClient } from './client.ts'
import { FakeLeaseServer } from './fakeServer.ts'
import {
  attachPanelLeaseHost,
  type PanelBoard,
  PanelEditorLease,
  panelBeforeHistory,
  panelEditorOf,
} from './panelEditor.ts'

const ME = { sid: 'u1:tab1', uid: 'u1', name: 'Me' }
const DANA = { sid: 'u2:tab9', uid: 'u2', name: 'Dana' }
const CARD = 'card1'

interface Write {
  readonly text: string
  readonly join: boolean
  /** the lease was held when the write was made */
  readonly held: boolean
}

function setup(opts: { editable?: boolean } = {}) {
  const server = new FakeLeaseServer({ me: ME, delayMs: 'manual' })
  const lease = new LeaseClient((m) => server.connect(m), ME)
  let words: string | null = '# Plan\n- [ ] one'
  let live = true
  let editable = opts.editable ?? true
  let version = 1
  let inPlace: string | null = null
  const writes: Write[] = []
  const changes = new Set<(c: { source: string; ids: readonly string[] }) => void>()
  const timers: (() => void)[] = []
  const saved: boolean[] = []
  let presence = 0
  const board: PanelBoard = {
    words: () => (live ? words : null),
    editable: () => live && editable,
    live: () => live,
    write(_id, text, join) {
      writes.push({ text, join, held: lease.isHeld(CARD) })
      words = text
      version++
    },
    ownIds: () => [CARD, `${CARD}.t`],
    stamp: () => String(version),
    onChange(l) {
      changes.add(l)
      return () => changes.delete(l)
    },
  }
  const editor = new PanelEditorLease({
    host: {
      lease,
      inPlaceLease: () => inPlace,
      refreshPresence: () => {
        presence++
      },
      holdSaved: (on) => saved.push(on),
    },
    board,
    maxChars: 40,
    setTimer: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimer: () => {
      timers.length = 0
    },
  })
  const tick = () => {
    for (const fn of timers.splice(0)) fn()
  }
  const grant = async () => {
    server.flush()
    await Promise.resolve()
    await Promise.resolve()
  }
  const emit = (source: string, ids: readonly string[]) => {
    for (const l of [...changes]) l({ source, ids })
  }
  return {
    server,
    lease,
    editor,
    writes,
    saved,
    tick,
    grant,
    emit,
    presence: () => presence,
    setWords: (w: string) => {
      words = w
      version++
    },
    setLive: (v: boolean) => {
      live = v
    },
    setEditable: (v: boolean) => {
      editable = v
    },
    setInPlace: (v: string | null) => {
      inPlace = v
    },
    released: () => server.log.filter((l) => l.dir === 'up' && l.message.type === 'lease.release').length,
  }
}

describe('the doc card panel is a lease client', () => {
  it('read-only until the lease is granted: input is refused and nothing is written', async () => {
    const t = setup()
    t.editor.open(CARD, { edit: true })
    expect(t.editor.state().phase).toBe('pending')
    expect(t.editor.editingLease()).toBe(CARD)
    expect(t.editor.isWritable()).toBe(false)
    expect(t.editor.input('typed before the grant')).toBe(false)
    t.tick()
    expect(t.writes).toEqual([])
    await t.grant()
    expect(t.editor.state().phase).toBe('open')
    expect(t.editor.isWritable()).toBe(true)
    expect(t.editor.state().text).toBe('# Plan\n- [ ] one')
  })

  it('writes at most every push tick, the first write a step and the later ones joined to it, all under the lease', async () => {
    const t = setup()
    t.editor.open(CARD, { edit: true })
    await t.grant()
    expect(t.editor.input('a')).toBe(true)
    expect(t.editor.state().pending).toBe(true)
    expect(t.saved.at(-1)).toBe(true)
    t.tick()
    expect(t.editor.input('ab')).toBe(true)
    expect(t.editor.input('abc')).toBe(true)
    t.tick()
    expect(t.writes).toEqual([
      { text: 'a', join: false, held: true },
      { text: 'abc', join: true, held: true },
    ])
    expect(t.saved.at(-1)).toBe(false)
  })

  it('keeps the words to the cap', async () => {
    const t = setup()
    t.editor.open(CARD, { edit: true })
    await t.grant()
    t.editor.input('x'.repeat(100))
    t.editor.flush()
    expect(t.writes.at(-1)?.text).toHaveLength(40)
  })

  it('a deny names the holder and stays read-only', async () => {
    const t = setup()
    t.server.holdByOther(CARD, DANA)
    t.editor.open(CARD, { edit: true })
    await t.grant()
    expect(t.editor.state()).toMatchObject({ phase: 'denied', holder: DANA })
    expect(t.editor.state().reason).toBe('Dana is editing this doc card.')
    expect(t.editor.isWritable()).toBe(false)
    expect(t.editor.input('x')).toBe(false)
    expect(t.editor.editingLease()).toBeNull()
    // Dana lets go: the panel says so, and Edit asks again
    t.server.clearOther(CARD)
    expect(t.editor.state()).toMatchObject({ phase: 'reading', holder: null })
    t.editor.requestEdit()
    await t.grant()
    expect(t.editor.isWritable()).toBe(true)
  })

  it('a lost lease: read-only at once, the unsaved words offered, nothing written and nothing released', async () => {
    const t = setup()
    t.editor.open(CARD, { edit: true })
    await t.grant()
    t.editor.input('my words')
    // the lease goes to Dana before the tick
    t.server.holdByOther(CARD, DANA)
    expect(t.editor.state()).toMatchObject({ phase: 'lost', holder: DANA, unsaved: 'my words' })
    expect(t.editor.isWritable()).toBe(false)
    t.tick()
    t.editor.flush()
    expect(t.editor.input('more')).toBe(false)
    t.editor.close()
    expect(t.writes).toEqual([])
    expect(t.released()).toBe(0)
  })

  it('closing writes the typed words, then gives the lease back', async () => {
    const t = setup()
    t.editor.open(CARD, { edit: true })
    await t.grant()
    t.editor.input('last words')
    t.editor.close()
    expect(t.writes).toEqual([{ text: 'last words', join: false, held: true }])
    expect(t.released()).toBe(1)
    expect(t.editor.state().phase).toBe('closed')
    expect(t.editor.isWritable()).toBe(false)
    expect(t.editor.editingLease()).toBeNull()
  })

  it('the in-place editor opening on the card takes it over: the typed words go first, then nothing, and no release', async () => {
    const t = setup()
    t.editor.open(CARD, { edit: true })
    await t.grant()
    t.editor.input('typed in the panel')
    t.setInPlace(CARD)
    t.editor.inPlaceChanged('opening', CARD)
    expect(t.writes).toEqual([{ text: 'typed in the panel', join: false, held: true }])
    expect(t.editor.state().phase).toBe('handed-over')
    expect(t.editor.isWritable()).toBe(false)
    expect(t.editor.input('x')).toBe(false)
    t.editor.close()
    expect(t.released()).toBe(0)
    expect(t.writes).toHaveLength(1)
  })

  it('another editor of this tab giving the lease back while the panel is open: the panel stops writing', async () => {
    const t = setup()
    t.editor.open(CARD, { edit: true })
    await t.grant()
    t.editor.input('x')
    t.lease.release(CARD)
    expect(t.editor.state().phase).toBe('lost')
    expect(t.editor.isWritable()).toBe(false)
    t.tick()
    expect(t.writes).toEqual([])
  })

  it('never writable while the in-place editor is on the card, whatever the panel thinks', async () => {
    const t = setup()
    t.editor.open(CARD, { edit: true })
    await t.grant()
    t.setInPlace(CARD)
    expect(t.editor.isWritable()).toBe(false)
    expect(t.editor.input('x')).toBe(false)
  })

  it('a read-only role never asks for the lease', () => {
    const t = setup({ editable: false })
    t.editor.open(CARD, { edit: true })
    expect(t.editor.state().phase).toBe('reading')
    expect(t.server.log).toEqual([])
    expect(t.editor.isWritable()).toBe(false)
  })

  it('the card deleted while open: lost, the words offered, nothing written', async () => {
    const t = setup()
    t.editor.open(CARD, { edit: true })
    await t.grant()
    t.editor.input('gone soon')
    t.setLive(false)
    t.emit('remote', [CARD])
    expect(t.editor.state()).toMatchObject({ phase: 'lost', unsaved: 'gone soon' })
    expect(t.editor.state().reason).toBe('This doc card was deleted.')
    t.tick()
    expect(t.writes).toEqual([])
  })

  it('one undo step per session: another step of this tab in between starts a new one', async () => {
    const t = setup()
    t.editor.open(CARD, { edit: true })
    await t.grant()
    t.editor.input('a')
    t.editor.flush()
    t.editor.input('ab')
    t.editor.flush()
    // the person moves something else on the board meanwhile
    t.emit('local', ['other'])
    t.editor.input('abc')
    t.editor.flush()
    // an undo
    t.emit('history', [CARD])
    t.editor.input('abcd')
    t.editor.flush()
    expect(t.writes.map((w) => w.join)).toEqual([false, true, false, false])
  })

  it('words changed under an idle open panel (an undo) are shown; a remote change of a reading panel too', async () => {
    const t = setup()
    t.editor.open(CARD, { edit: true })
    await t.grant()
    t.setWords('undone')
    t.emit('history', [CARD])
    expect(t.editor.state().text).toBe('undone')
    t.editor.close()
    t.editor.open(CARD, { edit: false })
    t.setWords('remote words')
    t.emit('remote', [`${CARD}.t`])
    expect(t.editor.state().text).toBe('remote words')
  })

  it('a board undo under typing not yet written wins: the pending push is dropped and the textarea shows the undo', async () => {
    const t = setup()
    t.editor.open(CARD, { edit: true })
    await t.grant()
    t.editor.input('a')
    t.tick()
    // typing within the push interval: not written yet
    t.editor.input('ab')
    expect(t.editor.state().pending).toBe(true)
    // the board undo of the session step lands before the push tick
    t.setWords('# Plan\n- [ ] one')
    t.emit('history', [CARD, `${CARD}.t`])
    expect(t.editor.state()).toMatchObject({ text: '# Plan\n- [ ] one', pending: false })
    expect(t.saved.at(-1)).toBe(false)
    t.tick()
    t.editor.flush()
    expect(t.writes.map((w) => w.text)).toEqual(['a'])
    // typing on goes on from the undone words, as its own step
    t.editor.input('# Plan\n- [ ] one!')
    t.tick()
    expect(t.writes.at(-1)).toEqual({ text: '# Plan\n- [ ] one!', join: false, held: true })
  })

  it('before a board undo the typing not yet written is written, joined to the session step the undo takes out', async () => {
    const t = setup()
    const host = {
      lease: t.lease,
      inPlaceLease: () => null,
      refreshPresence: () => {},
      holdSaved: () => {},
    }
    const canvas = {}
    const detach = attachPanelLeaseHost(canvas as never, host)
    const writes: { text: string; join: boolean }[] = []
    let words = 'start'
    const board: PanelBoard = {
      words: () => words,
      editable: () => true,
      live: () => true,
      write(_id, text, join) {
        writes.push({ text, join })
        words = text
      },
      ownIds: () => [CARD],
      stamp: () => words,
      onChange: () => () => {},
    }
    const timers: (() => void)[] = []
    const panel = panelEditorOf(canvas as never, () => ({
      board,
      maxChars: 100,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {
        timers.length = 0
      },
    }))
    if (!panel) throw new Error('no panel')
    panel.open(CARD, { edit: true })
    await t.grant()
    panel.input('start a')
    for (const fn of timers.splice(0)) fn()
    panel.input('start ab')
    panelBeforeHistory(t.lease)
    expect(writes).toEqual([
      { text: 'start a', join: false },
      { text: 'start ab', join: true },
    ])
    expect(panel.state().pending).toBe(false)
    // nothing left to push over the undo
    expect(timers).toHaveLength(0)
    detach()
  })

  it('a card locked while the panel holds its lease: read-only, the typing offered, the lease given back and not renewed', async () => {
    const t = setup()
    t.editor.open(CARD, { edit: true })
    await t.grant()
    expect(t.editor.editingLease()).toBe(CARD)
    t.editor.input('typed')
    t.setEditable(false)
    t.emit('local', [CARD])
    expect(t.editor.state()).toMatchObject({ phase: 'reading', unsaved: 'typed', pending: false })
    expect(t.editor.state().reason).toBe('You can read this doc card but not edit it.')
    expect(t.editor.editingLease()).toBeNull()
    expect(t.released()).toBe(1)
    expect(t.lease.isHeld(CARD)).toBe(false)
    t.tick()
    expect(t.writes).toEqual([])
  })

  it('a role dropped to viewer (no element change): presence stops naming the card and the lease goes back', async () => {
    const t = setup()
    t.editor.open(CARD, { edit: true })
    await t.grant()
    t.setEditable(false)
    expect(t.editor.editingLease()).toBeNull()
    await Promise.resolve()
    expect(t.editor.state().phase).toBe('reading')
    expect(t.editor.isWritable()).toBe(false)
    expect(t.released()).toBe(1)
  })

  it('a role dropped while the lease is asked for: the late grant is given straight back', async () => {
    const t = setup()
    t.editor.open(CARD, { edit: true })
    t.setEditable(false)
    expect(t.editor.editingLease()).toBeNull()
    await Promise.resolve()
    expect(t.editor.state().phase).toBe('reading')
    await t.grant()
    expect(t.editor.state().phase).toBe('reading')
    expect(t.lease.isHeld(CARD)).toBe(false)
    expect(t.released()).toBe(1)
  })

  it('presence follows the panel: the card while asking and holding, nothing after', async () => {
    const t = setup()
    const before = t.presence()
    t.editor.open(CARD, { edit: true })
    expect(t.presence()).toBeGreaterThan(before)
    await t.grant()
    expect(t.editor.editingLease()).toBe(CARD)
    t.editor.close()
    expect(t.editor.editingLease()).toBeNull()
  })

  it('the guard holds over any sequence: writable only while open with the lease held, every write under the lease', async () => {
    let seed = 7
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    for (let run = 0; run < 40; run++) {
      const t = setup()
      for (let step = 0; step < 40; step++) {
        const k = rand(12)
        if (k === 0) t.editor.open(CARD, { edit: true })
        else if (k === 1) await t.grant()
        else if (k === 2) t.editor.input(`t${step}`)
        else if (k === 3) t.tick()
        else if (k === 4) t.server.holdByOther(CARD, DANA)
        else if (k === 5) t.server.clearOther(CARD)
        else if (k === 6) t.editor.close()
        else if (k === 7) {
          t.setInPlace(rand(2) ? CARD : null)
          t.editor.inPlaceChanged('open', CARD)
        } else if (k === 8) t.editor.requestEdit()
        else if (k === 9) t.lease.release(CARD)
        else if (k === 10) t.editor.flush()
        else t.setEditable(rand(3) !== 0)
        if (t.editor.isWritable()) {
          expect(t.editor.state().phase).toBe('open')
          expect(t.lease.isHeld(CARD)).toBe(true)
        }
      }
      for (const w of t.writes) expect(w.held, `run ${run}`).toBe(true)
    }
  })
})
