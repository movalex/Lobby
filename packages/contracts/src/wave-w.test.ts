// The wave W foundation's contracts (docs/WAVE-W-CONTRACTS.md): the five kill switches, the worker ops protocol and its
// capabilities, the per-kind params and results, the browser routes and their rules, the limits, the additive
// SearchHit.file, the workspace admin shapes and the pending palette ids. The element kinds against the frozen readers
// are in packages/canvas-schema/src/wave-w-kinds.test.ts.
import { describe, expect, it } from 'vitest'
import {
  ACTIVE_WORKER_OP_STATUSES,
  ADMIN_LIMITS,
  ADMIN_RETENTION_FACT_IDS,
  ADMIN_ROUTE_KEYS,
  ADMIN_TABS,
  AdminAuditEvent,
  AdminAuditQuery,
  AdminRetentionFact,
  AuthConfig,
  adminPath,
  adminWebPath,
  claimableKinds,
  DECK_LIMITS,
  DOC_CARD_LIMITS,
  deckRenderRuns,
  deckSlideName,
  ExtractTextParams,
  FILE_OP_EVENT,
  FILE_TEXT_LIMITS,
  FileOpInput,
  FileOpState,
  FORMAT_ELEMENT_KINDS,
  FORMAT_GUEST_REFUSED_ROUTE_KEYS,
  FORMAT_ROUTE_KEYS,
  FORMAT_RULES,
  FORMAT_SWITCH_ENV,
  FORMAT_SWITCH_OP,
  FORMAT_SWITCHES,
  FORMAT_SWITCHES_OFF,
  FormatSwitches,
  fileHitObjectId,
  LOBBY_CLIENT_REV,
  noBackgroundName,
  opFailureCode,
  opKindOfCapability,
  PALETTE_COMMAND_IDS,
  PENDING_PALETTE_COMMAND_IDS,
  parseFileHitObjectId,
  REMOVE_BG_LIMITS,
  RemoveBgParams,
  RemoveBgResult,
  RenderPagesParams,
  SEARCH_HIT_KINDS,
  SEARCH_HITS_PER_BOARD,
  SearchHit,
  SearchResponse,
  WAVE_W_PALETTE_COMMAND_IDS,
  WORKER_CAPABILITIES,
  WORKER_OP_ERROR_CODES,
  WORKER_OP_KINDS,
  WORKER_OP_LIMITS,
  WORKER_OP_MESSAGES,
  WORKER_OP_PARAMS,
  WORKER_OP_RESULTS,
  WORKER_OP_ROUTES,
  WORKER_OP_SWITCH,
  WorkerOpClaimInput,
  WorkerOpCompleteInput,
  WorkerOpOutputInput,
  WorkerOpTextInput,
} from './index.ts'

const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => s.safeParse(v).success
const VER = 'ver_0123456789abcdefghij'
const OP = 'wop_0123456789abcdefghij'

describe('the wave W switches', () => {
  it('five api switches, each with its env name; AuthConfig.formats is optional (an older api sends none)', () => {
    expect([...FORMAT_SWITCHES]).toEqual([
      'docCards',
      'removeBackground',
      'fileSearch',
      'deckImport',
      'admin',
    ])
    expect(FORMAT_SWITCH_ENV).toEqual({
      docCards: 'DRAFTROOM_DOC_CARDS',
      removeBackground: 'DRAFTROOM_REMOVE_BACKGROUND',
      fileSearch: 'DRAFTROOM_FILE_SEARCH',
      deckImport: 'DRAFTROOM_DECK_IMPORT',
      admin: 'DRAFTROOM_WORKSPACE_ADMIN',
    })
    expect(Object.keys(FORMAT_SWITCHES_OFF).sort()).toEqual([...FORMAT_SWITCHES].sort())
    expect(Object.values(FORMAT_SWITCHES_OFF).every((v) => v === false)).toBe(true)
    expect(AuthConfig.parse({ providers: ['dev'] }).formats).toBeUndefined()
    const on = { docCards: true, removeBackground: false, fileSearch: false, deckImport: true, admin: true }
    expect(AuthConfig.parse({ providers: ['dev'], formats: on }).formats).toEqual(on)
    // not strict: a later switch is additive for this web
    expect(ok(FormatSwitches, { ...on, later: true })).toBe(true)
    expect(ok(FormatSwitches, { docCards: true })).toBe(false)
  })

  it('the three worker-backed switches each name one op kind, and each op kind its switch', () => {
    expect(FORMAT_SWITCH_OP).toEqual({
      removeBackground: 'remove-bg',
      fileSearch: 'extract-text',
      deckImport: 'render-pages',
    })
    for (const k of WORKER_OP_KINDS) expect(FORMAT_SWITCH_OP[WORKER_OP_SWITCH[k]]).toBe(k)
  })

  it('wave W adds no response enum value: LOBBY_CLIENT_REV stays 3, the hit kinds are unchanged', () => {
    expect(LOBBY_CLIENT_REV).toBe(3)
    expect([...SEARCH_HIT_KINDS]).toEqual([
      'note',
      'text',
      'shape',
      'arrow',
      'frame',
      'file',
      'image',
      'video',
      'other',
      'comment',
      'resolved-comment',
    ])
  })
})

