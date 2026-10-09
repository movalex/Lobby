// OWNER: W2 (wave L, L2-3). "Copy as Markdown": the recap as Markdown for the client email or Slack (pure; the
// golden file recap.golden.md pins the format). Bounded at RECAP_MARKDOWN_MAX_BYTES: past it, whole lines are
// left out and the last line says so. The board's words go in as plain text: line breaks become spaces and the
// characters Markdown would read as structure in a table cell are escaped.

import type { RecapPlan } from './plan.ts'

export const RECAP_MARKDOWN_MAX_BYTES = 20_000

const enc = new TextEncoder()
const bytes = (s: string) => enc.encode(s).length
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const cell = (s: string) => flat(s).replace(/\|/g, '\\|')
const minutes = (n: number | null) => (n === null ? '—' : `${n} min`)

export function recapMarkdown(p: RecapPlan): string {
  const lines: string[] = [`# ${flat(p.title)}`, '', `_${p.scopeLabel}_`]
  if (p.headline) lines.push('', flat(p.headline))
  const list = (title: string, items: readonly string[]) => {
    if (!items.length) return
    lines.push('', `## ${title}`, ...items)
  }
  list(
    'Decisions',
    p.decisions.map((d) => `- ${flat(d.text)}`),
  )
  list(
    'Action items',
    p.actions.map((a) => `- [ ] ${flat(a.task)}${a.owner ? ` (owner: ${flat(a.owner)})` : ''}`),
  )
  list(
    'Open questions',
    p.questions.map((q) => `- ${flat(q.text)}`),
  )
  list(
    p.topVotedTitle,
    p.topVoted.map((v) => `${v.rank}. ${flat(v.label)} (${v.votes} ${v.votes === 1 ? 'vote' : 'votes'})`),
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
