// The Pieces catalogue (wave L, L8-3): the shape kits, as data. No engine in it: the Pieces panel searches and
// lists from this, and loads the builders (./index.ts) only when a piece is inserted.
//
// A piece is a handful of native Lobby elements (rectangles, ellipses, diamonds, lines, texts, a frame) that
// someone can restyle and edit like any others, with semantic markers: every element carries
// `customData.lobby.kind = 'piece-<id>'` (create-only; KindValue allows 32 characters, so the id is at most 26),
// image placeholders carry the template slot marker, and nothing is a data: image. They are original work.

export const PIECE_CATEGORIES = [
  { id: 'flowchart', label: 'Flowchart' },
  { id: 'wireframe', label: 'Wireframe' },
  { id: 'org-chart', label: 'Org chart' },
  { id: 'agency', label: 'Agency' },
] as const
export type PieceCategory = (typeof PIECE_CATEGORIES)[number]['id']

export const PIECE_IDS = [
  // flowchart
  'process',
  'decision',
  'terminator',
  'data',
  'document',
  'subprocess',
  'swimlane',
  // wireframe
  'browser',
  'phone',
  'button',
  'input',
  'checkbox',
  'toggle',
  'card',
  'navbar',
  'modal',
  'image',
  // org chart
  'person',
  // agency
  'shot',
  'storyboard',
  'persona',
  'stage',
] as const
export type PieceId = (typeof PIECE_IDS)[number]

/** The `customData.lobby.kind` prefix of a piece's elements. */
export const PIECE_KIND_PREFIX = 'piece-'
export const pieceKind = (id: PieceId) => `${PIECE_KIND_PREFIX}${id}`

export interface PieceInfo {
  readonly id: PieceId
  readonly name: string
  readonly category: PieceCategory
  /** one sentence for the panel */
  readonly description: string
  /** more words the search finds it by ('dec' finds Decision by its name, 'branch' by a keyword) */
  readonly keywords: readonly string[]
  /** its size at insertion, board units */
  readonly w: number
  readonly h: number
  /** a frame: it is made on the page and never inside another frame (frames do not nest) */
  readonly frame?: true
}

const p = (info: PieceInfo): PieceInfo =>
  Object.freeze({ ...info, keywords: Object.freeze([...info.keywords]) })

