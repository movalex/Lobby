// What an export draws (docs/EXCALIDRAW-MIGRATION.md §4.5, §4.7): live elements, never a hidden one (a
// collapsed mind-map branch: render overrides do not change exports, so the exporter filters them), and,
// for a partial export, the chosen elements with their bound labels and a chosen frame's children; none
// of them with a `link` (XSS-F1, below). Pure: unit-tested in Node.

export interface ExportableElement {
  readonly id: string
  readonly type: string
  readonly isDeleted?: boolean
  readonly containerId?: string | null
  readonly frameId?: string | null
}

export interface ExportSelection {
  /** hidden ids (labels and frame children already included by the collapse): left out */
  readonly isHidden?: (id: string) => boolean
  /** only these ids (a selection or a frame), after the hidden filter */
  readonly only?: ReadonlySet<string>
}

export function exportElements<T extends ExportableElement>(
  elements: readonly T[],
  sel: ExportSelection = {},
): T[] {
  const live = elements.filter((e) => !e.isDeleted && !sel.isHidden?.(e.id))
  if (!sel.only) return live
  const keep = new Set(sel.only)
  // to a fixed point: a chosen frame's child, that child's label, …
  for (let grew = true; grew; ) {
    grew = false
    for (const e of live) {
      if (keep.has(e.id)) continue
      const viaLabel = e.type === 'text' && !!e.containerId && keep.has(e.containerId)
      const viaFrame = !!e.frameId && keep.has(e.frameId)
      if (viaLabel || viaFrame) {
        keep.add(e.id)
        grew = true
      }
    }
  }
  return live.filter((e) => keep.has(e.id))
}

/**
 * The export's copies of `elements` with no `link` (XSS-F1, the wave-4b security sweep): Excalidraw's
 * `exportToSvg` wraps a linked element in `<a href="…">`, a reference outside the file, so one link card
 * (3g's D2: a rectangle whose `link` is the URL) made `selfContainedProblems` refuse the SVG export of the
 * board or frame for everyone, and a link in a picture meant to stand alone is a navigation nobody asked
 * for. The scene is never written: unlinked elements are returned as they are.
 */
export function withoutLinks<T extends object>(elements: readonly T[]): T[] {
  return elements.map((e) => ((e as { link?: unknown }).link ? ({ ...e, link: null } as T) : e))
}

/**
 * The `id` an SVG export's files-map entry carries (fix/firefox): Excalidraw's `exportToSvg` names each image's
 * `<symbol>` `image-<file id>` and first looks it up with `querySelector('#image-<file id>')`, which throws on a CSS
 * character, so an image shown from its display file (`ver_X@display`: the derivative swap, any 2x screen, a Retina
 * Mac in Safari) was left out of the SVG, with only a console error. Letters, digits and `_` stay; every other
 * character becomes `-<hex>-` (`-` itself too, so two file ids never share one). The map stays keyed by the
 * element's own `fileId`: only the symbol's name changes.
 */
export const svgFileSymbolId = (fileId: string): string =>
  fileId.replace(/[^A-Za-z0-9_]/g, (c) => `-${(c.codePointAt(0) ?? 0).toString(16)}-`)
