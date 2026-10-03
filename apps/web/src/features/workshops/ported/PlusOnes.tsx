// OWNER: 3f. +1 on sticky notes (FAC-08), canvas overlay on the Excalidraw page (the tldraw board's
// PlusOnes.tsx): a small "+1" control at the bottom left of the hovered or selected note, and a count
// badge on every note that has +1s. One click adds or removes the person's +1 (./plus-ones.ts writes the
// identity-bound key through the canvas). Viewers and commenters cannot write to the canvas, so they see
// the counts; on the note they select the control is shown disabled and explains why. Hidden while
// presenting (the slides stay clean) and on notes too small on screen to carry it. While a dot vote is
// open, votes are the one way to back a note (R2-05): the counts stay, the control goes.
//
// A LOCKED note (a facilitator's template prompt) takes +1s like any other (CR-3F-2): the sync server lets
// the writer's own `plusOne:<uid>` key past the lock (the registry's `lockExempt`, canvas-schema
// custom-data.ts), as the tldraw board did; every other change of the note stays locked.
import { useMemo, useState } from 'react'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { elementLabel, isPlusOneTarget } from './elements.ts'
import { canPlusOne, plusOnesOf, writePlusOne } from './plus-ones.ts'

type Ctx = CanvasFeatureContext

/** The board's keyboard back after a pointer click on a +1. */
const focusBoard = (ctx: Ctx) => ctx.canvas.focus({ preventScroll: true })

/** Notes narrower than this on screen get no +1 control or badge (they would cover the note). */
const MIN_NOTE_PX = 56
const INSET_PX = 6

interface Item {
  id: string
  ref: string
  x: number
  y: number
  count: number
  mine: boolean
  active: boolean
  locked: boolean
}