describe('worker op capabilities', () => {
  it('one versioned capability per kind, each parsing back to its kind', () => {
    expect(WORKER_CAPABILITIES).toEqual({
      'remove-bg': 'remove-bg:u2netp@1',
      'extract-text': 'extract-text@1',
      'render-pages': 'render-pages@1',
    })
    for (const k of WORKER_OP_KINDS) expect(opKindOfCapability(WORKER_CAPABILITIES[k])).toBe(k)
  })

  it('anything else names no kind', () => {
    for (const c of [
      'remove-bg',
      'remove-bg@0',
      'Remove-bg@1',
      'previews@1',
      'remove-bg:@1',
      '',
      'x'.repeat(80),
    ])
      expect(opKindOfCapability(c), c).toBeNull()
    expect(opKindOfCapability('remove-bg:isnet@2')).toBe('remove-bg')
  })

  it('a worker is given only the kinds whose CURRENT capability it reports exactly', () => {
    expect(claimableKinds([])).toEqual([])
    expect(claimableKinds(['remove-bg:isnet@2', 'extract-text@1'])).toEqual(['extract-text'])
    expect(claimableKinds(Object.values(WORKER_CAPABILITIES))).toEqual([...WORKER_OP_KINDS])
  })

  it('a claim lists at most 16 well-formed capabilities', () => {
    expect(ok(WorkerOpClaimInput, { workerId: 'nas-1', capabilities: ['extract-text@1'] })).toBe(true)
    expect(ok(WorkerOpClaimInput, { workerId: 'nas-1', capabilities: ['bad cap'] })).toBe(false)
    const many = Array.from({ length: 17 }, (_, i) => `extract-text@${i + 1}`)
    expect(ok(WorkerOpClaimInput, { workerId: 'nas-1', capabilities: many })).toBe(false)
    expect(ok(WorkerOpClaimInput, { workerId: ' nas', capabilities: [] })).toBe(false)
  })
})

