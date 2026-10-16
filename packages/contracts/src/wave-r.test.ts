// The wave R foundation's contracts (docs/WAVE-R-CONTRACTS.md): import jobs, Miro import, chat hooks, board backups
// and design-file previews. OWNER: the lead (imports.ts) and WS1-WS4 after the foundation (their own files).
import { describe, expect, it } from 'vitest'
import {
  BACKUP_CREATOR_ROUTE_KEYS,
  BACKUP_ROUTE_KEYS,
  BoardBackupManifest,
  CHAT_HOOK_CREATOR_ROUTE_KEYS,
  CHAT_HOOK_KINDS,
  CHAT_HOOK_LIMITS,
  CHAT_HOOK_ROUTE_KEYS,
  ChatPrefsResponse,
  type ChatMessage,
  CreateChatHookInput,
  checkChatHookUrl,
  chatMessageSentence,
  DESIGN_FORMAT_ROWS,
  DESIGN_PREVIEW_CODES,
  DESIGN_PREVIEW_KINDS,
  DESIGN_PREVIEW_MESSAGES,
  designFormatOf,
  EMPTY_IMPORT_PROGRESS,
  IMPORT_CREATOR_ROUTE_KEYS,
  IMPORT_ERROR_CODE_PATTERN,
  IMPORT_ROUTE_KEYS,
  IMPORT_STATUSES,
  ImportBoardReport,
  ImportJobView,
  importJobPath,
  importJobStatus,
  importListPath,
  isBackupEntryName,
  ListMiroBoardsInput,
  MIRO_API_HOST,
  MIRO_API_PATH_PATTERNS,
  MIRO_CODE_MESSAGES,
  MIRO_CODES,
  MIRO_DOWNLOAD_HOSTS,
  MIRO_IMPORT_CREATOR_ROUTE_KEYS,
  MIRO_IMPORT_LIMITS,
  MIRO_IMPORT_ROUTE_KEYS,
  MIRO_ITEM_TYPES,
  MIRO_RESOURCE_PATH_PATTERN,
  NotificationKind,
  PatchChatHookInput,
  PutChatPrefsInput,
  parseMiroBoardLink,
  StartMiroImportInput,
  slackEscape,
  slackPayload,
  splitMiroToken,
  teamsEscape,
  teamsPayload,
} from './index.ts'

const IMP = 'imp_0123456789abcdefghij'
const IMB = 'imb_0123456789abcdefghij'
const W = 'wsp_0123456789abcdefghij'
const U = 'usr_0123456789abcdefghij'
const HOOK = 'chk_0123456789abcdefghij'
const SHA = 'a'.repeat(64)
const TOKEN = 'eyJtaXJvLm9yaWdpbiI6ImV1MDEifQ_SECRET-TOKEN-1234567890'

