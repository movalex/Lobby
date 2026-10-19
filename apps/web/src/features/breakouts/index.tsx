// OWNER: WS4 (wave V, breakouts; docs/WAVE-V-CONTRACTS.md §4.4). The 'breakouts' feature on the Excalidraw board page:
//   - the Breakouts dock panel (./Panel.tsx): the setup for a facilitator, the groups × people while they run;
//   - the chip in the top-centre slot 'breakout' (./Chip.tsx): "Group 2 · 8:30 left · Go to my frame";
//   - the Facilitate menu's "Breakouts" entry and its pill part ("Group 2 · 8:30"), through the menu's registry
//     (../workshops/ported/facilitate-entries.ts: WorkshopBar.tsx is not edited);
//   - the camera: to this person's frame when breakouts start or they are moved, and following the facilitator after a
//     summon of their own group (./camera.ts; contracts breakoutSummonApplies, so a summon of another group never
//     moves this camera, whatever reached this page);
//   - a toast for each message the facilitator sends (to everyone, or to this person's group: the api sends a group's
//     message to that group only);
//   - "Only show my group's cursors" (./cursors.ts: this screen only);
//   - the recap's 'breakouts' section (groups, member counts, duration: no names) and the palette's breakouts.start
//     (held while the contracts list it pending, as ai.capture was).
// It runs only while its web switch (features/live LIVE_FLAGS.breakouts) AND the api's DRAFTROOM_BREAKOUTS are on: off,
// it makes no request and draws nothing. Nothing here writes to the board except "Make N frames" (./frames.ts, one
// undo step), and nothing touches presence or the sync protocol. Editing is not fenced to a group's frame.
import { PENDING_PALETTE_COMMAND_IDS } from '@draftroom/contracts'
import type {
  CanvasFeature,
  CanvasFeatureContext,
  CanvasPanelSpec,
  CommandSpec,
} from '../../canvas/api/index.ts'
import { react, untracked, useValue } from '../../lib/signals.ts'
import { registerRecapSource } from '../ai/recap/sources.ts'
import { liveEnabled, liveFlags } from '../live/index.ts'
import {
  type FacilitateItemProps,
  registerFacilitateEntry,
  setFacilitatePill,
} from '../workshops/ported/facilitate-entries.ts'
import { BREAKOUTS_PANEL_ID, BreakoutChipLayer } from './Chip.tsx'
import { followPerson, goToFrame } from './camera.ts'
import { breakoutsClient } from './client.ts'
import { cursorFilter, onlyMyGroupOf, visibleUsers } from './cursors.ts'
import { clockText, groupOf, pillPart, remainingMs } from './model.ts'
import { BreakoutsPanel, facilitatorHere } from './Panel.tsx'
import { recapSection } from './recap.ts'
import { BreakoutStore, breakoutStoreOf, setBreakoutStore } from './store.ts'

type Ctx = CanvasFeatureContext

export const BREAKOUTS_COMMAND_ID = 'breakouts.start'
/** Whether the contracts still hold 'breakouts.start' pending (then the palette does not offer it). */
export const breakoutsCommandHeld = (pending: readonly string[] = PENDING_PALETTE_COMMAND_IDS): boolean =>
  pending.includes(BREAKOUTS_COMMAND_ID)

const runningOn = (ctx: Pick<Ctx, 'canvas'>) =>
  breakoutStoreOf(ctx.canvas)?.state.get()?.session?.status === 'running'
const offeredOn = (ctx: Pick<Ctx, 'canvas'>) =>
  liveEnabled('breakouts') && (breakoutStoreOf(ctx.canvas)?.available.get() ?? false)

function BreakoutsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor">
      <rect x="3" y="4" width="7.5" height="7" rx="1.5" strokeWidth="1.8" />
      <rect x="13.5" y="4" width="7.5" height="7" rx="1.5" strokeWidth="1.8" />
      <rect x="3" y="13.5" width="7.5" height="7" rx="1.5" strokeWidth="1.8" />
      <rect x="13.5" y="13.5" width="7.5" height="7" rx="1.5" strokeWidth="1.8" />
    </svg>
  )
}

export const BREAKOUTS_PANEL: CanvasPanelSpec = {
  id: BREAKOUTS_PANEL_ID,
  label: 'Breakouts',
  icon: BreakoutsIcon,
  // after Voting (40) and Private brainstorm (45)
  order: 46,
  visible: (ctx) => offeredOn(ctx) && (facilitatorHere(ctx) || runningOn(ctx)),
  component: BreakoutsPanel,
}

const COMMANDS: readonly CommandSpec[] = [
  {
    id: BREAKOUTS_COMMAND_ID,
    label: 'Breakouts',
    group: 'Facilitate',
    keywords: ['breakout', 'breakouts', 'groups', 'rooms', 'split', 'teams'],
    disabledReason: (ctx) =>
      !offeredOn(ctx)
        ? 'Breakouts are not available here'
        : !facilitatorHere(ctx)
          ? 'Breakouts are run by editors with an account'
          : null,
    run: (ctx) => ctx.openPanel(BREAKOUTS_PANEL_ID),
  },
]

/** The Facilitate menu's entry: opens the panel (a facilitator: setup or the groups; anyone: their group). */
function FacilitateItem({ ctx, close }: FacilitateItemProps) {
  const store = breakoutStoreOf(ctx.canvas)
  const s = useValue('dr-brk-item', () => breakoutStoreOf(ctx.canvas)?.state.get() ?? null, [ctx.canvas])
  const running = s?.session?.status === 'running'
  const left = running && s?.session && store ? remainingMs(s.session, store.serverNow()) : null
  const mine = s ? groupOf(s, s.myGroupId) : null
  const meta = running
    ? [mine?.name ?? `${s?.session?.groups.length ?? 0} groups`, left === null ? null : clockText(left)]
        .filter(Boolean)
        .join(' · ')
    : ''
  return (
    <button
      type="button"
      role="menuitem"
      className="dr-wk-menu__item"
      data-testid="breakouts-entry"
      onClick={() => {
        close(false)
        ctx.openPanel(BREAKOUTS_PANEL_ID)
      }}
    >
      <span className="dr-wk-menu__icon" aria-hidden="true">
        <BreakoutsIcon />
      </span>
      <span className="dr-wk-menu__label">Breakouts</span>
      {meta && <span className="dr-wk-menu__meta">{meta}</span>}
    </button>
  )
}

const PANELS_CHANGED_EVENT = 'lobby:panels-changed'