describe('worker op wire', () => {
  it('the routes live under /api/worker/ops/ (the preview routes do not change)', () => {
    for (const p of Object.values(WORKER_OP_ROUTES)) expect(p.startsWith('/api/worker/ops/')).toBe(true)
  })

  it('an output is a new original, or a page of the source with its page number', () => {
    const base = { workerId: 'w', attempt: 1, mimeType: 'image/png', width: 10, height: 10, bytes: 5 }
    expect(ok(WorkerOpOutputInput, { ...base, role: 'original' })).toBe(true)
    expect(ok(WorkerOpOutputInput, { ...base, role: 'original', page: 3 })).toBe(false)
    expect(ok(WorkerOpOutputInput, { ...base, role: 'page', page: 9 })).toBe(true)
    expect(ok(WorkerOpOutputInput, { ...base, role: 'page' })).toBe(false)
    expect(ok(WorkerOpOutputInput, { ...base, role: 'thumb' })).toBe(false)
    expect(
      ok(WorkerOpOutputInput, { ...base, role: 'original', bytes: WORKER_OP_LIMITS.maxOutputBytes + 1 }),
    ).toBe(false)
  })

  it('text comes in batches of at most 50 pages of at most 8,000 characters', () => {
    const page = (n: number) => ({ page: n, body: 'x' })
    expect(ok(WorkerOpTextInput, { workerId: 'w', attempt: 1, pages: [page(1)] })).toBe(true)
    expect(ok(WorkerOpTextInput, { workerId: 'w', attempt: 1, pages: [] })).toBe(false)
    const fifty = Array.from({ length: 51 }, (_, i) => page(i + 1))
    expect(ok(WorkerOpTextInput, { workerId: 'w', attempt: 1, pages: fifty })).toBe(false)
    const long = { page: 1, body: 'x'.repeat(FILE_TEXT_LIMITS.maxPageChars + 1) }
    expect(ok(WorkerOpTextInput, { workerId: 'w', attempt: 1, pages: [long] })).toBe(false)
    expect(ok(WorkerOpTextInput, { workerId: 'w', attempt: 1, pages: [page(301)] })).toBe(false)
  })

  it('complete names its outputs (at most 32) and a result object', () => {
    expect(WorkerOpCompleteInput.parse({ workerId: 'w', attempt: 1, result: {} }).outputs).toEqual([])
    const outs = Array.from({ length: 33 }, (_, i) => `wpo_${String(i).padStart(10, '0')}`)
    expect(ok(WorkerOpCompleteInput, { workerId: 'w', attempt: 1, outputs: outs, result: {} })).toBe(false)
  })

  it('params and results are strict per kind', () => {
    expect(Object.keys(WORKER_OP_PARAMS).sort()).toEqual([...WORKER_OP_KINDS].sort())
    expect(Object.keys(WORKER_OP_RESULTS).sort()).toEqual([...WORKER_OP_KINDS].sort())
    expect(ok(RemoveBgParams, {})).toBe(true)
    expect(ok(RemoveBgParams, { url: 'https://x' })).toBe(false)
    expect(ok(ExtractTextParams, { maxPages: 300 })).toBe(true)
    expect(ok(ExtractTextParams, { maxPages: 301 })).toBe(false)
    expect(ok(RenderPagesParams, { from: 9, to: 38 })).toBe(true)
    expect(ok(RenderPagesParams, { from: 9, to: 39 })).toBe(false)
    expect(ok(RenderPagesParams, { from: 10, to: 9 })).toBe(false)
    const sha = 'a'.repeat(64)
    expect(ok(RemoveBgResult, { sha256: sha, width: 4096, height: 10, bytes: 1 })).toBe(true)
    expect(ok(RemoveBgResult, { sha256: sha, width: 4097, height: 10, bytes: 1 })).toBe(false)
    // the largest params of each kind fit worker_ops.params (1 KiB)
    for (const p of [{}, { maxPages: 300 }, { from: 9970, to: 9999 }])
      expect(JSON.stringify(p).length).toBeLessThanOrEqual(WORKER_OP_LIMITS.paramsBytes)
  })

  it('every failure code has a fixed message; an unknown code becomes INTERNAL', () => {
    expect(Object.keys(WORKER_OP_MESSAGES).sort()).toEqual([...WORKER_OP_ERROR_CODES].sort())
    for (const m of Object.values(WORKER_OP_MESSAGES)) expect(m.length).toBeGreaterThan(5)
    expect(opFailureCode('REMOVE_BG_FAILED')).toBe('REMOVE_BG_FAILED')
    expect(opFailureCode('/tmp/x: segfault')).toBe('INTERNAL')
    expect(opFailureCode(null)).toBe('INTERNAL')
    expect([...ACTIVE_WORKER_OP_STATUSES]).toEqual(['queued', 'running'])
  })
})

