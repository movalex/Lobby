// OWNER: 3f (workshops; wave N, WS3). Emoji reactions on notes (./note-reactions.ts, ./NoteReactions.tsx): the gate
// (a room below REACTIONS_REV, a read-only tab), the row's counts and order, the names, the write (one skipUndo
// transact of the person's own key, off writes null), the refusals (the kill switch, a full note), the picker's
// ways in, and the layer rendered to markup (react-dom/server). In a browser: e2e/excalidraw/n3-reactions.spec.ts.
import { REACTIONS_MAX } from '@draftroom/canvas-schema/limits'
import { type Ack, REACTIONS_REV } from '@draftroom/canvas-schema/protocol'
import { reactionKey } from '@draftroom/canvas-schema/reactions'
import {
  PALETTE_COMMAND_IDS,
  REACTION_CODE_EMOJI,
  REACTION_CODES,
  type ReactionCode,
} from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasElement, CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { pendingUsage } from '../../../lib/usage.ts'
import { feature } from './index.tsx'
import { NoteReactionsLayer, ReactionPicker } from './NoteReactions.tsx'
import {
  canClearReactions,
  clear,
  clearReactions,
  closeReactionPicker,
  nameResolver,
  openReactionPicker,
  pickerOf,
  REACTIONS_COMMAND_ID,
  REACTIONS_FULL_TEXT,
  REACTIONS_NOT_YET_TEXT,
  REACTIONS_OFF_TEXT,
  REACTIONS_SELECTION_ITEM_ID,
  REACTIONS_UI,
  react,
  reactionArgs,
  reactionChipsOf,
  reactionCountOf,
  reactionLabel,
  reactionPatch,
  reactionsOffered,
  reactionsOn,
  reactionsRoom,
  reactionTargets,
  SOMEONE,
  toggleReaction,
  toggleReactions,
  UNAVAILABLE_TWICE,
  watchReactionWrite,
  whoReacted,
} from './note-reactions.ts'
import { type FakeCanvas, fakeCanvas, note } from './test-kit.ts'

const ME = 'usr_me0000000001'
const BOB = 'usr_bob000000001'
const CAL = 'usr_cal000000001'
const GONE = 'usr_gone00000001'

const keys = (...pairs: [code: ReactionCode, uid: string][]) =>
  Object.fromEntries(pairs.map(([c, u]) => [reactionKey(c, u), true as const]))

/** A note whose bound label says `words`; `lobby` is its customData.lobby. */
const reacted = (
  id: string,
  lobby: Record<string, unknown> | undefined,
  patch: Record<string, unknown> = {},
) => note(id, 'Words', { ...patch, ...(lobby ? { customData: { lobby } } : {}) })

interface Kit {
  f: FakeCanvas
  ctx: CanvasFeatureContext
  notices: { key: string; text: string; testId?: string; tone?: string }[]
  /** how many times the scene was walked (canvas.items) */
  walks: { items: number }
  engine: FakeEngine
  setRev(rev: number | null): void
  setHovered(id: string | null): void
  roster: { uid: string; sid: string; name: string; guest: boolean; role: string; color: string }[]
}

class FakeEngine {
  readonly listeners = new Set<(ack: Ack) => void>()
  readonly log: { seq: number; ops: unknown[] }[] = []
  stored = new Map<string, { customData?: { lobby?: Record<string, unknown> } }>()
  onAck(l: (ack: Ack) => void) {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }
  pushLog() {
    return this.log
  }
  confirmed(id: string) {
    return this.stored.get(id)
  }
  /** a push of the page that patches `key` of note `id` goes up */
  push(seq: number, id: string, c: Record<string, unknown>) {
    this.log.push({ seq, ops: [{ k: 'p', id, pv: 1, c }] })
  }
  ack(seq: number, r: unknown[]) {
    for (const l of [...this.listeners]) l({ type: 'ack', seq, clock: 1, r } as unknown as Ack)
  }
}

function kit(
  elements: CanvasElement[],
  o: { rev?: number | null; role?: string; readOnly?: boolean; zoom?: number } = {},
): Kit {
  const f = fakeCanvas(elements)
  f.readOnly = o.readOnly ?? false
  f.viewport = { x: 0, y: 0, width: 1000, height: 800, zoom: o.zoom ?? 1 }
  const walks = { items: 0 }
  const realItems = f.canvas.items
  let rev: number | null = o.rev === undefined ? REACTIONS_REV : o.rev
  let hovered: string | null = null
  const engine = new FakeEngine()
  const notices: Kit['notices'] = []
  const roster = [
    { uid: ME, sid: 's-me', name: 'Mia Me', guest: false, role: 'editor', color: '#111111' },
    { uid: BOB, sid: 's-bob', name: 'Bob Builder', guest: false, role: 'editor', color: '#222222' },
  ]
  Object.assign(f.canvas, {
    items: () => {
      walks.items++
      return realItems()
    },
    room: { contractsRev: () => rev },
    index: {
      withLobbyKeyPrefix: (prefix: string) =>
        realItems().filter((e) =>
          Object.keys(e.customData?.lobby ?? {}).some(
            (k) => k.startsWith(prefix) && k.length > prefix.length,
          ),
        ),
    },
    tool: () => 'select',
    hovered: () => hovered,
    editingId: () => null,
    collaborators: () => roster,
    settings: { get: () => ({ focusMode: false }) },
    focus: () => {},
    container: () => null,
    engine,
  })
  const ctx = {
    canvas: f.canvas,
    role: o.role ?? 'editor',
    me: { user: { id: ME, name: 'Mia Me', color: '#111111' } },
    board: { id: 'b-n3kit00001', title: 'Kit', status: 'active' },
    notify: (n: Kit['notices'][number]) => notices.push(n),
    dismiss: () => {},
  } as unknown as CanvasFeatureContext
  return {
    f,
    ctx,
    notices,
    walks,
    engine,
    roster,
    setRev: (r) => {
      rev = r
    },
    setHovered: (id) => {
      hovered = id
    },
  }
}

