/**
 * Limit samples (spike B contracts step C0; docs/EXCALIDRAW-MIGRATION.md §3.3–3.6, §6.1): a valid and
 * an invalid sample per element type, every limit of §3.5 with worst-case samples, the rounding rule,
 * links and `fileId`s, the customData classes' value schemas and budgets, doc keys and object refs.
 */
import { GUESTS_PER_LINK } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { checkLobbyData, LOBBY_KEY_SPECS, lobbyKeySpec, lobbyValueProblem } from './custom-data.ts'
import { canWriteDocKey, docValueProblem } from './doc.ts'
import { checkElement, ELEMENT_TYPES, REFUSED_ELEMENT_TYPES } from './elements.ts'
import {
  COORD_LIMIT,
  FILE_ID_PATTERN,
  GEOMETRY_TOLERANCE_PX,
  GUEST_BOARD_ITEM_CAP,
  GUEST_ITEM_CAP,
  GUEST_TAG_DEF_CAP,
  isAllowedLink,
  isLobbyFontFamily,
  jsonByteLength,
  LOBBY_FONT_FAMILIES,
  MAX_ELEMENT_BYTES,
  MAX_FREEDRAW_POINTS,
  MAX_ITEMS,
  MAX_LINEAR_POINTS,
  MAX_ORIGINAL_TEXT_CHARS,
  MAX_TAG_DEFS,
  PLUS_ONES_MAX,
  pdfPageOf,
  roundGeometry,
  stripLocalFileSuffix,
  versionIdOf,
} from './limits.ts'
import { fromShapeRef, toShapeRef } from './refs.ts'
import { SAMPLE_ELEMENTS as E } from './test-samples.ts'

// biome-ignore lint/suspicious/noExplicitAny: the engine's own element objects, built by its constructors
type Any = any
const code = (el: unknown) => {
  const r = checkElement(el)
  return r.ok ? 'ok' : r.code
}