describe('the browser routes', () => {
  it('four routes, each with its rule; the two that queue work refuse name-only guests', () => {
    expect(FORMAT_ROUTE_KEYS).toEqual({
      removeBackground: 'POST /api/files/:ver/remove-background',
      renderPages: 'POST /api/files/:ver/render-pages',
      opState: 'GET /api/file-ops/:op',
      opCancel: 'POST /api/file-ops/:op/cancel',
    })
    expect(Object.keys(FORMAT_RULES).sort()).toEqual(Object.keys(FORMAT_ROUTE_KEYS).sort())
    expect([...FORMAT_GUEST_REFUSED_ROUTE_KEYS]).toEqual([
      FORMAT_ROUTE_KEYS.removeBackground,
      FORMAT_ROUTE_KEYS.renderPages,
    ])
  })

  it('a request names its board, nothing else', () => {
    expect(ok(FileOpInput, { boardId: 'b-0123456789' })).toBe(true)
    expect(ok(FileOpInput, { boardId: 'b-0123456789', url: 'https://x' })).toBe(false)
    expect(ok(FileOpInput, {})).toBe(false)
  })

  it('an op state carries no person, path or URL', () => {
    const state = {
      id: OP,
      kind: 'remove-bg',
      status: 'done',
      boardId: 'b-0123456789',
      sourceVersionId: VER,
      resultVersionId: 'ver_abcdefghij0123456789',
      pagesReady: null,
      errorCode: null,
      message: null,
      createdAt: '2026-10-19T00:00:00.000Z',
      finishedAt: '2026-10-19T00:00:10.000Z',
    }
    expect(ok(FileOpState, state)).toBe(true)
    for (const k of Object.keys(FileOpState.shape)) expect(k).not.toMatch(/user|by|name|url|path|email/i)
    expect(FILE_OP_EVENT).toBe('file.op')
  })
})

describe('limits', () => {
  it('background removal: 25 MiB, 40 MP, a 12,000 px edge in; 4,096 px out; 256 MB and 45 s in the child', () => {
    expect(REMOVE_BG_LIMITS.maxInputBytes).toBe(25 * 1024 * 1024)
    expect(REMOVE_BG_LIMITS.maxInputPixels).toBe(40_000_000)
    expect(REMOVE_BG_LIMITS.maxInputEdge).toBe(12_000)
    expect(REMOVE_BG_LIMITS.maxOutputEdge).toBe(4_096)
    expect(REMOVE_BG_LIMITS.childHeapMb).toBe(256)
    expect(REMOVE_BG_LIMITS.childTimeoutMs).toBe(45_000)
    expect(REMOVE_BG_LIMITS.inputMimeTypes).toEqual(['image/png', 'image/jpeg', 'image/webp'])
  })

  it('the new version is named "<name> (no background).png" within 200 characters', () => {
    expect(noBackgroundName('Hero shot.jpg')).toBe('Hero shot (no background).png')
    expect(noBackgroundName('.png')).toBe('Image (no background).png')
    expect([...noBackgroundName(`${'é'.repeat(300)}.webp`)].length).toBe(200)
  })

  it('file text: 300 pages, 8,000 characters a page, 512 KiB a version; two file hits a board', () => {
    expect(FILE_TEXT_LIMITS.maxPages).toBe(300)
    expect(FILE_TEXT_LIMITS.maxPageChars).toBe(8_000)
    expect(FILE_TEXT_LIMITS.maxVersionBytes).toBe(512 * 1024)
    expect(FILE_TEXT_LIMITS.maxFileHitsPerBoard).toBeLessThan(SEARCH_HITS_PER_BOARD)
  })

  it('a deck renders pages 9..min(N, 100) in runs of at most 30', () => {
    expect(deckRenderRuns(8)).toEqual([])
    expect(deckRenderRuns(9)).toEqual([{ from: 9, to: 9 }])
    expect(deckRenderRuns(40)).toEqual([
      { from: 9, to: 38 },
      { from: 39, to: 40 },
    ])
    const big = deckRenderRuns(500)
    expect(big.at(-1)?.to).toBe(DECK_LIMITS.maxSlides)
    for (const r of big) expect(ok(RenderPagesParams, r)).toBe(true)
    // a whole deck's placement (a frame and an image per slide) fits one push
    expect(DECK_LIMITS.maxSlides * 2).toBeLessThanOrEqual(500)
  })

  it('a slide frame is "<n> · <first line>", or "Slide <n>"', () => {
    expect(deckSlideName(3, '  Our   plan\n')).toBe('3 · Our plan')
    expect(deckSlideName(4, '')).toBe('Slide 4')
    expect(deckSlideName(5, null)).toBe('Slide 5')
    expect([...deckSlideName(1, 'x'.repeat(100))].length).toBe(4 + 60)
  })

  it('a doc card holds the canvas text cap; search indexes its first 4,000 characters', () => {
    expect(DOC_CARD_LIMITS.maxChars).toBe(20_000)
    expect(DOC_CARD_LIMITS.searchIndexedChars).toBe(4_000)
  })
})

