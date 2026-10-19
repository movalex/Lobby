// Wave W (WS5, W5-3): every audit action has a view entry on the admin page, every writer goes through audit() (no
// module writes audit_events itself), and an entry's kinds never let a URL, an address or a token through.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUDIT_ACTIONS } from '../../../src/audit.ts'
import { AUDIT_VIEW, collectRefs, showDetail } from '../../../src/features/workspace-admin/audit-view.ts'

const SRC = join(import.meta.dirname, '../../../src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sourceFiles(p)
    return p.endsWith('.ts') ? [p] : []
  })
}

describe('the audit log viewer', () => {
  it('has an entry for every audit action, and none for an action that does not exist', () => {
    expect(Object.keys(AUDIT_VIEW).sort()).toEqual([...AUDIT_ACTIONS].sort())
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length)
    for (const a of AUDIT_ACTIONS) expect(a, a).toMatch(/^[a-z][a-z_.]*$/) // audit_events.action CHECK
  })

  it('only audit.ts writes audit_events (the three raw-SQL writers moved into the union)', () => {
    const writers = sourceFiles(SRC)
      .filter((f) => /INSERT\s+INTO\s+audit_events/i.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).replaceAll('\\', '/'))
    expect(writers).toEqual(['audit.ts'])
  })

  it('every action a module names in an audit() call is in the union', () => {
    // a literal `action: '…'` next to an audit( call; the type checker holds the rest (boards.ts's board.${action})
    const named = new Set<string>()
    for (const f of sourceFiles(SRC)) {
      const text = readFileSync(f, 'utf8')
      for (const m of text.matchAll(/audit\(\s*\w+,\s*\{[^}]*?action:\s*'([a-z_.]+)'/gs))
        named.add(m[1] ?? '')
    }
    expect(named.size).toBeGreaterThan(20)
    for (const a of named) expect(AUDIT_ACTIONS as readonly string[], a).toContain(a)
  })

  it('shows only allowlisted keys, each through its kind; names and titles replace ids', () => {
    const names = new Map([['usr_0123456789abcdefghij', 'Dana']])
    const titles = new Map([['b-client', 'Client board']])
    const refs = { users: new Set<string>(), boards: new Set<string>() }
    const detail = {
      userId: 'usr_0123456789abcdefghij',
      role: 'editor',
      previousRole: 'https://evil.example',
      via: 'someone@client.example',
      requestId: 'not an id',
      userIds: ['usr_a', 'usr_b', 'usr_c'],
      extra: 'never shown',
    }
    collectRefs('board.member.put', detail, refs)
    expect([...refs.users]).toEqual(['usr_0123456789abcdefghij'])
    expect(showDetail('board.member.put', detail, names, titles)).toEqual({
      userId: 'Dana',
      role: 'editor',
      userIds: 3,
    })
    expect(
      showDetail(
        'invitation.extend',
        { boardId: 'b-client', from: '2026-10-01T00:00:00.000Z', to: 'soon' },
        names,
        titles,
      ),
    ).toEqual({
      boardId: 'Client board',
      from: '2026-10-01T00:00:00.000Z',
    })
    // a board of another workspace is not resolved; an unknown person is "Someone"
    expect(
      showDetail(
        'invitation.revoke',
        { boardId: 'b-elsewhere', userId: 'usr_9999999999abcdefghij' },
        names,
        titles,
      ),
    ).toEqual({
      boardId: 'A removed board',
      userId: 'Someone',
    })
    // an action this build does not know shows nothing; a non-object detail shows nothing
    expect(showDetail('future.action', { anything: 'x' }, names, titles)).toEqual({})
    expect(showDetail('board.create', ['x'], names, titles)).toEqual({})
    expect(showDetail('board.create', null, names, titles)).toEqual({})
  })

  it('no entry shows a string key that names a URL, an address, a token, a hint or a free-text name', () => {
    // numbers, booleans and counts cannot carry one (emailLocked is a yes or no; userIds only its length)
    for (const [action, entry] of Object.entries(AUDIT_VIEW))
      for (const [key, kind] of Object.entries(entry))
        if (kind !== 'number' && kind !== 'boolean' && kind !== 'count')
          expect(`${action}.${key}`).not.toMatch(/url|email|token|hint|secret|name|body|text|title/i)
  })
})
