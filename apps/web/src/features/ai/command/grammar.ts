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
//
// Colours (wave M, M3-4; ./colours.ts): the words are the pickers' ("butter", "blush", "sky"…), the hue families
// ("yellow" is Butter and Marigold, "pink" is Blush and Coral) and the older names ("light red"); a family on the
// target side matches all its swatches, on the destination side it means its first. P-012: every reply says a colour in
// the word the person typed ("Make 6 yellow notes blue"), never the palette's own name for a swatch (Butter, Iris) nor
// the stored one (`black` for a Butter note).
import {
  AI_COMMAND_FRAME_NAME_MAX_CHARS,
  AI_COMMAND_INSTRUCTION_MAX,
  AI_COMMAND_MAX_IDS_PER_OP,
  AI_COMMAND_TAG_MAX_CHARS,
  type AiColorName,
  type AiCommandOp,
} from '@draftroom/contracts'
import {
  COLOUR_WORDS,
  type ColourSpace,
  type ColourWord,
  capitalised,
  colourWord,
  covers,
  destinationIn,
  listWords,
} from './colours.ts'

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
  /** the colour word as typed: what it covers on a note and on everything else (./colours.ts) */
  readonly colour: ColourWord | null
  /** a frame's name as typed: what is inside it */
  readonly frame: string | null
  readonly tag: string | null
  readonly text: string | null
  /**
   * The words were taken as a frame's name, the frame itself ("zoom to Retro"). `guess`: only because they
   * were nothing else; a board with no frame of that name then leaves the phrase to AI.
   */
  readonly frameItself?: { readonly name: string; readonly guess: boolean }
  /**
   * M3-4: the words were also a bare colour ("zoom to sky"): a frame of that name is found first (the frame is what a
   * word that is a frame's name most likely means), and a board without one takes the colour's items.
   */
  readonly orColour?: TargetSpec
}

export interface ParsedCommand {
  readonly verb: CommandVerb
  readonly target: TargetSpec
  /** the colour the items become */
  readonly colour?: ColourWord
  readonly edge?: AlignEdge | 'auto'
  readonly axis?: 'horizontal' | 'vertical' | 'auto'
  /** the new frame's name, or the tag */
  readonly name?: string
}

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
const COLOR_RE = COLOUR_WORDS.map((w) => escapeRe(w.word)).join('|')

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
  let colour: ColourWord | null = null
  let frame: string | null = null
  let tag: string | null = null
  let text: string | null = null
  // "on the board" / "in this board" add nothing: the whole board is where a target looks anyway
  s = s.replace(/\s*\b(?:on|in|across|from)\s+(?:the|this)\s+(?:whole\s+)?(?:board|canvas)$/, '').trim()
  if (!s && phrase.trim()) s = 'everything'
  if (!s) return { selection: true, kind: null, colour: null, frame: null, tag: null, text: null }
  if (
    /^(?:them|it|the selection|selection|my selection|the selected ones|selected ones|what i selected|what is selected|what's selected|everything selected|all selected|the selected|selected)$/.test(
      s,
    )
  )
    return { selection: true, kind: null, colour: null, frame: null, tag: null, text: null }
  const deictic = /^(?:these|those|this|that|the selected|selected|my selected|the chosen)\s+(.+)$/.exec(s)
  if (deictic) {
    selection = true
    s = deictic[1] as string
  } else if (/^(?:these|those|this|that)$/.test(s)) {
    return { selection: true, kind: null, colour: null, frame: null, tag: null, text: null }
  }
  // quantifiers
  for (;;) {
    const next = s.replace(/^(?:all of the|all the|all of|all|every|each|any|the|my|our)\s+/, '')
    if (next === s) break
    s = next
  }
  if (/^(?:all|everything|every thing|all items|the lot)$/.test(s))
    return { selection, kind: null, colour, frame, tag, text }
  // a colour, then a kind
  const c = new RegExp(`^(${COLOR_RE})(?:\\s+(?:coloured|colored))?(?=\\s|$)`).exec(s)
  if (c) {
    colour = colourWord(c[1] as string)
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
      if (!cc || colour) return null
      colour = colourWord(cc[1] as string)
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
  if (!selection && kind === null && colour === null && frame === null && tag === null && text === null)
    return null
  return { selection, kind: kind === '*' ? null : kind, colour, frame, tag, text }
}