describe('elements and search', () => {
  it('the element kinds are short lowercase words (canvas-schema KindValue)', () => {
    expect(Object.values(FORMAT_ELEMENT_KINDS)).toEqual(['doc-card', 'deck-slide', 'deck-page'])
    for (const k of Object.values(FORMAT_ELEMENT_KINDS)) expect(k).toMatch(/^[a-z][a-z0-9-]{0,31}$/)
  })

  it('a file hit keeps kind file, adds an optional file part, and round-trips its objectId', () => {
    const id = fileHitObjectId(VER, 3)
    expect(parseFileHitObjectId(id)).toEqual({ versionId: VER, page: 3 })
    expect(parseFileHitObjectId('shape:abc')).toBeNull()
    expect(parseFileHitObjectId(`file:${VER}.p0`)).toBeNull()
    const hit = {
      kind: 'file',
      objectId: id,
      pageId: null,
      cutStart: false,
      cutEnd: true,
      snippet: [{ text: 'brief', hit: true }],
      file: { versionId: VER, page: 3, name: 'Brief.pdf' },
    }
    expect(SearchHit.parse(hit).file).toEqual(hit.file)
    const { file: _f, ...old } = hit
    expect(SearchHit.parse(old).file).toBeUndefined()
    const response = {
      terms: ['brief'],
      groups: [],
      totalBoards: 0,
      totalHits: 0,
      capped: false,
      pendingBoards: 0,
    }
    expect(ok(SearchResponse, response)).toBe(true)
  })
})

describe('the workspace admin page', () => {
  it('seven owner/admin routes under /api/workspaces/:wid/admin/', () => {
    for (const k of Object.values(ADMIN_ROUTE_KEYS))
      expect(k).toMatch(/^GET \/api\/workspaces\/:wid\/admin\//)
    expect(Object.keys(ADMIN_ROUTE_KEYS)).toHaveLength(7)
    expect(adminPath('wsp_0123456789', '/audit')).toBe('/api/workspaces/wsp_0123456789/admin/audit')
    expect(adminWebPath('wsp_0123456789')).toBe('/w/wsp_0123456789/admin')
    expect([...ADMIN_TABS]).toEqual(['members', 'storage', 'audit', 'links', 'retention'])
  })

  it('the audit page is at most 100 rows; its action is a free string and its detail scalars only', () => {
    expect(AdminAuditQuery.parse({ before: '42', limit: '100' })).toEqual({ before: 42, limit: 100 })
    expect(ok(AdminAuditQuery, { limit: ADMIN_LIMITS.pageSize + 1 })).toBe(false)
    expect(ok(AdminAuditQuery, { action: 'Board.Create' })).toBe(false)
    const ev = {
      id: 1,
      at: '2026-10-19T00:00:00Z',
      action: 'later.action',
      actor: null,
      board: null,
      detail: {},
    }
    expect(ok(AdminAuditEvent, ev)).toBe(true)
    expect(ok(AdminAuditEvent, { ...ev, detail: { nested: { a: 1 } } })).toBe(false)
    expect(ok(AdminAuditEvent, { ...ev, detail: { long: 'x'.repeat(201) } })).toBe(false)
  })

  it('retention is facts only, with stable ids', () => {
    for (const id of ADMIN_RETENTION_FACT_IDS)
      expect(ok(AdminRetentionFact, { id, label: 'L', value: 'V', source: 'code' }), id).toBe(true)
    expect(ADMIN_RETENTION_FACT_IDS).toContain('trash')
  })
})

describe('palette ids', () => {
  it('five wave W commands, known to the usage list and pending until their owners register them', () => {
    expect([...WAVE_W_PALETTE_COMMAND_IDS]).toEqual([
      'doc-card.insert',
      'doc-card.from-text',
      'image.remove-background',
      'deck.insert-slides',
      'workspace.admin',
    ])
    for (const id of WAVE_W_PALETTE_COMMAND_IDS) {
      expect(PALETTE_COMMAND_IDS as readonly string[], id).toContain(id)
      expect(PENDING_PALETTE_COMMAND_IDS as readonly string[], id).toContain(id)
    }
  })
})