const canvasAt = (rev: number | null, readOnly = false) => ({
  room: { contractsRev: () => rev },
  readOnly: () => readOnly,
})

const markup = (k: Kit) => renderToStaticMarkup(createElement(NoteReactionsLayer, { ctx: k.ctx }))
const count = (html: string, needle: string) => html.split(needle).length - 1

beforeEach(() => {
  // the picker state is per canvas (a WeakMap), the usage counts are the module's
})
afterEach(() => {
  // nothing global to restore
})

describe('reactions are offered only where the room takes them', () => {
  it('a room below 13 (the deployed rev 12), an unknown revision: not offered', () => {
    expect(REACTIONS_REV).toBe(13)
    for (const rev of [null, 10, 11, 12]) {
      expect(reactionsRoom(rev), String(rev)).toBe(false)
      expect(reactionsOffered(canvasAt(rev)), String(rev)).toBe(false)
    }
  })

  it('a rev-13 room: offered to a tab that can edit, never to a read-only one (viewers, commenters)', () => {
    expect(reactionsOffered(canvasAt(13))).toBe(true)
    expect(reactionsOffered(canvasAt(14))).toBe(true)
    expect(reactionsOffered(canvasAt(13, true))).toBe(false)
  })

  it('the hold (REACTIONS_UI) hides the whole feature even in a rev-13 room', () => {
    expect(REACTIONS_UI).toBe(true)
    expect(reactionsOn(canvasAt(13))).toBe(true)
    expect(reactionsOn(canvasAt(13), false)).toBe(false)
  })

  it('the frozen ids: the selection bar item, and the palette command a feature now registers', () => {
    expect(REACTIONS_SELECTION_ITEM_ID).toBe('reactions')
    expect(PALETTE_COMMAND_IDS as readonly string[]).toContain(REACTIONS_COMMAND_ID)
    expect((feature.commands ?? []).map((c) => c.id)).toContain(REACTIONS_COMMAND_ID)
    expect((feature.selectionBar ?? []).map((i) => i.id)).toContain(REACTIONS_SELECTION_ITEM_ID)
  })
})

describe('a note’s row: counts and order from the keys', () => {
  it('counts per emoji in REACTION_CODES order, whatever order the keys were stored in', () => {
    const [n] = reacted(
      'n',
      keys(['clap', BOB], ['up', CAL], ['heart', ME], ['up', ME], ['up', BOB], ['think', GONE]),
    )
    const chips = reactionChipsOf(n, ME)
    expect(chips.map((c) => [c.code, c.count, c.mine])).toEqual([
      ['up', 3, true],
      ['heart', 1, true],
      ['think', 1, false],
      ['clap', 1, false],
    ])
    expect(chips.map((c) => c.emoji)).toEqual(['👍', '❤️', '🤔', '👏'])
    // the order is the contract's, not the keys'
    const order = chips.map((c) => REACTION_CODES.indexOf(c.code))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(chips.length).toBeLessThanOrEqual(REACTION_CODES.length)
    expect(chips[0]?.uids).toEqual([BOB, CAL, ME].sort())
  })

  it('malformed keys, other keys and values that are not true count for nothing', () => {
    const [n] = reacted('n', {
      'react:bogus:usr_a': true,
      'react:up:': true,
      'react:up': true,
      [reactionKey('laugh', BOB)]: 1,
      [reactionKey('party', BOB)]: false,
      [`plusOne:${BOB}`]: true,
      'tag:x': { name: 'x' },
      [reactionKey('clap', CAL)]: true,
    })
    expect(reactionChipsOf(n, ME).map((c) => c.code)).toEqual(['clap'])
    expect(reactionChipsOf(undefined, ME)).toEqual([])
    expect(reactionChipsOf(reacted('m', undefined)[0], ME)).toEqual([])
  })

  it('the aria-label says how many people and whether you are among them', () => {
    expect(reactionLabel({ count: 3, emoji: '👍', mine: true })).toBe('3 people reacted 👍, including you')
    expect(reactionLabel({ count: 1, emoji: '❤️', mine: false })).toBe('1 person reacted ❤️')
    expect(reactionLabel({ count: 1, emoji: '🎉', mine: true })).toBe('1 person reacted 🎉, including you')
  })

  it('only live sticky notes are targets (a label, a shape, a gone note are not)', () => {
    const f = fakeCanvas([
      ...reacted('n', keys(['up', BOB])),
      ...reacted('d', keys(['up', BOB]), { isDeleted: true }),
    ])
    expect(reactionTargets(f.canvas, ['n', 'n-label', 'd', 'nope', 'n'])).toEqual(['n'])
  })
})

