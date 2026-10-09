// OWNER: W3 (wave L, L3-3). Plain-language board commands, the local grammar: common phrases become board
// command ops (@draftroom/contracts AiCommandOp, the closed, non-destructive set the AI fallback returns too)
// with no call at all. Pure: `parseCommand` reads only the words, `resolveCommand` reads a plain snapshot of
// the board (BoardFacts, ./facts.ts), and `grammar` is the two together.
//
// What it understands (English only; anything else, or a word it does not know, is not understood, and the
// palette offers AI for it when AI is on):
//   recolour      make|turn|paint|colour|change <target> [to] <colour>; change the colour of <target> to <colour>
//   select, find  select|pick|highlight <target>; find|show [me] <target> (selects and zooms to them)
//   zoom          zoom to|go to|jump to|focus on <target or a frame's name>
//   align         align [<target>] [to the] left|right|top|bottom|centre|middle; line [<target>] up [in a row|column]
//   distribute    distribute|space out|spread out [<target>] [evenly] [horizontally|vertically]
//   grid          arrange|lay out [<target>] as a grid; tidy [up] [<target>]
//   lock          lock <target>
//   frame         put|wrap <target> in a [new] frame [called <name>]; frame <target> [as <name>]
//   tag           tag <target> as|with <tag>; add the tag <tag> to <target>
// A target: the selection (these, this, it, them, the selection, selected notes, these red notes…) or, with
// all / every / the / nothing, the whole board, narrowed by a colour, a kind (notes, text, shapes,
// connectors, frames, images, files, everything), and `in <frame>`, `tagged <tag>`, `with tag <tag>`,
// `#tag`, `containing <words>`. "about …" is a matter of meaning, not of words: it goes to AI.
// There is no verb for delete, remove, unlock, ungroup, rename, move or any text edit, and none is ever
// guessed: such a phrase is not understood.
import {
  AI_COMMAND_FRAME_NAME_MAX_CHARS,
  AI_COMMAND_INSTRUCTION_MAX,
  AI_COMMAND_MAX_IDS_PER_OP,
  AI_COMMAND_TAG_MAX_CHARS,
  type AiColorName,
  type AiCommandOp,
} from '@draftroom/contracts'

// ---- the board, as the grammar sees it ---------------------------------------------------------------------

export type KindName = 'note' | 'text' | 'shape' | 'connector' | 'frame' | 'image' | 'file'

export interface FactItem {
  /** the element id */
  readonly id: string
  readonly kind: KindName
  /** its Lobby colour name (a note's fill, a shape's or a text's stroke), or null */
  readonly color: AiColorName | null
  readonly frameId: string | null
  /** its tags' names */
  readonly tags: readonly string[]
  /** its words (a container's are its label's) */
  readonly text: string
  readonly bounds: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
}

export interface BoardFacts {
  /** the live content items (no bound labels, nothing hidden) */
  readonly items: readonly FactItem[]
  readonly frames: readonly { readonly id: string; readonly name: string }[]
  /** the selection as items (a selected label stands for its container) */
  readonly selection: readonly string[]
}

// ---- the parse ---------------------------------------------------------------------------------------------

export type CommandVerb =
  | 'recolor'
  | 'select'
  | 'find'
  | 'zoomTo'
  | 'align'
  | 'distribute'
  | 'arrangeGrid'
  | 'lock'
  | 'wrapInFrame'
  | 'tag'

export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'

export interface TargetSpec {
  /** the selection (else the whole board) */
  readonly selection: boolean
  /** null: any kind */
  readonly kind: KindName | null
  readonly color: AiColorName | null
  /** a frame's name as typed: what is inside it */
  readonly frame: string | null
  readonly tag: string | null
  readonly text: string | null
  /**
   * The words were taken as a frame's name, the frame itself ("zoom to Retro"). `guess`: only because they
   * were nothing else; a board with no frame of that name then leaves the phrase to AI.
   */
  readonly frameItself?: { readonly name: string; readonly guess: boolean }
}

export interface ParsedCommand {
  readonly verb: CommandVerb
  readonly target: TargetSpec
  readonly color?: AiColorName
  readonly edge?: AlignEdge | 'auto'
  readonly axis?: 'horizontal' | 'vertical' | 'auto'
  /** the new frame's name, or the tag */
  readonly name?: string
}

