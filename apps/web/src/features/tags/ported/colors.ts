// Tag colours as CSS custom properties: `--dr-tag-fill` / `--dr-tag-ink` on anything with
// `data-dr-tag-color`, from the note palette, in the app's light and dark themes (html[data-theme]).
// The port of ../Overlay.tsx tagColorCss: the chips here are DOM over the canvas (not inside tldraw's
// themed container), so the app's theme decides.

import { NOTE_PALETTE } from '../../canvas-ux/palette.ts'

export function tagColorCss(): string {
  const out: string[] = []
  const rule = (sel: string, v: { fill: string; text: string }) =>
    `${sel}{--dr-tag-fill:${v.fill};--dr-tag-ink:${v.text}}`
  for (const sw of NOTE_PALETTE) {
    const el = `[data-dr-tag-color="${sw.name}"]`
    out.push(rule(el, sw.light))
    out.push(rule(`:root[data-theme="dark"] ${el}`, sw.dark))
  }
  return out.join('\n')
}

export const TAG_COLOR_CSS = tagColorCss()
