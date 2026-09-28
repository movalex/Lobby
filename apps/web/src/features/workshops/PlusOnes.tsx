// +1 on sticky notes (FAC-08), canvas overlay: a small "+1" control at the bottom left of the
// hovered or selected note (tldraw's "last edited by" line is at the bottom right), and a count badge
// on every note that has +1s. One click adds or removes the person's +1 (plus-ones.ts writes it into
// the note through the canvas sync). Viewers and commenters cannot write to the canvas, so they see
// the counts; on the note they select the control is shown disabled and explains why. Hidden while
// presenting (the slides stay clean) and on notes too small on screen to carry it.

import { PLUS_ONES_META_KEY, readPlusOnes } from '@draftroom/contracts'
import { useMemo, useState } from 'react'
import { type Editor, type TLShapeId, useValue } from 'tldraw'
import type { FeatureContext } from '../types.ts'
import { canPlusOne, isPlusOneTarget, plusOneIntentsFor, writePlusOne } from './plus-ones.ts'
import { shapeLabel } from './voting.ts'

/** Notes narrower than this on screen get no +1 control or badge (they would cover the note). */
const MIN_NOTE_PX = 56
const INSET_PX = 6

interface Item {
  id: string
  x: number
  y: number
  count: number
  mine: boolean
  active: boolean
}

function focusBoard(editor: Editor) {
  editor.focus()
  editor.getContainer().focus({ preventScroll: true })
}

export function PlusOnes({ ctx, voting = false }: { ctx: FeatureContext; voting?: boolean }) {
  const { editor } = ctx
  const me = ctx.me.user.id
  // While a vote is open the counts are plain badges (R2-05, see activeKey).
  const editable = canPlusOne(ctx) && !voting
  const [said, setSaid] = useState('')

  // Notes on this page that have +1s (ids only: recomputed on document changes, not camera moves).
  // Most notes have no +1 key at all: skip parsing those (this runs over every shape on each change).
  const counted = useValue('dr-wk-plusone-notes', () => {
    const out: string[] = []
    for (const s of editor.getCurrentPageShapes()) {
      const raw = (s.meta as Record<string, unknown>)[PLUS_ONES_META_KEY]
      if (raw !== null && typeof raw === 'object' && isPlusOneTarget(s) && readPlusOnes(s.meta).length > 0)
        out.push(s.id)
    }
    return out.join(' ')
  }, [editor])

  // The notes that show the control: the one selected note, and (for people who can +1) the note
  // under the pointer with the select tool. Never the note being edited.
  const activeKey = useValue('dr-wk-plusone-active', () => {
    // While a dot vote is open, votes are the one way to back a note (final review R2-05): no "+1"
    // control, so a click never adds a public, named +1 next to anonymous dots. The counts stay.
    if (voting) return ''
    const editing = editor.getEditingShapeId()
    const out: string[] = []
    const selected = editor.getOnlySelectedShape()
    if (selected && isPlusOneTarget(selected) && selected.id !== editing) out.push(selected.id)
    if (editable && editor.getCurrentToolId() === 'select') {
      const hovered = editor.getHoveredShapeId()
      const shape = hovered ? editor.getShape(hovered) : undefined
      if (shape && isPlusOneTarget(shape) && shape.id !== editing && !out.includes(shape.id))
        out.push(shape.id)
    }
    return out.join(' ')
  }, [editor, editable, voting])

  const key = useValue('dr-wk-plusone-placed', () => {
    const active = new Set(activeKey ? activeKey.split(' ') : [])
    const ids = new Set([...(counted ? counted.split(' ') : []), ...active])
    const view = editor.getViewportScreenBounds()
    const page = editor.getCurrentPageId()
    const editing = editor.getEditingShapeId()
    const out: Item[] = []
    for (const id of ids) {
      const s = editor.getShape(id as TLShapeId)
      if (!s || id === editing || editor.getAncestorPageId(s) !== page || editor.isShapeHidden(s)) continue
      const b = editor.getShapePageBounds(s)
      if (!b) continue
      const tl = editor.pageToViewport({ x: b.minX, y: b.minY })
      const br = editor.pageToViewport({ x: b.maxX, y: b.maxY })
      if (br.x - tl.x < MIN_NOTE_PX) continue
      if (br.x < 0 || br.y < 0 || tl.x > view.w || tl.y > view.h) continue // off screen
      const people = readPlusOnes(s.meta)
      out.push({
        id,
        x: Math.round(tl.x + INSET_PX),
        y: Math.round(br.y - INSET_PX),
        count: people.length,
        mine: people.includes(me),
        active: active.has(id),
      })
    }
    return JSON.stringify(out)
  }, [editor, counted, activeKey, me])
  const items = useMemo(() => JSON.parse(key) as Item[], [key])

  const toggle = (id: string, viaKeyboard: boolean) => {
    const r = writePlusOne(editor, id as TLShapeId, me)
    if (!r.ok) {
      ctx.notify({ key: 'plusone', text: r.message ?? 'That did not work.', testId: 'plusone-toast' })
      return
    }
    plusOneIntentsFor(editor).note(id, !!r.added, Date.now())
    const n = readPlusOnes(editor.getShape(id as TLShapeId)?.meta).length
    setSaid(`${r.added ? 'Added your +1' : 'Removed your +1'}. ${n} in total.`)
    // A pointer click hands the keyboard back to the board (typing edits the note again).
    if (!viaKeyboard) focusBoard(editor)
  }

  const explain = () =>
    ctx.notify({
      key: 'plusone',
      text: 'Only people who can edit this board can +1 notes. You can still react from the top bar.',
      testId: 'plusone-toast',
    })

  if (items.length === 0 && !said) return null
  return (
    <>
      {items.map((p) => {
        const label = shapeLabel(editor.getShape(p.id as TLShapeId))
        const style = { transform: `translate(${p.x}px, ${p.y}px) translateY(-100%)` }
        const common = {
          'data-testid': 'plusone',
          'data-shape-id': p.id,
          'data-count': p.count,
          'data-mine': p.mine ? 'true' : 'false',
          'data-active': p.active ? 'true' : 'false',
          style,
        }
        if (!editable) {
          const text = `${p.count} ${p.count === 1 ? 'person' : 'people'} +1’d ${label}.`
          if (!p.active)
            return (
              <span
                key={p.id}
                className="dr-wk-plusone dr-wk-plusone--badge"
                data-readonly="true"
                title={text}
                {...common}
              >
                <span className="dr-wk-plusone__label" aria-hidden="true">
                  +1
                </span>
                <span className="dr-wk-plusone__n">{p.count}</span>
              </span>
            )
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