describe('who reacted (N3-3)', () => {
  it('names come from the roster by uid; an unknown uid reads Someone', () => {
    const k = kit([])
    const nameOf = nameResolver(k.f.canvas, { id: ME, name: 'Mia Me' })
    expect(nameOf(BOB)).toBe('Bob Builder')
    expect(nameOf(ME)).toBe('Mia Me')
    expect(nameOf(GONE)).toBe(SOMEONE)
    expect(SOMEONE).toBe('Someone')
  })

  it('a person this tab saw on the roster is still named after they leave; one it never saw is Someone', () => {
    const k = kit([])
    const me = { id: ME, name: 'Mia Me' }
    expect(nameResolver(k.f.canvas, me)(BOB)).toBe('Bob Builder')
    k.roster.splice(1, 1) // Bob leaves
    expect(nameResolver(k.f.canvas, me)(BOB)).toBe('Bob Builder')
    expect(nameResolver(k.f.canvas, me)(CAL)).toBe(SOMEONE)
    // a blank name is no name
    k.roster.push({ uid: CAL, sid: 's-cal', name: '   ', guest: true, role: 'editor', color: '#333333' })
    expect(nameResolver(k.f.canvas, me)(CAL)).toBe(SOMEONE)
  })

  it('the list: you first, the others by name, the unknown last; names withheld while authors are hidden', () => {
    const k = kit([])
    const nameOf = nameResolver(k.f.canvas, { id: ME, name: 'Mia Me' })
    const [n] = reacted('n', keys(['up', GONE], ['up', BOB], ['up', ME], ['heart', BOB]))
    const up = reactionChipsOf(n, ME).find((c) => c.code === 'up')
    if (!up) throw new Error('no up chip')
    expect(whoReacted(up, ME, nameOf, false)).toBe('You, Bob Builder and Someone')
    expect(whoReacted(up, ME, nameOf, true)).toBe('You and 2 others')
    const heart = reactionChipsOf(n, ME).find((c) => c.code === 'heart')
    if (!heart) throw new Error('no heart chip')
    expect(whoReacted(heart, ME, nameOf, false)).toBe('Bob Builder')
    expect(whoReacted(heart, ME, nameOf, true)).toBe('1 person')
    // never the key's text: a uid never shows
    expect(whoReacted(up, ME, nameOf, false)).not.toContain('usr_')
  })

  it('a long list is cut with a count', () => {
    const k = kit([])
    const nameOf = nameResolver(k.f.canvas, { id: ME, name: 'Mia Me' })
    const many = Array.from({ length: 12 }, (_, i) => `usr_many${String(i).padStart(8, '0')}`)
    const [n] = reacted('n', keys(...many.map((u) => ['up', u] as [ReactionCode, string])))
    const chip = reactionChipsOf(n, ME)[0]
    if (!chip) throw new Error('no chip')
    const line = whoReacted(chip, ME, nameOf, false)
    expect(line).toContain('and 4 more')
    expect(line.startsWith('Someone, Someone')).toBe(true)
  })
})