/** Lobby's colours by the words people use for them, longest first. */
const COLOR_WORDS: readonly (readonly [string, AiColorName])[] = (
  [
    ['light red', 'light-red'],
    ['light-red', 'light-red'],
    ['pink', 'light-red'],
    ['light violet', 'light-violet'],
    ['light-violet', 'light-violet'],
    ['light purple', 'light-violet'],
    ['lilac', 'light-violet'],
    ['lavender', 'light-violet'],
    ['light blue', 'light-blue'],
    ['light-blue', 'light-blue'],
    ['sky blue', 'light-blue'],
    ['light green', 'light-green'],
    ['light-green', 'light-green'],
    ['lime', 'light-green'],
    ['red', 'red'],
    ['violet', 'violet'],
    ['purple', 'violet'],
    ['blue', 'blue'],
    ['green', 'green'],
    ['orange', 'orange'],
    ['yellow', 'yellow'],
    ['grey', 'grey'],
    ['gray', 'grey'],
    ['black', 'black'],
    ['white', 'white'],
  ] as const
)
  .slice()
  .sort((a, b) => b[0].length - a[0].length)

/** What people call each kind, longest first; '*' is anything. */
const KIND_WORDS: readonly (readonly [string, KindName | '*'])[] = (
  [
    ['sticky notes', 'note'],
    ['sticky note', 'note'],
    ['post-its', 'note'],
    ['post-it', 'note'],
    ['post its', 'note'],
    ['postits', 'note'],
    ['stickies', 'note'],
    ['notes', 'note'],
    ['note', 'note'],
    ['text boxes', 'text'],
    ['texts', 'text'],
    ['text', 'text'],
    ['shapes', 'shape'],
    ['shape', 'shape'],
    ['rectangles', 'shape'],
    ['rectangle', 'shape'],
    ['boxes', 'shape'],
    ['box', 'shape'],
    ['circles', 'shape'],
    ['circle', 'shape'],
    ['ellipses', 'shape'],
    ['ellipse', 'shape'],
    ['diamonds', 'shape'],
    ['diamond', 'shape'],
    ['connectors', 'connector'],
    ['connector', 'connector'],
    ['arrows', 'connector'],
    ['arrow', 'connector'],
    ['lines', 'connector'],
    ['line', 'connector'],
    ['frames', 'frame'],
    ['frame', 'frame'],
    ['images', 'image'],
    ['image', 'image'],
    ['pictures', 'image'],
    ['picture', 'image'],
    ['photos', 'image'],
    ['photo', 'image'],
    ['file cards', 'file'],
    ['files', 'file'],
    ['file', 'file'],
    ['cards', 'file'],
    ['items', '*'],
    ['item', '*'],
    ['things', '*'],
    ['objects', '*'],
    ['object', '*'],
    ['elements', '*'],
    ['everything', '*'],
    ['stuff', '*'],
  ] as const
)
  .slice()
  .sort((a, b) => b[0].length - a[0].length)

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const COLOR_RE = COLOR_WORDS.map(([w]) => escapeRe(w)).join('|')
const colorOf = (word: string): AiColorName | null =>
  COLOR_WORDS.find(([w]) => w === word.trim())?.[1] ?? null

/** Words the grammar never acts on (nothing destructive and no text edit is ever guessed). */
const REFUSED =
  /^(?:delete|remove|erase|clear|wipe|destroy|unlock|ungroup|rename|edit|rewrite|write|type|duplicate|copy|cut|paste|undo|redo|move|drag|resize|rotate|hide|archive|share|export|send)\b/

/** The phrase as the grammar reads it: lower case, plain quotes, no politeness, no closing punctuation. */
export function normalizeCommand(text: string): string {
  let s = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”«»„]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
  s = s.replace(/[.!?;,]+$/, '').trim()
  for (;;) {
    const next = s
      .replace(/^(?:please|pls|plz|kindly|lobby|hey lobby|can you|could you|would you|will you),?\s+/, '')
      .replace(/,?\s+(?:please|pls|plz|for me|thanks|thank you)$/, '')
      .replace(/[.!?;,]+$/, '')
      .trim()
    if (next === s) break
    s = next
  }
  return s
}

