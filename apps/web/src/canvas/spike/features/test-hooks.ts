// `window.lobbySpikeFeatures`: the spike B specs' handle on O5's features (b5-r2-*, b7-*, b12-*), next to
// O3's `window.lobbyCanvas` facade and behind the same dev-auth guard (the spike board page exists only
// with VITE_LOBBY_ENGINE=excalidraw and the guard; the check is repeated here). Every write goes through
// the features' own paths (CanvasPort.transact, the engine core's setDoc, the api), never straight into
// the engine, so specs test what the UI does. Return values are JSON-serializable.
import { DEV_AUTH_ENABLED } from '../../../lib/identity.ts'
import { overridesOf } from '../../overrides.ts'
import { setCollapsed } from './mindmap.tsx'
import { mindmapHidden, plusOnesOf, tagsOf } from './model.ts'
import { plusOne, tagElements, untagElements } from './tags.tsx'
import { voteAt } from './votes.tsx'
import type { FeatureSet } from './wiring.ts'

export interface LobbySpikeFeatures {
  me(): { uid: string; role: string; guest: boolean } | null
  /** tags `ids` with `name` (defines the board's tag first when new) */
  tag(ids: string[], name: string, color?: string): { ok: boolean; key?: string; error?: string }
  untag(ids: string[], key: string): void
  tagsOf(id: string): { key: string; name: string; color: string }[]
  /** my +1 on `id` (set, clear, or toggle) */
  plusOne(id: string, want?: boolean): boolean
  plusOnesOf(id: string): string[]
  /** the workshop state as the features hold it (after a fresh read) */
  workshop(): Promise<{
    voteOpen: boolean
    voteId: string | null
    myVotes: Record<string, number>
    myRemaining: number | null
    timerMs: number | null
  }>
  startVote(opts?: { votesPerPerson?: number }): Promise<void>
  closeVote(): Promise<void>
  /** casts on the element `id` (as the vote tool does on a press there) */
  vote(id: string, delta?: 1 | -1): Promise<{ ok: boolean; code?: string }>
  startTimer(ms: number): Promise<void>
  stopTimer(): Promise<void>
  /** comment threads the pins show */
  threads(): { id: string; anchor: unknown; body: string }[]
  refreshThreads(): Promise<void>
  collapse(topicId: string, collapsed: boolean): boolean
  /** the collapse prototype's hidden set (as computed from the scene, and as the overrides hold it) */
  hidden(): { computed: string[]; overrides: string[] }
  exportSvg(
    only?: string[],
  ): Promise<{ text: string; bytes: number; embeddedFiles: string[]; embeddedFonts: string[] }>
  /** PNG export as a data: URL (size in bytes too) */
  exportPng(only?: string[]): Promise<{ dataUrl: string; bytes: number }>
  /** the loader's state (B7: fetches in flight, addFiles calls, …) */
  loader(): { states: Record<string, number>; stats: Record<string, number> } | null
}

declare global {
  interface Window {
    lobbySpikeFeatures?: LobbySpikeFeatures
  }
}

const guardOn = () =>
  import.meta.env.VITE_LOBBY_ENGINE === 'excalidraw' &&
  (import.meta.env.DEV || import.meta.env.VITE_DRAFTROOM_DEV_AUTH === '1') &&
  DEV_AUTH_ENABLED

export function installFeatureHooks(set: FeatureSet): () => void {
  if (typeof window === 'undefined' || !guardOn()) return () => {}
  const { rt, workshop, comments } = set
  const port = rt.port
  const hooks: LobbySpikeFeatures = {
    me: () => {
      const m = rt.me()
      return m ? { uid: m.uid, role: m.role, guest: m.guest } : null
    },
    tag: (ids, name, color) => {
      const r = tagElements(rt, ids, name, color as never)
      return r.ok ? { ok: true, key: r.key } : { ok: false, error: r.error }
    },
    untag: (ids, key) => untagElements(rt, ids, key),
    tagsOf: (id) => tagsOf(port.get(id)).map((t) => ({ ...t })),
    plusOne: (id, want) => plusOne(rt, id, want, !!workshop.openVote),
    plusOnesOf: (id) => plusOnesOf(port.get(id)),
    workshop: async () => {
      await workshop.refresh()
      const v = workshop.openVote
      return {
        voteOpen: !!v,
        voteId: workshop.voteState?.session.id ?? null,
        myVotes: { ...(workshop.voteState?.myVotes ?? {}) },
        myRemaining: v?.myRemaining ?? null,
        timerMs: workshop.remainingMs(),
      }
    },
    startVote: (opts) => workshop.startVote(opts),
    closeVote: () => workshop.closeVote(),
    vote: async (id, delta = 1) => {
      const r = await voteAt(rt, workshop, id, delta)
      return r.ok ? { ok: true } : { ok: false, ...(r.code ? { code: r.code } : {}) }
    },
    startTimer: (ms) => workshop.timerAction({ action: 'start', durationMs: ms }),
    stopTimer: () => workshop.timerAction({ action: 'stop' }),
    threads: () =>
      comments.threads.map((t) => ({ id: t.id, anchor: t.anchor, body: t.comments[0]?.body ?? '' })),
    refreshThreads: () => comments.refresh(),
    collapse: (id, collapsed) => setCollapsed(port, id, collapsed),
    hidden: () => ({
      computed: [...mindmapHidden(port.items())].sort(),
      overrides: [...(overridesOf(rt.registries)?.hiddenIds() ?? [])].sort(),
    }),
    exportSvg: async (only) => {
      const r = await set.exportSvg(only ? { only } : {})
      return {
        text: r.text,
        bytes: r.bytes,
        embeddedFiles: [...r.embeddedFiles],
        embeddedFonts: [...r.embeddedFonts],
      }
    },
    exportPng: async (only) => {
      const blob = await set.exportPng(only ? { only } : {})
      const u8 = new Uint8Array(await blob.arrayBuffer())
      let bin = ''
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000))
      return { dataUrl: `data:image/png;base64,${btoa(bin)}`, bytes: u8.length }
    },
    loader: () => {
      const f = set.files()
      return f ? { states: { ...f.loader.states() }, stats: { ...f.loader.stats } } : null
    },
  }
  window.lobbySpikeFeatures = hooks
  return () => {
    if (window.lobbySpikeFeatures === hooks) delete window.lobbySpikeFeatures
  }
}
