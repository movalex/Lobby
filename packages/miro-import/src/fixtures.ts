/**
 * Fixture boards in the shapes Miro's REST API v2 documents for its answers (developers.miro.com reference: "Get
 * boards", "Get items on board", "Get connectors", "Get all groups", "Get tags from board", "Get items by tag",
 * "Get all board members", "Get access token context", "Get resource"), with synthetic ids, names and text. Used
 * by the converter's tests, the api's tests (a fake Miro over node:http) and the e2e fake Miro
 * (e2e/tests/support/miro.ts). Nothing here was copied from a real board.
 *
 * `SPRINT` holds every item type the API returns (and the cases the converter must handle: frames with children
 * and a frame inside a frame, rotation, every shape family, captions, every connector shape, a connector to an
 * item that is not on the board, an item without a position, groups that hold and one that spans frames, tags);
 * `RETRO` is a small second board; `EMPTY` has nothing on it.
 */
import { deflateSync } from 'node:zlib'
import {
  fileRefOf,
  MIRO_SEED_FORMAT,
  type MiroConnector,
  type MiroFileOutcome,
  type MiroGroup,
  type MiroItem,
  type MiroSeedBody,
  type MiroTag,
  slimConnector,
  slimGroup,
  slimItem,
  slimTag,
} from './sources.ts'

export interface FixtureBoard {
  readonly id: string
  readonly name: string
  readonly modifiedAt: string
  readonly items: readonly Record<string, unknown>[]
  readonly connectors: readonly Record<string, unknown>[]
  readonly groups: readonly Record<string, unknown>[]
  readonly tags: readonly Record<string, unknown>[]
  /** tag id → item ids (what `GET …/items?tag_id=` answers) */
  readonly tagItems: Readonly<Record<string, readonly string[]>>
  readonly members: readonly Record<string, unknown>[]
}

export const FIXTURE_TEAM = { type: 'team', name: 'Fixture team', id: '3458764500000000001' }

/** `GET /v1/oauth-token`'s answer for a good token. */
export const FIXTURE_TOKEN_CONTEXT = {
  type: 'oauth_token',
  team: FIXTURE_TEAM,
  createdBy: { type: 'user', name: 'Fixture Owner', id: '3074457350000000009' },
  scopes: ['boards:read'],
  organization: { type: 'organization', name: 'Fixture org', id: '3458764500000000002' },
  user: { type: 'user', name: 'Fixture Owner', id: '3074457350000000009' },
}

const API = 'https://api.miro.com/v2/boards'
const user = { id: '3074457350000000009', type: 'user' }
const stamp = {
  createdAt: '2026-09-01T10:00:00Z',
  createdBy: user,
  modifiedAt: '2026-09-02T11:00:00Z',
  modifiedBy: user,
}

let seq = 0
const nextId = (prefix: string) => `${prefix}${String(++seq).padStart(4, '0')}`

function item(
  boardId: string,
  type: string,
  fields: {
    id?: string
    data?: Record<string, unknown>
    style?: Record<string, unknown>
    geometry?: Record<string, unknown>
    position?: Record<string, unknown> | null
    parent?: string
  },
): Record<string, unknown> {
  const id = fields.id ?? nextId('345876451751')
  return {
    id,
    type,
    ...(fields.data ? { data: fields.data } : {}),
    ...(fields.style ? { style: fields.style } : {}),
    ...(fields.geometry ? { geometry: fields.geometry } : {}),
    ...(fields.position === null
      ? {}
      : {
          position: {
            origin: 'center',
            relativeTo: fields.parent ? 'parent_top_left' : 'canvas_center',
            ...(fields.position ?? { x: 0, y: 0 }),
          },
        }),
    ...(fields.parent
      ? { parent: { id: fields.parent, links: { self: `${API}/${boardId}/items/${fields.parent}` } } }
      : {}),
    ...stamp,
    links: { self: `${API}/${encodeURIComponent(boardId)}/items/${id}` },
  }
}

const resource = (boardId: string, kind: 'images' | 'documents', id: string, format = 'preview') =>
  `${API}/${boardId}/resources/${kind}/${id}?${kind === 'images' ? `format=${format}&` : ''}redirect=false`

