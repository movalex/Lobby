// A map as an outline (pure): Markdown (a heading for the central topic, then a nested list) or CSV
// (one row per topic: level, topic, parent, path). Collapsed branches are included: the outline is the
// map's content, not what happens to be expanded. Branches follow the map's reading order, clockwise
// from the top right (model.ts clockwiseBranches); children top to bottom.
//
// Engine-neutral: the CSV cell formatter is passed in (./outline.ts gives the board CSV's csvTextCell), so
// the tldraw feature and the ported one (./ported/outline.ts) share these rules without sharing imports.

import { MINDMAP_OUTLINE_CSV_HEADER } from '@draftroom/contracts'
import { clockwiseBranches, type MindmapTree } from './model.ts'
/** What an empty topic is called in an outline. */
export const EMPTY_TOPIC = '(empty topic)'

export interface OutlineRow {
  id: string
  level: number
  text: string
  parentText: string
  path: string[]
}

/** One line of topic text: line breaks and runs of whitespace become single spaces. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** The topics in outline order with their text (depth-first, the root first at level 0). */
export function outlineRows(tree: MindmapTree, textOf: (id: string) => string): OutlineRow[] {
  const rows: OutlineRow[] = []
  const label = (id: string) => oneLine(textOf(id)) || EMPTY_TOPIC
  const visit = (id: string, level: number, path: string[], parentText: string) => {
    const n = tree.nodes.get(id)
    if (!n) return
    const text = label(id)
    const here = [...path, text]
    rows.push({ id, level, text, parentText, path: here })
    const kids = n.parentId === null ? clockwiseBranches(tree) : n.children
    for (const k of kids) visit(k, level + 1, here, text)
  }
  visit(tree.rootId, 0, [], '')
  return rows
}

/**
 * Escapes what Markdown would otherwise read as formatting or structure: inline markup characters
 * anywhere, and a leading marker that would start a heading, quote, list or numbered list.
 */
export function escapeMarkdown(text: string): string {
  const inline = text.replace(/[\\`*_[\]<>|~]/g, (c) => `\\${c}`)
  return inline.replace(/^(#{1,6}|>|[-+])(?=\s|$)/, '\\$1').replace(/^(\d+)([.)])(?=\s|$)/, '$1\\$2')
}

/** `# Central topic` then `- Branch` lists, two spaces per level. Ends with a newline. */
export function outlineMarkdown(tree: MindmapTree, textOf: (id: string) => string): string {
  const lines: string[] = []
  for (const row of outlineRows(tree, textOf)) {
    const text = escapeMarkdown(row.text)
    if (row.level === 0) lines.push(`# ${text}`, '')
    else lines.push(`${'  '.repeat(row.level - 1)}- ${text}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * CSV with the header `level,topic,parent,path` (RFC 4180, CRLF records; `cell` quotes and
 * formula-neutralizes each text cell). `path` joins the topics from the root with " > ".
 */
export function outlineCsvWith(
  tree: MindmapTree,
  textOf: (id: string) => string,
  cell: (text: string) => string,
): string {
  const lines = [MINDMAP_OUTLINE_CSV_HEADER.join(',')]
  for (const row of outlineRows(tree, textOf)) {
    lines.push(
      [String(row.level), cell(row.text), cell(row.parentText), cell(row.path.join(' > '))].join(','),
    )
  }
  return `${lines.join('\r\n')}\r\n`
}