export function PlusOnes({ ctx, voting = false }: { ctx: Ctx; voting?: boolean }) {
  const { canvas } = ctx
  const me = ctx.me.user.id
  const readOnly = useValue('dr-wk-plusone-readonly', () => canvas.readOnly(), [canvas])
  // While a vote is open the counts are plain badges (R2-05, see activeKey).
  const editable = canPlusOne(ctx) && !readOnly && !voting
  const [said, setSaid] = useState('')

  // Notes that have +1s (ids only: recomputed on document changes, not camera moves).
  const counted = useValue('dr-wk-plusone-notes', () => {
    const out: string[] = []
    for (const el of canvas.items()) if (isPlusOneTarget(el) && plusOnesOf(el).length > 0) out.push(el.id)
    return out.join(' ')
  }, [canvas])

  // The notes that show the control: the one selected note, and (for people who can +1) the note
  // under the pointer with the select tool. Never the note being edited.
  const activeKey = useValue('dr-wk-plusone-active', () => {
    if (voting) return ''
    const editing = canvas.editingId()
    const out: string[] = []
    const sel = canvas.selection
    const selected = sel.length === 1 ? canvas.get(sel[0] as string) : undefined
    if (selected && isPlusOneTarget(selected) && selected.id !== editing) out.push(selected.id)
    if (editable && canvas.tool() === 'select') {
      const hovered = canvas.hovered()
      const el = hovered ? canvas.get(hovered) : undefined
      if (el && isPlusOneTarget(el) && el.id !== editing && !out.includes(el.id)) out.push(el.id)
    }
    return out.join(' ')
  }, [canvas, editable, voting])

  const key = useValue('dr-wk-plusone-placed', () => {
    const active = new Set(activeKey ? activeKey.split(' ') : [])
    const ids = new Set([...(counted ? counted.split(' ') : []), ...active])
    const view = canvas.viewport.screenRect()
    const editing = canvas.editingId()
    const out: Item[] = []
    for (const id of ids) {
      const el = canvas.get(id)
      if (!el || !isPlusOneTarget(el) || id === editing || canvas.isHidden(id)) continue
      const b = canvas.bounds(id)
      if (!b) continue
      const tl = canvas.sceneToOverlay({ x: b.x, y: b.y })
      const br = canvas.sceneToOverlay({ x: b.x + b.width, y: b.y + b.height })
      if (br.x - tl.x < MIN_NOTE_PX) continue
      if (br.x < 0 || br.y < 0 || tl.x > view.width || tl.y > view.height) continue // off screen
      const people = plusOnesOf(el)
      out.push({
        id,
        ref: `shape:${id}`,
        x: Math.round(tl.x + INSET_PX),
        y: Math.round(br.y - INSET_PX),
        count: people.length,
        mine: people.includes(me),
        active: active.has(id),
        locked: canvas.isLocked(id),
      })
    }
    return JSON.stringify(out)
  }, [canvas, counted, activeKey, me])
  const list = useMemo(() => JSON.parse(key) as Item[], [key])

  const toggle = (id: string, viaKeyboard: boolean) => {
    const r = writePlusOne(canvas, id, me)
    if (!r.ok) {
      ctx.notify({ key: 'plusone', text: r.message ?? 'That did not work.', testId: 'plusone-toast' })
      return
    }
    const n = plusOnesOf(canvas.get(id)).length
    setSaid(`${r.added ? 'Added your +1' : 'Removed your +1'}. ${n} in total.`)
    // A pointer click hands the keyboard back to the board (typing edits the note again).
    if (!viaKeyboard) focusBoard(ctx)
  }

  const explain = () =>
    ctx.notify({
      key: 'plusone',
      text: 'Only people who can edit this board can +1 notes. You can still react from the top bar.',
      testId: 'plusone-toast',
    })

  if (list.length === 0 && !said) return null
  const get = (id: string) => canvas.get(id)
  return (
    <>
      {list.map((p) => {
        const label = elementLabel(canvas.get(p.id), get)
        const style = { transform: `translate(${p.x}px, ${p.y}px) translateY(-100%)` }
        const common = {
          'data-testid': 'plusone',
          'data-shape-id': p.ref,
          'data-count': p.count,
          'data-mine': p.mine ? 'true' : 'false',
          'data-active': p.active ? 'true' : 'false',
          style,
        }
        const text = `${p.count} ${p.count === 1 ? 'person' : 'people'} +1’d ${label}.`
        const badge = (extra: Record<string, string>) => (
          <span key={p.id} className="dr-wk-plusone dr-wk-plusone--badge" title={text} {...extra} {...common}>
            <span className="dr-wk-plusone__label" aria-hidden="true">
              +1
            </span>
            <span className="dr-wk-plusone__n">{p.count}</span>
          </span>
        )
        if (!editable) {
          if (!p.active || voting) return badge({ 'data-readonly': 'true' })
          return (
            <button
              key={p.id}
              type="button"
              className="dr-wk-plusone"
              data-readonly="true"
              aria-disabled="true"
              aria-label={`${p.count > 0 ? text : `No +1s on ${label} yet.`} Only people who can edit the board can add one.`}
              title="Only people who can edit this board can +1 notes"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={explain}
              {...common}
            >
              <span className="dr-wk-plusone__label">+1</span>
              {p.count > 0 && <span className="dr-wk-plusone__n">{p.count}</span>}
            </button>
          )
        }
        const action = p.mine ? `Remove your +1 from ${label}` : `+1 ${label}`
        return (
          <button
            key={p.id}
            type="button"
            className="dr-wk-plusone"
            aria-pressed={p.mine}
            aria-label={`${action} (${p.count} so far)`}
            title={p.mine ? 'Remove your +1' : '+1 this note'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => toggle(p.id, e.detail === 0)}
            {...(p.locked ? { 'data-locked': 'true' } : {})}
            {...common}
          >
            <span className="dr-wk-plusone__label">+1</span>
            {p.count > 0 && <span className="dr-wk-plusone__n">{p.count}</span>}
          </button>
        )
      })}
      <p className="dr-sr-only" aria-live="polite" data-testid="plusone-announce">
        {said}
      </p>
    </>
  )
}