describe('element schemas (§3.1, §3.5)', () => {
  it('a valid sample of every stored type passes', () => {
    const types = new Set(Object.values(E).map((e) => e.type))
    expect([...types].sort()).toEqual([...ELEMENT_TYPES].sort())
    for (const [name, el] of Object.entries(E)) expect(code(el), name).toBe('ok')
  })

  it('an invalid sample of every type is refused', () => {
    for (const [name, el] of Object.entries(E)) {
      expect(code({ ...el, surprise: true }), `${name} + unknown key`).toBe('INVALID')
      expect(code({ ...el, x: Number.NaN }), `${name} NaN`).toBe('INVALID')
      const { id: _, ...noId } = el as Any
      expect(code(noId), `${name} without id`).toBe('INVALID')
    }
    for (const t of REFUSED_ELEMENT_TYPES) expect(code({ ...E.rectangle, type: t }), t).toBe('INVALID')
  })

  it('fonts are 5, 6, 7 or 8 (F15; 7 Lilita One since CONTRACTS_REV 7, D3)', () => {
    for (const f of [5, 6, 7, 8]) expect(code({ ...E.text, fontFamily: f })).toBe('ok')
    expect([...LOBBY_FONT_FAMILIES]).toEqual([5, 6, 7, 8])
    for (const f of [5, 6, 7, 8]) expect(isLobbyFontFamily(f)).toBe(true)
    for (const f of [1, 2, 3, 4, 9, 10])
      expect(code({ ...E.text, fontFamily: f }), `family ${f}`).toBe('INVALID')
  })

  it('x, y, width and height within ±1e6 (F16)', () => {
    expect(code({ ...E.rectangle, x: COORD_LIMIT })).toBe('ok')
    expect(code({ ...E.rectangle, x: 2e6 })).toBe('INVALID')
    expect(code({ ...E.rectangle, width: -COORD_LIMIT - 1 })).toBe('INVALID')
  })

  it('point counts: 1,000 for lines and arrows, 2,500 for freedraw', () => {
    const pts = (n: number) => Array.from({ length: n }, (_, i) => [i % 97, Math.floor(i / 97)])
    expect(code({ ...E.line, points: pts(MAX_LINEAR_POINTS) })).toBe('ok')
    expect(code({ ...E.line, points: pts(MAX_LINEAR_POINTS + 1) })).toBe('INVALID')
    expect(code({ ...E.arrow, points: pts(MAX_LINEAR_POINTS + 1) })).toBe('INVALID')
    expect(code({ ...E.freedraw, points: pts(MAX_FREEDRAW_POINTS) })).toBe('ok')
    expect(code({ ...E.freedraw, points: pts(MAX_FREEDRAW_POINTS + 1) })).toBe('INVALID')
  })

  it('per-type byte limits hold their worst cases (text 144 KiB, freedraw 64 KiB, others 32 KiB)', () => {
    // two copies of 20,000 three-byte characters fit a text; a 20,001-character original does not
    const worst = 'あ'.repeat(MAX_ORIGINAL_TEXT_CHARS)
    const text = { ...E.text, text: worst, originalText: worst }
    expect(jsonByteLength(text)).toBeLessThan(MAX_ELEMENT_BYTES.text)
    expect(code(text)).toBe('ok')
    expect(code({ ...E.text, originalText: 'x'.repeat(MAX_ORIGINAL_TEXT_CHARS + 1) })).toBe('INVALID')
    // 2,500 rounded points with pressures fit a freedraw
    const pts = Array.from({ length: MAX_FREEDRAW_POINTS }, (_, i) => [123.45 + i, 678.9 - i])
    const draw = { ...E.freedraw, points: pts, pressures: pts.map(() => 0.55), simulatePressure: false }
    expect(code(draw)).toBe('ok')
    // 1,000 rounded arrow points fit 32 KiB; 1,000 unrounded ones do not (spike A16-static: 39.6 KB)
    const rounded = Array.from({ length: MAX_LINEAR_POINTS }, (_, i): [number, number] => [
      1234.56 + i,
      -987.65 - i,
    ])
    expect(code({ ...E.arrow, points: rounded })).toBe('ok')
    const raw = rounded.map(([x, y]) => [x + 0.123456789012, y - 0.987654321098])
    expect(code({ ...E.arrow, points: raw })).toBe('TOO_LARGE')
    // a rectangle over 32 KiB (a huge link is refused first; use the frame name budget instead)
    expect(code({ ...E.frame, name: 'n'.repeat(201) })).toBe('INVALID')
  })

  it('freedraw pressures match its points', () => {
    expect(code({ ...E.freedraw, pressures: [0.5] })).toBe('INVALID')
    expect(code({ ...E.freedraw, pressures: [0.5, 0.5, 0.5] })).toBe('ok')
  })

  it('links: http(s), mailto or Lobby-relative; never data:, javascript: or signed (F10)', () => {
    for (const l of ['https://example.com/a?b=1', 'http://x.test', 'mailto:a@b.test', '/b/board-1?el=a,b'])
      expect(isAllowedLink(l), l).toBe(true)
    for (const l of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'https://bucket.r2.cloudflarestorage.com/k?X-Amz-Signature=abc',
      'https://cdn.test/f?Signature=abc&Expires=1',
      // percent-encoded parameter names (V2, part-3 round)
      'https://x.example/k?X%2DAmz%2DSignature=abc',
      'https://x.example/k?%53ignature=abc',
      'https://x.example/k?X%252DAmz%252DCredential=abc',
      '/b/board-1?X%2DAmz%2DSignature=abc',
      '//evil.test/a',
      'ftp://x.test',
      `https://x.test/${'a'.repeat(2100)}`,
      'https://user:pw@x.test',
    ])
      expect(isAllowedLink(l), l).toBe(false)
    expect(isAllowedLink('https://example.com', { guest: true })).toBe(false)
    expect(isAllowedLink('/b/board-1', { guest: true })).toBe(true)
    expect(code({ ...E.rectangle, link: 'javascript:alert(1)' })).toBe('INVALID')
  })

  it('relative links are read normalised, absolute ones must spell their authority (XSS-F3, CONTRACTS_REV 9)', () => {
    // each of these was allowed at rev 8: a consumer that normalises the path first (a router,
    // safeReturnTo) lands on //evil.com, and the browser reads `https:evil.com` as https://evil.com/
    for (const l of [
      '/..//evil.com',
      '/a/..//evil.com',
      '/a\\..\\..//evil.com',
      '/\\evil.com',
      '/b/..\\..//evil.com',
      '/b/board-1\\x',
      'https:evil.com',
      'https:/evil.com',
      'HTTPS:\\\\evil.com',
      'http:evil.com/a',
      ' https://evil.com',
    ])
      expect(isAllowedLink(l), l).toBe(false)
    for (const l of [
      '/',
      '/b/board-1',
      '/b/board-1/../board-2',
      '/b/board-1//el',
      '/b/board-1?el=a,b#x',
      'https://example.com/a/..//b',
      'HTTPS://example.com',
    ])
      expect(isAllowedLink(l), l).toBe(true)
    expect(isAllowedLink('/..//evil.com', { guest: true })).toBe(false)
    expect(code({ ...E.rectangle, link: '/..//evil.com' })).toBe('INVALID')
    expect(code({ ...E.rectangle, link: 'https:evil.com' })).toBe('INVALID')
  })

  it('signed URLs fail closed: a malformed escape no longer hides an encoded name; GCS V4 names (V2 re-check, CONTRACTS_REV 7)', () => {
    // V2's re-check (P-N5): each of these was stored at rev 6, because decodeURIComponent threw
    for (const l of [
      'https://x.example/k?X%2DAmz%2DSignature=abc&z=%',
      'https://x.example/k?z=%E0%A4%A&X%2DAmz%2DSignature=abc',
      'https://x.example/k?X%2DAmz%2DCredential=abc&q=100%',
      'https://x.example/k?%58-Amz-Signature=abc&z=%zz',
      '/k?X%2DAmz%2DSignature=abc&z=%',
      'https://x.example/k?X-Goog-Signature=abc&X-Goog-Credential=c',
      'https://x.example/k?x-goog-credential=c',
      'https://x.example/k?X%2DGoog%2DSignature=abc&z=%',
      'https://x.example/k?X-Amz-Algorithm=AWS4-HMAC-SHA256',
      // still changing after four rounds of decoding: refused
      'https://x.example/k?a=%2525252525252541',
    ])
      expect(isAllowedLink(l), l).toBe(false)
    // ordinary links with percents, malformed or not, stay allowed
    for (const l of [
      'https://example.com/sale?off=100%',
      'https://example.com/a?q=caf%C3%A9&n=%zz',
      'https://example.com/a%20b?c=%25',
      '/b/board-1?el=a,b&q=%',
    ])
      expect(isAllowedLink(l), l).toBe(true)
  })

  it('fileId: a Lobby version id, or a placed PDF page (F9, §3.1)', () => {
    for (const f of ['ver_0123456789', 'ver_0123456789abcdef.p3', 'ver_0123456789.p9999'])
      expect(FILE_ID_PATTERN.test(f), f).toBe(true)
    for (const f of [
      'ver_short',
      'ast_0123456789',
      'blob:http://x/1',
      'data:image/png;base64,AA',
      'ver_0123456789.p0',
    ])
      expect(FILE_ID_PATTERN.test(f), f).toBe(false)
    expect(pdfPageOf('ver_0123456789.p12')).toBe(12)
    expect(versionIdOf('ver_0123456789.p12')).toBe('ver_0123456789')
    expect(stripLocalFileSuffix('ver_0123456789@thumb')).toBe('ver_0123456789')
    expect(code({ ...E.image, fileId: 'data:image/png;base64,AA' })).toBe('INVALID')
  })
})