describe('writing a reaction (N3-2)', () => {
  it('the transact is skipUndo and writes only the person’s own key', () => {
    const k = kit([...reacted('n', keys(['up', BOB]))])
    expect(toggleReaction(k.f.canvas, 'n', 'up', ME)).toEqual({ ok: true, added: true, changed: 1 })
    expect(k.f.steps).toEqual(['reaction'])
    expect(k.f.options).toEqual([{ skipUndo: true }])
    const lobby = k.f.canvas.get('n')?.customData?.lobby
    expect(lobby).toEqual({ ...keys(['up', BOB]), [reactionKey('up', ME)]: true })
  })

  it('a toggle off writes null for the key, and keeps everyone else’s', () => {
    const k = kit([...reacted('n', keys(['up', ME], ['up', BOB]))])
    let patch: unknown
    const update = k.f.canvas.transact.bind(k.f.canvas)
    k.f.canvas.transact = ((label: string, fn: (tx: never) => unknown, opts?: never) =>
      update(
        label,
        (tx) =>
          fn({
            ...(tx as object),
            update: (id: string, p: unknown) => {
              patch = p
              return (tx as { update(i: string, p: unknown): void }).update(id, p)
            },
          } as never),
        opts,
      )) as typeof k.f.canvas.transact
    expect(toggleReaction(k.f.canvas, 'n', 'up', ME)).toEqual({ ok: true, added: false, changed: 1 })
    expect(patch).toEqual({ customData: { lobby: { [reactionKey('up', ME)]: null } } })
    expect(k.f.canvas.get('n')?.customData?.lobby).toEqual(keys(['up', BOB]))
    expect(k.f.options).toEqual([{ skipUndo: true }])
  })

  it('want makes it idempotent: no change is no write', () => {
    const k = kit([...reacted('n', keys(['up', ME]))])
    expect(toggleReaction(k.f.canvas, 'n', 'up', ME, true)).toEqual({ ok: true, added: true, changed: 0 })
    expect(toggleReaction(k.f.canvas, 'n', 'heart', ME, false)).toEqual({
      ok: true,
      added: false,
      changed: 0,
    })
    expect(k.f.steps).toEqual([])
  })

  it('several notes in ONE transact: on every note that lacks it, or off every note when all have it', () => {
    const k = kit([
      ...reacted('a', keys(['party', ME])),
      ...reacted('b', undefined),
      ...reacted('c', keys(['party', BOB])),
    ])
    expect(toggleReactions(k.f.canvas, ['a', 'b', 'c'], 'party', ME)).toMatchObject({
      added: true,
      changed: 2,
    })
    expect(k.f.steps).toEqual(['reaction'])
    for (const id of ['a', 'b', 'c'])
      expect(k.f.canvas.get(id)?.customData?.lobby?.[reactionKey('party', ME)]).toBe(true)
    expect(toggleReactions(k.f.canvas, ['a', 'b', 'c'], 'party', ME)).toMatchObject({
      added: false,
      changed: 3,
    })
    for (const id of ['a', 'b', 'c'])
      expect(k.f.canvas.get(id)?.customData?.lobby?.[reactionKey('party', ME)]).toBeUndefined()
    expect(k.f.options).toEqual([{ skipUndo: true }, { skipUndo: true }])
  })

  it('a tab that may not react writes nothing: a room below 13, a read-only canvas', () => {
    const k = kit([...reacted('n', keys(['up', BOB]))], { rev: 12 })
    expect(toggleReaction(k.f.canvas, 'n', 'up', ME)).toEqual({ ok: false, message: REACTIONS_NOT_YET_TEXT })
    k.setRev(13)
    k.f.readOnly = true
    expect(toggleReaction(k.f.canvas, 'n', 'up', ME).ok).toBe(false)
    expect(clearReactions(k.f.canvas, ['n']).ok).toBe(false)
    expect(k.f.steps).toEqual([])
  })

  it('a locked note takes it (the server lets the writer’s own key past the lock)', () => {
    const k = kit([...reacted('n', undefined, { locked: true })])
    expect(k.f.canvas.isLocked('n')).toBe(true)
    expect(toggleReaction(k.f.canvas, 'n', 'heart', ME)).toMatchObject({ ok: true, added: true })
  })

  it('at the cap the client does not write the key, and says the note is full', () => {
    const many = Array.from({ length: REACTIONS_MAX }, (_, i) => `usr_cap${String(i).padStart(9, '0')}`)
    const k = kit([...reacted('n', keys(...many.map((u) => ['up', u] as [ReactionCode, string])))])
    const [n] = reacted('n', keys(...many.map((u) => ['up', u] as [ReactionCode, string])))
    expect(reactionCountOf(n)).toBe(REACTIONS_MAX)
    expect(reactionPatch(n as CanvasElement, 'heart', ME, true)).toBe('full')
    // taking one back is still fine at the cap
    expect(reactionPatch(n as CanvasElement, 'up', many[0] as string, false)).toEqual({
      [reactionKey('up', many[0] as string)]: null,
    })
    const r = react(k.ctx, ['n'], 'heart')
    expect(r).toEqual({ ok: false, message: REACTIONS_FULL_TEXT })
    expect(k.notices.map((x) => x.text)).toEqual([REACTIONS_FULL_TEXT])
    expect(k.f.steps).toEqual([])
  })

  it('counts the add in the usage events (never the removal), and the clear', () => {
    const before = { ...pendingUsage() }
    const k = kit([...reacted('n', undefined)], { role: 'owner' })
    react(k.ctx, ['n'], 'laugh')
    react(k.ctx, ['n'], 'laugh') // off
    const after = pendingUsage()
    expect((after['reactions.add:laugh'] ?? 0) - (before['reactions.add:laugh'] ?? 0)).toBe(1)
    react(k.ctx, ['n'], 'clap')
    clear(k.ctx, ['n'])
    expect((pendingUsage()['reactions.clear'] ?? 0) - (before['reactions.clear'] ?? 0)).toBe(1)
  })
})

