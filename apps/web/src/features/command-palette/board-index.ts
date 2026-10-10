// OWNER: W3 (wave L, L3-2). The board palette's index, built from the live registries each time it opens, so
// every feature's command, tool and panel is in it without a line here:
//  - every registered command (registries.commands): its label, its keys (formatted), its keywords and
//    group, and whether it can run now (commandRunnable: available, the read-only rule, enabled and
//    disabledReason). A read-only role gets only the commands it may run (readOnlyAllowed); one that cannot
//    run now is listed with its reason. It runs through canvas-ux's runCommand(ctx, id, 'palette'), so the
//    undo steps, the export gates and the lock refusals are the menus'.
//  - the toolbar's tools (the built-in ones of this role and the features' tools), the dock panels;
//  - the board's frames (presentation order): the camera goes to the frame, as the Frames panel does;
//  - the templates (editors), inserted as the Templates panel inserts them.
// Not the top bar's items: each is a feature's own component, reached through that feature's commands.
import { TEMPLATE_INFOS } from '@draftroom/templates/plan'
import { isReadonlyRole } from '../../board/access.ts'
import {
  type CanvasFeatureContext,
  type CommandSpec,
  commandRunnable,
  currentPlatform,
  formatChord,
  type Platform,
} from '../../canvas/api/index.ts'
import { runCommand } from '../canvas-ux/ported/commands.ts'
import { goToFrameCamera } from '../canvas-ux/ported/navigation/camera.ts'
import { frameRows } from '../canvas-ux/ported/navigation/model.ts'
import { lastFrameJump } from '../canvas-ux/ported/navigation/state.ts'
import { insertTemplate } from '../canvas-ux/ported/navigation/template-insert.ts'
import { MAIN_TOOLS, OVERFLOW_TOOLS, READONLY_TOOLS } from '../canvas-ux/ported/Toolbar.tsx'
import { PALETTE_COMMAND_ID } from './ids.ts'
import type { PaletteEntry } from './model.ts'

export { PALETTE_COMMAND_ID }

/** A command's group when it names none: by its feature (the id's first part). */
const FEATURE_GROUPS: Readonly<Record<string, string>> = {
  'canvas-ux': 'Edit',
  navigation: 'View',
  comments: 'Comments',
  workshops: 'Facilitate',
  'present-export': 'Present and export',
  'present-live': 'Present and export',
  history: 'History',
  sharing: 'Share',
  people: 'People',
  mindmap: 'Mind map',
  tags: 'Tags',
  ai: 'AI',
  media: 'Media',
  a11y: 'Keyboard',
  'cursor-chat': 'Collaborate',
  flow: 'Flow',
  sort: 'Arrange',
  pieces: 'Insert',
  thumbnails: 'Board',
}

/** Labels that read only inside their menu ('PNG' under Export ▸ Selection): the palette says the whole thing. */
const LABELS: Readonly<Record<string, string>> = {
  'present-export.export-as-png': 'Export as PNG (selection, or the board)',
  'present-export.export-as-svg': 'Export as SVG (selection, or the board)',
  'present-export.export-all-as-png': 'Export the whole board as PNG',
  'present-export.export-all-as-svg': 'Export the whole board as SVG',
  'mindmap.delete': 'Delete mind-map topic',
  'navigation.open-templates': 'Open templates',
}

/** More words for commands that do not carry their own `keywords` yet. */
const KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  'navigation.board-search': ['find', 'look for'],
  'navigation.zoom-to-fit': ['fit', 'whole board', 'everything'],
  'navigation.toggle-minimap': ['map', 'overview'],
  'navigation.arrange-grid': ['tidy', 'grid', 'layout'],
  'present-export.present': ['slides', 'slideshow', 'presentation'],
  'present-export.export': ['download', 'pdf', 'png', 'svg', 'csv'],
  'present-export.print': ['print', 'pdf'],
  'comments.select-tool': ['comment', 'feedback', 'note'],
  'cursor-chat.open': ['chat', 'message', 'say'],
  'mindmap.start': ['mind map', 'mindmap', 'brainstorm'],
}

