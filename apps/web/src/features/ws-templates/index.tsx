// OWNER: W8 (wave M, M8-4). The 'ws-templates' feature on the Excalidraw board page: "Save as workspace
// template…" in the board menu (Board ▸) and the palette (command 'ws-templates.save'), offered to a creator who
// is an owner or admin of the board's workspace (./model.ts canSaveWsTemplate; the api decides the same again).
// It opens ./SaveTemplateDialog.tsx. Starting a board from a template is the dashboard picker's Workspace tab
// (dashboard/TemplateGallery.tsx). An api without templates (a 404 to the list) hides the command for the tab.
import type {
  CanvasFeature,
  CanvasFeatureContext,
  CommandSpec,
  MenuEntrySpec,
} from '../../canvas/api/index.ts'
import { type Atom, atom, useValue } from '../../lib/signals.ts'
import { wsTemplatesMissing } from './client.ts'
import { canSaveWsTemplate } from './model.ts'
import { SaveTemplateDialog } from './SaveTemplateDialog.tsx'

/** The command W8 registers (contracts usage.ts PALETTE_COMMAND_IDS). */
export const WS_TEMPLATES_SAVE_COMMAND_ID = 'ws-templates.save'

/** Whether the dialog is open, per board page (a WeakMap: a closed board leaves nothing behind). */
const dialogs = new WeakMap<object, Atom<boolean>>()
const dialogOf = (ctx: CanvasFeatureContext): Atom<boolean> => {
  let a = dialogs.get(ctx.canvas)
  if (!a) {
    a = atom('ws-templates.dialog', false)
    dialogs.set(ctx.canvas, a)
  }
  return a
}

/** The rule, from what the board page knows (Me, the board). */
export const saveOffered = (ctx: CanvasFeatureContext): boolean =>
  canSaveWsTemplate({
    access: ctx.me.access,
    workspaceRole: ctx.me.workspaces.find((w) => w.id === ctx.workspace.id)?.role ?? null,
    boardStatus: ctx.board.status,
    missing: wsTemplatesMissing(ctx.workspace.id),
  })

export const COMMANDS: readonly CommandSpec[] = [
  {
    id: WS_TEMPLATES_SAVE_COMMAND_ID,
    label: 'Save as workspace template…',
    group: 'Board',
    keywords: ['template', 'team template', 'reuse', 'retro', 'kickoff'],
    // it changes nothing on the board (an archived board can be a template too)
    readOnlyAllowed: true,
    available: saveOffered,
    run: (ctx) => {
      if (saveOffered(ctx)) dialogOf(ctx).set(true)
    },
  },
]

export const MAIN_MENU: readonly MenuEntrySpec[] = [
  {
    id: WS_TEMPLATES_SAVE_COMMAND_ID,
    group: 'board',
    order: 57,
    label: 'Save as workspace template…',
    command: WS_TEMPLATES_SAVE_COMMAND_ID,
    visible: saveOffered,
  },
]

function SaveTemplateOverlay({ ctx }: { ctx: CanvasFeatureContext }) {
  const open = useValue(dialogOf(ctx))
  if (!open) return null
  return (
    <SaveTemplateDialog
      ctx={ctx}
      onClose={() => {
        dialogOf(ctx).set(false)
        ctx.canvas.focus({ preventScroll: true })
      }}
    />
  )
}

export const feature: CanvasFeature = {
  id: 'ws-templates',
  commands: COMMANDS,
  mainMenu: MAIN_MENU,
  overlays: [
    { id: 'ws-templates.save', layer: 'screen', order: 30, pointer: 'auto', component: SaveTemplateOverlay },
  ],
}
