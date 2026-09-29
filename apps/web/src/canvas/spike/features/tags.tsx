// Tags and +1 for spike B (docs/EXCALIDRAW-MIGRATION.md §8.1; checks B1.2, U1, U2, F13): `tag:<key>`
// element keys with the board's `tagDef:<key>` doc key (the server accepts a tag only once it is in
// `lb_doc`, §3.3), and `plusOne:<uid>` = true (identity-bound: only my own uid). Chips and +1 badges are
// drawn in the overlay. Every write is one `CanvasPort.transact` step (so one undo step: U1, U2).
import type { CSSProperties } from 'react'
import type { CanvasElement, CanvasPort } from '../../port.ts'
import type { OverlayLayerProps } from '../../registries.ts'
import { onScreen, usePortTick } from './hooks.ts'
import {
  isPlusOneTarget,
  plusOnePatch,
  plusOnesOf,
  TAG_CHIP_HEX,
  type TagView,
  tagsOf,
  tagWrite,
} from './model.ts'
import type { FeatureRuntime } from './runtime.ts'

/** How many tag definitions the board has (for the next colour of the rotation). */
function definedTags(port: CanvasPort): number {
  let n = 0
  for (const k of port.engine?.doc().keys() ?? []) if (k.startsWith('tagDef:')) n++
  return n
}

export type TagResult = { ok: true; key: string } | { ok: false; error: string }

/**
 * Tags `ids` with `name`: defines the tag on the board first (a doc write, in this session's push order)
 * when it is new, then writes the key on each element in one transact step.
 */
export function tagElements(
  rt: FeatureRuntime,
  ids: readonly string[],
  name: string,
  color?: TagView['color'],
): TagResult {
  const port = rt.port
  const w = tagWrite(name, {
    existing: (k) => port.engine?.doc().get(k),
    defined: definedTags(port),
    ...(color ? { color } : {}),
  })
  if (!w.ok) return w
  const targets = ids.map((id) => port.get(id)).filter((el): el is CanvasElement => !!el && !el.isDeleted)
  if (!targets.length) return { ok: false, error: 'Select something to tag.' }
  const doc = port.engine?.doc().get(w.docKey) as { name?: string; color?: string } | undefined
  if (!doc || doc.name !== w.value.name || doc.color !== w.value.color)
    port.engine?.setDoc({ [w.docKey]: w.value })
  port.transact('Tag', (tx) => {
    for (const el of targets) tx.update(el.id, { customData: { lobby: { [w.elementKey]: w.value } } })
  })
  return { ok: true, key: w.key }
}

/** Removes the tag `key` from `ids` (one transact step). */
export function untagElements(rt: FeatureRuntime, ids: readonly string[], key: string): void {
  const elementKey = `tag:${key}`
  const targets = ids
    .map((id) => rt.port.get(id))
    .filter((el) => el?.customData?.lobby?.[elementKey] !== undefined)
  if (!targets.length) return
  rt.port.transact('Untag', (tx) => {
    for (const el of targets) if (el) tx.update(el.id, { customData: { lobby: { [elementKey]: null } } })
  })
}

/**
 * My +1 on `id`: set (`want` true), cleared (false) or toggled. Refused locally while a dot vote runs
 * (the server refuses it too: `VOTE_OPEN`, F13).
 */
export function plusOne(rt: FeatureRuntime, id: string, want?: boolean, voteOpen = false): boolean {
  const me = rt.me()
  const el = rt.port.get(id)
  if (!me || !el || !isPlusOneTarget(el)) return false
  const patch = plusOnePatch(el, me.uid, want)
  if (!patch) return false
  if (voteOpen && Object.values(patch).includes(true)) {
    rt.toast('+1 is off while a vote runs')
    return false
  }
  rt.port.transact('+1', (tx) => tx.update(id, { customData: { lobby: patch } }))
  return true
}

const chipStyle = (hex: string): CSSProperties => ({
  display: 'inline-block',
  padding: '1px 6px',
  marginRight: 3,
  borderRadius: 8,
  background: hex,
  color: hex === '#ffffff' ? '#222' : '#fff',
  font: '600 11px/16px system-ui, sans-serif',
  whiteSpace: 'nowrap',
  border: hex === '#ffffff' ? '1px solid #ccc' : 'none',
})

/** The overlay: tag chips under each tagged element, and a +N badge on each element with +1s. */
export function makeTagsLayer(rt: FeatureRuntime) {
  return function TagsLayer({ port }: OverlayLayerProps) {
    usePortTick(port, ['changed', 'viewportChanged'])
    const me = rt.me()?.uid
    const out = []
    for (const el of port.items()) {
      if (rt.registries.hidden.isHidden(el.id)) continue
      const tags = tagsOf(el)
      const plus = plusOnesOf(el)
      if (!tags.length && !plus.length) continue
      const b = port.bounds(el.id)
      if (!b) continue
      if (tags.length) {
        const at = onScreen(port, b.x, b.y + b.height)
        if (at)
          out.push(
            <div
              key={`t:${el.id}`}
              data-lobby-tags={el.id}
              style={{ position: 'fixed', left: at.x, top: at.y + 4, pointerEvents: 'none', zIndex: 5 }}
            >
              {tags.map((t) => (
                <span key={t.key} data-lobby-tag-chip={t.key} style={chipStyle(TAG_CHIP_HEX[t.color])}>
                  #{t.name}
                </span>
              ))}
            </div>,
          )
      }
      if (plus.length) {
        const at = onScreen(port, b.x + b.width, b.y)
        if (at)
          out.push(
            <div
              key={`p:${el.id}`}
              data-lobby-plusones={el.id}
              data-count={plus.length}
              data-mine={me && plus.includes(me) ? '1' : '0'}
              style={{
                position: 'fixed',
                left: at.x - 18,
                top: at.y - 10,
                minWidth: 22,
                padding: '1px 5px',
                borderRadius: 10,
                background: me && plus.includes(me) ? '#4465e9' : '#fff',
                color: me && plus.includes(me) ? '#fff' : '#333',
                border: '1px solid #4465e9',
                font: '700 11px/16px system-ui, sans-serif',
                textAlign: 'center',
                pointerEvents: 'none',
                zIndex: 6,
              }}
            >
              +{plus.length}
            </div>,
          )
      }
    }
    return <>{out}</>
  }
}