const shapeStyle = (o: Record<string, unknown> = {}) => ({
  fillColor: '#ffffff',
  fillOpacity: '1.0',
  fontFamily: 'open_sans',
  fontSize: '14',
  borderColor: '#1a1a1a',
  borderWidth: '2.0',
  borderOpacity: '1.0',
  borderStyle: 'normal',
  textAlign: 'center',
  textAlignVertical: 'middle',
  color: '#1a1a1a',
  ...o,
})

export const SPRINT_ID = 'uXjVOfjkmAk='
export const RETRO_ID = 'uXjVPcbz1Zo='
export const EMPTY_ID = 'o9J_kzLmN0A='

/** Ids the tests refer to. */
export const SPRINT_IDS = {
  frame: '3458764517000000001',
  innerFrame: '3458764517000000002',
  noteHello: '3458764517000000010',
  notePink: '3458764517000000011',
  noteBlack: '3458764517000000012',
  noteInner: '3458764517000000013',
  rect: '3458764517000000020',
  round: '3458764517000000021',
  circle: '3458764517000000022',
  rhombus: '3458764517000000023',
  triangle: '3458764517000000024',
  star: '3458764517000000025',
  cloud: '3458764517000000026',
  oddShape: '3458764517000000027',
  title: '3458764517000000030',
  serif: '3458764517000000031',
  image: '3458764517000000040',
  imageAgain: '3458764517000000041',
  document: '3458764517000000042',
  card: '3458764517000000050',
  appCard: '3458764517000000051',
  embed: '3458764517000000052',
  preview: '3458764517000000053',
  doc: '3458764517000000054',
  table: '3458764517000000055',
  unknown: '3458764517000000056',
  cardNoPosition: '3458764517000000057',
  imageResource: '3458764518000000001',
  documentResource: '3458764518000000002',
  member: '3074457350000000001',
  tagUrgent: '3458764519000000001',
  tagResearch: '3458764519000000002',
  groupKept: '3458764520000000001',
  groupSpans: '3458764520000000002',
} as const