describe('Clear reactions (an owner, N2-4)', () => {
  it('removes every react key, anyone’s, and nothing else, in one skipUndo transact', () => {
    const k = kit(
      [
        ...reacted('n', {
          ...keys(['up', BOB], ['heart', CAL], ['clap', ME]),
          [`plusOne:${BOB}`]: true,
          'tag:x': 1,
        }),
      ],
      { role: 'owner' },
    )
    expect(canClearReactions(k.ctx)).toBe(true)
    expect(clearReactions(k.f.canvas, ['n'])).toEqual({ ok: true, changed: 1 })
    expect(k.f.canvas.get('n')?.customData?.lobby).toEqual({ [`plusOne:${BOB}`]: true, 'tag:x': 1 })
    expect(k.f.steps).toEqual(['clear reactions'])
    expect(k.f.options).toEqual([{ skipUndo: true }])
    // nothing left to clear: no write
    expect(clearReactions(k.f.canvas, ['n'])).toEqual({ ok: true, changed: 0 })
    expect(k.f.steps).toHaveLength(1)
  })

  it('only an owner is offered it (an editor, a room below 13: no)', () => {
    expect(canClearReactions(kit([], { role: 'owner' }).ctx)).toBe(true)
    expect(canClearReactions(kit([], { role: 'editor' }).ctx)).toBe(false)
    expect(canClearReactions(kit([], { role: 'owner', rev: 12 }).ctx)).toBe(false)
    expect(canClearReactions(kit([], { role: 'owner', readOnly: true }).ctx)).toBe(false)
  })
})

describe('a refusal is told once and the key returns to the server’s value (N3-2)', () => {
  /** A reaction written, its push gone up as seq 7. */
  function written(rev = 13) {
    const k = kit([...reacted('n', undefined)], { rev })
    const key = reactionKey('up', ME)
    expect(react(k.ctx, ['n'], 'up')).toMatchObject({ ok: true, added: true })
    expect(k.engine.listeners.size).toBe(1)
    k.engine.push(7, 'n', { [key]: true })
    return { k, key }
  }

  it('the kill switch: the second UNAVAILABLE puts the key back and shows the toast', () => {
    const { k, key } = written()
    expect(UNAVAILABLE_TWICE).toBe(2)
    k.engine.ack(7, [{ id: 'n', ok: false, code: 'UNAVAILABLE', el: null }])
    // the first one is a retry the engine makes (a commit failure is rarely repeated): nothing yet
    expect(k.notices).toEqual([])
    expect(k.f.canvas.get('n')?.customData?.lobby?.[key]).toBe(true)
    k.engine.push(8, 'n', { [key]: true })
    k.engine.ack(8, [{ id: 'n', ok: false, code: 'UNAVAILABLE', el: null }])
    expect(k.notices.map((n) => [n.text, n.testId, n.tone])).toEqual([
      [REACTIONS_OFF_TEXT, 'reaction-toast', 'error'],
    ])
    // the key is the server's again (it never had it), by one more skipUndo transact, the only write
    expect(k.f.canvas.get('n')?.customData?.lobby?.[key]).toBeUndefined()
    expect(k.f.options).toEqual([{ skipUndo: true }, { skipUndo: true }])
    // done: the watch is gone
    expect(k.engine.listeners.size).toBe(0)
  })

  it('a removal refused under the switch returns to the server’s value too: the key is back', () => {
    const k = kit([...reacted('n', keys(['up', ME]))])
    const key = reactionKey('up', ME)
    k.engine.stored.set('n', { customData: { lobby: { [key]: true } } })
    react(k.ctx, ['n'], 'up') // off
    expect(k.f.canvas.get('n')?.customData?.lobby?.[key]).toBeUndefined()
    for (const seq of [3, 4]) {
      k.engine.push(seq, 'n', { [key]: null })
      k.engine.ack(seq, [{ id: 'n', ok: false, code: 'UNAVAILABLE', el: null }])
    }
    expect(k.notices.map((n) => n.text)).toEqual([REACTIONS_OFF_TEXT])
    expect(k.f.canvas.get('n')?.customData?.lobby?.[key]).toBe(true)
  })

  it('TOO_LARGE: the toast says the note is full, nothing else is written (the engine restores the copy)', () => {
    const { k } = written()
    k.engine.ack(7, [{ id: 'n', ok: false, code: 'TOO_LARGE', el: null }])
    expect(k.notices.map((n) => n.text)).toEqual([REACTIONS_FULL_TEXT])
    expect(k.f.steps).toEqual(['reaction'])
    expect(k.engine.listeners.size).toBe(0)
  })

  it('an accepted write ends the watch: a later refusal of another push is not this reaction’s', () => {
    const { k } = written()
    k.engine.ack(7, [{ id: 'n', ok: true, v: 2 }])
    expect(k.engine.listeners.size).toBe(0)
    k.engine.push(9, 'n', { whatever: 1 })
    k.engine.ack(9, [{ id: 'n', ok: false, code: 'TOO_LARGE', el: null }])
    expect(k.notices).toEqual([])
  })

  it('a push that does not carry the key is not this reaction’s (another edit of the note, refused)', () => {
    const { k } = written()
    k.engine.push(8, 'n', { 'tag:x': 1 })
    k.engine.ack(8, [{ id: 'n', ok: false, code: 'TOO_LARGE', el: null }])
    k.engine.push(9, 'other', { [reactionKey('up', ME)]: true })
    k.engine.ack(9, [{ id: 'other', ok: false, code: 'TOO_LARGE', el: null }])
    expect(k.notices).toEqual([])
    expect(k.engine.listeners.size).toBe(1)
  })

  it('a denied group on an accepted op counts as the refusal (TOO_LARGE)', () => {
    const { k, key } = written()
    k.engine.ack(7, [{ id: 'n', ok: true, v: 2, denied: { groups: [`c:${key}`], code: 'TOO_LARGE' } }])
    expect(k.notices.map((n) => n.text)).toEqual([REACTIONS_FULL_TEXT])
  })

  it('RATE is the engine’s to retry: the watch goes on', () => {
    const { k } = written()
    k.engine.ack(7, [{ id: 'n', ok: false, code: 'RATE', el: null }])
    expect(k.notices).toEqual([])
    expect(k.engine.listeners.size).toBe(1)
  })

  it('a later write of the same note replaces the earlier watch; the stop and the timer end it', () => {
    const k = kit([...reacted('n', undefined)])
    const timers: (() => void)[] = []
    const stopA = watchReactionWrite(k.f.canvas, k.ctx.notify, 'n', [reactionKey('up', ME)], {
      setTimer: ((fn: () => void) => timers.push(fn)) as never,
      clearTimer: (() => {}) as never,
    })
    expect(k.engine.listeners.size).toBe(1)
    watchReactionWrite(k.f.canvas, k.ctx.notify, 'n', [reactionKey('heart', ME)])
    expect(k.engine.listeners.size).toBe(1) // A is gone, B stands
    stopA() // already stopped: harmless
    expect(k.engine.listeners.size).toBe(1)
    // the first one's timer, had it run, would not touch B
    timers[0]?.()
    expect(k.engine.listeners.size).toBe(1)
  })

  it('no engine (a page without sync), or nothing to watch: no watch', () => {
    const k = kit([...reacted('n', undefined)])
    ;(k.f.canvas as { engine: unknown }).engine = null
    expect(watchReactionWrite(k.f.canvas, k.ctx.notify, 'n', [reactionKey('up', ME)])).toBeTypeOf('function')
    expect(k.engine.listeners.size).toBe(0)
    ;(k.f.canvas as { engine: unknown }).engine = k.engine
    watchReactionWrite(k.f.canvas, k.ctx.notify, 'n', [])
    expect(k.engine.listeners.size).toBe(0)
  })
})