/**
 * Keys the engine or the key allowlist takes itself, so the commands carry none in the registry (a registered chord
 * would be a second handler). The palette still shows them, as the shortcuts dialog does (ShortcutsDialog BUILT_IN_EDIT);
 * M3-2 (FTU-12): Undo and Redo showed none while Cut did.
 */
const BUILT_IN_KBD: Readonly<Record<string, readonly string[]>> = {
  'canvas-ux.undo': ['mod+z'],
  'canvas-ux.redo': ['mod+shift+z', 'mod+y'],
}

/** A generic reason for a command whose `enabled` says no and that names no `disabledReason`. */
export const NOT_NOW = 'Not available right now'
export const READ_ONLY_REASON = 'You can view this board, not change it'

export function groupOf(cmd: Pick<CommandSpec, 'id' | 'group'>): string {
  if (cmd.group) return cmd.group
  const feature = cmd.id.split('.')[0] ?? ''
  return FEATURE_GROUPS[feature] ?? (feature ? feature[0]?.toUpperCase() + feature.slice(1) : 'Board')
}

/** Why `cmd` cannot run now (null: it can). Its own reason first; else a generic one. */
export function reasonOf(cmd: CommandSpec, ctx: CanvasFeatureContext): string | null {
  // one feature's broken state read never breaks the palette: its line just says it is not available
  try {
    if (commandRunnable(cmd, ctx)) return null
    if (ctx.canvas.readOnly() && !cmd.readOnlyAllowed) return READ_ONLY_REASON
    return cmd.disabledReason?.(ctx) || NOT_NOW
  } catch (e) {
    console.error(`command palette: ${cmd.id} could not say whether it may run`, e)
    return NOT_NOW
  }
}

/** `available`, read safely (a read that throws offers the command; its run is refused as usual). */
function offered(cmd: CommandSpec, ctx: CanvasFeatureContext): boolean {
  try {
    return !cmd.available || cmd.available(ctx)
  } catch {
    return true
  }
}

const kbdOf = (keys: readonly string[] | undefined, platform: Platform): string | undefined =>
  keys?.length ? keys.map((k) => formatChord(k, platform)).join(' or ') : undefined

/** The palette line of one command (null: not offered here, or not for this role). */
export function commandEntry(
  cmd: CommandSpec,
  ctx: CanvasFeatureContext,
  platform: Platform = currentPlatform(),
): PaletteEntry | null {
  if (cmd.id === PALETTE_COMMAND_ID) return null
  if (!offered(cmd, ctx)) return null
  // a read-only role sees only what it may run
  if (ctx.canvas.readOnly() && !cmd.readOnlyAllowed) return null
  const keywords = cmd.keywords ?? KEYWORDS[cmd.id]
  const keys = cmd.kbd?.length ? cmd.kbd : BUILT_IN_KBD[cmd.id]
  return {
    id: `cmd:${cmd.id}`,
    label: LABELS[cmd.id] ?? cmd.label,
    group: groupOf(cmd),
    ...(keys?.length ? { kbd: kbdOf(keys, platform) } : {}),
    ...(keywords ? { keywords } : {}),
    recentKey: `cmd:${cmd.id}`,
    disabledReason: reasonOf(cmd, ctx),
    run: () => {
      runCommand(ctx, cmd.id, 'palette')
    },
  }
}

const TOOL_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  note: ['sticky', 'sticky note', 'post-it'],
  arrow: ['arrow', 'line', 'connect'],
  freedraw: ['draw', 'pencil', 'freehand'],
  rectangle: ['shape', 'box', 'square'],
  ellipse: ['circle', 'oval', 'shape'],
  diamond: ['shape', 'decision'],
  hand: ['pan', 'move the view'],
  select: ['pointer', 'arrow'],
  laser: ['pointer', 'point'],
  frame: ['section', 'slide', 'area'],
  eraser: ['erase', 'rubber'],
}

