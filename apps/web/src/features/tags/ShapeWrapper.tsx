// Tag chips on notes, cards, images and shapes, drawn in the shape itself through tldraw 5.4.2's `ShapeWrapper`
// component slot (the div each shape renders into; editor Shape.tsx). Being inside the shape, the chips:
//  - move, scale and rotate with it through the camera's CSS transform: no work per frame or per camera
//    move, and they stack with their note (a note on top covers the chips of the note below);
//  - are culled with it (tldraw hides culled shape containers);
//  - carry the shape's tag keys as `data-dr-tags`, which the "Show only #tag" filter matches in one
//    stylesheet rule (Overlay.tsx), again with no per-shape JavaScript.
// Level of detail: full chips, colour dots or nothing, set by one reactor on the editor container
// (runtime.ts tagsLodFor) and applied by CSS.
// Chips re-render only when the shape's meta or the board's tag list changes (not when it moves).

import type { TagDef } from '@draftroom/contracts'
import { forwardRef, memo } from 'react'
import { DefaultShapeWrapper, type TLShape, type TLShapeWrapperProps, useEditor, useValue } from 'tldraw'
import {
  chipLayout,
  chipPlacement,
  displayTags,
  isShortTagName,
  isTaggable,
  type Meta,
  tagTokens,
} from './model.ts'
import { boardTags } from './runtime.ts'

export const TagShapeWrapper = forwardRef<HTMLDivElement, TLShapeWrapperProps>(function TagShapeWrapper(
  { children, shape, isBackground, ...rest },
  ref,
) {
  // Cheap for every shape: a type check, then (notes and cards) one cached parse per meta object.
  const tokens = isTaggable(shape) ? tagTokens(shape.meta) : ''
  return (
    <DefaultShapeWrapper
      ref={ref}
      shape={shape}
      isBackground={isBackground}
      {...rest}
      data-dr-tags={tokens || undefined}
    >
      {children}
      {tokens && !isBackground ? (
        <TagChips meta={shape.meta} kind={shape.type} scale={scaleOf(shape)} />
      ) : null}
    </DefaultShapeWrapper>
  )
})

function scaleOf(shape: TLShape): number {
  const s = (shape.props as { scale?: unknown }).scale
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1
}

const TagChips = memo(function TagChips({ meta, kind, scale }: { meta: Meta; kind: string; scale: number }) {
  const editor = useEditor()
  const board = useValue('dr-tag-board', () => boardTags(editor).get(), [editor])
  const tags = displayTags(meta, board)
  if (!tags.length) return null
  const { shown, more } = chipLayout(tags)
  return (
    <ul
      className="dr-tag-chips"
      data-kind={chipPlacement(kind)}
      data-testid="tag-chips"
      data-tags={tags.map((t) => t.key).join(' ')}
      aria-label={`Tags: ${tags.map((t) => t.name).join(', ')}`}
      style={scale === 1 ? undefined : { ['--dr-tag-scale' as string]: scale }}
    >
      {tags.map((t, i) => (
        <Chip key={t.key} tag={t} overflow={i >= shown.length} />
      ))}
      {more > 0 && (
        <li className="dr-tag-chip dr-tag-chip--more" data-testid="tag-chip-more" data-dr-tag-color="grey">
          +{more}
        </li>
      )}
    </ul>
  )
})

/** `overflow`: behind "+N" at full size, but still a dot when zoomed out (every tag's colour shows). */
function Chip({ tag, overflow }: { tag: TagDef; overflow: boolean }) {
  return (
    <li
      className="dr-tag-chip"
      data-testid={overflow ? 'tag-chip-overflow' : 'tag-chip'}
      data-tag-key={tag.key}
      data-dr-tag-color={tag.color}
      data-overflow={overflow || undefined}
      // Short names never shrink: a long neighbour takes the ellipsis instead.
      data-whole={isShortTagName(tag.name) || undefined}
    >
      {tag.name}
    </li>
  )
}