describe('the ways in open the one picker (N3-2)', () => {
  it('the command opens it for the selected notes; with {code} it reacts at once; it is disabled with a reason', () => {
    const k = kit([...reacted('a', undefined), ...reacted('b', undefined)])
    const cmd = (feature.commands ?? []).find((c) => c.id === REACTIONS_COMMAND_ID)
    if (!cmd) throw new Error('no command')
    k.f.selection = []
    expect(cmd.enabled?.(k.ctx)).toBe(false)
    expect(cmd.disabledReason?.(k.ctx)).toBe('Select a sticky note first')
    k.f.selection = ['a', 'b']
    expect(cmd.enabled?.(k.ctx)).toBe(true)
    expect(cmd.disabledReason?.(k.ctx)).toBeNull()
    void cmd.run(k.ctx, 'palette')
    const open = pickerOf(k.f.canvas).get()
    expect(open?.ids).toEqual(['a', 'b'])
    expect(open?.via).toBe('click')
    closeReactionPicker(k.f.canvas)
    expect(pickerOf(k.f.canvas).get()).toBeNull()
    void cmd.run(k.ctx, 'palette', { code: 'party' })
    expect(pickerOf(k.f.canvas).get()).toBeNull()
    for (const id of ['a', 'b'])
      expect(k.f.canvas.get(id)?.customData?.lobby?.[reactionKey('party', ME)]).toBe(true)
    // a room below 13, a viewer: disabled, with words
    k.setRev(12)
    expect(cmd.enabled?.(k.ctx)).toBe(false)
    expect(cmd.disabledReason?.(k.ctx)).toBe(REACTIONS_NOT_YET_TEXT)
    k.setRev(13)
    k.f.readOnly = true
    expect(cmd.disabledReason?.(k.ctx)).toBe('Only people who can edit this board can react')
    expect(cmd.readOnlyAllowed).toBeFalsy()
  })

  it('the selection bar item shows for a selected note when reacting is offered, and for nothing else', () => {
    const k = kit([...reacted('a', undefined), { id: 'r', type: 'rectangle' } as unknown as CanvasElement])
    const item = (feature.selectionBar ?? []).find((i) => i.id === REACTIONS_SELECTION_ITEM_ID)
    if (!item) throw new Error('no item')
    expect(item.visible?.(k.ctx, ['a'])).toBe(true)
    expect(item.visible?.(k.ctx, ['r'])).toBe(false)
    expect(item.visible?.(k.ctx, [])).toBe(false)
    k.setRev(12)
    expect(item.visible?.(k.ctx, ['a'])).toBe(false)
    k.setRev(13)
    k.f.readOnly = true
    expect(item.visible?.(k.ctx, ['a'])).toBe(false)
  })

  it('the context menu offers React… on a note and Clear reactions to an owner of a note that has some', () => {
    const owner = kit([...reacted('a', keys(['up', BOB])), ...reacted('b', undefined)], { role: 'owner' })
    const edit = kit([...reacted('a', keys(['up', BOB]))], { role: 'editor' })
    const menu = (id: string) => (feature.contextMenu ?? []).find((m) => m.id === id)
    const target = (ids: string[]) => ({ ids, point: null, hit: null })
    expect(menu('reactions-react')?.visible?.(owner.ctx, target(['a']))).toBe(true)
    expect(menu('reactions-react')?.visible?.(owner.ctx, target([]))).toBe(false)
    expect(menu('reactions-clear')?.visible?.(owner.ctx, target(['a']))).toBe(true)
    expect(menu('reactions-clear')?.visible?.(owner.ctx, target(['b']))).toBe(false)
    expect(menu('reactions-clear')?.visible?.(edit.ctx, target(['a']))).toBe(false)
    void menu('reactions-clear')?.run?.(owner.ctx, target(['a']))
    expect(owner.f.canvas.get('a')?.customData?.lobby).toEqual({})
    openReactionPicker(edit.f.canvas, ['a'], { via: 'hover' })
    expect(pickerOf(edit.f.canvas).get()?.via).toBe('hover')
    expect(openReactionPicker(edit.f.canvas, ['nope'])).toBe(false)
  })

  it('command args: only a known code counts', () => {
    expect(reactionArgs({ code: 'heart' })).toEqual({ code: 'heart' })
    for (const bad of [undefined, null, {}, { code: 'sparkle' }, { code: 5 }, '👍'])
      expect(reactionArgs(bad), String(bad)).toBeNull()
  })
})

