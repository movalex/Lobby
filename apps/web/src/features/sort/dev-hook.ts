// Dev-auth builds only (the e2e build): `window.__lobbySort`, so the specs can run this feature's commands and
// stand in for what is not on the page in every build: W2's runAi and showAiPreview (they answer null and
// 'discard' until the AI feature's bodies land; a spec says what the AI "returned" and what the person chose).
// Never installed in a normal build.
import type { AiResult, AiRunInput } from '@draftroom/contracts'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { DEV_AUTH_ENABLED } from '../../lib/identity.ts'
import { setSortDeps } from './deps.ts'
import type { SortDevHook } from './dev-hook-types.ts'
import { sortMenu } from './state.ts'

const RUN_ID = 'air_L8L8L8L8L8L8L8L8L8L8'
const refToId = (r: string) => (r.startsWith('shape:') ? r.slice(6) : r)

export function installSortDevHook(ctx: CanvasFeatureContext): () => void {
  if (!DEV_AUTH_ENABLED) return () => {}
  const requests: AiRunInput[] = []
  const previews: { title: string; summary: string; moves: number }[] = []
  const hook: SortDevHook = {
    async run(commandId, args) {
      const cmd = ctx.registries.commands.get(commandId)
      if (!cmd) return false
      if (ctx.canvas.readOnly() && !cmd.readOnlyAllowed) return false
      if (cmd.enabled && !cmd.enabled(ctx)) return false
      if (cmd.disabledReason && cmd.disabledReason(ctx) !== null) return false
      await cmd.run(ctx, 'api', args)
      return true
    },
    menu() {
      const m = sortMenu(ctx.canvas).get()
      return m ? { view: m.view, ids: m.ids } : null
    },
    fakeAi(config) {
      if (config === null) {
        setSortDeps(null)
        return
      }
      const runId = config.runId ?? RUN_ID
      setSortDeps({
        runAi: async (_ctx, input) => {
          requests.push(input)
          const common = { truncated: false, budget: null, runId }
          if (input.action === 'sort') {
            const ids = input.shapeIds.map(refToId)
            const half = Math.ceil(ids.length / 2)
            const themes = config.themes ?? [
              { name: 'Sooner', ids: ids.slice(0, half) },
              { name: 'Later', ids: ids.slice(half) },
            ]
            return {
              action: 'sort',
              lens: input.lens,
              themes: themes.map((t) => ({ name: t.name, noteIds: t.ids.map((i) => `shape:${i}`) })),
              ...common,
            } as AiResult
          }
          if (input.action === 'score') {
            const ids = input.shapeIds.map(refToId)
            return {
              action: 'score',
              axes: input.axes,
              scores: ids.map((id, k) => {
                if (config.unscored?.includes(id)) return { id: `shape:${id}`, x: 0, y: 0, unscored: true }
                const s = config.scores?.[id]
                return {
                  id: `shape:${id}`,
                  x: s ? s[0] : k % 2 ? 3 : -3,
                  y: s ? s[1] : k % 4 < 2 ? 3 : -3,
                }
              }),
              ...common,
            } as AiResult
          }
          return null
        },
        showAiPreview: async (_ctx, plan) => {
          previews.push({ title: plan.title, summary: plan.summary, moves: plan.moves.length })
          return config.preview ?? 'apply'
        },
      })
    },
    requests: () => requests,
    previews: () => previews,
  }
  window.__lobbySort = hook
  return () => {
    if (window.__lobbySort === hook) delete window.__lobbySort
    setSortDeps(null)
  }
}