/** A target, else the words as a frame's own name (for zoom, select and find). */
function targetOrFrame(phrase: string): TargetSpec | null {
  const t = parseTarget(phrase)
  // a bare colour word ("sky", "stone") may be a frame's name as well (M3-4: the pickers' names are colour words now)
  const bareColour = !!t && t.colour !== null && !t.selection && !t.kind && !t.frame && !t.tag && !t.text
  if (t && !bareColour) return t
  const explicit = /^(?:the\s+)?(?:frame\s+(?:called\s+|named\s+)?(.+)|(.+?)\s+frame)$/.exec(phrase)
  const name = unquote(explicit ? ((explicit[1] ?? explicit[2]) as string) : phrase.replace(/^the\s+/, ''))
  if (!name || name.length > AI_COMMAND_FRAME_NAME_MAX_CHARS) return t
  return {
    selection: false,
    kind: null,
    colour: null,
    frame: null,
    tag: null,
    text: null,
    frameItself: { name, guess: !explicit },
    ...(t ? { orColour: t } : {}),
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
    const colour = colourWord(m[2] as string)
    return target && colour ? { verb: 'recolor', target, colour } : null
  }
  m = new RegExp(`^(?:make|turn|paint|colou?r|recolou?r)\\s+(?:it\\s+|them\\s+)?(${COLOR_RE})$`).exec(s)
  if (m) {
    const colour = colourWord(m[1] as string)
    return colour ? { verb: 'recolor', target: parseTarget('') as TargetSpec, colour } : null
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

  // lock (a bare "lock" is the Lock or unlock command's)
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
      /** what it will do, in words ('Make 3 Coral notes in “Ideas” Butter') */
      readonly title: string
      /** only selects or moves the camera (a viewer may run it) */
      readonly find: boolean
      /**
       * Only a guess: the words were nothing else, and a frame of that name happens to be on the board ("show grid" with a
       * frame "Grid ideas"). The palette ranks such a line under a command whose name the words are (M3-2, FTU-12).
       */
      readonly guess?: true
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
/** Notes are named by the sticky-note picker; everything else the grammar colours by the style panel's. */
const spaceOf = (kind: KindName): ColourSpace => (kind === 'note' ? 'note' : 'stroke')
/** Whether an item has the colour a target names. */
const hasColour = (i: FactItem, w: ColourWord | null): boolean =>
  w === null || covers(w, i.color, spaceOf(i.kind))
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

/** The colour part of a phrase: the word the person typed (P-012: "yellow", not Butter and Marigold). */
const colourPhrase = (t: TargetSpec): string | null => t.colour?.word ?? null

/** The phrase that names what a target picked: 'selected Coral notes in “Ideas”'. */
function describe(t: TargetSpec, n: number, frameName: string | null): string {
  const parts: string[] = []
  if (t.selection) parts.push('selected')
  const colour = colourPhrase(t)
  if (colour) parts.push(colour)
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
    // M3-4: no frame of that name, and the words are also a bare colour ("zoom to sky"): that colour's items
    if (!f && t.orColour) return resolveCommand({ ...cmd, target: t.orColour }, facts)
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
    return {
      ok: true,
      verb: cmd.verb,
      ops,
      ids: [f.id],
      title: `${verbWord} frame “${f.name}”`,
      find: true,
      ...(t.frameItself.guess ? { guess: true as const } : {}),
    }
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
      hasColour(i, t.colour) &&
      (frame === null || i.frameId === frame.id) &&
      (tagWanted === null || i.tags.some((g) => fold(g) === tagWanted)) &&
      (textWanted === null || fold(i.text).includes(textWanted)),
  )
  let picked =
    cmd.verb === 'recolor'
      ? matched.filter((i) => COLOURABLE.has(i.kind))
      : cmd.verb === 'wrapInFrame'
        ? matched.filter((i) => i.kind !== 'frame')
        : matched
  // M3-4: a word that is no colour of a kind (black on a note: a note's own `black` is Butter) leaves that kind as it is
  const recolour = cmd.verb === 'recolor' && cmd.colour ? cmd.colour : null
  const takesIt = recolour ? picked.filter((i) => destinationIn(recolour, spaceOf(i.kind)) !== null) : picked
  if (recolour && picked.length && !takesIt.length) {
    const nouns = [...new Set(picked.map((i) => KIND_NOUN[i.kind][1]))]
    return {
      ok: false,
      reason: `${capitalised(listWords(nouns, 'and'))} do not come in ${recolour.word}.`,
    }
  }
  picked = takesIt
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
      const word = cmd.colour as ColourWord
      // one op per destination (a note takes the word's note name, everything else its stroke name)
      const byColour = new Map<AiColorName, string[]>()
      for (const i of picked) {
        const color = destinationIn(word, spaceOf(i.kind)) as AiColorName
        byColour.set(color, [...(byColour.get(color) ?? []), i.id])
      }
      const ops = [...byColour].flatMap(([color, group]) =>
        chunked(group, (x) => ({ op: 'recolor', ids: x, color })),
      )
      return done(ops, `Make ${n} ${what} ${word.word}`)
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
