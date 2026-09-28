import { CaptureUpdateAction, convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI, ExcalidrawProps } from '@excalidraw/excalidraw/types'
import { useEffect, useMemo, useState } from 'react'
import ExcalidrawHost, { type HostWiring } from '../../engine/ExcalidrawHost.tsx'
import { LOBBY_ROLES, type LobbyRole } from '../../engine/interaction.ts'
import { CanvasInput, type InputTrace } from '../../input/CanvasInput.ts'
import { LeaseClient } from '../../lease/client.ts'
import { FakeLeaseServer } from '../../lease/fakeServer.ts'
import { classifyEditorWrites, type ElementSnapshot } from '../../lease/fit.ts'
import { attachPresencePointer, type PresenceSample } from '../../presence/pointer.ts'
import { attachCustomTools, type CustomToolClick } from '../../tools/customTools.ts'
import { buildNote, type NoteOptions } from '../../tools/notes.ts'
import { activeLobbyTool, setEngineTool, setTool } from '../../tools/tools.ts'
import { createSpikeHandle, installSpikeHandle, pickParam } from '../harness.ts'

// /spike/host-lab — spike A checks A1, A2, A4, A5, A6, A16, A17 (host and input owner).
// Query: role, theme, grant=<ms>|manual (fake lease server delay, default 150), allowlist=on|off,
// dbl=on|off (double-click / double-tap interception), dup=on|off (Lobby's onDuplicate stamp),
// copy=allow|deny (export policy), toolbar=1 (Lobby's minimal toolbar, A5).
// `off` values exist only for CONTROL runs that show what Excalidraw does without Lobby's layer.

const THEMES = ['light', 'dark'] as const
const ME = { sid: 'spike-user:tab-1', uid: 'spike-user', name: 'Spike User' }
const OTHER = { sid: 'alice:tab-9', uid: 'alice', name: 'Alice' }

interface LabConfig {
  role: LobbyRole
  grant: number | 'manual'
  allowlist: 'on' | 'off'
  dbl: 'on' | 'off'
  dup: 'on' | 'off'
  copy: 'allow' | 'deny'
  toolbar: boolean
}

function readConfig(): LabConfig {
  const q = new URLSearchParams(location.search)
  const grantRaw = q.get('grant') ?? '150'
  const grantNum = Number(grantRaw)
  return {
    role: pickParam('role', LOBBY_ROLES, 'editor'),
    grant: grantRaw === 'manual' ? 'manual' : Number.isFinite(grantNum) && grantNum >= 0 ? grantNum : 150,
    allowlist: pickParam('allowlist', ['on', 'off'] as const, 'on'),
    dbl: pickParam('dbl', ['on', 'off'] as const, 'on'),
    dup: pickParam('dup', ['on', 'off'] as const, 'on'),
    copy: pickParam('copy', ['allow', 'deny'] as const, 'allow'),
    toolbar: q.get('toolbar') === '1',
  }
}

type Plain = Record<string, unknown> & { id: string; type: string }
const plain = (e: ExcalidrawElement): Plain => JSON.parse(JSON.stringify(e)) as Plain