const unquote = (s: string) =>
  s
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim()

const QUALIFIER_START =
  /\s+(?=(?:in|inside|within|from|on|tagged|labell?ed|with|containing|that|which|saying|#)\b|#)/

/** A target phrase, or null when a word of it is not understood. '' is the selection. */
export function parseTarget(phrase: string): TargetSpec | null {
  let s = phrase.trim()
  let selection = false
  let kind: KindName | '*' | null = null
  let color: AiColorName | null = null
  let frame: string | null = null
  let tag: string | null = null
  let text: string | null = null
  // "on the board" / "in this board" add nothing: the whole board is where a target looks anyway
  s = s.replace(/\s*\b(?:on|in|across|from)\s+(?:the|this)\s+(?:whole\s+)?(?:board|canvas)$/, '').trim()
  if (!s && phrase.trim()) s = 'everything'
  if (!s) return { selection: true, kind: null, color: null, frame: null, tag: null, text: null }
  if (
    /^(?:them|it|the selection|selection|my selection|the selected ones|selected ones|what i selected|what is selected|what's selected|everything selected|all selected|the selected|selected)$/.test(
      s,
    )
  )
    return { selection: true, kind: null, color: null, frame: null, tag: null, text: null }
  const deictic = /^(?:these|those|this|that|the selected|selected|my selected|the chosen)\s+(.+)$/.exec(s)
  if (deictic) {
    selection = true
    s = deictic[1] as string
  } else if (/^(?:these|those|this|that)$/.test(s)) {
    return { selection: true, kind: null, color: null, frame: null, tag: null, text: null }
  }
  // quantifiers
  for (;;) {
    const next = s.replace(/^(?:all of the|all the|all of|all|every|each|any|the|my|our)\s+/, '')
    if (next === s) break
    s = next
  }
  if (/^(?:all|everything|every thing|all items|the lot)$/.test(s))
    return { selection, kind: null, color, frame, tag, text }
  // a colour, then a kind
  const c = new RegExp(`^(${COLOR_RE})(?:\\s+(?:coloured|colored))?(?=\\s|$)`).exec(s)
  if (c) {
    color = colorOf(c[1] as string)
    s = s.slice((c[0] as string).length).trim()
  }
  for (const [w, k] of KIND_WORDS) {
    if (s === w || s.startsWith(`${w} `)) {
      kind = k
      s = s.slice(w.length).trim()
      break
    }
  }
  // the qualifiers, in any order (a kind may still follow one: '#finance notes')
  while (s) {
    if (kind === null) {
      const k = KIND_WORDS.find(([w]) => s === w || s.startsWith(`${w} `))
      if (k) {
        kind = k[1]
        s = s.slice(k[0].length).trim()
        continue
      }
    }
    if (
      /^(?:about|related to|regarding|concerning|on the topic of|to do with|that talk about|that mention)\b/.test(
        s,
      )
    )
      return null
    let m = /^(?:that are|which are|that is|which is)\s+(.+)$/.exec(s)
    if (m) {
      const cc = new RegExp(`^(${COLOR_RE})(?=\\s|$)`).exec(m[1] as string)
      if (!cc || color) return null
      color = colorOf(cc[1] as string)
      s = (m[1] as string).slice((cc[1] as string).length).trim()
      continue
    }
    m =
      /^(?:containing|that contain|that contains|that say|that says|which say|saying|with the words?|with text|with the text)\s+(.+)$/.exec(
        s,
      )
    if (m) {
      text = unquote(m[1] as string)
      if (!text) return null
      s = ''
      continue
    }
    const until = (rest: string) => {
      const cut = rest.split(QUALIFIER_START)
      return { head: (cut[0] ?? '').trim(), tail: rest.slice((cut[0] ?? '').length).trim() }
    }
    m = /^(?:tagged|labell?ed|with (?:the )?tag)\s+#?(.+)$/.exec(s)
    if (m) {
      const { head, tail } = until(m[1] as string)
      tag = unquote(head)
      if (!tag) return null
      s = tail
      continue
    }
    m = /^#(\S+)\s*(.*)$/.exec(s)
    if (m) {
      tag = m[1] as string
      s = (m[2] as string).trim()
      continue
    }
    m = /^(?:in|inside|within|from|on)\s+(?:the\s+)?(.+)$/.exec(s)
    if (m) {
      const { head, tail } = until(m[1] as string)
      const name = unquote(head.replace(/^frames?\s+(?:called\s+|named\s+)?/, '').replace(/\s+frame$/, ''))
      if (!name || frame) return null
      frame = name
      s = tail
      continue
    }
    return null
  }
  if (!selection && kind === null && color === null && frame === null && tag === null && text === null)
    return null
  return { selection, kind: kind === '*' ? null : kind, color, frame, tag, text }
}

/** A target, else the words as a frame's own name (for zoom, select and find). */
function targetOrFrame(phrase: string): TargetSpec | null {
  const t = parseTarget(phrase)
  if (t) return t
  const explicit = /^(?:the\s+)?(?:frame\s+(?:called\s+|named\s+)?(.+)|(.+?)\s+frame)$/.exec(phrase)
  const name = unquote(explicit ? ((explicit[1] ?? explicit[2]) as string) : phrase.replace(/^the\s+/, ''))
  if (!name || name.length > AI_COMMAND_FRAME_NAME_MAX_CHARS) return null
  return {
    selection: false,
    kind: null,
    color: null,
    frame: null,
    tag: null,
    text: null,
    frameItself: { name, guess: !explicit },
  }
}

const EDGES: readonly (readonly [RegExp, AlignEdge])[] = [
  [/^(?:left|left edges?|left sides?|the left)$/, 'left'],
  [/^(?:right|right edges?|right sides?|the right)$/, 'right'],
  [/^(?:top|tops|top edges?|the top)$/, 'top'],
  [/^(?:bottom|bottoms|bottom edges?|the bottom)$/, 'bottom'],
  [/^(?:cent(?:er|re)s?|horizontally|in a column|in one column|as a column|vertically centred)$/, 'center'],
  [/^(?:middles?|vertically|in a row|in one row|as a row)$/, 'middle'],
]

function trailingEdge(rest: string): { target: string; edge: AlignEdge | 'auto' } | null {
  const words = rest.split(' ')
  for (let i = 0; i < words.length; i++) {
    const tail = words.slice(i).join(' ')
    const cut = tail.replace(/^(?:to|on|by|along|with|at)\s+(?:the\s+|their\s+)?/, '')
    const edge = EDGES.find(([re]) => re.test(cut))?.[1]
    if (edge) return { target: words.slice(0, i).join(' '), edge }
  }
  return { target: rest, edge: 'auto' }
}

function trailingAxis(rest: string): { target: string; axis: 'horizontal' | 'vertical' | 'auto' } {
  let s = rest
  let axis: 'horizontal' | 'vertical' | 'auto' = 'auto'
  for (;;) {
    const before = s
    let m = /^(.*?)\s*\b(?:horizontally|across|left to right|in a row|sideways)$/.exec(s)
    if (m && axis === 'auto') {
      axis = 'horizontal'
      s = (m[1] as string).trim()
    }
    m = /^(.*?)\s*\b(?:vertically|down|top to bottom|in a column)$/.exec(s)
    if (m && axis === 'auto') {
      axis = 'vertical'
      s = (m[1] as string).trim()
    }
    s = s.replace(/\s*\b(?:evenly|equally|out)$/, '').trim()
    if (s === before) break
  }
  return { target: s, axis }
}

/** The verb and its target, or null when the phrase is not one the grammar knows. */
export function parseCommand(input: string): ParsedCommand | null {
  const s = normalizeCommand(input)
  if (!s || [...s].length > AI_COMMAND_INSTRUCTION_MAX || REFUSED.test(s)) return null
  // a bare verb (lock, align, tidy) is a command's name: the palette's commands answer it
  if (!s.includes(' ')) return null
  let m: RegExpExecArray | null

  // recolour
  m = new RegExp(`^change\\s+the\\s+colou?r\\s+of\\s+(.+?)\\s+to\\s+(${COLOR_RE})$`).exec(s)
  if (!m)
    m = new RegExp(
      `^(?:make|turn|paint|colou?r|recolou?r|change|set|switch)\\s+(.+?)\\s+(?:to\\s+|into\\s+)?(?:be\\s+)?(?:the\\s+colou?r\\s+)?(${COLOR_RE})(?:\\s+colou?r(?:ed)?)?$`,
    ).exec(s)
  if (m) {
    const target = parseTarget(m[1] as string)
    const color = colorOf(m[2] as string)
    return target && color ? { verb: 'recolor', target, color } : null
  }
  m = new RegExp(`^(?:make|turn|paint|colou?r|recolou?r)\\s+(?:it\\s+|them\\s+)?(${COLOR_RE})$`).exec(s)
  if (m) {
    const color = colorOf(m[1] as string)
    return color ? { verb: 'recolor', target: parseTarget('') as TargetSpec, color } : null
  }

  // tag
  m = /^tag\s+(.+?)\s+(?:as|with)\s+#?(.+)$/.exec(s) ?? null
  let tagName: string | null = null
  let tagTarget: string | null = null
  if (m) {
    tagTarget = m[1] as string
    tagName = m[2] as string
  } else {
    m = /^add\s+(?:the\s+|a\s+)?tag\s+#?(.+?)\s+to\s+(.+)$/.exec(s)
    if (m) {
      tagName = m[1] as string
      tagTarget = m[2] as string
    }
  }
  if (tagName !== null && tagTarget !== null) {
    const target = parseTarget(tagTarget)
    const name = unquote(tagName)
    if (!target || !name || [...name].length > AI_COMMAND_TAG_MAX_CHARS) return null
    return { verb: 'tag', target, name }
  }

  // a new frame around things
  m =
    /^(?:put|wrap|place|group)\s+(.+?)\s+(?:in|into|inside)\s+(?:a\s+)?(?:new\s+)?frame(?:\s+(?:called|named|titled)\s+(.+))?$/.exec(
      s,
    ) ?? /^frame\s+(.+?)(?:\s+(?:as|called|named|titled)\s+(.+))?$/.exec(s)
  if (m) {
    const target = parseTarget(m[1] as string)
    const name = m[2] ? unquote(m[2]) : 'Frame'
    if (!target || !name || [...name].length > AI_COMMAND_FRAME_NAME_MAX_CHARS) return null
    return { verb: 'wrapInFrame', target, name: m[2] ? name.charAt(0).toUpperCase() + name.slice(1) : name }
  }

  // a grid
  m =
    /^(?:arrange|lay\s?out|organi[sz]e|place|put|sort)\s+(?:(.+?)\s+)?(?:as|in|into)\s+(?:a\s+)?grid$/.exec(
      s,
    ) ??
    /^(?:arrange|lay\s?out|organi[sz]e)\s+(?:(.+?)\s+)?(?:as|in|into)\s+(?:rows and columns|a table)$/.exec(
      s,
    ) ??
    /^(?:tidy up|neaten up|clean up|tidy|neaten)(?:\s+(.+))?$/.exec(s) ??
    /^(?:tidy|clean|neaten)\s+(.+?)\s+up$/.exec(s) ??
    /^make\s+a\s+grid(?:\s+(?:of|from|with)\s+(.+))?$/.exec(s)
  if (m) {
    const target = parseTarget(m[1] ?? '')
    return target ? { verb: 'arrangeGrid', target } : null
  }

  // align
  const lineUp = /^line\s+(.+?)\s+up(?:\s+(.+))?$/.exec(s)
  if (lineUp && !/^up\b/.test(lineUp[1] as string)) {
    const target = parseTarget(lineUp[1] as string)
    const how = lineUp[2]
    const edge = how ? (EDGES.find(([re]) => re.test(how))?.[1] ?? null) : 'auto'
    return target && edge ? { verb: 'align', target, edge } : null
  }
  m = /^(?:align|line\s+up)(?:\s+(.+))?$/.exec(s)
  if (m) {
    const split = trailingEdge(m[1] ?? '')
    const target = split ? parseTarget(split.target) : null
    return target && split ? { verb: 'align', target, edge: split.edge } : null
  }

  // distribute
  m = /^(?:distribute|space\s+out|space|spread\s+out|spread|even\s+out|even\s+up)(?:\s+(.+))?$/.exec(s)
  if (m) {
    const { target: rest, axis } = trailingAxis(m[1] ?? '')
    const target = parseTarget(rest)
    return target ? { verb: 'distribute', target, axis } : null
  }

  // lock (a bare "lock" is the Toggle locked command's)
  m = /^lock(?:\s+down)?\s+(.+)$/.exec(s)
  if (m) {
    const target = parseTarget(m[1] as string)
    return target ? { verb: 'lock', target } : null
  }

  // select, find, zoom
  m =
    /^(?:zoom\s+(?:in\s+)?(?:to|on|into)|go\s+to|jump\s+to|take\s+me\s+to|focus\s+on|navigate\s+to)\s+(.+)$/.exec(
      s,
    )
  if (m) {
    const target = targetOrFrame(m[1] as string)
    return target ? { verb: 'zoomTo', target } : null
  }
  m = /^(?:find|show\s+me|show|where\s+(?:are|is))\s+(.+)$/.exec(s)
  if (m) {
    const target = targetOrFrame(m[1] as string)
    return target ? { verb: 'find', target } : null
  }
  m = /^(?:select|pick|choose|highlight)\s+(.+)$/.exec(s)
  if (m) {
    const target = targetOrFrame(m[1] as string)
    return target ? { verb: 'select', target } : null
  }
  return null
}

// ---- resolving against the board ---------------------------------------------------------------------------

export type Resolved =
  | {
      readonly ok: true
      readonly verb: CommandVerb
      readonly ops: readonly AiCommandOp[]
      /** the element ids it acts on */
      readonly ids: readonly string[]
      /** what it will do, in words ('Make 3 red notes in “Ideas” yellow') */
      readonly title: string
      /** only selects or moves the camera (a viewer may run it) */
      readonly find: boolean
    }
  | {
      readonly ok: false
      /** why nothing can be done, in words */
      readonly reason: string
      /** understood only as a guess (a frame's name that is not on the board): leave it to AI */
      readonly fallThrough?: boolean
    }

const FIND_VERBS: ReadonlySet<CommandVerb> = new Set(['select', 'find', 'zoomTo'])
const COLOURABLE: ReadonlySet<KindName> = new Set(['note', 'text', 'shape', 'connector'])

const KIND_NOUN: Readonly<Record<KindName, readonly [string, string]>> = {
  note: ['note', 'notes'],
  text: ['text', 'texts'],
  shape: ['shape', 'shapes'],
  connector: ['connector', 'connectors'],
  frame: ['frame', 'frames'],
  image: ['image', 'images'],
  file: ['file', 'files'],
}
const COLOUR_LABEL = (c: AiColorName) => c.replace('-', ' ')
const EDGE_LABEL: Readonly<Record<AlignEdge, string>> = {
  left: 'on their left edges',
  right: 'on their right edges',
  top: 'on their tops',
  bottom: 'on their bottoms',
  center: 'in a column',
  middle: 'in a row',
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

/** The board's frame for a typed name: exactly, else the one frame whose name starts with or holds it. */
export function frameNamed(
  frames: BoardFacts['frames'],
  typed: string,
): { readonly id: string; readonly name: string } | null {
  const t = fold(typed)
  if (!t) return null
  const exact = frames.filter((f) => fold(f.name) === t)
  if (exact.length) return exact[0] ?? null
  const starts = frames.filter((f) => fold(f.name).startsWith(t))
  if (starts.length === 1) return starts[0] ?? null
  const holds = frames.filter((f) => fold(f.name).includes(t))
  return holds.length === 1 ? (holds[0] ?? null) : null
}

/** The phrase that names what a target picked: 'selected red notes in “Ideas”'. */
function describe(t: TargetSpec, n: number, frameName: string | null): string {
  const parts: string[] = []
  if (t.selection) parts.push('selected')
  if (t.color) parts.push(COLOUR_LABEL(t.color))
  const noun = t.kind ? KIND_NOUN[t.kind] : (['item', 'items'] as const)
  parts.push(n === 1 ? noun[0] : noun[1])
  if (frameName !== null) parts.push(`in “${frameName}”`)
  if (t.tag) parts.push(`tagged “${t.tag}”`)
  if (t.text) parts.push(`containing “${t.text}”`)
  return parts.join(' ')
}

const shapeRef = (id: string) => `shape:${id}`

/** `ids` as ops of one kind, at most AI_COMMAND_MAX_IDS_PER_OP ids each. */
function chunked(ids: readonly string[], make: (ids: string[]) => AiCommandOp): AiCommandOp[] {
  const out: AiCommandOp[] = []
  for (let i = 0; i < ids.length; i += AI_COMMAND_MAX_IDS_PER_OP)
    out.push(make(ids.slice(i, i + AI_COMMAND_MAX_IDS_PER_OP).map(shapeRef)))
  return out
}

/** Width or height of the space `items` spread over. */
function spread(items: readonly FactItem[]): { w: number; h: number } {
  const xs = items.map((i) => i.bounds.x + i.bounds.w / 2)
  const ys = items.map((i) => i.bounds.y + i.bounds.h / 2)
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

/** What a parsed command does on this board (its ops, in AiCommandOp terms), or why it cannot. */
export function resolveCommand(cmd: ParsedCommand, facts: BoardFacts): Resolved {
  const t = cmd.target
  const byId = new Map(facts.items.map((i) => [i.id, i]))
  // a frame named by itself ("zoom to Retro")
  if (t.frameItself) {
    const f = frameNamed(facts.frames, t.frameItself.name)
    if (!f)
      return t.frameItself.guess
        ? {
            ok: false,
            reason: `No frame on this board is called “${t.frameItself.name}”.`,
            fallThrough: true,
          }
        : { ok: false, reason: `No frame on this board is called “${t.frameItself.name}”.` }
    const ops: AiCommandOp[] =
      cmd.verb === 'zoomTo'
        ? [{ op: 'zoomTo', ids: [shapeRef(f.id)] }]
        : cmd.verb === 'find'
          ? [
              { op: 'select', ids: [shapeRef(f.id)] },
              { op: 'zoomTo', ids: [shapeRef(f.id)] },
            ]
          : [{ op: 'select', ids: [shapeRef(f.id)] }]
    const verbWord = cmd.verb === 'zoomTo' ? 'Zoom to' : cmd.verb === 'find' ? 'Find' : 'Select'
    return { ok: true, verb: cmd.verb, ops, ids: [f.id], title: `${verbWord} frame “${f.name}”`, find: true }
  }

  let frame: { id: string; name: string } | null = null
  if (t.frame !== null) {
    frame = frameNamed(facts.frames, t.frame)
    if (!frame) return { ok: false, reason: `No frame on this board is called “${t.frame}”.` }
  }
  const pool = t.selection
    ? facts.selection.map((id) => byId.get(id)).filter((i): i is FactItem => !!i)
    : facts.items
  if (t.selection && !pool.length) return { ok: false, reason: 'Select something first.' }
  const tagWanted = t.tag ? fold(t.tag) : null
  const textWanted = t.text ? fold(t.text) : null
  const matched = pool.filter(
    (i) =>
      (t.kind === null || i.kind === t.kind) &&
      (t.color === null || i.color === t.color) &&
      (frame === null || i.frameId === frame.id) &&
      (tagWanted === null || i.tags.some((g) => fold(g) === tagWanted)) &&
      (textWanted === null || fold(i.text).includes(textWanted)),
  )
  const picked =
    cmd.verb === 'recolor'
      ? matched.filter((i) => COLOURABLE.has(i.kind))
      : cmd.verb === 'wrapInFrame'
        ? matched.filter((i) => i.kind !== 'frame')
        : matched
  const n = picked.length
  const what = describe(t, n, frame?.name ?? null)
  if (!n)
    return {
      ok: false,
      reason:
        matched.length && cmd.verb === 'recolor'
          ? `Nothing here takes a colour: no ${describe(t, 2, frame?.name ?? null)}.`
          : matched.length
            ? 'A frame cannot go inside another frame.'
            : `No ${describe(t, 2, frame?.name ?? null)} on this board.`,
    }
  const ids = picked.map((i) => i.id)
  const find = FIND_VERBS.has(cmd.verb)
  const done = (ops: AiCommandOp[], title: string): Resolved => ({
    ok: true,
    verb: cmd.verb,
    ops,
    ids,
    title,
    find,
  })
  switch (cmd.verb) {
    case 'recolor': {
      const color = cmd.color as AiColorName
      return done(
        chunked(ids, (x) => ({ op: 'recolor', ids: x, color })),
        `Make ${n} ${what} ${COLOUR_LABEL(color)}`,
      )
    }
    case 'select':
      return done(
        chunked(ids, (x) => ({ op: 'select', ids: x })),
        `Select ${n} ${what}`,
      )
    case 'find':
      return done(
        [
          ...chunked(ids, (x) => ({ op: 'select', ids: x })),
          ...chunked(ids, (x) => ({ op: 'zoomTo', ids: x })),
        ],
        `Find ${n} ${what}`,
      )
    case 'zoomTo':
      return done(
        chunked(ids, (x) => ({ op: 'zoomTo', ids: x })),
        `Zoom to ${n} ${what}`,
      )
    case 'lock':
      return done(
        chunked(ids, (x) => ({ op: 'lock', ids: x })),
        `Lock ${n} ${what}`,
      )
    case 'tag': {
      const tag = cmd.name as string
      return done(
        chunked(ids, (x) => ({ op: 'tag', ids: x, tag })),
        `Tag ${n} ${what} “${tag}”`,
      )
    }
    case 'wrapInFrame': {
      if (ids.length > AI_COMMAND_MAX_IDS_PER_OP)
        return {
          ok: false,
          reason: `A new frame can take at most ${AI_COMMAND_MAX_IDS_PER_OP} items at once.`,
        }
      const name = cmd.name as string
      return done(
        [{ op: 'wrapInFrame', ids: ids.map(shapeRef), name }],
        `Put ${n} ${what} in a new frame “${name}”`,
      )
    }
    case 'arrangeGrid':
      if (n < 2) return { ok: false, reason: 'A grid needs two or more objects.' }
      if (ids.length > AI_COMMAND_MAX_IDS_PER_OP)
        return { ok: false, reason: `A grid can take at most ${AI_COMMAND_MAX_IDS_PER_OP} items at once.` }
      return done([{ op: 'arrangeGrid', ids: ids.map(shapeRef) }], `Arrange ${n} ${what} as a grid`)
    case 'align': {
      if (n < 2) return { ok: false, reason: 'Lining up needs two or more objects.' }
      if (ids.length > AI_COMMAND_MAX_IDS_PER_OP)
        return { ok: false, reason: `Line up at most ${AI_COMMAND_MAX_IDS_PER_OP} items at once.` }
      let edge = cmd.edge ?? 'auto'
      if (edge === 'auto') {
        const sp = spread(picked)
        edge = sp.w >= sp.h ? 'middle' : 'center'
      }
      return done([{ op: 'align', ids: ids.map(shapeRef), edge }], `Line up ${n} ${what} ${EDGE_LABEL[edge]}`)
    }
    case 'distribute': {
      if (n < 3) return { ok: false, reason: 'Spacing out needs three or more objects.' }
      if (ids.length > AI_COMMAND_MAX_IDS_PER_OP)
        return { ok: false, reason: `Space out at most ${AI_COMMAND_MAX_IDS_PER_OP} items at once.` }
      let axis = cmd.axis ?? 'auto'
      if (axis === 'auto') {
        const sp = spread(picked)
        axis = sp.w >= sp.h ? 'horizontal' : 'vertical'
      }
      return done(
        [{ op: 'distribute', ids: ids.map(shapeRef), axis }],
        `Space ${n} ${what} evenly ${axis === 'horizontal' ? 'across' : 'down'}`,
      )
    }
  }
}

/**
 * The local grammar: null when the phrase is not one it knows (the palette may offer AI for it), else what
 * it does on this board, or why it cannot.
 */
export function grammar(text: string, facts: BoardFacts): Resolved | null {
  const parsed = parseCommand(text)
  if (!parsed) return null
  const r = resolveCommand(parsed, facts)
  return !r.ok && r.fallThrough ? null : r
}
