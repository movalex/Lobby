import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { matchRoute, navigate, safeReturnTo, setLeaveGuard, signInPath, workspacePath } from './routing.ts'

const WS = 'wsp_0123456789abcdefghij'
const PRJ = 'prj_0123456789ABCDEFGHIJ'

describe('matchRoute', () => {
  it('maps the M1 routes', () => {
    expect(matchRoute('/')).toEqual({ name: 'root' })
    expect(matchRoute('/signin')).toEqual({ name: 'signin' })
    expect(matchRoute('/signin/')).toEqual({ name: 'signin' })
    expect(matchRoute(`/w/${WS}`)).toEqual({
      name: 'workspace',
      workspaceId: WS,
      section: { kind: 'recent' },
    })
    expect(matchRoute(`/w/${WS}/all`)).toEqual({
      name: 'workspace',
      workspaceId: WS,
      section: { kind: 'all' },
    })
    expect(matchRoute(`/w/${WS}/archived`)).toEqual({
      name: 'workspace',
      workspaceId: WS,
      section: { kind: 'archived' },
    })
    expect(matchRoute(`/w/${WS}/trash/`)).toEqual({
      name: 'workspace',
      workspaceId: WS,
      section: { kind: 'trash' },
    })
    expect(matchRoute(`/w/${WS}/p/${PRJ}`)).toEqual({
      name: 'workspace',
      workspaceId: WS,
      section: { kind: 'project', projectId: PRJ },
    })
    expect(matchRoute('/b/b-3k9x0q2m7a')).toEqual({ name: 'board', boardId: 'b-3k9x0q2m7a' })
    expect(matchRoute('/invite/AbC_-123xyz')).toEqual({ name: 'invite', token: 'AbC_-123xyz' })
  })

  it('wave W: maps /w/:wid/admin (the workspace admin page), and nothing deeper or on a malformed workspace id', () => {
    expect(matchRoute(`/w/${WS}/admin`)).toEqual({ name: 'workspace-admin', workspaceId: WS })
    expect(matchRoute(`/w/${WS}/admin/`)).toEqual({ name: 'workspace-admin', workspaceId: WS })
    for (const p of [`/w/${WS}/admin/audit`, '/w/wsp_x/admin', '/admin', `/w/${WS}/Admin`])
      expect(matchRoute(p), p).toEqual({ name: 'not-found' })
  })

  it('wave V: maps /j/:code (a join code as typed: the page reads it), and nothing longer or deeper', () => {
    expect(matchRoute('/j/ABCD-2345')).toEqual({ name: 'join', code: 'ABCD-2345' })
    expect(matchRoute('/j/abcd2345/')).toEqual({ name: 'join', code: 'abcd2345' })
    expect(matchRoute('/j/AB%20CD%202345')).toEqual({ name: 'join', code: 'AB CD 2345' })
    for (const p of ['/j', '/j/', `/j/${'x'.repeat(33)}`, '/j/ABCD-2345/x', '/j/%E0%A4%A'])
      expect(matchRoute(p), p).toEqual({ name: 'not-found' })
  })

  it('maps /feedback (the inbox; the api decides who may read it) and nothing under it', () => {
    expect(matchRoute('/feedback')).toEqual({ name: 'feedback' })
    expect(matchRoute('/feedback/')).toEqual({ name: 'feedback' })
    expect(matchRoute('/feedback/fbk_x')).toEqual({ name: 'not-found' })
    expect(matchRoute('/Feedback')).toEqual({ name: 'not-found' })
  })

  it('flags bad board ids instead of opening a room (mixed case would split rooms on NTFS)', () => {
    expect(matchRoute('/b/Board1')).toEqual({ name: 'invalid-board', raw: 'Board1' })
    expect(matchRoute('/b/%E0%A4%A').name).toBe('invalid-board')
    expect(matchRoute('/b/..%2Fetc').name).toBe('invalid-board')
  })

  it('P-019: an address that cannot be one of Lobby’s board ids is not a board to ask access to', () => {
    expect(matchRoute('/b/not-a-board')).toEqual({ name: 'invalid-board', raw: 'not-a-board' })
    expect(matchRoute('/b/abc')).toEqual({ name: 'invalid-board', raw: 'abc' })
    expect(matchRoute('/b/b-3k9x0q2m7a').name).toBe('board')
    // a well-formed id of a board that is gone cannot be told from one they lack access to: the api answers alike
    expect(matchRoute('/b/b-zzzzzzzzzz').name).toBe('board')
  })

  it('treats malformed workspace/project ids and unknown paths as not found', () => {
    for (const p of [
      '/w/not-a-workspace',
      `/w/${WS}/p/not-a-project`,
      `/w/${WS}/settings`,
      `/w/${WS}/p`,
      '/b/x/y',
      '/invite/',
      `/invite/${'x'.repeat(513)}`,
      '/dev-api/boards',
      '/settings',
    ]) {
      expect(matchRoute(p), p).toEqual({ name: 'not-found' })
    }
  })

  it('builds paths that route back to the same section', () => {
    for (const section of [
      { kind: 'recent' },
      { kind: 'all' },
      { kind: 'archived' },
      { kind: 'trash' },
      { kind: 'project', projectId: PRJ },
    ] as const) {
      expect(matchRoute(workspacePath(WS, section))).toEqual({ name: 'workspace', workspaceId: WS, section })
    }
  })
})