describe('import jobs', () => {
  it('a job view parses, with one board row in each status', () => {
    for (const status of IMPORT_STATUSES) {
      const view = {
        importId: IMP,
        workspaceId: W,
        projectId: null,
        source: 'miro',
        status,
        startedBy: { id: U, name: 'Ana' },
        createdAt: '2026-10-16T10:00:00.000Z',
        updatedAt: '2026-10-16T10:00:01.000Z',
        finishedAt: null,
        resumable: false,
        resumeNeedsToken: true,
        boards: [
          {
            id: IMB,
            sourceRef: 'uXjVOD1Ab2c=',
            title: 'Pitch wall',
            status,
            progress: EMPTY_IMPORT_PROGRESS,
            boardId: null,
            errorCode: status === 'failed' ? 'MIRO_UNAVAILABLE' : null,
            summary: null,
            finishedAt: null,
          },
        ],
      }
      expect(ImportJobView.safeParse(view).success, status).toBe(true)
    }
  })

  it('the job status follows its boards (running first, then waiting, then the worst ending)', () => {
    expect(importJobStatus(['done', 'running', 'failed'])).toBe('running')
    expect(importJobStatus(['done', 'queued'])).toBe('queued')
    expect(importJobStatus(['done', 'interrupted', 'paused'])).toBe('interrupted')
    expect(importJobStatus(['done', 'paused'])).toBe('paused')
    expect(importJobStatus(['done', 'failed', 'cancelled'])).toBe('failed')
    expect(importJobStatus(['done', 'cancelled'])).toBe('cancelled')
    expect(importJobStatus(['done', 'done'])).toBe('done')
  })

  it('error codes are upper-case words only (nothing a message or a token could fill)', () => {
    for (const code of ['MIRO_TOKEN_INVALID', 'IMPORT_BUSY', 'QUOTA_EXCEEDED', 'INTERNAL'])
      expect(IMPORT_ERROR_CODE_PATTERN.test(code), code).toBe(true)
    for (const bad of [TOKEN, 'miro said: no', 'A', `X${'Y'.repeat(64)}`, 'BAD CODE'])
      expect(IMPORT_ERROR_CODE_PATTERN.test(bad), bad).toBe(false)
  })

  it('a report holds counts, notes and rows; results and notes are closed vocabularies', () => {
    const report = {
      total: 3,
      counts: { native: 1, approximate: 1, placeholder: 1, failed: 0, skipped: 0 },
      byType: {
        sticky_note: { native: 1 },
        connector: { approximate: 1 },
        data_table_format: { placeholder: 1 },
      },
      notes: { 'curved-connector': 1 },
      rows: [
        { sourceId: '345', type: 'sticky_note', result: 'native', elementId: 'el1', note: null },
        {
          sourceId: '346',
          type: 'connector',
          result: 'approximate',
          elementId: 'el2',
          note: 'curved-connector',
        },
      ],
      rowsOmitted: 0,
    }
    expect(ImportBoardReport.safeParse(report).success).toBe(true)
    const badNote = { ...report, notes: { 'Has Spaces': 1 } }
    expect(ImportBoardReport.safeParse(badNote).success).toBe(false)
    const badResult = { ...report, rows: [{ ...report.rows[0], result: 'imported' }] }
    expect(ImportBoardReport.safeParse(badResult).success).toBe(false)
  })

  it('routes: the six job routes, resume is a creator’s, the paths are encoded', () => {
    expect(IMPORT_ROUTE_KEYS).toHaveLength(6)
    expect(IMPORT_CREATOR_ROUTE_KEYS).toEqual(['POST /api/imports/:id/resume'])
    expect(importJobPath(IMP)).toBe(`/api/imports/${IMP}`)
    expect(importListPath(W, true)).toBe(`/api/workspaces/${W}/imports?mine=1`)
    expect(importJobPath('a/b')).toBe('/api/imports/a%2Fb')
  })
})