describe('the rounding rule and the tolerance (revision 3.5)', () => {
  it('rounds points, pressures and fixed segments to 2 decimals; x, y only when unrotated', () => {
    const arrow = {
      ...E.arrow,
      x: 205.123456,
      y: 50.987654,
      points: [
        [0, 0],
        [300.004, 299.996],
      ],
    } as Any
    const r = roundGeometry(arrow)
    expect(r.x).toBe(205.12)
    expect(r.y).toBe(50.99)
    expect(r.points).toEqual([
      [0, 0],
      [300, 300],
    ])
    const rotated = roundGeometry({ ...arrow, angle: 0.6 })
    expect(rotated.x).toBe(205.123456)
    expect(rotated.y).toBe(50.987654)
    expect(rotated.points).toEqual([
      [0, 0],
      [300, 300],
    ])
    const elbow = roundGeometry({
      ...E.elbow,
      fixedSegments: [{ start: [50.004, 0], end: [50.004, 100.006], index: 2 }],
    } as Any)
    expect(elbow.fixedSegments).toEqual([{ start: [50, 0], end: [50, 100.01], index: 2 }])
    const draw = roundGeometry({ ...E.freedraw, points: [[1.234, 5.678]], pressures: [0.5555] } as Any)
    expect(draw.points).toEqual([[1.23, 5.68]])
    expect(draw.pressures).toEqual([0.56])
    expect(draw.x).toBe(0)
    const rect = { ...E.rectangle, x: 1.23456 } as Any
    expect(roundGeometry(rect)).toBe(rect)
    expect(GEOMETRY_TOLERANCE_PX).toBe(0.5)
  })
})