function sprint(): FixtureBoard {
  const b = SPRINT_ID
  const I = SPRINT_IDS
  const items = [
    item(b, 'frame', {
      id: I.frame,
      data: { format: 'custom', title: 'Sprint 42', type: 'freeform', showContent: true },
      style: { fillColor: '#ffffffff' },
      geometry: { width: 2000, height: 1200 },
      position: { x: 0, y: 0 },
    }),
    item(b, 'sticky_note', {
      id: I.noteHello,
      data: { content: '<p>Hello <strong>team</strong> &amp; friends</p>', shape: 'square' },
      style: { fillColor: 'light_yellow', textAlign: 'center', textAlignVertical: 'top' },
      geometry: { width: 199, height: 228 },
      position: { x: 200, y: 200 },
      parent: I.frame,
    }),
    item(b, 'sticky_note', {
      id: I.notePink,
      data: { content: '<p>Wide note</p><p>second line</p>', shape: 'rectangle' },
      style: { fillColor: 'pink', textAlign: 'left', textAlignVertical: 'middle' },
      geometry: { width: 350, height: 228 },
      position: { x: 600, y: 200 },
      parent: I.frame,
    }),
    item(b, 'shape', {
      id: I.rect,
      data: { content: '<p>Process</p>', shape: 'rectangle' },
      style: shapeStyle({ fillColor: '#e6e6e6' }),
      geometry: { width: 240, height: 120 },
      position: { x: 200, y: 600 },
      parent: I.frame,
    }),
    item(b, 'shape', {
      id: I.round,
      data: { content: '<p>Rounded</p>', shape: 'round_rectangle' },
      style: shapeStyle({ fillColor: '#fff9b1', borderStyle: 'dashed' }),
      geometry: { width: 240, height: 120 },
      position: { x: 600, y: 600 },
      parent: I.frame,
    }),
    item(b, 'shape', {
      id: I.circle,
      data: { content: '<p>Circle</p>', shape: 'circle' },
      style: shapeStyle({ fillColor: '#a6ccf5', fillOpacity: '0.5' }),
      geometry: { width: 160, height: 160 },
      position: { x: 1000, y: 600 },
      parent: I.frame,
    }),
    item(b, 'frame', {
      id: I.innerFrame,
      data: { format: 'custom', title: 'Inner area', type: 'freeform', showContent: true },
      style: { fillColor: '#f5f6f8' },
      geometry: { width: 500, height: 400 },
      position: { x: 1600, y: 800 },
      parent: I.frame,
    }),
    item(b, 'sticky_note', {
      id: I.noteInner,
      data: { content: '<p>Inside the inner frame</p>', shape: 'square' },
      style: { fillColor: 'cyan' },
      geometry: { width: 199, height: 228 },
      position: { x: 250, y: 200 },
      parent: I.innerFrame,
    }),
    item(b, 'sticky_note', {
      id: I.noteBlack,
      data: { content: 'Plain words, no markup', shape: 'square' },
      style: { fillColor: 'black', textAlign: 'center', textAlignVertical: 'middle' },
      geometry: { width: 199, height: 228 },
      position: { x: -1400, y: -200 },
    }),
    item(b, 'shape', {
      id: I.rhombus,
      data: { content: '<p>Decide?</p>', shape: 'rhombus' },
      style: shapeStyle(),
      geometry: { width: 200, height: 140 },
      position: { x: -1400, y: 300 },
    }),
    item(b, 'shape', {
      id: I.triangle,
      data: { content: '<p>Up</p>', shape: 'triangle' },
      style: shapeStyle({ fillColor: '#93d275' }),
      geometry: { width: 180, height: 160 },
      position: { x: -1100, y: 300 },
    }),
    item(b, 'shape', {
      id: I.star,
      data: { content: '', shape: 'star' },
      style: shapeStyle({ fillColor: '#f5d128' }),
      geometry: { width: 160, height: 160, rotation: 15 },
      position: { x: -800, y: 300 },
    }),
    item(b, 'shape', {
      id: I.cloud,
      data: { content: '<p>Cloud</p>', shape: 'cloud' },
      style: shapeStyle(),
      geometry: { width: 220, height: 140 },
      position: { x: -500, y: 300 },
    }),
    item(b, 'shape', {
      id: I.oddShape,
      data: { content: '<p>Odd</p>', shape: 'flow_chart_future_shape' },
      style: shapeStyle(),
      geometry: { width: 160, height: 100 },
      position: { x: -200, y: 300 },
    }),
    item(b, 'text', {
      id: I.title,
      data: { content: '<p>Board title</p><p>See <a href="https://example.com/brief">the brief</a></p>' },
      style: {
        color: '#1a1a1a',
        fillColor: 'transparent',
        fillOpacity: '1.0',
        fontFamily: 'open_sans',
        fontSize: '36',
        textAlign: 'left',
      },
      geometry: { width: 520, rotation: 0 },
      position: { x: -1100, y: -700 },
    }),
    item(b, 'text', {
      id: I.serif,
      data: { content: '<p>Set in a serif face</p>' },
      style: { color: '#e03131', fontFamily: 'georgia', fontSize: '20', textAlign: 'center' },
      geometry: { width: 300 },
      position: { x: -1100, y: -550 },
    }),
    item(b, 'image', {
      id: I.image,
      data: {
        imageUrl: resource(b, 'images', I.imageResource),
        title: 'diagram.png',
        altText: 'A small diagram',
      },
      geometry: { width: 320, height: 240 },
      position: { x: 1400, y: -300 },
    }),
    item(b, 'image', {
      id: I.imageAgain,
      data: { imageUrl: resource(b, 'images', I.imageResource), title: 'diagram.png' },
      geometry: { width: 160, height: 120, rotation: -10 },
      position: { x: 1800, y: -300 },
    }),
    item(b, 'document', {
      id: I.document,
      data: { documentUrl: resource(b, 'documents', I.documentResource), title: 'brief.pdf' },
      geometry: { width: 200, height: 260 },
      position: { x: 2100, y: -300 },
    }),
    item(b, 'card', {
      id: I.card,
      data: {
        title: '<p>Ship the importer</p>',
        description: 'Cards keep their words',
        dueDate: '2026-10-20T22:00:00Z',
        assigneeId: I.member,
      },
      style: { cardTheme: '#2d9bf0' },
      geometry: { width: 320, height: 160 },
      position: { x: 1400, y: 300 },
    }),
    item(b, 'app_card', {
      id: I.appCard,
      data: {
        title: 'Ticket LOB-12',
        description: 'From another app',
        status: 'disconnected',
        fields: [
          {
            value: 'High',
            fillColor: '#ffcee0',
            iconShape: 'round',
            textColor: '#1a1a1a',
            tooltip: 'Priority',
          },
          { value: 'Backend', fillColor: '#a6ccf5', iconShape: 'square', textColor: '#1a1a1a' },
        ],
      },
      style: { fillColor: '#2d9bf0' },
      geometry: { width: 320, height: 200 },
      position: { x: 1800, y: 300 },
    }),
    item(b, 'embed', {
      id: I.embed,
      data: {
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        mode: 'inline',
        providerName: 'YouTube',
        title: 'A video',
        html: '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>',
        previewUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        contentType: 'video',
      },
      geometry: { width: 480, height: 270 },
      position: { x: 1400, y: 800 },
    }),
    item(b, 'preview', {
      id: I.preview,
      data: { url: 'https://example.com/article' },
      geometry: { width: 400, height: 120 },
      position: { x: 1900, y: 800 },
    }),
    item(b, 'doc_format', {
      id: I.doc,
      data: { contentType: 'markdown', content: '# A doc' },
      geometry: { width: 400, height: 300 },
      position: { x: 1400, y: 1300 },
    }),
    item(b, 'data_table_format', {
      id: I.table,
      geometry: { width: 400, height: 300 },
      position: { x: 1900, y: 1300 },
    }),
    item(b, 'unknown', {
      id: I.unknown,
      geometry: { width: 200, height: 100 },
      position: { x: 2400, y: 1300 },
    }),
    item(b, 'card', {
      id: I.cardNoPosition,
      data: { title: 'A card on a kanban', description: '' },
      style: { cardTheme: '#f16c7f' },
      position: null,
    }),
  ]
  const connectors = [
    {
      id: '3458764521000000001',
      type: 'connector',
      shape: 'straight',
      startItem: { id: I.noteHello, position: { x: '100%', y: '50%' }, snapTo: 'right' },
      endItem: { id: I.notePink, position: { x: '0%', y: '50%' }, snapTo: 'left' },
      captions: [{ content: '<p>next</p>', position: '50%', textAlignVertical: 'middle' }],
      style: {
        color: '#1a1a1a',
        endStrokeCap: 'stealth',
        startStrokeCap: 'none',
        fontSize: '14',
        strokeColor: '#1a1a1a',
        strokeStyle: 'normal',
        strokeWidth: '2.0',
        textOrientation: 'horizontal',
      },
      isSupported: true,
      ...stamp,
    },
    {
      id: '3458764521000000002',
      type: 'connector',
      shape: 'elbowed',
      startItem: { id: I.rect },
      endItem: { id: I.round },
      captions: [
        { content: '<p>first</p>', position: '30%' },
        { content: '<p>second</p>', position: '70%' },
      ],
      style: {
        startStrokeCap: 'filled_diamond',
        endStrokeCap: 'erd_many',
        strokeColor: '#4262ff',
        strokeWidth: '3.0',
      },
      isSupported: true,
      ...stamp,
    },
    {
      id: '3458764521000000003',
      type: 'connector',
      shape: 'curved',
      startItem: { id: I.round },
      endItem: { id: I.circle },
      style: { endStrokeCap: 'arrow', strokeStyle: 'dashed' },
      ...stamp,
    },
    {
      id: '3458764521000000004',
      type: 'connector',
      shape: 'straight',
      startItem: { id: I.noteBlack },
      endItem: { id: I.rhombus },
      isSupported: false,
      ...stamp,
    },
    {
      id: '3458764521000000005',
      type: 'connector',
      shape: 'straight',
      startItem: { id: I.rhombus },
      endItem: { id: '3458764599999999999' },
      ...stamp,
    },
    {
      id: '3458764521000000006',
      type: 'connector',
      shape: 'straight',
      startItem: { id: I.triangle, position: { x: '50%', y: '0%' } },
      endItem: { id: I.title },
      style: { startStrokeCap: 'oval', endStrokeCap: 'some_new_cap' },
      ...stamp,
    },
  ]
  const groups = [
    { id: I.groupKept, type: 'group', data: { items: [I.rect, I.round] } },
    { id: I.groupSpans, type: 'group', data: { items: [I.circle, I.noteBlack] } },
  ]
  const tags = [
    { id: I.tagUrgent, type: 'tag', title: 'Urgent', fillColor: 'red' },
    { id: I.tagResearch, type: 'tag', title: '#Research', fillColor: 'cyan' },
  ]
  return {
    id: b,
    name: 'Sprint planning',
    modifiedAt: '2026-10-10T09:00:00Z',
    items,
    connectors,
    groups,
    tags,
    tagItems: { [I.tagUrgent]: [I.noteHello, I.card], [I.tagResearch]: [I.notePink] },
    members: [{ id: I.member, name: 'Ana Lima', role: 'editor', type: 'board_member' }],
  }
}

