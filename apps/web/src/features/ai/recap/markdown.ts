// OWNER: W2 (wave L, L2-3). "Copy as Markdown": the recap as Markdown for the client email or Slack (pure; the
// golden file recap.golden.md pins the format). Bounded at RECAP_MARKDOWN_MAX_BYTES: past it, whole lines are
// left out and the last line says so. The board's (and the AI's) words go in as plain text: line breaks become
// spaces, and the characters Markdown or the HTML in it would read as a link, an image, code, emphasis or a tag (a
// leading heading or list marker too, and a table cell's bar) are backslash-escaped, so a note's "[x](url)" or
// "<b>" pasted into an email stays words. Wave V: the registered sources' sections (./sources.ts) follow "Planned vs
// actual", a heading and a list each, their words escaped the same way.

import type { RecapPlan } from './plan.ts'

export const RECAP_MARKDOWN_MAX_BYTES = 20_000

const enc = new TextEncoder()
const bytes = (s: string) => enc.encode(s).length
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
/** Board or AI words as plain Markdown text (see the header). */
export const mdText = (s: string) =>
  flat(s)
    .replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`)
    .replace(/^(\d+)([.)])/, '$1\\$2')
    .replace(/^([#+=-])/, '\\$1')
const cell = (s: string) => mdText(s).replace(/\|/g, '\\|')
const minutes = (n: number | null) => (n === null ? '—' : `${n} min`)

export function recapMarkdown(p: RecapPlan): string {
  const lines: string[] = [`# ${flat(p.title)}`, '', `_${p.sharedLabel}_`]
  if (p.headline) lines.push('', mdText(p.headline))
  const list = (title: string, items: readonly string[]) => {
    if (!items.length) return
    lines.push('', `## ${title}`, ...items)
  }
  list(
    'Decisions',
    p.decisions.map((d) => `- ${mdText(d.text)}`),
  )
  list(
    'Action items',
    p.actions.map((a) => `- [ ] ${mdText(a.task)}${a.owner ? ` (owner: ${mdText(a.owner)})` : ''}`),
  )
  list(
    'Open questions',
    p.questions.map((q) => `- ${mdText(q.text)}`),
  )
  list(
    p.topVotedTitle,
    p.topVoted.map((v) => `${v.rank}. ${mdText(v.label)} (${v.votes} ${v.votes === 1 ? 'vote' : 'votes'})`),
  )
  if (p.plannedVsActual?.length)
    lines.push(
      '',
      '## Planned vs actual',
      '| Section | Planned | Actual |',
      '| --- | --- | --- |',
      ...p.plannedVsActual.map(
        (r) => `| ${cell(r.name)} | ${minutes(r.plannedMin)} | ${minutes(r.actualMin)} |`,
      ),
    )
  // wave V: the registered sources' sections (polls and scales, word clouds, breakouts), in order
  for (const s of p.sections)
    list(
      mdText(s.title),
      s.lines.map((l) => `- ${mdText(l.text)}`),
    )
  if (!p.ai && p.aiNote) lines.push('', `_${p.aiNote}_`)
  if (p.ai) lines.push('', '_Written with AI from the board: check it before you send it._')
  // bounded: whole lines, then a last line that says what was left out
  const out: string[] = []
  let size = 0
  const tail = '\n…(cut to fit; the rest is on the board)\n'
  for (const l of lines) {
    const next = bytes(l) + 1
    if (size + next + bytes(tail) > RECAP_MARKDOWN_MAX_BYTES) return `${out.join('\n')}${tail}`
    out.push(l)
    size += next
  }
  return `${out.join('\n')}\n`
}
