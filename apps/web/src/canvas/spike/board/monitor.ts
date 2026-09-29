/**
 * The editor-guard monitor of the spike board page (B3 L9, L11, L12, L13): host-lab's A6/A16 regression
 * monitor (apps/web/src/canvas/spike/pages/host-lab.tsx) on the real board, independent of EditorLease's
 * bookkeeping. A textarea may be writable, and may receive input, only if this session HOLDS the lease of
 * the element Excalidraw opened it for (`LeaseClient.isHeld`: the grant arrived and no broadcast took it
 * away). The one exception is the New element rule (§2.9.2): the FIRST textarea on an element this session
 * created may be writable while its acquire is out and no other holder is known.
 *
 * Checked: at the textarea's first sight (a MutationObserver, after CanvasInput's own lock, which is
 * registered first) and at every task boundary after an engine change; Lobby's session and Excalidraw's
 * `editingTextElement` must agree after each engine change (`agreement()`); every input into a textarea
 * without a lease is a violation; every stored label text change is recorded with whether its lease was
 * held; every lease release is recorded with whether the core still had the label dirty (the final push
 * not out yet).
 *
 * Exposed on `window.__lobbyBoard.monitor` (the spike board page only exists behind the dev-auth guard).
 */
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { CanvasInput } from '../../input/CanvasInput.ts'
import type { LeaseClient } from '../../lease/client.ts'
import type { LobbyEngineCore } from '../../sync/core/engine.ts'

export interface GuardMonitorDeps {
  readonly api: ExcalidrawImperativeAPI
  readonly lease: LeaseClient
  readonly input: CanvasInput
  readonly core: LobbyEngineCore
  /** the board's root element (textareas are looked up inside it) */
  readonly root: HTMLElement
}

export interface GuardMonitor {
  start(): void
  stop(): void
  report(): GuardReport
  agreement(): Agreement
  dispose(): void
}

export interface Agreement {
  ok: boolean
  issues: string[]
  phase: string
  origin: string | null
  leaseId: string | null
  editing: string | null
  textareas: number
}

export interface GuardReport {
  violations: { kind: string; [key: string]: unknown }[]
  /** each textarea at first sight: its lease id, read-only, and whether this session may write it */
  firstSeen: { probe: string; lease: string | null; readOnly: boolean; mayWrite: boolean; at: number }[]
  textWrites: { id: string; text: string; held: boolean; provisional: boolean; at: number }[]
  inputs: { probe: string; type: string; inputType: string; leased: boolean }[]
  releases: { id: string; dirty: boolean; at: number }[]
}