/** The toolbar's tools for this role: the built-in ones and the features' tools. */
function toolEntries(ctx: CanvasFeatureContext, platform: Platform): PaletteEntry[] {
  const { canvas } = ctx
  const readOnly = canvas.readOnly()
  const out: PaletteEntry[] = []
  const pick = (id: string) => () => {
    canvas.setTool(id)
    canvas.focus({ preventScroll: true })
  }
  for (const t of readOnly ? READONLY_TOOLS : [...MAIN_TOOLS, ...OVERFLOW_TOOLS]) {
    out.push({
      id: `tool:${t.id}`,
      label: `${t.label} tool`,
      group: 'Tools',
      ...(t.key ? { kbd: formatChord(t.key, platform) } : {}),
      keywords: [t.label, ...(TOOL_KEYWORDS[t.id] ?? [])],
      recentKey: `tool:${t.id}`,
      run: pick(t.id),
    })
  }
  for (const t of ctx.registries.tools.list()) {
    if (!t.toolbar || (readOnly && !t.readOnlyAllowed)) continue
    const disabled = t.toolbar.disabled?.(ctx) === true
    const select = t.toolbar.select
    out.push({
      id: `tool:${t.id}`,
      label: `${t.label} tool`,
      group: 'Tools',
      ...(t.kbd?.length ? { kbd: kbdOf(t.kbd, platform) } : {}),
      keywords: [t.label],
      recentKey: `tool:${t.id}`,
      // the button's own explanation stays the toolbar's: here it only says it is not offered now
      disabledReason: disabled ? (t.toolbar.hint?.(ctx, false) ?? NOT_NOW) : null,
      run: select ? () => select(ctx) : pick(t.id),
    })
  }
  return out
}

/** The dock panels this person sees (a panel whose label is a command's already is left to the command). */
function panelEntries(ctx: CanvasFeatureContext, platform: Platform, taken: ReadonlySet<string>) {
  const out: PaletteEntry[] = []
  for (const p of ctx.registries.sorted(ctx.registries.panels)) {
    if (p.visible && !p.visible(ctx)) continue
    if (taken.has(p.label.toLowerCase())) continue
    out.push({
      id: `panel:${p.id}`,
      label: `Open ${p.label}`,
      group: 'Panels',
      ...(p.shortcutHint ? { kbd: formatChord(p.shortcutHint, platform) } : {}),
      keywords: [p.label, 'panel', 'sidebar'],
      recentKey: `panel:${p.id}`,
      run: () => ctx.openPanel(p.id),
    })
  }
  return out
}

/** The board's frames, in presentation order: the camera goes to one (it is not selected), as in the Frames panel. */
export function frameEntries(ctx: CanvasFeatureContext): PaletteEntry[] {
  const { canvas } = ctx
  return frameRows(canvas.items()).map((f, i) => {
    const name = f.name.trim() || `Frame ${i + 1}`
    return {
      id: `frame:${f.id}`,
      label: name,
      group: 'Frames',
      detail: `Frame ${i + 1}${f.skip ? ' · skipped in Present' : ''}`,
      keywords: ['frame', 'go to', 'jump to'],
      run: () => {
        canvas.select([])
        lastFrameJump(canvas).set(f.id)
        goToFrameCamera(canvas, f.id)
      },
    }
  })
}

/** The templates (editors): inserted near the view as the Templates panel inserts them, one undo step. */
function templateEntries(ctx: CanvasFeatureContext): PaletteEntry[] {
  if (isReadonlyRole(ctx.role, ctx.board.status) || ctx.canvas.readOnly()) return []
  return TEMPLATE_INFOS.map((t) => ({
    id: `template:${t.id}`,
    label: `Add template: ${t.name}`,
    group: 'Templates',
    detail: t.description,
    keywords: [t.name, 'template', t.category, ...t.sections],
    recentKey: `template:${t.id}`,
    run: () => {
      const { canvas } = ctx
      setTimeout(() => {
        canvas.viewport.remeasure()
        void insertTemplate(canvas, t.id).then((result) => {
          if (!result.ok) {
            ctx.notify({
              key: 'template-insert',
              tone: 'error',
              text:
                result.reason === 'readonly'
                  ? 'You can view this board but not add templates to it.'
                  : result.reason === 'too-many-shapes'
                    ? 'This board has too many objects to add this template.'
                    : 'The template could not be added.',
            })
            return
          }
          canvas.focus({ preventScroll: true })
          ctx.notify({
            key: 'template-insert',
            text: `Added “${t.name}”. Undo removes it.`,
            testId: 'template-inserted',
          })
        })
      }, 0)
    },
  }))
}