describe('Miro import', () => {
  it('the token is taken out by hand: never a schema issue, never in the rest', () => {
    const body = { token: TOKEN, boards: [{ miroBoardId: 'uXjVOD1Ab2c=' }] }
    const { token, rest } = splitMiroToken(body)
    expect(token).toBe(TOKEN)
    expect(rest).toEqual({ boards: [{ miroBoardId: 'uXjVOD1Ab2c=' }] })
    expect(JSON.stringify(rest)).not.toContain(TOKEN)
    // a bad rest fails without the token anywhere in the issues
    const bad = StartMiroImportInput.safeParse({ ...rest, boards: [] })
    expect(bad.success).toBe(false)
    expect(JSON.stringify(bad.error)).not.toContain(TOKEN)
    // shapes that cannot be a token: null, and still never echoed
    const notTokens = ['short', 'has space in it 1234567', 'line\nbreak-12345678', 42, null, undefined]
    for (const t of notTokens) expect(splitMiroToken({ token: t }).token).toBeNull()
    for (const b of [null, 'text', [TOKEN], 5]) expect(splitMiroToken(b)).toEqual({ token: null, rest: {} })
    // the schemas themselves refuse a token key (the route must split it first)
    expect(StartMiroImportInput.safeParse(body).success).toBe(false)
    expect(ListMiroBoardsInput.safeParse({ token: TOKEN }).success).toBe(false)
  })

  it('a pasted board link gives its id; anything else gives null', () => {
    expect(parseMiroBoardLink('https://miro.com/app/board/uXjVOD1Ab2c=/')).toBe('uXjVOD1Ab2c=')
    const pasted = ' https://miro.com/app/board/uXjVOD1Ab2c=/?moveToWidget=1 '
    expect(parseMiroBoardLink(pasted)).toBe('uXjVOD1Ab2c=')
    expect(parseMiroBoardLink('https://eu.miro.com/app/board/uXjVOD1Ab2c%3D/')).toBe('uXjVOD1Ab2c=')
    for (const bad of [
      'http://miro.com/app/board/uXjVOD1Ab2c=/',
      'https://miro.com.evil.example/app/board/uXjVOD1Ab2c=/',
      'https://evilmiro.com/app/board/uXjVOD1Ab2c=/',
      'https://miro.com/app/dashboard/',
      'https://miro.com/app/board/%E0%A4%A/',
      'https://miro.com/app/board/a/b/',
      'not a url',
    ])
      expect(parseMiroBoardLink(bad), bad).toBeNull()
  })

  it('only api.miro.com read paths; files only from the probed hosts (none until the probe ran)', () => {
    expect(MIRO_API_HOST).toBe('api.miro.com')
    expect(MIRO_DOWNLOAD_HOSTS).toEqual([])
    const allowed = (p: string) => MIRO_API_PATH_PATTERNS.some((r) => r.test(p))
    for (const p of [
      '/v1/oauth-token',
      '/v2/boards',
      '/v2/boards/uXjVOD1Ab2c=',
      '/v2/boards/uXjVOD1Ab2c=/items',
      '/v2/boards/uXjVOD1Ab2c=/connectors',
      '/v2/boards/uXjVOD1Ab2c=/groups',
      '/v2/boards/uXjVOD1Ab2c=/tags',
      '/v2/boards/uXjVOD1Ab2c=/members',
      '/v2/boards/uXjVOD1Ab2c=/resources/images/3458764517517819000',
    ])
      expect(allowed(p), p).toBe(true)
    for (const p of [
      '/v1/boards',
      '/v2/boards/uXjVOD1Ab2c=/items/1',
      '/v2/boards/uXjVOD1Ab2c=/share',
      '/v2-experimental/boards/uXjVOD1Ab2c=/mindmap_nodes',
      '/v2/orgs/1',
      '/v2/boards/../v1/oauth-token',
      '/v2/boards/uXjVOD1Ab2c=/resources/images/../../x',
    ])
      expect(allowed(p), p).toBe(false)
    expect(MIRO_RESOURCE_PATH_PATTERN.test('/v2/boards/uXjVOD1Ab2c=/resources/documents/12')).toBe(true)
    expect(MIRO_RESOURCE_PATH_PATTERN.test('/v2/boards/uXjVOD1Ab2c=/items/12')).toBe(false)
  })

  it('a start names 1 to 50 distinct boards; every code has a message; every type is listed once', () => {
    const boards = (n: number) => Array.from({ length: n }, (_, i) => ({ miroBoardId: `board-${i}-id` }))
    expect(StartMiroImportInput.safeParse({ boards: boards(1) }).success).toBe(true)
    const most = boards(MIRO_IMPORT_LIMITS.boardsPerJob)
    expect(StartMiroImportInput.safeParse({ boards: most }).success).toBe(true)
    expect(StartMiroImportInput.safeParse({ boards: boards(51) }).success).toBe(false)
    expect(StartMiroImportInput.safeParse({ boards: [...boards(1), ...boards(1)] }).success).toBe(false)
    expect(StartMiroImportInput.safeParse({ boards: [{ miroBoardId: '../x' }] }).success).toBe(false)
    for (const code of Object.values(MIRO_CODES)) expect(MIRO_CODE_MESSAGES[code], code).toBeTruthy()
    expect(new Set(MIRO_ITEM_TYPES).size).toBe(MIRO_ITEM_TYPES.length)
    expect(MIRO_IMPORT_ROUTE_KEYS).toEqual(MIRO_IMPORT_CREATOR_ROUTE_KEYS)
  })
})