export function createGuardMonitor(d: GuardMonitorDeps): GuardMonitor {
  const m = {
    on: false,
    violations: [] as GuardReport['violations'],
    firstSeen: [] as GuardReport['firstSeen'],
    textWrites: [] as GuardReport['textWrites'],
    inputs: [] as GuardReport['inputs'],
    releases: [] as GuardReport['releases'],
    lastText: new Map<string, string>(),
    probes: 0,
  }
  const openedLeases = new Set<string>()
  const textareas = () =>
    Array.from(d.root.querySelectorAll<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg'))
  const editingLeaseId = () => {
    const e = d.api.getAppState().editingTextElement
    return e ? (e.containerId ?? e.id) : null
  }
  const leaseOfTextarea = (ta: HTMLTextAreaElement) => {
    if (!ta.dataset.guardLease) {
      const id = editingLeaseId() ?? ''
      ta.dataset.guardLease = id
      if (id) {
        ta.dataset.guardFirst = openedLeases.has(id) ? '0' : '1'
        openedLeases.add(id)
      }
    }
    return ta.dataset.guardLease || null
  }
  const provisional = (ta: HTMLTextAreaElement, id: string | null) =>
    !!id &&
    d.lease.isCreatedHere(id) &&
    ta.dataset.guardFirst === '1' &&
    d.lease.isPending(id) &&
    !d.lease.heldByOther(id)
  const mayWrite = (ta: HTMLTextAreaElement) => {
    const id = leaseOfTextarea(ta)
    return (!!id && d.lease.isHeld(id)) || provisional(ta, id)
  }
  const violation = (kind: string, data: Record<string, unknown> = {}) => {
    if (m.on) m.violations.push({ kind, at: Date.now(), ...data })
  }
  const pendingVisible = () => {
    const el = document.querySelector<HTMLElement>('[data-testid="lease-status"]')
    // position: fixed has no offsetParent: read the computed display and the box
    return (
      !!el &&
      el.dataset.phase === 'pending' &&
      getComputedStyle(el).display !== 'none' &&
      el.getClientRects().length > 0
    )
  }
  const pendingIssues = () => {
    const el = d.input.editorLease
    const phase = el?.phase ?? 'idle'
    const live = d.lease.livePending()
    const issues: string[] = []
    if (phase === 'pending') {
      if (live.length !== 1 || live[0] !== el?.leaseId)
        issues.push(`pending on ${el?.leaseId} with live requests [${live.join(',')}]`)
      if (!pendingVisible()) issues.push('pending without a visible affordance')
    }
    if (phase === 'idle' && live.length > 0) issues.push(`idle with live requests [${live.join(',')}]`)
    return issues
  }
  const agreement = (): Agreement => {
    const editing = d.api.getAppState().editingTextElement
    const el = d.input.editorLease
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
    for (const ta of tas)
      if (!ta.readOnly && !mayWrite(ta)) issues.push('a writable textarea without a granted lease')
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
    }
  }
  const watchTextarea = (ta: HTMLTextAreaElement) => {
    if (ta.dataset.guardProbe) return
    ta.dataset.guardProbe = String(++m.probes)
    const lease = leaseOfTextarea(ta)
    const may = mayWrite(ta)
    if (m.on) {
      m.firstSeen.push({
        probe: ta.dataset.guardProbe,
        lease,
        readOnly: ta.readOnly,
        mayWrite: may,
        at: Date.now(),
      })
      if (!ta.readOnly && !may) violation('writable-at-first-sight', { lease })
    }
    for (const type of ['beforeinput', 'input'] as const)
      ta.addEventListener(type, (e) => {
        if (!m.on) return
        const leased = mayWrite(ta)
        m.inputs.push({
          probe: ta.dataset.guardProbe ?? '',
          type,
          inputType: (e as InputEvent).inputType ?? '',
          leased,
        })
        if (type === 'input' && !leased)
          violation('input-into-unleased-editor', { lease: leaseOfTextarea(ta) })
      })
  }
  const tick = () => {
    for (const ta of textareas()) {
      watchTextarea(ta)
      if (!ta.readOnly && !mayWrite(ta))
        violation('writable-editor-without-lease', { lease: leaseOfTextarea(ta) })
    }
    const pi = pendingIssues()
    if (pi.length) violation('pending-invariant', { issues: pi, phase: d.input.editorLease?.phase ?? 'idle' })
  }
  const onChange = () => {
    if (!m.on) return
    for (const e of d.api.getSceneElementsIncludingDeleted()) {
      if (e.type !== 'text') continue
      const text = (e as { originalText: string }).originalText
      const prev = m.lastText.get(e.id)
      m.lastText.set(e.id, text)
      if (prev === undefined || prev === text) continue
      const id = (e as { containerId?: string | null }).containerId ?? e.id
      const held = d.lease.isHeld(id)
      const prov = !held && textareas().some((ta) => leaseOfTextarea(ta) === id && provisional(ta, id))
      m.textWrites.push({ id, text, held, provisional: prov, at: Date.now() })
    }
    for (const ta of textareas()) watchTextarea(ta)
    setTimeout(() => m.on && tick(), 0)
    // after this task's microtasks (Lobby's deferred closes), Lobby and Excalidraw must agree
    setTimeout(() => {
      if (!m.on) return
      const a = agreement()
      if (!a.ok) violation('disagree', { ...a })
    }, 0)
  }
  const observer = new MutationObserver((records) => {
    if (!m.on) return
    for (const r of records)
      for (const n of r.addedNodes)
        if (n instanceof HTMLTextAreaElement && n.classList.contains('excalidraw-wysiwyg')) watchTextarea(n)
  })
  const offChange = d.api.onChange(onChange)
  const offLease = d.lease.on((ev) => {
    if (!m.on || ev.kind !== 'release') return
    const labelId = d.api
      .getSceneElementsIncludingDeleted()
      .find(
        (e) =>
          e.type === 'text' &&
          !e.isDeleted &&
          ((e as { containerId?: string | null }).containerId ?? e.id) === ev.id,
      )?.id
    // the event comes just before the release is handed to the core, which flushes first (§2.9.3): read
    // the core once that send returned
    queueMicrotask(() => {
      const dirty = !!labelId && d.core.unsentIds().includes(labelId)
      m.releases.push({ id: ev.id, dirty, at: Date.now() })
      if (dirty) violation('release-before-final-push', { id: ev.id })
    })
  })
  return {
    start() {
      m.violations.length = 0
      m.firstSeen.length = 0
      m.textWrites.length = 0
      m.inputs.length = 0
      m.releases.length = 0
      m.lastText.clear()
      for (const e of d.api.getSceneElementsIncludingDeleted())
        if (e.type === 'text') m.lastText.set(e.id, (e as { originalText: string }).originalText)
      m.on = true
      observer.observe(d.root, { childList: true, subtree: true })
    },
    stop() {
      m.on = false
      observer.disconnect()
    },
    report: () =>
      JSON.parse(
        JSON.stringify({
          violations: m.violations,
          firstSeen: m.firstSeen,
          textWrites: m.textWrites,
          inputs: m.inputs,
          releases: m.releases,
        }),
      ),
    agreement,
    dispose() {
      m.on = false
      observer.disconnect()
      offChange()
      offLease()
    },
  }
}