// ---- M3-2: what an empty palette starts with ------------------------------------------------------------------------

/**
 * "Try", in the order an empty palette tells it: what wave L offers, which an empty field used to hide behind Undo and
 * Redo and a screenful of greyed lines (FTU-4). Each is a line of the index (by its id) that gets a place in the section
 * and, where the command's own name is short, words that say what it does. A line the index does not have (the AI is off
 * for this person, a viewer, a guest, a command a later wave registers) is simply not in the section, and so is one that
 * cannot run for no reason worth telling (the generic "not available right now").
 */
export const STARTERS: readonly { readonly id: string; readonly label: string; readonly detail: string }[] = [
  {
    id: 'cmd:ai.recap',
    label: 'Wrap up this board',
    detail: 'A private recap of what was decided, and the actions',
  },
  {
    id: 'cmd:ai.ask',
    label: 'Ask this board',
    detail: 'A question in your own words, answered with sources',
  },
  { id: 'cmd:flow.diagram', label: 'Diagram from words', detail: 'Describe a process and get a flowchart' },
  { id: 'cmd:sort.colour', label: 'Sort notes', detail: 'Group notes by colour, author, tag or votes' },
  { id: 'cmd:navigation.open-templates', label: 'Templates', detail: 'Start from a ready-made layout' },
  {
    id: 'panel:history',
    label: 'Time travel',
    detail: 'Bring back just what you need from an earlier version',
  },
  // W8's command, once it is registered and reports itself available (it is then enabled; a disabled one is left out)
  {
    id: 'cmd:ai.askWorkspace',
    label: 'Ask all boards',
    detail: 'One question across every board you can open',
  },
]

const ALWAYS_RUNNABLE_STARTERS: ReadonlySet<string> = new Set(['cmd:ai.askWorkspace'])

/** `list` with the starters marked (see STARTERS); the lines themselves are the index's. */
export function withStarters(list: readonly PaletteEntry[]): PaletteEntry[] {
  const marks = new Map<string, NonNullable<PaletteEntry['starter']>>()
  STARTERS.forEach((s, rank) => {
    const e = list.find((x) => x.id === s.id)
    if (!e || e.disabledReason === NOT_NOW) return
    if (ALWAYS_RUNNABLE_STARTERS.has(s.id) && e.disabledReason) return
    marks.set(s.id, { rank, label: s.label, detail: s.detail })
  })
  return list.map((e) => {
    const starter = marks.get(e.id)
    return starter ? { ...e, starter } : e
  })
}

/** Every line of the board's palette for this person, now. */
export function boardEntries(
  ctx: CanvasFeatureContext,
  platform: Platform = currentPlatform(),
): PaletteEntry[] {
  const commands: PaletteEntry[] = []
  // a panel a command already opens ('Search board', 'Templates') is left to the command
  const taken = new Set<string>()
  for (const cmd of ctx.registries.commands.list()) {
    const e = commandEntry(cmd, ctx, platform)
    if (!e) continue
    commands.push(e)
    taken.add(e.label.toLowerCase())
    taken.add(cmd.label.toLowerCase())
  }
  return withStarters([
    ...commands,
    ...toolEntries(ctx, platform),
    ...panelEntries(ctx, platform, taken),
    ...frameEntries(ctx),
    ...templateEntries(ctx),
  ])
}