function retro(): FixtureBoard {
  const b = RETRO_ID
  const ids = ['3458764530000000001', '3458764530000000002', '3458764530000000003']
  const colors = ['light_green', 'orange', 'violet']
  const words = ['Went well', 'To improve', 'Ideas']
  return {
    id: b,
    name: 'Team retro',
    modifiedAt: '2026-10-09T09:00:00Z',
    items: ids.map((id, i) =>
      item(b, 'sticky_note', {
        id,
        data: { content: `<p>${words[i]}</p>`, shape: 'square' },
        style: { fillColor: colors[i] },
        geometry: { width: 199, height: 228 },
        position: { x: i * 260, y: 0 },
      }),
    ),
    connectors: [],
    groups: [],
    tags: [],
    tagItems: {},
    members: [],
  }
}

function empty(): FixtureBoard {
  return {
    id: EMPTY_ID,
    name: 'Empty board',
    modifiedAt: '2026-10-01T09:00:00Z',
    items: [],
    connectors: [],
    groups: [],
    tags: [],
    tagItems: {},
    members: [],
  }
}

/** The fixture boards (fresh copies), in "last modified" order. */
export function fixtureBoards(): FixtureBoard[] {
  return [sprint(), retro(), empty()]
}

/** A board as `GET /v2/boards` lists it (the documented fields; links are Miro's own). */
export function boardSummary(board: FixtureBoard): Record<string, unknown> {
  return {
    id: board.id,
    type: 'board',
    name: board.name,
    description: '',
    links: {
      self: `${API}/${encodeURIComponent(board.id)}`,
      related: `${API}/${encodeURIComponent(board.id)}/members`,
    },
    createdAt: '2026-08-01T09:00:00Z',
    createdBy: user,
    modifiedAt: board.modifiedAt,
    modifiedBy: user,
    owner: user,
    team: FIXTURE_TEAM,
    viewLink: `https://miro.com/app/board/${board.id}/`,
  }
}