const SLACK = 'https://hooks.slack.com/services/T0001ABCD/B0002EFGH/abcdefGHIJKL1234mnopWXYZ'
const TEAMS =
  'https://default1234abcd.ab.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/0123456789abcdef0123456789abcdef/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=SIGabcdefghijklmnopqrstuvwxyz9876'

describe('chat hooks: the URL rules', () => {
  it('accepts a Slack incoming webhook and a Teams Workflows URL; hints keep only 4 characters', () => {
    const slack = checkChatHookUrl(SLACK)
    expect(slack).toMatchObject({ ok: true, provider: 'slack', hint: 'hooks.slack.com/…/•••WXYZ' })
    const teams = checkChatHookUrl(TEAMS)
    expect(teams).toMatchObject({ ok: true, provider: 'teams' })
    if (teams.ok) {
      expect(teams.hint).toBe('….environment.api.powerplatform.com/…/•••9876')
      expect(teams.hint).not.toContain('SIGabcdef')
    }
    // the host is lower-cased by the parser; an explicit :443 is the default port
    expect(checkChatHookUrl(SLACK.replace('hooks.slack.com', 'HOOKS.SLACK.COM')).ok).toBe(true)
    expect(checkChatHookUrl(SLACK.replace('hooks.slack.com', 'hooks.slack.com:443')).ok).toBe(true)
    // what a paste adds around it is trimmed
    expect(checkChatHookUrl(` ${SLACK}\n`).ok).toBe(true)
    // the declared provider must be the URL's
    expect(checkChatHookUrl(SLACK, 'teams').ok).toBe(false)
    expect(checkChatHookUrl(TEAMS, 'teams').ok).toBe(true)
  })

  it('refuses look-alikes, other ports, credentials, IP literals, punycode, paths and queries', () => {
    const bad = [
      SLACK.replace('https:', 'http:'),
      SLACK.replace('hooks.slack.com', 'hooks.slack.com.evil.com'),
      SLACK.replace('hooks.slack.com', 'hooks.slack.com@evil.example'),
      SLACK.replace('hooks.slack.com', 'evil.example#@hooks.slack.com'),
      SLACK.replace('hooks.slack.com', 'hooks.slack.com.'),
      SLACK.replace('hooks.slack.com', 'hooks.slack.com:8443'),
      SLACK.replace('hooks.slack.com', 'user:pass@hooks.slack.com'),
      SLACK.replace('hooks.slack.com', 'xn--hooks-slack-com-xyz'),
      SLACK.replace('hooks.slack.com', 'h00ks.slack.com'),
      SLACK.replace('hooks.slack.com', '52.0.0.1'),
      SLACK.replace('hooks.slack.com', '[::1]'),
      SLACK.replace('hooks.slack.com', '0x7f.1'),
      `${SLACK}?x=1`,
      `${SLACK}#frag`,
      SLACK.replace('/services/', '/triggers/'),
      'https://hooks.slack.com/services/T1/B1/../../x',
      `${SLACK} `.repeat(2),
      `${SLACK}\n${SLACK}`,
      'https://hooks.slack.com/services/t1/b1/abc',
      TEAMS.replace('.environment.api.powerplatform.com', '.environment.api.powerplatform.com.evil.example'),
      TEAMS.replace('&sig=', '&sig2='),
      `${TEAMS}&extra=1`,
      `${TEAMS}&sig=again`,
      TEAMS.replace('/invoke?', '/invoke/x?'),
      'javascript:alert(1)',
      `https://hooks.slack.com/services/T1/B1/${'a'.repeat(CHAT_HOOK_LIMITS.urlBytes)}`,
      42,
      null,
    ]
    for (const raw of bad) {
      const got = checkChatHookUrl(raw)
      expect(got.ok, String(raw)).toBe(false)
      if (!got.ok) {
        expect(got.code, String(raw)).toBe('CHAT_HOOK_URL_INVALID')
        // the refusal never repeats the URL
        if (typeof raw === 'string') expect(got.message).not.toContain(raw.slice(8, 40))
      }
    }
  })

  it('refuses the retired Microsoft hosts with a message that says what to use', () => {
    for (const raw of [
      'https://dbc.webhook.office.com/webhookb2/abc@def/IncomingWebhook/123/456',
      'https://outlook.office.com/webhook/abc',
      'https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x',
    ]) {
      const got = checkChatHookUrl(raw)
      expect(got.ok, raw).toBe(false)
      if (!got.ok) {
        expect(got.code).toBe('CHAT_HOOK_URL_RETIRED')
        expect(got.message).toMatch(/Workflows/)
      }
    }
  })
})

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  kind: 'mention',
  actor: 'Ana',
  target: 'Ben',
  boardTitle: 'Pitch wall',
  link: 'https://lobby.example/b/b-abc1234567?thread=thr_1',
  workspaceName: 'DBC Pitches',
  ...over,
})

