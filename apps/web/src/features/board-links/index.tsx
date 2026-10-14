// OWNER: WS7 (wave N, links between boards, PWR-10). The 'board-links' feature on the Excalidraw board page:
//  - N7-1 board cards: a pasted board URL becomes a board card (file-card/ported/link-cards.tsx, the media feature's
//    URL handler; here only the pasted relative path `/b/<id>[?el=<id>]`, which arrives as text), and the palette
//    command 'board-links.insert' opens a picker over the boards this person can open in this workspace (the
//    api's permission-filtered board list, GET /api/workspaces/:wid/boards) and places the chosen one's card at the
//    view's centre. Nothing about the target is stored but its path.
//  - N7-2 faces: drawn by the media feature's scene layer (file-card/ported/CardLayer.tsx) with ./BoardCardFace.tsx.
//  - N7-5 "Linked from": the navigation panel's section (canvas-ux NavigationPanel.tsx, ./backlinks.ts) and the palette
//    command 'board-links.backlinks', a list of the boards that link here, each with "Go to the link".
// Both lists use the command palette's dialog (features/command-palette/Palette.tsx). Every role may open "Linked
// from" (a viewer finds the boards too); only people who can edit insert cards; a name-only guest is never offered
// "Linked from" (the api refuses them: GUEST_REFUSED_ROUTES).
import { BOARD_LINK_PATH_PATTERN, boardLinkPath } from '@draftroom/contracts'
import { useEffect, useMemo, useState } from 'react'
import type {
  CanvasFeature,
  CanvasFeatureContext,
  ContentHandlerSpec,
  LobbyCanvas,
} from '../../canvas/api/index.ts'
import { canBoardCard, placeBoardCard } from '../../file-card/ported/link-cards.tsx'
import { knownUserKind } from '../../invite/guest.tsx'
import { type Atom, atom, useValue } from '../../lib/signals.ts'
import { countUsage } from '../../lib/usage.ts'
import type { PaletteEntry } from '../command-palette/model.ts'
import { Palette } from '../command-palette/Palette.tsx'
import {
  BACKLINKS_EARLY_DELAY_MS,
  backlinkPath,
  backlinksStoreOf,
  linkedFromLabel,
  useBacklinks,
} from './backlinks.ts'
import { BOARD_LINKS_BACKLINKS_COMMAND_ID, BOARD_LINKS_INSERT_COMMAND_ID } from './model.ts'
import { openBoardPath, openFrom } from './open.ts'
import './board-links.css'

/** At most this many boards are offered by the insert picker (typing narrows them). */
export const PICKER_MAX_BOARDS = 500

type PickerMode = 'insert' | 'backlinks'
interface PickerState {
  readonly key: number
  readonly mode: PickerMode
}

const pickers = new WeakMap<LobbyCanvas, Atom<PickerState | null>>()
let opened = 0

/** The board-links picker of one board page (null: closed). */
export function pickerState(canvas: LobbyCanvas): Atom<PickerState | null> {
  let a = pickers.get(canvas)
  if (!a) {
    a = atom<PickerState | null>('board-links.picker', null)
    pickers.set(canvas, a)
  }
  return a
}

export function openPicker(ctx: CanvasFeatureContext, mode: PickerMode): void {
  if (mode === 'backlinks') countUsage('boardlinks.backlinks')
  pickerState(ctx.canvas).set({ key: ++opened, mode })
}

const isGuest = (ctx: CanvasFeatureContext) => knownUserKind(ctx.me.user.id) === 'guest'

/** The pasted text is exactly a Lobby-relative board path (a URL arrives as `url` and goes to the link cards). */
export function relativeBoardPath(text: string): string | null {
  const t = text.trim()
  const m = BOARD_LINK_PATH_PATTERN.exec(t)
  return m?.[1] ? boardLinkPath(m[1], m[2] ?? null) : null
}

export const relativeBoardPathHandler: ContentHandlerSpec = {
  id: 'board-links.relative-path',
  kinds: ['text'],
  // before the bulk paste (50), which would make the line a note
  priority: 60,
  handle(content, ctx, at) {
    if (content.kind !== 'text') return false
    const link = relativeBoardPath(content.text)
    if (!link || !canBoardCard(ctx, link)) return false
    placeBoardCard(ctx, link, at)
    return true
  },
}

// ---- the pickers ------------------------------------------------------------------------------------------------

function closePicker(ctx: CanvasFeatureContext) {
  pickerState(ctx.canvas).set(null)
  requestAnimationFrame(() => {
    const a = document.activeElement
    if (!a || a === document.body) ctx.canvas.focus({ preventScroll: true })
  })
}

function runAfterClose(ctx: CanvasFeatureContext, entry: PaletteEntry) {
  closePicker(ctx)
  setTimeout(() => {
    try {
      entry.run()
    } catch (e) {
      console.error(`board links: ${entry.id} failed`, e)
    }
  }, 0)
}