/** Everything that runs while breakouts are offered on this page (the switches on); returns its cleanup. */
function mountLive(ctx: Ctx): () => void {
  const { canvas } = ctx
  const offs: (() => void)[] = []
  let cancelFollow: (() => void) | null = null
  const store = new BreakoutStore({
    client: breakoutsClient(ctx.api),
    boardId: ctx.board.id,
    userId: ctx.me.user.id,
    events: ctx.events,
    onMyGroup: (state, groupId) => {
      const g = groupOf(state, groupId)
      if (!g) return
      goToFrame(canvas, g.frameId)
      ctx.notify({ key: 'breakout-group', text: `You are in ${g.name}.`, testId: 'breakout-group-toast' })
    },
    onBroadcast: (ev) => {
      const group = ev.groupId ? groupOf(store.state.get() ?? { session: null }, ev.groupId) : null
      ctx.notify({
        key: 'breakout-broadcast',
        text: `${ev.from.name}${group ? ` to ${group.name}` : ''}: ${ev.text}`,
        testId: 'breakout-broadcast-toast',
        timeoutMs: 15_000,
      })
    },
    onSummon: (ev) => {
      cancelFollow?.()
      cancelFollow = followPerson(canvas, ev.userId, ev.screen, (ok) =>
        ctx.notify({
          key: 'breakout-summon',
          text: ok
            ? `${ev.name} brought your group to their view. Click the board to look around on your own.`
            : `${ev.name} asked your group to follow their view, but it isn't available here yet.`,
          testId: 'breakout-summon-toast',
        }),
      )
    },
  })
  setBreakoutStore(canvas, store)
  offs.push(store.connect())
  void store.refresh()
  offs.push(() => {
    cancelFollow?.()
    setBreakoutStore(canvas, null)
    setFacilitatePill(canvas, 'breakouts', null)
  })

  // the Facilitate menu's entry
  offs.push(
    registerFacilitateEntry({
      id: 'breakouts',
      order: 300,
      shown: ({ ctx: c, facilitator }) => offeredOn(c) && (facilitator || runningOn(c)),
      Item: FacilitateItem,
    }),
  )

  // the pill ("Group 2 · 8:30"), redrawn when its text changes
  let pill = ''
  const drawPill = () => {
    const part = pillPart(store.state.get(), store.serverNow())
    const key = part ? `${part.text}|${part.spoken}` : ''
    if (key === pill) return
    pill = key
    setFacilitatePill(canvas, 'breakouts', part)
  }
  offs.push(react('dr-brk-pill', drawPill))
  const tick = setInterval(drawPill, 1000)
  offs.push(() => clearInterval(tick))

  // the dock shows the panel to participants only while breakouts run: tell it when that changes
  let wasRunning = false
  offs.push(
    react('dr-brk-dock', () => {
      const now = store.state.get()?.session?.status === 'running' && store.available.get()
      if (now === wasRunning) return
      wasRunning = now
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(PANELS_CHANGED_EVENT))
    }),
  )

  // "Only show my group's cursors"
  let unprovide: (() => void) | null = null
  offs.push(
    react('dr-brk-cursors', () => {
      const users = visibleUsers(store.state.get(), onlyMyGroupOf(canvas).get())
      unprovide?.()
      unprovide = null
      if (!users) return
      const uidOf = (sid: string) =>
        canvas.presence.peer(sid)?.uid ?? canvas.collaborators().find((c) => c.sid === sid)?.uid ?? null
      unprovide = ctx.registries.cursorVisible.provide(cursorFilter(users, uidOf))
    }),
  )
  offs.push(() => {
    unprovide?.()
    unprovide = null
  })

  // the recap's section (from what this page holds: no request, so no late joiner is placed by a recap)
  offs.push(
    registerRecapSource({
      id: 'breakouts',
      order: 300,
      collect: async (input) => recapSection(breakoutStoreOf(input.ctx.canvas)?.state.get() ?? null, input),
    }),
  )
  return () => {
    for (const off of offs.splice(0).reverse()) off()
  }
}

function mount(ctx: Ctx): (() => void) | undefined {
  // the web switch off: nothing at all (no request, nothing drawn)
  if (!liveFlags().breakouts) return undefined
  let live: (() => void) | null = null
  // the api's switch arrives with the auth config (features/live liveSwitches): mount when it says on
  const off = react('dr-brk-mount', () => {
    const on = liveEnabled('breakouts')
    if (on && !live) live = untracked(() => mountLive(ctx))
    else if (!on && live) {
      live()
      live = null
    }
  })
  return () => {
    off()
    live?.()
    live = null
  }
}

export const feature: CanvasFeature = {
  id: 'breakouts',
  panels: [BREAKOUTS_PANEL],
  overlays: [
    // in the top-centre stack (slot 'breakout'); the layer takes no pointer, the chip's buttons do
    { id: 'breakouts.chip', layer: 'screen', order: 55, pointer: 'none', component: BreakoutChipLayer },
  ],
  commands: breakoutsCommandHeld() ? [] : COMMANDS,
  onMount: mount,
}
