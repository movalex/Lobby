// REVIEW-6 (wave D6): the name from an `access.changed` event is kept only while it can be about the change the
// role toast announces. The server sends the event after every PUT or DELETE of my grant, a no-op PUT included,
// and sends nothing for a change of the workspace role or the board's visibility; before, a name held from a
// no-op stayed 60 s and went onto the toast of a later change that someone else made.
import { describe, expect, it } from 'vitest'
import { ACCESS_ACTOR_FRESH_MS, AccessActorHint, roleChangeNotice } from './access.ts'

const event = (name: string) => ({ actor: { name } })

/** The toast the page puts up when my role goes `before` -> `after` at `now`, as LobbyBoardPage does. */
function toast(
  hint: AccessActorHint,
  before: 'owner' | 'editor' | 'commenter' | 'viewer',
  after: typeof before,
  now: number,
) {
  const text = roleChangeNotice(before, after, hint.fresh(now))
  if (text) hint.clear()
  return text
}

describe('AccessActorHint', () => {
  it('holds the name of an access.changed event for the toast that follows (a real lowering)', () => {
    const hint = new AccessActorHint()
    hint.record(event('Bob Owner'), 1_000)
    // the read after the event says my role is lower than the page shows: the change is real, the name stays
    hint.settle(hint.mark, 'editor', 'commenter')
    expect(toast(hint, 'editor', 'commenter', 2_000)).toBe(
      'Your access changed to Can comment (changed by Bob Owner)',
    )
    // and it is used once
    expect(toast(hint, 'commenter', 'viewer', 3_000)).toBe('Your access changed to Can view')
  })

  it('a raise keeps the name too: the role on screen waits for the socket to reconnect with it', () => {
    const hint = new AccessActorHint()
    hint.record(event('Bob Owner'), 1_000)
    hint.settle(hint.mark, 'viewer', 'editor')
    expect(toast(hint, 'viewer', 'editor', 9_000)).toBe('You can edit this board now (changed by Bob Owner)')
  })

  it('a no-op change is ignored: the read agrees with the page, so the name is dropped and names nobody later', () => {
    const hint = new AccessActorHint()
    // an owner sets my grant to what it already was: the event comes, nothing changes
    hint.record(event('Alice Admin'), 1_000)
    hint.settle(hint.mark, 'editor', 'editor')
    expect(hint.fresh(1_001)).toBeNull()
    // thirty seconds later my role drops for a reason that sent no event (the workspace role): no name
    expect(toast(hint, 'editor', 'viewer', 31_000)).toBe('Your access changed to Can view')
  })

  it('before, the same sequence put the owner’s name on the later toast (no settling: the 60 s window)', () => {
    const hint = new AccessActorHint()
    hint.record(event('Alice Admin'), 1_000)
    // nothing settles it: this is how the page behaved
    expect(toast(hint, 'editor', 'viewer', 31_000)).toBe(
      'Your access changed to Can view (changed by Alice Admin)',
    )
  })

  it('a hint that arrived after the read started is kept: the read may not have seen its change', () => {
    const hint = new AccessActorHint()
    hint.record(event('Alice Admin'), 1_000)
    const upTo = hint.mark
    // the read goes out, and a second event arrives before it comes back
    hint.record(event('Bob Owner'), 1_050)
    hint.settle(upTo, 'editor', 'editor')
    expect(hint.fresh(1_100)).toBe('Bob Owner')
    // the read that started after it settles it
    hint.settle(hint.mark, 'editor', 'editor')
    expect(hint.fresh(1_100)).toBeNull()
  })

  it('an event with no name clears an older one: whoever acted before is not who acted now', () => {
    const hint = new AccessActorHint()
    hint.record(event('Bob Owner'), 1_000)
    hint.record({}, 1_100)
    expect(hint.fresh(1_200)).toBeNull()
    hint.record(event('Bob Owner'), 1_300)
    hint.record(null, 1_400)
    expect(hint.fresh(1_500)).toBeNull()
  })

  it('a newer event’s name replaces the older one', () => {
    const hint = new AccessActorHint()
    hint.record(event('Alice Admin'), 1_000)
    hint.record(event('Bob Owner'), 2_000)
    expect(hint.fresh(2_500)).toBe('Bob Owner')
  })

  it('a name is only fresh for ACCESS_ACTOR_FRESH_MS', () => {
    const hint = new AccessActorHint()
    hint.record(event('Bob Owner'), 1_000)
    expect(hint.fresh(1_000 + ACCESS_ACTOR_FRESH_MS)).toBe('Bob Owner')
    expect(hint.fresh(1_001 + ACCESS_ACTOR_FRESH_MS)).toBeNull()
  })

  it('settling with nothing held does nothing, and nothing unreadable is a name', () => {
    const hint = new AccessActorHint()
    hint.settle(0, 'editor', 'editor')
    expect(hint.fresh(0)).toBeNull()
    for (const bad of [undefined, 'Bob', { actor: { name: 7 } }, { actor: { name: '  ' } }]) {
      hint.record(bad, 10)
      expect(hint.fresh(11)).toBeNull()
    }
  })

  it('a role that changes without an event is not named by an earlier one that was settled', () => {
    const hint = new AccessActorHint()
    hint.record(event('Alice Admin'), 1_000)
    hint.settle(hint.mark, 'owner', 'owner')
    // an admin demoted to a member: owner -> editor, no access.changed event
    expect(toast(hint, 'owner', 'editor', 2_000)).toBe('Your access changed to Can edit')
  })
})
