// "Hide note authors" (a workshops session setting, features/workshops/session-settings.ts) also
// applies to exports: tldraw 5.4.2 draws a note's "last edited by" name in its SVG export as
// <foreignObject …><div …><div class="tl-note__attribution" …>Name</div></div></foreignObject>
// (NoteShapeUtil.toSvg). PNG, SVG, PDF and copy-as-PNG all rasterize or save that SVG, so the name is
// removed from the SVG string before that. Pure: unit-tested in Node.

/**
 * The attribution element (the class as a whole token). Its content is only the XML-escaped name, so
 * the first `<` after the start tag is its end tag.
 */
const ATTRIBUTION = /<div\b[^>]*\bclass="(?:[^"]*\s)?tl-note__attribution(?:\s[^"]*)?"[^>]*>[^<]*<\/div>/g

/** The SVG without any note's author name. */
export function stripNoteAuthors(svg: string): string {
  return svg.replace(ATTRIBUTION, '')
}
