// OWNER: WS2 (wave T, Script to boards). "Break down with AI": the pasted script through the AI route's `storyboard`
// action (features/ai/ported/public.ts runAi: the same gate, "Sends … to OpenAI" notice, busy pill, budgets and error
// notices as every AI action). Text only: no image is made. The dialog closes while the call runs (the notice and
// the busy pill must be reachable) and opens again on the panels, which go into the same editable preview as the
// parser's; what Create then makes carries `lobby.ai` ({by, run}). A refused or failed call opens the dialog again
// as it was (runAi has said why).
import {
  AI_STORYBOARD_MAX_PANELS,
  AI_STORYBOARD_SCRIPT_MAX_CHARS,
  type AiRunInput,
} from '@draftroom/contracts'
import type { CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import { canBuildWithAi } from '../ai/ported/gate.ts'
import { runAi } from '../ai/ported/public.ts'
import { aiStatus } from '../ai/ported/runtime.ts'
import { planningOffered } from '../planning/index.ts'
import { type Beat, spokenMs } from './script/parse.ts'
import { type ScriptDraft, sbState } from './state.ts'

/** Whether "Break down with AI" is offered: its switch, a rev-14 room, AI on for this editor here. */
export function aiOffered(canvas: LobbyCanvas): boolean {
  return planningOffered('storyboardAi', canvas) && canBuildWithAi(aiStatus(canvas).get(), canvas.readOnly())
}

/** Why the AI breakdown cannot run on this draft, in words, or null. */
export function aiBlocked(draft: Pick<ScriptDraft, 'text'>): string | null {
  const t = draft.text.trim()
  if (!t) return 'Paste a script first'
  if (t.length > AI_STORYBOARD_SCRIPT_MAX_CHARS)
    return `AI reads up to ${AI_STORYBOARD_SCRIPT_MAX_CHARS.toLocaleString('en')} characters`
  return null
}

export async function breakDownWithAi(ctx: CanvasFeatureContext, draft: ScriptDraft): Promise<boolean> {
  const s = sbState(ctx.canvas)
  if (aiBlocked(draft) || s.aiBusy.get()) return false
  s.dialog.set(null)
  s.aiBusy.set(true)
  try {
    const input = {
      action: 'storyboard',
      script: draft.text.trim(),
      aspect: draft.aspect,
      maxPanels: AI_STORYBOARD_MAX_PANELS,
    } as AiRunInput
    const result = await runAi(ctx, input)
    if (result?.action !== 'storyboard' || !result.panels.length) {
      s.dialog.set({ kind: 'script', draft })
      return false
    }
    const beats: Beat[] = result.panels.map((p) => ({
      camera: p.camera,
      action: p.action,
      dialogue: p.dialogue,
      sfx: p.sfx,
      durationMs: p.durationMs ?? spokenMs(p.dialogue),
    }))
    s.dialog.set({
      kind: 'script',
      draft: { ...draft, beats, ai: { by: ctx.me.user.id, run: result.runId ?? null } },
    })
    if (result.truncated)
      ctx.notify({
        key: 'storyboard:ai',
        text: 'AI read the first part of the script only: it was longer than one breakdown takes.',
      })
    return true
  } finally {
    s.aiBusy.set(false)
  }
}