describe('customData classes (§3.3)', () => {
  it('every key the checks use has a spec with a class and a duplicate rule', () => {
    const names = LOBBY_KEY_SPECS.map((s) => s.name).sort()
    expect(names).toEqual(
      [
        'tag:',
        'plusOne:',
        'file',
        'pdfPage',
        'kind',
        'ai',
        'privateFrame',
        'mindmap',
        'mindmapEdge',
        'alt',
        'present',
        'prompt',
        'slot',
        'swatch',
      ].sort(),
    )
    expect(lobbyKeySpec('plusOne:usr_0123456789')?.class).toBe('identity-bound')
    expect(lobbyKeySpec('ai')?.class).toBe('create-only')
    expect(lobbyKeySpec('file')?.class).toBe('api-validated')
    expect(lobbyKeySpec('ai')?.duplicate).toBe('strip')
    expect(lobbyKeySpec('present')?.duplicate).toBe('strip-index')
    expect(lobbyKeySpec('whatever')).toBeNull()
  })

  it('a lock lets through only the writer’s own +1 and a frame’s present (CR-3F-2, CR-3b-4)', () => {
    const exempt = LOBBY_KEY_SPECS.filter((s) => s.lockExempt).map((s) => [s.name, s.lockExempt])
    expect(exempt.sort()).toEqual([
      ['plusOne:', 'own'],
      ['present', 'frame-account'],
    ])
    expect(lobbyKeySpec('plusOne:usr_0123456789')?.lockExempt).toBe('own')
    for (const k of ['tag:x', 'alt', 'file', 'kind', 'mindmap', 'prompt'])
      expect(lobbyKeySpec(k)?.lockExempt, k).toBeUndefined()
  })

  it('value schemas: tags as today, +1 as an epoch ms, file facts canonical, create-only stamps', () => {
    expect(lobbyValueProblem('tag:research', { name: 'research', color: 'blue' })).toBeNull()
    expect(lobbyValueProblem('tag:research', { name: 'Research', color: 'blue' })).toBeNull()
    expect(lobbyValueProblem('tag:other', { name: 'research', color: 'blue' })).not.toBeNull()
    expect(lobbyValueProblem('tag:research', { name: 'research', color: 'magenta' })).not.toBeNull()
    expect(lobbyValueProblem('plusOne:usr_0123456789', true)).toBeNull()
    expect(lobbyValueProblem('plusOne:usr_0123456789', 1_790_000_000_000)).not.toBeNull()
    expect(lobbyValueProblem(`plusOne:${'u'.repeat(61)}`, true)).not.toBeNull()
    expect(lobbyValueProblem('ai', { by: 'usr_0123456789', run: 'r1' })).toBeNull()
    expect(lobbyValueProblem('privateFrame', { session: 's1', by: 'usr_0123456789' })).toBeNull()
    expect(
      lobbyValueProblem('mindmap', { rootId: 'a', parentId: null, side: 'right', collapsed: true }),
    ).toBeNull()
    expect(
      lobbyValueProblem('mindmap', { rootId: 'shape:a b', parentId: null, side: 'right', collapsed: true }),
    ).not.toBeNull()
    expect(lobbyValueProblem('alt', 'x'.repeat(501))).not.toBeNull()
    expect(lobbyValueProblem('present', { index: 2 })).toBeNull()
  })

  it('present.mins (wave L, CONTRACTS_REV 12): whole minutes from 1 to 240, beside index and skip', () => {
    expect(lobbyValueProblem('present', { index: 2, skip: false, mins: 5 })).toBeNull()
    expect(lobbyValueProblem('present', { mins: 1 })).toBeNull()
    expect(lobbyValueProblem('present', { mins: 240 })).toBeNull()
    for (const mins of [0, 241, 1.5, -1, '5', null])
      expect(lobbyValueProblem('present', { index: 0, mins }), String(mins)).not.toBeNull()
    expect(lobbyValueProblem('present', { index: 0, minutes: 5 })).not.toBeNull() // still strict
    // the same key: the lock exemption and the duplicate rule are present's
    expect(lobbyKeySpec('present')).toMatchObject({ lockExempt: 'frame-account', duplicate: 'strip-index' })
    // the largest value fits the key's byte budget
    expect(checkLobbyData({ present: { index: 9_999_999, skip: false, mins: 240 } })).toEqual({ ok: true })
  })

  it('budgets: 200 +1s of 60-character uids within 16 KiB; 8 KiB for the rest; 10 tags', () => {
    const plus: Record<string, unknown> = {}
    for (let i = 0; i < PLUS_ONES_MAX; i++) plus[`plusOne:${`u${i}`.padEnd(60, 'x')}`] = true
    expect(checkLobbyData(plus)).toEqual({ ok: true })
    expect(checkLobbyData({ ...plus, [`plusOne:${'z'.repeat(60)}`]: true })).toMatchObject({
      ok: false,
      code: 'INVALID',
    })
    const tags: Record<string, unknown> = {}
    for (let i = 0; i < 11; i++) tags[`tag:t${i}`] = { name: `t${i}`, color: 'blue' }
    expect(checkLobbyData(tags)).toMatchObject({ ok: false, code: 'INVALID' })
    const big: Record<string, unknown> = { alt: 'あ'.repeat(500) }
    for (let i = 0; i < 10; i++)
      big[`tag:${'t'.repeat(20)}${i}`] = { name: `${'t'.repeat(20)}${i}`, color: 'blue' }
    expect(checkLobbyData(big)).toEqual({ ok: true })
    expect(checkLobbyData({ 'made-up': 1 })).toMatchObject({ ok: false, code: 'INVALID' })
    expect(code({ ...E.rectangle, customData: { other: {} } })).toBe('INVALID')
    expect(code({ ...E.rectangle, customData: { lobby: { 'plusOne:usr_1': 'x' } } })).toBe('INVALID')
    // the worst case of §3.5: 200 +1s of 60-character uids on one note
    expect(code({ ...E.stickynote, customData: { lobby: plus } })).toBe('ok')
  })
})