export const PIECES: readonly PieceInfo[] = Object.freeze([
  p({
    id: 'process',
    name: 'Process',
    category: 'flowchart',
    description: 'A step: something someone does.',
    keywords: ['step', 'action', 'task', 'rectangle', 'box'],
    w: 200,
    h: 96,
  }),
  p({
    id: 'decision',
    name: 'Decision',
    category: 'flowchart',
    description: 'A question with a yes and a no.',
    keywords: ['branch', 'question', 'if', 'diamond', 'yes', 'no', 'choice'],
    w: 220,
    h: 150,
  }),
  p({
    id: 'terminator',
    name: 'Terminator',
    category: 'flowchart',
    description: 'Where a flow starts or ends.',
    keywords: ['start', 'end', 'begin', 'stop', 'oval', 'pill'],
    w: 200,
    h: 64,
  }),
  p({
    id: 'data',
    name: 'Data',
    category: 'flowchart',
    description: 'Something that comes in or goes out.',
    keywords: ['input', 'output', 'io', 'parallelogram', 'file'],
    w: 220,
    h: 96,
  }),
  p({
    id: 'document',
    name: 'Document',
    category: 'flowchart',
    description: 'A document, report or brief.',
    keywords: ['report', 'paper', 'brief', 'page', 'file'],
    w: 200,
    h: 120,
  }),
  p({
    id: 'subprocess',
    name: 'Sub-process',
    category: 'flowchart',
    description: 'A step that is a flow of its own.',
    keywords: ['subroutine', 'predefined', 'nested', 'step', 'process'],
    w: 200,
    h: 96,
  }),
  p({
    id: 'swimlane',
    name: 'Swimlane',
    category: 'flowchart',
    description: 'A lane for one team or role; things dropped in it belong to it.',
    keywords: ['lane', 'team', 'role', 'frame', 'owner', 'responsibility'],
    w: 1000,
    h: 280,
    frame: true,
  }),
  p({
    id: 'browser',
    name: 'Browser',
    category: 'wireframe',
    description: 'A browser window with an address bar.',
    keywords: ['window', 'web', 'page', 'screen', 'desktop', 'site'],
    w: 640,
    h: 420,
  }),
  p({
    id: 'phone',
    name: 'Phone',
    category: 'wireframe',
    description: 'A phone screen.',
    keywords: ['mobile', 'device', 'screen', 'app', 'iphone', 'android'],
    w: 280,
    h: 560,
  }),
  p({
    id: 'button',
    name: 'Button',
    category: 'wireframe',
    description: 'A button.',
    keywords: ['click', 'action', 'cta', 'submit', 'control'],
    w: 160,
    h: 48,
  }),
  p({
    id: 'input',
    name: 'Input',
    category: 'wireframe',
    description: 'A text field.',
    keywords: ['field', 'text', 'form', 'textbox', 'search', 'control'],
    w: 280,
    h: 44,
  }),
  p({
    id: 'checkbox',
    name: 'Checkbox',
    category: 'wireframe',
    description: 'A tick box with its label.',
    keywords: ['tick', 'check', 'option', 'form', 'control'],
    w: 220,
    h: 28,
  }),
  p({
    id: 'toggle',
    name: 'Toggle',
    category: 'wireframe',
    description: 'An on and off switch with its label.',
    keywords: ['switch', 'on', 'off', 'setting', 'control'],
    w: 220,
    h: 32,
  }),
  p({
    id: 'card',
    name: 'Card',
    category: 'wireframe',
    description: 'A card with a picture, a title and a line of text.',
    keywords: ['tile', 'teaser', 'article', 'product', 'picture'],
    w: 280,
    h: 320,
  }),
  p({
    id: 'navbar',
    name: 'Nav bar',
    category: 'wireframe',
    description: 'A navigation bar with a logo and links.',
    keywords: ['navigation', 'menu', 'header', 'links', 'top bar'],
    w: 640,
    h: 56,
  }),
  p({
    id: 'modal',
    name: 'Modal',
    category: 'wireframe',
    description: 'A dialog with a title, a message and two buttons.',
    keywords: ['dialog', 'popup', 'overlay', 'confirm', 'window'],
    w: 420,
    h: 260,
  }),
  p({
    id: 'image',
    name: 'Image placeholder',
    category: 'wireframe',
    description: 'A box to drop a picture on.',
    keywords: ['picture', 'photo', 'slot', 'media', 'placeholder'],
    w: 240,
    h: 160,
  }),
  p({
    id: 'person',
    name: 'Person card',
    category: 'org-chart',
    description: 'A person with a name, a title and a photo.',
    keywords: ['team', 'employee', 'role', 'staff', 'photo', 'reports to', 'org'],
    w: 280,
    h: 112,
  }),
  p({
    id: 'shot',
    name: 'Shot card',
    category: 'agency',
    description: 'A shot: its number, framing, movement and a thumbnail.',
    keywords: ['shot list', 'camera', 'scene', 'film', 'video', 'frame', 'framing'],
    w: 320,
    h: 200,
  }),
  p({
    id: 'storyboard',
    name: 'Storyboard panel',
    category: 'agency',
    description: 'A picture with room for the action and the words.',
    keywords: ['panel', 'story', 'comic', 'scene', 'frame', 'board'],
    w: 320,
    h: 290,
  }),
  p({
    id: 'persona',
    name: 'Persona',
    category: 'agency',
    description: 'Who it is for: a name, goals and frustrations.',
    keywords: ['audience', 'user', 'customer', 'profile', 'research', 'archetype'],
    w: 320,
    h: 380,
  }),
  p({
    id: 'stage',
    name: 'Journey stage',
    category: 'agency',
    description: 'One stage of a journey: what they do, think and feel.',
    keywords: ['journey map', 'customer journey', 'step', 'touchpoint', 'experience', 'column'],
    w: 240,
    h: 320,
  }),
])

export const pieceInfo = (id: string): PieceInfo | undefined => PIECES.find((x) => x.id === id)
export const isPieceId = (id: unknown): id is PieceId =>
  typeof id === 'string' && (PIECE_IDS as readonly string[]).includes(id)

/** The words the palette's command for a piece says: 'Insert decision'. */
export const insertLabel = (info: PieceInfo) => `Insert ${info.name.toLowerCase()}`

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/**
 * The pieces matching `query` (words, any order, each a prefix of a word of the name, the category or a keyword,
 * or inside the name), best first: a name that starts with the query, then a word of the name, then the rest.
 * An empty query lists them all in catalogue order, narrowed to `category` when given.
 */
export function searchPieces(
  query: string,
  category: PieceCategory | 'all' = 'all',
  list: readonly PieceInfo[] = PIECES,
): PieceInfo[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  const pool = list.filter((x) => category === 'all' || x.category === category)
  if (!words.length) return [...pool]
  const scored: { info: PieceInfo; score: number; at: number }[] = []
  pool.forEach((info, at) => {
    const name = fold(info.name)
    const nameWords = name.split(/[\s-]+/)
    const other = [fold(info.category), ...info.keywords.map(fold), ...fold(info.description).split(/\W+/)]
    let score = 0
    for (const w of words) {
      if (name.startsWith(w)) score += 100
      else if (nameWords.some((n) => n.startsWith(w))) score += 60
      else if (name.includes(w)) score += 30
      else if (other.some((o) => o.startsWith(w) || (w.length > 2 && o.includes(w)))) score += 10
      else return
    }
    scored.push({ info, score, at })
  })
  return scored.sort((a, b) => b.score - a.score || a.at - b.at).map((s) => s.info)
}