describe('chat hooks: messages', () => {
  it('one sentence per kind; opt-in kinds are notification kinds (never resolved, access_granted)', () => {
    expect(chatMessageSentence(message())).toBe('Ana mentioned Ben on Pitch wall')
    expect(chatMessageSentence(message({ kind: 'reply' }))).toBe('Ana replied to Ben on Pitch wall')
    expect(chatMessageSentence(message({ kind: 'new_comment', actor: 'Client (guest)' }))).toBe(
      'Client (guest) commented on Pitch wall',
    )
    expect(chatMessageSentence(message({ kind: 'access_request', actor: 'Sam', role: 'editor' }))).toBe(
      'Sam asked for editor access to Pitch wall',
    )
    expect(chatMessageSentence(message({ kind: 'outsider_joined', actor: 'agency.com' }))).toBe(
      'Someone from @agency.com opened Pitch wall',
    )
    for (const k of CHAT_HOOK_KINDS) expect(NotificationKind.options).toContain(k)
    expect(CHAT_HOOK_KINDS).not.toContain('resolved')
    expect(CHAT_HOOK_KINDS).not.toContain('access_granted')
  })

  it('Slack: escaped text (no mention, no link injection), unfurling off, no snippet unless given', () => {
    const evil = message({ actor: '<!channel> *Ana*', boardTitle: '<https://evil.example|Pitch> & co' })
    const payload = slackPayload(evil)
    const json = JSON.stringify(payload)
    expect(payload.unfurl_links).toBe(false)
    expect(payload.unfurl_media).toBe(false)
    const section = (payload.blocks as { text?: { text: string } }[])[0]?.text?.text ?? ''
    expect(section).toContain('&lt;!channel&gt; *Ana*')
    expect(section).toContain('&lt;https://evil.example|Pitch&gt; &amp; co')
    expect(section).not.toContain('<!channel>')
    expect(section).toContain('<https://lobby.example/b/b-abc1234567?thread=thr_1|Open in Lobby>')
    // the fallback text (notifications, previews) is escaped too
    expect(payload.text).toBe(
      '&lt;!channel&gt; *Ana* mentioned Ben on &lt;https://evil.example|Pitch&gt; &amp; co',
    )
    expect(json).not.toContain('<!channel>')
    expect(slackEscape('a<b>&c')).toBe('a&lt;b&gt;&amp;c')
    expect(section).not.toContain('\n>')
    expect(slackPayload(message({ snippet: 'Looks good' })).blocks).toBeDefined()
    const blocks = slackPayload(message({ snippet: 'Looks good' })).blocks as { text?: { text: string } }[]
    expect(blocks[0]?.text?.text).toContain('\n>Looks good')
  })

  it('caps: a 1 MB title, bidi characters and a long snippet stay within the limits', () => {
    const huge = message({
      boardTitle: `Pitch‮wall${'x'.repeat(1_000_000)}`,
      actor: `A​na${'y'.repeat(500)}`,
      snippet: 'z'.repeat(10_000),
    })
    const sentence = chatMessageSentence(huge)
    expect(sentence).not.toMatch(/[‮​]/)
    const most = CHAT_HOOK_LIMITS.titleChars + CHAT_HOOK_LIMITS.nameInMessageChars * 2 + 40
    expect([...sentence].length).toBeLessThan(most)
    const slack = slackPayload(huge)
    const section = (slack.blocks as { text?: { text: string } }[])[0]?.text?.text ?? ''
    expect([...section].length).toBeLessThanOrEqual(CHAT_HOOK_LIMITS.slackSectionChars)
    expect(section).toContain(`>${'z'.repeat(CHAT_HOOK_LIMITS.snippetChars - 1)}…`)
    const teams = JSON.stringify(teamsPayload(huge))
    // UTF-8 bytes (this package has no TextEncoder type): each %XX of the encoding is one byte
    const bytes = encodeURIComponent(teams).replace(/%[0-9A-F]{2}/g, '_').length
    expect(bytes).toBeLessThan(CHAT_HOOK_LIMITS.teamsCardBytes)
  })

  it('Teams: an Adaptive Card 1.4 with escaped text and only Action.OpenUrl', () => {
    const card = teamsPayload(message({ actor: '*Ana* [x](https://evil.example)' })) as {
      attachments: { content: { version: string; body: { text: string }[]; actions: { type: string }[] } }[]
    }
    const content = card.attachments[0]?.content
    expect(content?.version).toBe('1.4')
    expect(content?.actions.map((a) => a.type)).toEqual(['Action.OpenUrl'])
    const sentence = '*Ana* [x](https://evil.example) mentioned Ben on Pitch wall'
    expect(content?.body[0]?.text).toBe(teamsEscape(sentence))
    expect(content?.body[0]?.text).toContain('\\*Ana\\* \\[x\\]\\(https://evil\\.example\\)')
  })

  it('requests: a hook needs a name, a provider and a URL string; prefs list each hook and kind once', () => {
    const hook = { name: '#lobby', provider: 'slack', url: SLACK }
    expect(CreateChatHookInput.safeParse(hook).success).toBe(true)
    expect(CreateChatHookInput.parse(hook).includeSnippets).toBe(false)
    expect(CreateChatHookInput.safeParse({ name: ' ​ ', provider: 'slack', url: SLACK }).success).toBe(false)
    expect(PatchChatHookInput.safeParse({}).success).toBe(false)
    expect(PatchChatHookInput.safeParse({ enabled: false }).success).toBe(false)
    const prefs = { workspaceId: W, prefs: [{ hookId: HOOK, kinds: ['mention', 'reply'] }] }
    expect(PutChatPrefsInput.safeParse(prefs).success).toBe(true)
    const twice = { ...prefs, prefs: [...prefs.prefs, ...prefs.prefs] }
    expect(PutChatPrefsInput.safeParse(twice).success).toBe(false)
    expect(
      PutChatPrefsInput.safeParse({ workspaceId: W, prefs: [{ hookId: HOOK, kinds: ['resolved'] }] }).success,
    ).toBe(false)
    expect(ChatPrefsResponse.safeParse({ hooks: [], prefs: [] }).success).toBe(true)
    expect(CHAT_HOOK_ROUTE_KEYS).toHaveLength(7)
    expect(CHAT_HOOK_CREATOR_ROUTE_KEYS).not.toContain('DELETE /api/workspaces/:wid/chat-hooks/:hid')
  })
})