describe('the layer, rendered (N3-1)', () => {
  const board = () => [
    ...reacted('loved', keys(['up', BOB], ['up', ME], ['heart', BOB])),
    ...reacted('plain', undefined, { x: 400 }),
    ...reacted('far', keys(['clap', BOB]), { x: 5000, y: 5000 }),
  ]

  it('shows the row of a note with reactions, in order, with counts, and who is mine', () => {
    const k = kit(board())
    const html = markup(k)
    expect(count(html, 'data-testid="note-reactions"')).toBe(1)
    expect(html).toContain('data-note-id="loved"')
    expect(html).not.toContain('data-note-id="plain"')
    expect(html).not.toContain('data-note-id="far"') // off screen
    const up = html.indexOf('data-code="up"')
    const heart = html.indexOf('data-code="heart"')
    expect(up).toBeGreaterThan(0)
    expect(heart).toBeGreaterThan(up)
    expect(html).toContain('aria-label="2 people reacted 👍, including you"')
    expect(html).toContain('aria-label="1 person reacted ❤️"')
    expect(html).toContain('aria-pressed="true"') // mine
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('data-testid="note-reaction-add"')
    expect(html).toContain('role="group"')
  })

  it('a room below 13 shows the stored row read-only: no picker, no add button, no pressed state', () => {
    const k = kit(board(), { rev: 12 })
    const html = markup(k)
    expect(count(html, 'data-testid="note-reaction"')).toBe(2)
    expect(html).toContain('data-readonly="true"')
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toContain('note-reaction-add')
    expect(html).not.toContain('aria-pressed')
    expect(html).toContain('aria-label="2 people reacted 👍, including you"')
  })

  it('a viewer sees the counts with no controls', () => {
    const k = kit(board(), { readOnly: true, role: 'viewer' })
    // even a hovered note without reactions gets nothing from a viewer
    k.setHovered('plain')
    const html = markup(k)
    expect(count(html, 'data-testid="note-reaction"')).toBe(2)
    expect(html).not.toContain('note-reaction-add')
    expect(html).not.toContain('data-note-id="plain"')
    expect(html).not.toContain('aria-pressed')
    expect(html).toContain('data-readonly="true"')
  })

  it('a hovered or selected note without reactions gets the add button (people who react)', () => {
    const k = kit(board())
    k.setHovered('plain')
    const html = markup(k)
    expect(html).toContain('data-note-id="plain"')
    expect(count(html, 'data-testid="note-reaction"')).toBe(2)
    expect(count(html, 'data-testid="note-reaction-add"')).toBe(2)
    const sel = kit(board())
    sel.f.selection = ['plain']
    const selHtml = markup(sel)
    expect(selHtml).toContain('data-note-id="plain"')
    // a selected note’s row sits above it, out of the selection bar’s way
    expect(selHtml).toContain('data-selected="true"')
    expect(selHtml).toContain('translateY(-100%)')
    // not offered where the room takes none
    sel.setRev(12)
    expect(markup(sel)).not.toContain('data-note-id="plain"')
  })

  it('a hidden note (a collapsed branch), a deleted note and a note too small on screen show nothing', () => {
    const k = kit(board())
    ;(k.f.canvas as { isHidden: (id: string) => boolean }).isHidden = (id) => id === 'loved'
    expect(markup(k)).toBe('')
    const gone = kit([...reacted('loved', keys(['up', BOB]), { isDeleted: true })])
    expect(markup(gone)).toBe('')
    const small = kit(board(), { zoom: 0.2 }) // a 200 px note is 40 px on screen
    expect(markup(small)).toBe('')
  })

  it('reads the notes through canvas.index and never walks the scene', () => {
    const k = kit(board())
    k.setHovered('plain')
    k.f.selection = ['loved']
    markup(k)
    expect(k.walks.items).toBe(0)
  })

  it('the hold hides everything, stored reactions included', () => {
    // the hold is a constant: the layer is the same component with it on; this pins the constant’s value and the gate
    expect(REACTIONS_UI).toBe(true)
    expect(reactionsOn(kit([]).f.canvas, false)).toBe(false)
  })

  it('a note being typed in has no row (its label’s edit is open)', () => {
    const k = kit(board())
    ;(k.f.canvas as { editingId: () => string | null }).editingId = () => 'loved-label'
    expect(markup(k)).toBe('')
  })
})