// ---- file bytes ----------------------------------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** A `w` by `h` PNG of one colour (with a darker border), made here: no binary fixture in the repo. */
export function fixturePng(w = 96, h = 64, rgb: readonly [number, number, number] = [66, 98, 255]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const rows: Buffer[] = []
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3)
    for (let x = 0; x < w; x++) {
      const edge = x < 3 || y < 3 || x >= w - 3 || y >= h - 3
      row[1 + x * 3] = edge ? rgb[0] >> 1 : rgb[0]
      row[2 + x * 3] = edge ? rgb[1] >> 1 : rgb[1]
      row[3 + x * 3] = edge ? rgb[2] >> 1 : rgb[2]
    }
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** A one-page PDF with a line of text (valid cross-reference table). */
export function fixturePdf(text = 'Fixture brief'): Buffer {
  const content = `BT /F1 24 Tf 72 720 Td (${text.replace(/[()\\]/g, '')}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [i, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(out))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  }
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

// ---- the seed body the api would send ------------------------------------------------------------------------------

/**
 * The `miro-v2` seed body for a fixture board, as the api builds it (slimmed items in Miro's order), with `files` by
 * item id (default: every image and document `file-not-imported-yet`, as while MIRO_DOWNLOAD_HOSTS is empty).
 */
export function fixtureSeedBody(
  board: FixtureBoard,
  files: Readonly<Record<string, MiroFileOutcome>> | null = null,
): MiroSeedBody {
  const items = board.items.map(slimItem).filter((i): i is MiroItem => i !== null)
  const outcome: Record<string, MiroFileOutcome> = {}
  for (const raw of board.items) {
    const ref = fileRefOf(raw, board.id)
    if (!ref) continue
    outcome[raw.id as string] = files?.[raw.id as string] ?? { failed: 'file-not-imported-yet' }
  }
  return {
    format: MIRO_SEED_FORMAT,
    board: { id: board.id, name: board.name },
    items,
    connectors: board.connectors.map(slimConnector).filter((c): c is MiroConnector => c !== null),
    groups: board.groups.map(slimGroup).filter((g): g is MiroGroup => g !== null),
    tags: board.tags.map(slimTag).filter((t): t is MiroTag => t !== null),
    tagItems: board.tagItems,
    members: Object.fromEntries(board.members.map((m) => [String(m.id), String(m.name)])),
    files: outcome,
  }
}