describe('board backups', () => {
  const manifest = {
    format: 'lobby-backup',
    version: 1,
    createdAt: '2026-10-16T10:00:00.000Z',
    app: { contractsRev: 13, engineVersion: '0.18.0-1118751' },
    title: 'Pitch wall',
    counts: { elements: 12, files: 1 },
    board: { path: 'board.json', sha256: SHA, bytes: 1234 },
    files: [
      {
        path: `files/${SHA}`,
        versionId: 'ver_0123456789abcdefghij',
        assetId: 'ast_0123456789abcdefghij',
        name: 'photo.png',
        mimeType: 'image/png',
        kind: 'image',
        sizeBytes: 100,
        sha256: SHA,
      },
      {
        path: null,
        versionId: 'ver_1123456789abcdefghij',
        assetId: 'ast_1123456789abcdefghij',
        name: 'secret.pdf',
        mimeType: 'application/pdf',
        kind: 'pdf',
        sizeBytes: 100,
        sha256: 'b'.repeat(64),
        omitted: true,
      },
    ],
  }

  it('a manifest parses; its counts, paths and versions must agree', () => {
    expect(BoardBackupManifest.safeParse(manifest).success).toBe(true)
    const miscounted = { ...manifest, counts: { elements: 12, files: 2 } }
    expect(BoardBackupManifest.safeParse(miscounted).success).toBe(false)
    const wrongPath = { ...manifest, files: [{ ...manifest.files[0], path: `files/${'c'.repeat(64)}` }] }
    expect(BoardBackupManifest.safeParse(wrongPath).success).toBe(false)
    const files = [manifest.files[0], manifest.files[0]]
    const twice = { ...manifest, counts: { elements: 1, files: 2 }, files }
    expect(BoardBackupManifest.safeParse(twice).success).toBe(false)
    expect(BoardBackupManifest.safeParse({ ...manifest, extra: 1 }).success).toBe(false)
    expect(BoardBackupManifest.safeParse({ ...manifest, version: 2 }).success).toBe(false)
  })

  it('only three entry names exist', () => {
    for (const ok of ['manifest.json', 'board.json', `files/${SHA}`])
      expect(isBackupEntryName(ok), ok).toBe(true)
    for (const bad of [
      '../board.json',
      '/manifest.json',
      'files\\..\\x',
      `files/${SHA}/x`,
      `files/${SHA.toUpperCase()}`,
      'files/abc',
      'Board.json',
      'board.json\u0000',
      'thumbs/x.webp',
    ])
      expect(isBackupEntryName(bad), bad).toBe(false)
    expect(BACKUP_ROUTE_KEYS).toHaveLength(3)
    expect(BACKUP_CREATOR_ROUTE_KEYS).toEqual(['POST /api/workspaces/:wid/backups'])
  })
})