describe('the picker, rendered (N3-2, N3-3)', () => {
  const state = (ids: string[], via: 'hover' | 'focus' | 'click' = 'click') => ({
    ids,
    anchor: { x: 300, top: 100, bottom: 130 },
    via,
    seq: 1,
  })
  const picker = (
    k: Kit,
    ids: string[],
    o: { phone?: boolean; owner?: boolean; via?: 'hover' | 'focus' | 'click' } = {},
  ) =>
    renderToStaticMarkup(
      createElement(ReactionPicker, {
        ctx: k.ctx,
        state: state(ids, o.via),
        phone: o.phone ?? false,
        owner: o.owner ?? false,
        onPick: () => {},
        onClear: () => {},
        onClose: () => {},
        onEnter: () => {},
        onLeave: () => {},
      }),
    )

  it('six emoji buttons in the contract’s order, named in words, pressed for the ones I gave', () => {
    const k = kit([...reacted('n', keys(['heart', ME], ['up', BOB]))])
    const html = picker(k, ['n'])
    const codes = [...html.matchAll(/data-testid="note-reaction-option" data-code="([a-z]+)"/g)].map(
      (m) => m[1],
    )
    expect(codes).toEqual([...REACTION_CODES])
    for (const code of REACTION_CODES) expect(html).toContain(REACTION_CODE_EMOJI[code])
    expect(html).toContain('aria-label="Thumbs up"')
    expect(html).toMatch(/data-code="heart"[^>]*aria-pressed="true"/)
    expect(html).toMatch(/data-code="up"[^>]*aria-pressed="false"/)
    expect(html).toContain('role="group"')
    expect(html).toContain('React to Words')
    expect(html).not.toContain('dr-wk-nr-picker--sheet')
    expect(html).not.toContain('note-reactions-clear')
  })

  it('several notes: pressed only when every note has my reaction; the label counts them', () => {
    const k = kit([...reacted('a', keys(['heart', ME], ['up', ME])), ...reacted('b', keys(['up', ME]))])
    const html = picker(k, ['a', 'b'])
    expect(html).toMatch(/data-code="up"[^>]*aria-pressed="true"/)
    expect(html).toMatch(/data-code="heart"[^>]*aria-pressed="false"/)
    expect(html).toContain('React to 2 notes')
  })

  it('an owner gets Clear reactions when a note has some, nobody else does', () => {
    const k = kit([...reacted('n', keys(['up', BOB])), ...reacted('m', undefined)], { role: 'owner' })
    expect(picker(k, ['n'], { owner: true })).toContain('data-testid="note-reactions-clear"')
    expect(picker(k, ['n'], { owner: false })).not.toContain('note-reactions-clear')
    expect(picker(k, ['m'], { owner: true })).not.toContain('note-reactions-clear')
  })

  it('on a phone it is a sheet with a Close button (a finger has no hover); not on a desktop', () => {
    const k = kit([...reacted('n', undefined)])
    const phone = picker(k, ['n'], { phone: true })
    expect(phone).toContain('dr-wk-nr-picker--sheet')
    expect(phone).toContain('data-testid="reaction-picker-close"')
    expect(phone).not.toContain('left:') // placed by the sheet’s CSS, not by an anchor
    const desktop = picker(k, ['n'])
    expect(desktop).not.toContain('reaction-picker-close')
    expect(desktop).toContain('left:')
  })

  it('stays inside the canvas: left clamped, flipped above when there is no room below', () => {
    const k = kit([...reacted('n', undefined)])
    ;(k.f.canvas as { container: () => unknown }).container = () => ({
      getBoundingClientRect: () => ({ width: 500, height: 400, left: 0, top: 0 }),
    })
    const at = (anchor: { x: number; top: number; bottom: number }) =>
      renderToStaticMarkup(
        createElement(ReactionPicker, {
          ctx: k.ctx,
          state: { ids: ['n'], anchor, via: 'click', seq: 1 },
          phone: false,
          owner: false,
          onPick: () => {},
          onClear: () => {},
          onClose: () => {},
          onEnter: () => {},
          onLeave: () => {},
        }),
      )
    expect(at({ x: 0, top: 50, bottom: 80 })).toContain('left:8px')
    expect(at({ x: 500, top: 50, bottom: 80 })).toContain('left:248px') // 500 - 244 - 8
    expect(at({ x: 250, top: 50, bottom: 80 })).toContain('top:86px') // below
    expect(at({ x: 250, top: 340, bottom: 380 })).toContain('top:290px') // above: 340 - 6 - 44
  })
})
