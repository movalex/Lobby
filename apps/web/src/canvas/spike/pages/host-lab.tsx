import { CaptureUpdateAction, convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI, ExcalidrawProps } from '@excalidraw/excalidraw/types'
import { useEffect, useMemo, useState } from 'react'
import ExcalidrawHost, { type HostWiring } from '../../engine/ExcalidrawHost.tsx'
import { LOBBY_ROLES, type LobbyRole } from '../../engine/interaction.ts'
import { CanvasInput, type InputTrace } from '../../input/CanvasInput.ts'
import { LeaseClient } from '../../lease/client.ts'
import type { EditNotice, EditState } from '../../lease/editorLease.ts'
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

/**
 * Lobby's minimal lease UI, imperative so it changes in the same task as the session (the monitor reads
 * it at the next task boundary):
 *  - the pending affordance (§2.9.5): "Opening… Esc cancels" while a lease request is out, so keys typed
 *    meanwhile are never swallowed silently;
 *  - the notice banner: a deny, a cancelled open, and the plan's lost-lease banner (§2.9.3, minimal):
 *    "Not saved — Alice is editing this note now" with **Copy my text**.
 */
function createLeaseUi(notices: (EditNotice & { copied: boolean })[]) {
  const status = document.createElement('div')
  status.dataset.testid = 'lease-status'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  Object.assign(status.style, {
    position: 'fixed',
    bottom: '16px',
    left: '16px',
    padding: '6px 10px',
    borderRadius: '6px',
    background: '#1f2937',
    color: '#fff',
    font: '13px system-ui, sans-serif',
    zIndex: '20',
    display: 'none',
  })
  const banner = document.createElement('div')
  banner.dataset.testid = 'lease-notice'
  banner.setAttribute('role', 'alert')
  Object.assign(banner.style, {
    position: 'fixed',
    top: '56px',
    left: '50%',
    transform: 'translateX(-50%)',
    maxWidth: 'min(560px, calc(100vw - 32px))',
    padding: '8px 12px',
    borderRadius: '8px',
    background: '#7c2d12',
    color: '#fff',
    font: '13px system-ui, sans-serif',
    zIndex: '20',
    display: 'none',
    gap: '8px',
    alignItems: 'center',
  })
  const message = document.createElement('span')
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = 'Copy my text'
  copy.dataset.testid = 'lease-copy'
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = 'Dismiss'
  close.dataset.testid = 'lease-dismiss'
  banner.append(message, copy, close)
  let shown = -1
  copy.addEventListener('click', () => {
    const n = notices[shown]
    if (!n?.text) return
    n.copied = true
    void navigator.clipboard?.writeText(n.text).catch(() => {})
  })
  close.addEventListener('click', () => {
    banner.style.display = 'none'
  })
  return {
    mount: () => {
      document.body.append(status, banner)
      return () => {
        status.remove()
        banner.remove()
      }
    },
    showState: (s: EditState) => {
      status.dataset.phase = s.phase
      status.dataset.lease = s.leaseId ?? ''
      status.dataset.lost = s.lost ? '1' : ''
      if (s.phase === 'pending' || s.phase === 'opening') {
        status.textContent =
          s.buffered > 0
            ? `Opening the note… (${s.buffered} typed, Esc cancels)`
            : 'Opening the note… (Esc cancels)'
        status.style.display = 'block'
      } else if (s.lost) {
        status.textContent = `Read-only: ${s.lost.name} is editing this note`
        status.style.display = 'block'
      } else {
        status.textContent = ''
        status.style.display = 'none'
      }
    },
    showNotice: (i: number) => {
      const n = notices[i]
      if (!n) return
      shown = i
      message.textContent = n.message
      copy.style.display = n.text ? '' : 'none'
      banner.style.display = 'flex'
    },
    /** The pending affordance is on screen (the monitor's invariant). */
    pendingVisible: () =>
      status.isConnected &&
      status.dataset.phase === 'pending' &&
      status.style.display !== 'none' &&
      status.getBoundingClientRect().width > 0 &&
      (status.textContent ?? '').length > 0,
    reset: () => {
      banner.style.display = 'none'
      shown = -1
    },
  }
}

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
  /** Every EditNotice, with whether its "Copy my text" was clicked. */
  const notices: (EditNotice & { at: number; copied: boolean })[] = []
  /** Every EditState change, in order (the pending affordance's history). */
  const editStates: (EditState & { at: number })[] = []
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
  const ui = createLeaseUi(notices)

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
    onNotice: (n) => {
      notices.push({ ...n, at: performance.now(), copied: false })
      ui.showNotice(notices.length - 1)
    },
    onEditState: (s) => {
      editStates.push({ ...s, at: performance.now() })
      ui.showState(s)
    },
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
    createdIds.add(id)
    input.editorLease?.requestEdit(id, { reason: 'new-text', caretEnd: true })
    return id
  }

  const onToolClick = (c: CustomToolClick) => {
    customClicks.push(c)
    if (c.tool === 'note' && !readOnly) {
      const size = 200
      const made = note({ x: c.x - size / 2, y: c.y - size / 2, size })
      lease.markCreated(made.note)
      createdIds.add(made.note)
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

  // --- A6/A16 regression monitor ---------------------------------------------------------------------
  // Independent of EditorLease's bookkeeping: a textarea may be writable, and may receive input, only if
  // this session HOLDS the lease of the element Excalidraw opened it for (LeaseClient.isHeld: the grant
  // arrived and no broadcast took it away). "Created here" is NOT a lease (the second verifier found the
  // old monitor counting it as one, so it could not see an unbounded New-element bypass). The one
  // exception is the New element rule itself (§2.9.2): the FIRST textarea on an element this page created
  // may be writable before the grant, only while its acquire is out and the SERVER names no other holder.
  // Invariants: phase 'pending' implies exactly one live request (for the session's id) and a visible
  // pending affordance; phase 'idle' implies no live request; a lost lease leaves no writable editor.
  const monitor = {
    on: false,
    violations: [] as Record<string, unknown>[],
    /** Every lease release, with the leased label's stored text at that moment. */
    releases: [] as { id: string; text: string | null; at: number }[],
    /**
     * Every change of a label's stored text, and whether its lease was held when it was written
     * (`provisional`: not held, but the New element allowance above applied).
     */
    textWrites: [] as { id: string; text: string; held: boolean; provisional: boolean; at: number }[],
    /** Keydowns that reached a textarea's own handlers (target phase), per textarea probe id. */
    reached: [] as {
      probe: string
      key: string
      code: string
      ctrl: boolean
      meta: boolean
      alt: boolean
      shift: boolean
    }[],
    /** input / beforeinput events on a textarea, and whether its lease was held. */
    inputs: [] as { probe: string; type: string; inputType: string; leased: boolean; value: string }[],
    lastText: new Map<string, string>(),
    probes: 0,
  }
  let wrapperEl: HTMLElement | null = null
  const textareas = () =>
    wrapperEl
      ? Array.from(wrapperEl.querySelectorAll<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg'))
      : []
  /** Elements this page created with Lobby's tools (the N tool, a new free text): the monitor's record. */
  const createdIds = new Set<string>()
  /** Lease ids that have had a textarea: a later textarea on one is not a first open. */
  const openedLeases = new Set<string>()
  const heldHere = (id: string | null | undefined) => !!id && lease.isHeld(id)
  /** The fake server's own table (the truth), not what the client was told. */
  const otherHolds = (id: string) => {
    const h = server.holderOf(id)
    return !!h && h.sid !== ME.sid
  }
  const editingLeaseId = () => {
    const e = api?.getAppState().editingTextElement
    return e ? (e.containerId ?? e.id) : null
  }
  /** The lease id of the element a textarea edits (tagged when it appeared), and whether it is a first open. */
  const leaseOfTextarea = (ta: HTMLTextAreaElement) => {
    if (!ta.dataset.probeLease) {
      const id = editingLeaseId() ?? ''
      ta.dataset.probeLease = id
      if (id) {
        ta.dataset.probeFirst = openedLeases.has(id) ? '0' : '1'
        openedLeases.add(id)
      }
    }
    return ta.dataset.probeLease || null
  }
  /** The New element allowance: first textarea on a created element, acquire out, no other holder. */
  const provisional = (ta: HTMLTextAreaElement, id: string | null) =>
    !!id && createdIds.has(id) && ta.dataset.probeFirst === '1' && lease.isPending(id) && !otherHolds(id)
  const mayWrite = (ta: HTMLTextAreaElement) => {
    const id = leaseOfTextarea(ta)
    return heldHere(id) || provisional(ta, id)
  }
  const violation = (kind: string, data: Record<string, unknown> = {}) => {
    if (monitor.on) monitor.violations.push({ kind, at: performance.now(), ...data })
  }
  /** Phase 'pending' implies exactly one live request (the session's) and a visible affordance. */
  const pendingIssues = () => {
    const el = input.editorLease
    const phase = el?.phase ?? 'idle'
    const live = lease.livePending()
    const issues: string[] = []
    if (phase === 'pending') {
      if (live.length !== 1 || live[0] !== el?.leaseId)
        issues.push(`pending on ${el?.leaseId} with live requests [${live.join(',')}]`)
      if (!ui.pendingVisible()) issues.push('pending without a visible affordance')
    }
    if (phase === 'idle' && live.length > 0) issues.push(`idle with live requests [${live.join(',')}]`)
    return issues
  }
  const agreement = () => {
    const st = need().getAppState()
    const editing = st.editingTextElement
    const el = input.editorLease
    const phase = el?.phase ?? 'idle'
    const tas = textareas()
    const issues: string[] = []
    if (tas.length > 1) issues.push(`${tas.length} textareas`)
    if (editing) {
      const id = editing.containerId ?? editing.id
      if (phase === 'idle') issues.push('an editor is open and Lobby is idle')
      else if (el?.leaseId !== id) issues.push(`editor on ${id}, Lobby session on ${el?.leaseId}`)
      else if (phase === 'pending' && el?.origin !== 'guard')
        issues.push('an editor is open before the grant')
      if (tas.length === 0) issues.push('editingTextElement without a textarea')
    } else {
      if (tas.length > 0) issues.push('a textarea without editingTextElement')
      if (phase === 'open') issues.push('Lobby open, no editor')
      if (phase === 'pending' && el?.origin === 'guard') issues.push('Lobby guards a closed editor')
    }
    for (const ta of tas) {
      if (!ta.readOnly && !mayWrite(ta)) issues.push('a writable textarea without a granted lease')
    }
    const own = input.editorLease?.textarea() ?? null
    if (phase === 'open' && !el?.lost && !heldHere(el?.leaseId) && !(own && mayWrite(own)))
      issues.push('Lobby open without a lease')
    if (el?.lost) for (const ta of tas) if (!ta.readOnly) issues.push('lease lost, editor still writable')
    issues.push(...pendingIssues())
    return {
      ok: issues.length === 0,
      issues,
      phase,
      origin: el?.origin ?? null,
      leaseId: el?.leaseId ?? null,
      editing: editing?.id ?? null,
      textareas: tas.length,
      lost: el?.lost?.name ?? null,
    }
  }
  const watchTextarea = (ta: HTMLTextAreaElement) => {
    if (ta.dataset.probe) return
    ta.dataset.probe = String(++monitor.probes)
    leaseOfTextarea(ta)
    ta.addEventListener('keydown', (e) => {
      if (!monitor.on) return
      monitor.reached.push({
        probe: ta.dataset.probe ?? '',
        key: e.key,
        code: e.code,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        alt: e.altKey,
        shift: e.shiftKey,
      })
    })
    for (const type of ['beforeinput', 'input'] as const) {
      ta.addEventListener(type, (e) => {
        if (!monitor.on) return
        const leased = mayWrite(ta)
        monitor.inputs.push({
          probe: ta.dataset.probe ?? '',
          type,
          inputType: (e as InputEvent).inputType ?? '',
          leased,
          value: ta.value,
        })
        if (type === 'input' && !leased) violation('input-into-unleased-editor', { value: ta.value })
      })
    }
  }
  /**
   * Checked at task boundaries (a timer, an animation frame): input arrives in a task of its own, so a
   * textarea that Excalidraw appended and Lobby locked within one task was never writable for the user.
   */
  const monitorTick = () => {
    for (const ta of textareas()) {
      watchTextarea(ta)
      if (!ta.readOnly && !mayWrite(ta)) {
        violation('writable-editor-without-lease', {
          lease: leaseOfTextarea(ta),
          value: ta.value,
          firstOpen: ta.dataset.probeFirst === '1',
          createdHere: createdIds.has(leaseOfTextarea(ta) ?? ''),
          otherHolder: server.holderOf(leaseOfTextarea(ta) ?? '')?.name ?? null,
        })
      }
    }
    const pi = pendingIssues()
    if (pi.length) violation('pending-invariant', { issues: pi, phase: input.editorLease?.phase ?? 'idle' })
  }
  const tickLater = () => setTimeout(() => monitor.on && monitorTick(), 0)
  const monitorOnChange = () => {
    if (!monitor.on) return
    for (const e of need().getSceneElementsIncludingDeleted()) {
      if (e.type !== 'text') continue
      const text = (e as { originalText: string }).originalText
      const prev = monitor.lastText.get(e.id)
      monitor.lastText.set(e.id, text)
      if (prev === undefined || prev === text) continue
      const id = (e as { containerId?: string | null }).containerId ?? e.id
      const held = heldHere(id)
      const prov = !held && textareas().some((ta) => leaseOfTextarea(ta) === id && provisional(ta, id))
      monitor.textWrites.push({ id, text, held, provisional: prov, at: performance.now() })
    }
    for (const ta of textareas()) watchTextarea(ta)
    tickLater()
    // After this task's microtasks (Lobby's deferred closes), Lobby and Excalidraw must agree.
    setTimeout(() => {
      if (!monitor.on) return
      const a = agreement()
      if (!a.ok) violation('disagree', a)
    }, 0)
  }
  lease.on((ev) => {
    if (!monitor.on || ev.kind !== 'release') return
    const label = api
      ?.getSceneElementsIncludingDeleted()
      .find(
        (e) => e.type === 'text' && ((e as { containerId?: string | null }).containerId ?? e.id) === ev.id,
      )
    monitor.releases.push({
      id: ev.id,
      text: (label as { originalText?: string } | undefined)?.originalText ?? null,
      at: performance.now(),
    })
  })

  const extra = {
    config: cfg,
    input,
    agreement,
    notices,
    editStates,
    pendingVisible: () => ui.pendingVisible(),
    /** The banner's "Copy my text" (a user click, as a spec would do it). */
    copyNoticeText: () => {
      document.querySelector<HTMLButtonElement>('[data-testid="lease-copy"]')?.click()
      return notices.filter((n) => n.copied).length
    },
    monitor: {
      start: () => {
        monitor.violations.length = 0
        monitor.releases.length = 0
        monitor.textWrites.length = 0
        monitor.reached.length = 0
        monitor.inputs.length = 0
        monitor.lastText = new Map(
          need()
            .getSceneElementsIncludingDeleted()
            .filter((e) => e.type === 'text')
            .map((e) => [e.id, (e as { originalText: string }).originalText]),
        )
        monitor.on = true
      },
      report: () => ({
        violations: [...monitor.violations],
        releases: [...monitor.releases],
        textWrites: [...monitor.textWrites],
        reached: [...monitor.reached],
        inputs: [...monitor.inputs],
      }),
      stop: () => {
        monitor.on = false
      },
      /** Keydowns that reached any textarea's own handlers since `from`. */
      reachedSince: (from: number) => monitor.reached.slice(from),
      reachedCount: () => monitor.reached.length,
    },
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
        toolLocked: st.activeTool.locked,
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
        textareas: textareas().length,
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
      notices.length = 0
      editStates.length = 0
      createdIds.clear()
      ui.reset()
      server.log.length = 0
      for (const k of Object.keys(counters) as (keyof typeof counters)[]) counters[k] = 0
    },
  }

  const attach: HostWiring = (wrapper, readyApi) => {
    api = readyApi
    wrapperEl = wrapper
    // The monitor subscribes BEFORE Lobby's input layer: in one onChange it sees a label's final text
    // write before Lobby's release for the same close runs.
    const offMonitor = readyApi.onChange(monitorOnChange)
    const monitorObserver = new MutationObserver(() => {
      for (const ta of textareas()) watchTextarea(ta)
      if (monitor.on) tickLater()
    })
    monitorObserver.observe(wrapper, { childList: true, subtree: true })
    let raf = 0
    const frame = () => {
      if (monitor.on) monitorTick()
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    const unmountUi = ui.mount()
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
      unmountUi()
      cancelAnimationFrame(raf)
      monitorObserver.disconnect()
      offMonitor()
      wrapperEl = null
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
