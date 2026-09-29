// `window.lobbySpikeFeatures`: the spike B specs' handle on O5's features (b5-r2-*, b7-*, b12-*), next to
// O3's `window.lobbyCanvas` facade and behind the same dev-auth guard (the spike board page exists only
// with VITE_LOBBY_ENGINE=excalidraw and the guard; the check is repeated here). Every write goes through
// the features' own paths (CanvasPort.transact, the engine core's setDoc, the api), never straight into
// the engine, so specs test what the UI does. Return values are JSON-serializable.
import { DEV_AUTH_ENABLED } from '../../../lib/identity.ts'
import { placeFile, uploadToBoard, waitForProcessing } from '../../files/place.ts'
import { overridesOf } from '../../overrides.ts'
import type { LobbySpikeFeatures } from './hooks.types.ts'
import { setCollapsed } from './mindmap.tsx'
import { mindmapHidden, plusOnesOf, tagsOf } from './model.ts'
import { plusOne, tagElements, untagElements } from './tags.tsx'
import { voteAt } from './votes.tsx'
import type { FeatureSet } from './wiring.ts'

export type { LobbySpikeFeatures }

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
    upload: async (base64, name, mimeType, opts = {}) => {
      const bid = rt.boardId
      if (!bid) throw new Error('no board')
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const meta = await uploadToBoard(bid, new Blob([bytes], { type: mimeType }), name)
      const done = await waitForProcessing(bid, meta, { timeoutMs: opts.waitMs ?? 60_000 })
      const elementId = placeFile(port, done, opts.at ?? { x: 400, y: 300 }, set.files()?.resolver)
      set.files()?.sync()
      return {
        elementId,
        versionId: done.versionId,
        assetId: done.assetId,
        kind: done.kind,
        status: done.status,
        pageCount: done.probe?.pageCount ?? null,
      }
    },
    viewer: () => set.viewer.current?.facts.versionId ?? null,
    closeViewer: () => set.viewer.close(),
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