function InsertPicker({ ctx }: { ctx: CanvasFeatureContext }) {
  const [boards, setBoards] = useState<readonly PaletteEntry[] | null>(null)
  useEffect(() => {
    const ac = new AbortController()
    ctx.api
      .listBoards(ctx.workspace.id, {}, ac.signal)
      .then((list) =>
        setBoards(
          list
            .filter((b) => b.id !== ctx.board.id)
            .slice(0, PICKER_MAX_BOARDS)
            .map((b) => ({
              id: `board:${b.id}`,
              label: b.title,
              group: 'Boards',
              run: () => {
                if (canBoardCard(ctx, boardLinkPath(b.id))) placeBoardCard(ctx, boardLinkPath(b.id), null)
              },
            })),
        ),
      )
      .catch(() => {
        if (!ac.signal.aborted) setBoards([])
      })
    return () => ac.abort()
  }, [ctx])
  const entries = useMemo(
    () =>
      boards ?? [
        {
          id: 'board-links:loading',
          label: 'Loading your boards…',
          group: 'Boards',
          disabledReason: 'Still loading',
          run: () => {},
        },
      ],
    [boards],
  )
  return (
    <Palette
      label="Link a board"
      placeholder="Find a board to link to…"
      entries={boards && !boards.length ? NO_BOARDS : entries}
      recents={[]}
      onChoose={(entry) => runAfterClose(ctx, entry)}
      onClose={() => closePicker(ctx)}
    />
  )
}

const NO_BOARDS: readonly PaletteEntry[] = [
  {
    id: 'board-links:none',
    label: 'No other board to link to',
    group: 'Boards',
    disabledReason: 'Create another board first',
    run: () => {},
  },
]

function BacklinksPicker({ ctx }: { ctx: CanvasFeatureContext }) {
  const store = backlinksStoreOf(ctx.registries, ctx.board.id)
  useEffect(() => {
    void store.refresh({ force: true })
  }, [store])
  const list = useValue('board-links.picker-list', () => store.state.get().list, [store])
  const entries = useMemo((): readonly PaletteEntry[] => {
    if (!list?.length)
      return [
        {
          id: 'board-links:no-backlinks',
          label: 'No board you can open links here',
          group: 'Linked from',
          disabledReason: 'Nothing links here yet',
          run: () => {},
        },
      ]
    return list.map((b) => ({
      id: `backlink:${b.boardId}`,
      label: b.title,
      group: 'Linked from',
      detail: 'Go to the link',
      run: () => openBoardPath(backlinkPath(b), 'here', openFrom(ctx)),
    }))
  }, [list, ctx])
  return (
    <Palette
      label="Linked from"
      placeholder="Boards that link to this one…"
      entries={entries}
      recents={[]}
      onChoose={(entry) => runAfterClose(ctx, entry)}
      onClose={() => closePicker(ctx)}
    />
  )
}

function PickerOverlay({ ctx }: { ctx: CanvasFeatureContext }) {
  const open = useValue('board-links.picker', () => pickerState(ctx.canvas).get(), [ctx.canvas])
  if (!open) return null
  return open.mode === 'insert' ? (
    <InsertPicker key={open.key} ctx={ctx} />
  ) : (
    <BacklinksPicker key={open.key} ctx={ctx} />
  )
}

/**
 * P-018: "Linked from N" in the top bar, once the api says boards link here (nothing while it does not, for a
 * name-only guest, or when it cannot say). It opens the same list as the palette command. Asked as soon as the
 * board is ready.
 */
function LinkedFromTopBar({ ctx }: { ctx: CanvasFeatureContext }) {
  const list = useBacklinks(ctx, !isGuest(ctx), BACKLINKS_EARLY_DELAY_MS)
  if (!list?.length) return null
  const label = linkedFromLabel(list.length)
  return (
    <button
      type="button"
      className="dr-btn dr-btn--sm dr-linked-from-top"
      data-testid="linked-from-top"
      aria-label={label}
      title={label}
      onClick={() => openPicker(ctx, 'backlinks')}
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
      </svg>
      <span>Linked from {list.length}</span>
    </button>
  )
}

/** The boards that link here, as the board menu and the top bar know them now (empty: unknown or none). */
const knownBacklinks = (ctx: CanvasFeatureContext) =>
  isGuest(ctx) ? [] : (backlinksStoreOf(ctx.registries, ctx.board.id).state.get().list ?? [])

export const feature: CanvasFeature = {
  id: 'board-links',
  topBar: [
    {
      id: 'board-links.linked-from-top',
      order: 14,
      overflowCaption: 'Linked from',
      component: LinkedFromTopBar,
    },
  ],
  mainMenu: [
    {
      // P-018: where the boards that link here are found, next to Catch me up
      id: 'board-links.linked-from',
      group: 'board',
      order: 57,
      label: (ctx) => linkedFromLabel(knownBacklinks(ctx).length),
      visible: (ctx) => knownBacklinks(ctx).length > 0,
      run: (ctx) => openPicker(ctx, 'backlinks'),
    },
  ],
  commands: [
    {
      id: BOARD_LINKS_INSERT_COMMAND_ID,
      label: 'Link to another board',
      group: 'Insert',
      keywords: ['board link', 'board card', 'link board', 'connect boards'],
      disabledReason: (ctx) => (ctx.canvas.readOnly() ? 'You can view this board but not add to it' : null),
      run: (ctx) => openPicker(ctx, 'insert'),
    },
    {
      id: BOARD_LINKS_BACKLINKS_COMMAND_ID,
      label: 'Linked from: boards that link here',
      group: 'Navigate',
      keywords: ['backlinks', 'linked from', 'links here', 'board links'],
      readOnlyAllowed: true,
      available: (ctx) => !isGuest(ctx),
      run: (ctx) => openPicker(ctx, 'backlinks'),
    },
  ],
  contentHandlers: [relativeBoardPathHandler],
  overlays: [
    { id: 'board-links-picker', layer: 'screen', order: 61, pointer: 'auto', component: PickerOverlay },
  ],
}