describe('design-file previews', () => {
  it('PSD, AI and TIFF are flattened pages, HEIC an attachment; every code has a message', () => {
    expect(DESIGN_FORMAT_ROWS.map((r) => r.kind)).toEqual([...DESIGN_PREVIEW_KINDS])
    expect(designFormatOf('application/octet-stream', 'Key art.PSD')?.kind).toBe('psd')
    expect(designFormatOf('image/vnd.adobe.photoshop', 'file')?.kind).toBe('psd')
    expect(designFormatOf('application/postscript', 'logo.ai')?.kind).toBe('ai')
    // PostScript without an .ai name is EPS: not a design preview
    expect(designFormatOf('application/postscript', 'logo.eps')).toBeNull()
    expect(designFormatOf('image/tiff', 'scan.tif')?.preview).toBe('pages')
    expect(designFormatOf('image/heic', 'IMG_0001.HEIC')?.preview).toBe('none')
    expect(designFormatOf('image/png', 'photo.png')).toBeNull()
    for (const code of Object.values(DESIGN_PREVIEW_CODES))
      expect(DESIGN_PREVIEW_MESSAGES[code], code).toBeTruthy()
    for (const text of Object.values(DESIGN_PREVIEW_MESSAGES)) expect(text).not.toMatch(/editable/i)
  })
})