describe('safeReturnTo', () => {
  it('keeps same-origin paths with their query and hash', () => {
    expect(safeReturnTo('/b/b-3k9x0q2m7a')).toBe('/b/b-3k9x0q2m7a')
    expect(safeReturnTo(`/w/${WS}/all?x=1#top`)).toBe(`/w/${WS}/all?x=1#top`)
    expect(safeReturnTo('/invite/tok123')).toBe('/invite/tok123')
  })

  it('drops anything that could leave the site or loop back to sign-in', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'https://evil.example/b/x',
      '//evil.example/b/x',
      '/\\evil.example',
      '\\\\evil.example',
      'javascript:alert(1)',
      'b/relative',
      '/signin',
      '/signin?returnTo=/b/x',
      `/${'x'.repeat(3000)}`,
      // XSS-F2: protocol-relative only after normalising
      '/..//evil.example',
      '/..//evil.example/b/x?returnTo=1',
      '/a/..//evil.example',
      '/a/../..//evil.example',
      '/a\\..\\..//evil.example',
      '/.//evil.example',
    ]) {
      expect(safeReturnTo(bad), String(bad)).toBeNull()
    }
  })

  it('keeps a path that only looks like a dot segment', () => {
    expect(safeReturnTo('/b/..x/y')).toBe('/b/..x/y')
    expect(safeReturnTo('/w/ws_1/../all')).toBe('/w/all')
  })

  it('signInPath only carries a safe, non-root return path', () => {
    expect(signInPath('/b/b-3k9x0q2m7a')).toBe('/signin?returnTo=%2Fb%2Fb-3k9x0q2m7a')
    expect(signInPath('/')).toBe('/signin')
    expect(signInPath('//evil.example')).toBe('/signin')
    expect(signInPath(null)).toBe('/signin')
  })
})

describe('navigate with a leave guard', () => {
  // A minimal address bar: navigate() only reads location and writes history.
  let path = '/b/b-3k9x0q2m7a'
  const pushed: string[] = []
  beforeEach(() => {
    path = '/b/b-3k9x0q2m7a'
    pushed.length = 0
    vi.stubGlobal('location', {
      get pathname() {
        return new URL(path, 'http://x.invalid').pathname
      },
      get search() {
        return new URL(path, 'http://x.invalid').search
      },
      get hash() {
        return new URL(path, 'http://x.invalid').hash
      },
    })
    vi.stubGlobal('history', {
      pushState: (_s: unknown, _t: string, to: string) => {
        path = to
        pushed.push(to)
      },
      replaceState: (_s: unknown, _t: string, to: string) => {
        path = to
      },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('goes at once without a guard, or when the guard returns nothing', () => {
    navigate(`/w/${WS}`)
    expect(pushed).toEqual([`/w/${WS}`])
    const seen: string[] = []
    const off = setLeaveGuard((to) => {
      seen.push(to)
      return undefined
    })
    navigate(`/w/${WS}/all`)
    off()
    expect(seen).toEqual([`/w/${WS}/all`])
    expect(pushed).toEqual([`/w/${WS}`, `/w/${WS}/all`])
  })

  it('waits for the guard, and a later navigation supersedes one still waiting', async () => {
    const releases: Array<() => void> = []
    const off = setLeaveGuard(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve)
        }),
    )
    navigate(`/w/${WS}`)
    expect(pushed).toEqual([])
    navigate(`/w/${WS}/trash`)
    releases[0]?.()
    await Promise.resolve()
    expect(pushed).toEqual([]) // the first one was superseded
    releases[1]?.()
    await Promise.resolve()
    expect(pushed).toEqual([`/w/${WS}/trash`])
    off()
  })

  it('a stale remover does not remove a newer guard', async () => {
    const offOld = setLeaveGuard(() => undefined)
    let release = () => {}
    const offNew = setLeaveGuard(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    offOld()
    navigate(`/w/${WS}`)
    expect(pushed).toEqual([])
    release()
    await Promise.resolve()
    expect(pushed).toEqual([`/w/${WS}`])
    offNew()
    navigate(`/w/${WS}/all`)
    expect(pushed).toEqual([`/w/${WS}`, `/w/${WS}/all`])
  })
})
