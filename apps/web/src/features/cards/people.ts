// OWNER: WS4 (wave T; docs/WAVE-T-CONTRACTS.md §2, §3.2). The people a card may be assigned to: the board's members
// (`client.listMembers`: accounts with a role on the board; a name-only guest is never one), loaded when the cards
// feature mounts and again when the picker opens. Names for the chips come from the members, then the room's roster
// (someone present), then "Someone". The room decides who may be assigned (assignee-refs, fail closed); this list is
// what the picker offers. A person who later lost access stays named on the card ("No longer on this board").
import type { BoardMember } from '@draftroom/contracts'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { knownUserKind } from '../../invite/guest.tsx'
import { atom } from '../../lib/signals.ts'

export interface Person {
  readonly uid: string
  readonly name: string
  readonly handle: string | null
  readonly color: string
}

export type PeopleState = 'idle' | 'loading' | 'ready' | 'failed'

export class People {
  readonly list = atom<readonly Person[]>('cards.people', [])
  readonly state = atom<PeopleState>('cards.people-state', 'idle')
  private inFlight: Promise<void> | null = null

  private readonly load: () => Promise<readonly BoardMember[]>

  constructor(load: () => Promise<readonly BoardMember[]>) {
    this.load = load
  }

  /** Loads (or reloads) the members; a failure keeps the last list. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight
    if (this.state.get() !== 'ready') this.state.set('loading')
    this.inFlight = this.load()
      .then((members) => {
        const seen = new Set<string>()
        const out: Person[] = []
        for (const m of members) {
          if (seen.has(m.user.id)) continue
          seen.add(m.user.id)
          out.push({ uid: m.user.id, name: m.user.name, handle: m.user.handle, color: m.user.color })
        }
        out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        this.list.set(out)
        this.state.set('ready')
      })
      .catch(() => {
        if (this.state.get() !== 'ready') this.state.set('failed')
      })
      .finally(() => {
        this.inFlight = null
      })
    return this.inFlight
  }

  /** A member by uid (reactive). */
  member(uid: string): Person | null {
    return this.list.get().find((p) => p.uid === uid) ?? null
  }
}

export interface PersonView {
  readonly name: string
  readonly color: string | null
  /** the members list loaded and does not hold them */
  readonly gone: boolean
}

/** What a card says about its assignee `uid`: a member's name, else a present person's, else "Someone". */
export function personView(ctx: CanvasFeatureContext, people: People, uid: string): PersonView {
  const m = people.member(uid)
  if (m) return { name: m.name, color: m.color, gone: false }
  const ready = people.state.get() === 'ready'
  if (uid === ctx.me.user.id) return { name: ctx.me.user.name, color: ctx.me.user.color, gone: ready }
  const present = ctx.canvas.collaborators().find((r) => r.uid === uid)
  if (present) return { name: present.name, color: present.color, gone: ready }
  return { name: 'Someone', color: null, gone: ready }
}

/** Whether this person is a name-only guest (they may set statuses and dates, never assign anyone). */
export function isGuest(ctx: CanvasFeatureContext): boolean {
  if (knownUserKind(ctx.me.user.id) === 'guest') return true
  return ctx.canvas.collaborators().some((r) => r.uid === ctx.me.user.id && r.guest)
}