describe('the board document (§3.4) and object refs (§3.6)', () => {
  it('doc keys are validated per key; import is the server’s', () => {
    expect(docValueProblem('startView', { x: 0, y: 0, w: 10, h: 10 })).toBeNull()
    expect(docValueProblem('startView', { x: 0, y: 0, w: 10, h: 10, pageId: 'page:1' })).not.toBeNull()
    expect(docValueProblem('tagDef:research', { name: 'research', color: 'blue' })).toBeNull()
    expect(docValueProblem('tagDef:other', { name: 'research', color: 'blue' })).not.toBeNull()
    expect(docValueProblem('workshop', null)).toBeNull()
    expect(docValueProblem('drStartView', {})).not.toBeNull()
    expect(canWriteDocKey('import', 'owner')).toBe(false)
    expect(canWriteDocKey('startView', 'editor')).toBe(false)
    expect(canWriteDocKey('workshop', 'editor')).toBe(true)
    expect(canWriteDocKey('tagDef:x', 'commenter')).toBe(false)
  })

  it('a name-only guest writes the tag list only, as its role allows (CR-3D-5)', () => {
    const guest = { guest: true }
    expect(canWriteDocKey('tagDef:x', 'editor', guest)).toBe(true)
    expect(canWriteDocKey('tagDef:x', 'commenter', guest)).toBe(false)
    expect(canWriteDocKey('tagDef:x', 'viewer', guest)).toBe(false)
    for (const role of ['owner', 'editor'] as const) {
      expect(canWriteDocKey('workshop', role, guest), role).toBe(false)
      expect(canWriteDocKey('startView', role, guest), role).toBe(false)
      expect(canWriteDocKey('import', role, guest), role).toBe(false)
    }
    expect(canWriteDocKey('workshop', 'editor', { guest: false })).toBe(true)
    // the room's per-guest budget of tag-list keys, well inside the board's list
    expect(GUEST_TAG_DEF_CAP).toBe(10)
    expect(GUEST_TAG_DEF_CAP).toBeLessThan(MAX_TAG_DEFS)
  })

  it('every guest uid together has a board budget above one guest’s cap (CR-W5-FIX-3)', () => {
    // 200 guests a link x 30 items each, and still 30% of the board's item cap
    expect(GUEST_BOARD_ITEM_CAP).toBe(GUESTS_PER_LINK * 30)
    expect(GUEST_BOARD_ITEM_CAP).toBe(6_000)
    expect(GUEST_BOARD_ITEM_CAP).toBe(MAX_ITEMS * 0.3)
    expect(GUEST_BOARD_ITEM_CAP).toBeGreaterThan(GUEST_ITEM_CAP)
  })

  it('shape: refs map to element ids and back', () => {
    expect(toShapeRef('abc_1.t')).toBe('shape:abc_1.t')
    expect(fromShapeRef('shape:abc_1.t')).toBe('abc_1.t')
    expect(fromShapeRef('page:abc')).toBeNull()
    expect(fromShapeRef('shape:a,b')).toBeNull()
    expect(() => toShapeRef('a b')).toThrow()
  })
})