/** Everything the specs drive, behind window.__lobbySpike.extra. */
function createLab(cfg: LabConfig, onAttached: (api: ExcalidrawImperativeAPI) => void) {
  const server = new FakeLeaseServer({ me: ME, delayMs: cfg.grant })
  const lease = new LeaseClient((onMessage) => server.connect(onMessage), ME)
  const traces: (InputTrace | Record<string, unknown>)[] = []
  const presence: PresenceSample[] = []
  const pointerUpdates: { x: number; y: number; tool: string; button: string }[] = []
  const linkOpens: string[] = []
  const customClicks: CustomToolClick[] = []
  const toasts: string[] = []
  const counters = {
    lobbyUndo: 0,
    lobbyRedo: 0,
    registeredUndo: 0,
    registeredRedo: 0,
    contextMenu: 0,
    drop: 0,
    search: 0,
    emptyDoubleClick: 0,
  }
  let api: ExcalidrawImperativeAPI | null = null
  const need = () => {
    if (!api) throw new Error('host-lab: engine not ready')
    return api
  }
  const readOnly = cfg.role !== 'editor'
  let hidden = new Set<string>()

  const input = new CanvasInput({
    hiddenIds: () => hidden,
    role: () => (readOnly ? 'readonly' : 'editor'),
    lease,
    setTool: (t) => setTool(need(), t, { readOnly }),
    actions: {
      undo: () => {
        counters.lobbyUndo++
      },
      redo: () => {
        counters.lobbyRedo++
      },
      search: () => {
        counters.search++
      },
    },
    canCopy: () => cfg.copy === 'allow',
    onDrop: () => {
      counters.drop++
    },
    onContextMenu: () => {
      counters.contextMenu++
    },
    onEmptyDoubleClick: (p) => {
      counters.emptyDoubleClick++
      addFreeText(p.x, p.y)
    },
    onDeny: (_id, holder) => toasts.push(`${holder} is typing in this note`),
    trace: (t) => traces.push(t),
    allowlist: cfg.allowlist,
    interceptDoubleClicks: cfg.dbl === 'on',
  })

  let seq = 0
  const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`

  const addElements = (els: readonly ExcalidrawElement[], capture: 'never' | 'immediately' = 'never') => {
    const a = need()
    a.updateScene({
      elements: [...a.getSceneElementsIncludingDeleted(), ...els],
      captureUpdate: capture === 'never' ? CaptureUpdateAction.NEVER : CaptureUpdateAction.IMMEDIATELY,
    })
  }

  /** Converts skeletons with Lobby's rule (regenerateIds: false) and adds them as server state. */
  const add = (skeletons: Record<string, unknown>[]) => {
    const els = convertToExcalidrawElements(skeletons as never, { regenerateIds: false })
    addElements(els)
    return els.map((e) => e.id)
  }

  const note = (o: Partial<NoteOptions> & { created?: number | null }) => {
    const id = o.id ?? newId('note')
    const els = buildNote(
      (s, opts) => convertToExcalidrawElements(s as never, opts) as unknown as ExcalidrawElement[],
      { x: 100, y: 100, ...o, id },
    )
    const stamped =
      o.created !== undefined && o.created !== null
        ? els.map((e) => (e.type === 'stickynote' ? ({ ...e, created: o.created } as ExcalidrawElement) : e))
        : els
    addElements(stamped)
    const label = stamped.find((e) => e.type === 'text')
    return { note: id, label: label?.id ?? null }
  }

  function addFreeText(x: number, y: number): string {
    const id = newId('text')
    const els = convertToExcalidrawElements([{ type: 'text', id, x, y, text: '', fontFamily: 6 }] as never, {
      regenerateIds: false,
    })
    addElements(els, 'immediately')
    lease.markCreated(id)
    input.editorLease?.requestEdit(id, { reason: 'new-text', caretEnd: true })
    return id
  }

  const onToolClick = (c: CustomToolClick) => {
    customClicks.push(c)
    if (c.tool === 'note' && !readOnly) {
      const size = 200
      const made = note({ x: c.x - size / 2, y: c.y - size / 2, size })
      lease.markCreated(made.note)
      setTool(need(), 'select', { readOnly })
      input.editorLease?.requestEdit(made.note, { reason: 'new-note', caretEnd: true })
    } else if (c.tool === 'text' && !readOnly) {
      const target = input.textTargetAt(c.x, c.y)
      if (target) input.editorLease?.requestEdit(target.id, { reason: 'T-tool', caretEnd: true })
      else addFreeText(c.x, c.y)
    }
  }

  // --- A17: records every local write while the editor is open, classified (lease/fit.ts) ----------
  const recorder = {
    on: false,
    baseline: new Map<string, ElementSnapshot>(),
    steps: [] as { at: number; kind: string; writes: ReturnType<typeof classifyEditorWrites> }[],
    snapshot(): Map<string, ElementSnapshot> {
      return new Map(
        need()
          .getSceneElementsIncludingDeleted()
          .map((e) => [e.id, plain(e) as ElementSnapshot]),
      )
    },
    record(kind: string) {
      if (!recorder.on) return
      const a = need()
      const editing = a.getAppState().editingTextElement
      const next = recorder.snapshot()
      const ctxLabel = editing?.id ?? ''
      const writes = classifyEditorWrites(recorder.baseline, next, {
        labelId: ctxLabel,
        containerId: editing?.containerId ?? null,
        holder: !!input.editorLease?.leaseId && lease.isHeld(input.editorLease.leaseId),
        gesture: false,
      })
      if (writes.length) recorder.steps.push({ at: performance.now(), kind, writes })
      recorder.baseline = next
    },
  }

  const extra = {
    config: cfg,
    input,
    lease: {
      client: lease,
      server,
      log: () => server.log.map((l) => ({ dir: l.dir, message: l.message })),
      pending: () => server.pendingCount(),
      flush: (n?: number) => server.flush(n),
      holdByOther: (id: string) => server.holdByOther(id, OTHER),
      clearOther: (id: string) => server.clearOther(id),
      setDelay: (d: number | 'manual') => {
        server.delayMs = d
      },
      isHeld: (id: string) => lease.isHeld(id),
    },
    traces,
    presence,
    pointerUpdates,
    linkOpens,
    customClicks,
    toasts,
    counters,
    tools: {
      setTool: (t: string) => setTool(need(), t, { readOnly }),
      setEngineTool: (t: string) => setEngineTool(need(), t, { readOnly }),
      active: () => activeLobbyTool(need()),
    },
    fixture: {
      add,
      note,
      addFreeText,
      /**
       * Binds an arrow end to an element by hand. (convertToExcalidrawElements cannot: its skeleton
       * binding knows only rectangle, ellipse, diamond and text targets; a stickynote target hits
       * assertNever and then throws, @excalidraw/element dist/dev/index.js:24418-24441.)
       */
      bindArrow: (arrowId: string, targetId: string, end: 'start' | 'end', fixedPoint: [number, number]) => {
        const a = need()
        const elements = a.getSceneElementsIncludingDeleted().map((e) => {
          if (e.id === arrowId) {
            return {
              ...e,
              [end === 'start' ? 'startBinding' : 'endBinding']: {
                elementId: targetId,
                fixedPoint,
                mode: 'orbit',
              },
              version: e.version + 1,
            } as ExcalidrawElement
          }
          if (e.id === targetId) {
            return {
              ...e,
              boundElements: [...(e.boundElements ?? []), { id: arrowId, type: 'arrow' as const }],
              version: e.version + 1,
            } as ExcalidrawElement
          }
          return e
        })
        a.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER })
      },
    },
    /** Elements a mind-map collapse would hide (Lobby's Ctrl+A leaves them out). */
    setHidden: (ids: string[]) => {
      hidden = new Set(ids)
    },
    /** The appState fields a stray key could change (A6, A4). */
    appSnap: () => {
      const st = need().getAppState()
      return {
        activeTool: `${st.activeTool.type}:${st.activeTool.customType ?? ''}`,
        openDialog: st.openDialog?.name ?? null,
        openPopup: st.openPopup,
        openMenu: st.openMenu,
        openSidebar: st.openSidebar?.name ?? null,
        contextMenu: !!st.contextMenu,
        toast: st.toast ? String(st.toast.message) : null,
        zenModeEnabled: st.zenModeEnabled,
        gridModeEnabled: st.gridModeEnabled,
        objectsSnapModeEnabled: st.objectsSnapModeEnabled,
        statsOpen: st.stats.open,
        viewModeEnabled: st.viewModeEnabled,
        theme: st.theme,
        penMode: st.penMode,
        exportWithDarkMode: st.exportWithDarkMode,
        showHyperlinkPopup: st.showHyperlinkPopup,
        editingText: st.editingTextElement?.id ?? null,
        linearEditing: st.selectedLinearElement?.isEditing ?? false,
        editingGroupId: st.editingGroupId,
        croppingElementId: st.croppingElementId,
        editingFrame: st.editingFrame,
        fileHandle: !!st.fileHandle,
        selected: Object.keys(st.selectedElementIds)
          .filter((k) => st.selectedElementIds[k])
          .sort()
          .join(','),
        zoom: st.zoom.value,
        scrollX: Math.round(st.scrollX),
        scrollY: Math.round(st.scrollY),
        currentItemFontSize: st.currentItemFontSize,
        currentItemStrokeColor: st.currentItemStrokeColor,
        currentItemBackgroundColor: st.currentItemBackgroundColor,
      }
    },
    elements: () => need().getSceneElementsIncludingDeleted().map(plain),
    /**
     * Classifies what changed since `prev` (an elements() copy) as the adapter would see it while the
     * editor is open (lease/fit.ts): which writes fall in the groups the guard holds back (the leased
     * label's text/layout, the container fit) and which would be pushed.
     */
    classifySince: (prev: Plain[]) => {
      const a = need()
      const editing = a.getAppState().editingTextElement
      const leaseId = input.editorLease?.leaseId ?? null
      const phase = input.editorLease?.phase ?? 'idle'
      return classifyEditorWrites(
        new Map(prev.map((e) => [e.id, e as ElementSnapshot])),
        recorder.snapshot(),
        {
          labelId: editing?.id ?? '',
          containerId: editing?.containerId ?? null,
          holder: !!leaseId && lease.isHeld(leaseId),
          gesture: false,
          pending: phase === 'pending' || phase === 'opening',
        },
      )
    },
    versions: () =>
      Object.fromEntries(
        need()
          .getSceneElementsIncludingDeleted()
          .map((e) => [e.id, [e.version, e.versionNonce]]),
      ),
    editor: () => {
      const ta = input.editorLease?.textarea() ?? null
      const r = ta?.getBoundingClientRect()
      const s = api?.getAppState()
      return {
        phase: input.editorLease?.phase ?? 'idle',
        origin: input.editorLease?.origin ?? null,
        leaseId: input.editorLease?.leaseId ?? null,
        editingId: s?.editingTextElement?.id ?? null,
        textarea: ta
          ? {
              readOnly: ta.readOnly,
              value: ta.value,
              selectionStart: ta.selectionStart,
              selectionEnd: ta.selectionEnd,
              focused: document.activeElement === ta,
              left: r?.left ?? 0,
              top: r?.top ?? 0,
              width: r?.width ?? 0,
              height: r?.height ?? 0,
            }
          : null,
      }
    },
    recorder: {
      start: () => {
        recorder.baseline = recorder.snapshot()
        recorder.steps.length = 0
        recorder.on = true
      },
      stop: () => {
        recorder.record('final')
        recorder.on = false
        return recorder.steps
      },
      /** A remote change as the sync adapter applies it: patched server copies, captureUpdate NEVER. */
      applyRemote: (patches: { id: string; patch: Record<string, unknown> }[]) => {
        const a = need()
        recorder.record('before-remote')
        const byId = new Map(patches.map((p) => [p.id, p.patch]))
        const elements = a.getSceneElementsIncludingDeleted().map((e) => {
          const patch = byId.get(e.id)
          if (!patch) return e
          return {
            ...e,
            ...patch,
            version: e.version + 1,
            versionNonce: Math.floor(Math.random() * 2 ** 31),
          } as ExcalidrawElement
        })
        // Remote values are folded into the baseline: only what the ENGINE writes in reaction is local.
        recorder.baseline = new Map(elements.map((e) => [e.id, plain(e) as ElementSnapshot]))
        a.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER })
        recorder.record('after-remote')
      },
      /** The holder's re-fit with Excalidraw's own path: one input event on the open editor. */
      refit: () => {
        const ta = input.editorLease?.textarea()
        if (!ta) return false
        recorder.record('before-refit')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        recorder.record('refit')
        return true
      },
    },
    reset: () => {
      const a = need()
      server.flush() // answers and releases still queued from the previous case ('manual' mode)
      a.updateScene({
        elements: [],
        appState: { selectedElementIds: {}, selectedGroupIds: {}, editingGroupId: null },
        captureUpdate: CaptureUpdateAction.NEVER,
      })
      a.history.clear()
      setTool(a, 'select', { readOnly })
      hidden = new Set()
      traces.length = 0
      presence.length = 0
      pointerUpdates.length = 0
      linkOpens.length = 0
      customClicks.length = 0
      toasts.length = 0
      server.log.length = 0
      for (const k of Object.keys(counters) as (keyof typeof counters)[]) counters[k] = 0
    },
  }

  const attach: HostWiring = (wrapper, readyApi) => {
    api = readyApi
    const detachInput = input.attach(wrapper, readyApi)
    const detachPresence = attachPresencePointer(wrapper, {
      toScene: (x, y) => input.toScene(x, y),
      onSample: (s) => presence.push(s),
    })
    const detachTools = attachCustomTools(readyApi, { onClick: onToolClick })
    // Lobby's undo/redo replace Excalidraw's (§2.8). Stubs that count: A17 shows neither is reached from
    // inside the text editor. Lobby's Ctrl+Z outside the editor is its own key action (counters.lobbyUndo).
    readyApi.registerAction({
      name: 'undo',
      label: 'Undo',
      trackEvent: false,
      perform: () => {
        counters.registeredUndo++
        return false
      },
      keyTest: (e) => (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey,
    })
    readyApi.registerAction({
      name: 'redo',
      label: 'Redo',
      trackEvent: false,
      perform: () => {
        counters.registeredRedo++
        return false
      },
      keyTest: (e) =>
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z') ||
        ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'y'),
    })
    const offRecord = readyApi.onChange(() => recorder.record('onChange'))
    // The spike handle's `ready` resolves only now: every Lobby listener is attached.
    onAttached(readyApi)
    return () => {
      offRecord()
      detachTools()
      detachPresence()
      detachInput()
      api = null
    }
  }

  const onLinkOpen: ExcalidrawProps['onLinkOpen'] = (element, event) => {
    event.preventDefault() // Lobby opens links itself (plan §2.3.2)
    linkOpens.push(element.link ?? '')
  }
  const probePointerUpdate: ExcalidrawProps['onPointerUpdate'] = (p) => {
    pointerUpdates.push({ x: p.pointer.x, y: p.pointer.y, tool: p.pointer.tool, button: p.button })
  }

  return { extra, attach, onLinkOpen, probePointerUpdate, need }
}

const TOOLBAR: readonly { tool: string; label: string }[] = [
  { tool: 'select', label: 'Select' },
  { tool: 'hand', label: 'Hand' },
  { tool: 'note', label: 'Note' },
  { tool: 'text', label: 'Text' },
  { tool: 'rectangle', label: 'Shape' },
  { tool: 'arrow', label: 'Arrow' },
  { tool: 'freedraw', label: 'Pen' },
  { tool: 'frame', label: 'Frame' },
  { tool: 'comment', label: 'Comment' },
]

/** Lobby's minimal toolbar (A5): it drives Excalidraw only through setTool. */
function LobbyToolbar({ lab }: { lab: ReturnType<typeof createLab> }) {
  const [active, setActive] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let off: (() => void) | undefined
    const tick = setInterval(() => {
      try {
        const a = lab.need()
        clearInterval(tick)
        setReady(true)
        setActive(activeLobbyTool(a))
        off = a.onChange(() => setActive(activeLobbyTool(a)))
      } catch {
        // not ready yet
      }
    }, 50)
    return () => {
      clearInterval(tick)
      off?.()
    }
  }, [lab])
  return (
    <div
      data-testid="lobby-toolbar"
      role="toolbar"
      aria-label="Lobby tools"
      style={{
        position: 'fixed',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: 4,
        padding: 4,
        background: '#1f2937',
        borderRadius: 8,
        zIndex: 10,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {TOOLBAR.map((t) => (
        <button
          key={t.tool}
          type="button"
          data-tool={t.tool}
          aria-pressed={active === t.tool}
          disabled={!ready}
          onClick={() => lab.extra.tools.setTool(t.tool)}
          style={{
            padding: '6px 10px',
            border: 0,
            borderRadius: 6,
            color: '#fff',
            background: active === t.tool ? '#e0621b' : '#374151',
            cursor: 'pointer',
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export default function HostLabPage() {
  const [cfg] = useState(readConfig)
  const [theme] = useState<'light' | 'dark'>(() => pickParam('theme', THEMES, 'light'))
  const [spike] = useState(() => createSpikeHandle(cfg.role, theme))
  const [lab] = useState(() => createLab(cfg, (api) => spike.resolveReady(api)))
  const wiring = useMemo(() => [lab.attach], [lab])

  useEffect(() => {
    spike.handle.extra = lab.extra
    return installSpikeHandle(spike.handle)
  }, [spike, lab])

  return (
    <div data-testid="host-lab" data-role={cfg.role} style={{ position: 'fixed', inset: 0 }}>
      <ExcalidrawHost
        role={cfg.role}
        theme={theme}
        wiring={wiring}
        lobbyDuplicate={cfg.dup === 'on'}
        onLinkOpen={lab.onLinkOpen}
        probePointerUpdate={lab.probePointerUpdate}
        onApi={(api) => {
          spike.handle.api = api
        }}
        onReady={(api) => {
          spike.handle.api = api
        }}
      />
      {cfg.toolbar && <LobbyToolbar lab={lab} />}
    </div>
  )
}
