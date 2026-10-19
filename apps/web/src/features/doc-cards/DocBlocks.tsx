// OWNER: WS1 (wave W, doc cards). A doc card's words as React nodes (./markdown-lite.ts's tree): the card's face on the
// board (./DocFace.tsx) and the panel's Preview (./DocEditor.tsx) draw the same nodes. Text is only ever a React text
// child, never markup (no dangerouslySetInnerHTML anywhere in apps/web/src): `<b>` typed in a card shows as `<b>`.
//
// Each source line is one line of the face, at the label's own font size and line height, so the face is as tall as
// the words Excalidraw laid out on the card (headings by weight, not size). Consecutive items are one list (a list
// for screen readers), nested by their indent.
import { memo, type ReactNode } from 'react'
import { type Block, type Inline, itemMarker, type ParsedDoc } from './markdown-lite.ts'

export interface DocBlocksProps {
  readonly doc: ParsedDoc
  /** 'face': links and checkboxes take no keyboard focus (the panel is the keyboard's way in) */
  readonly mode: 'face' | 'preview'
  /** a checklist item's box was pressed (null: the boxes are read-only) */
  readonly onToggle: ((line: number) => void) | null
}

function inlineNodes(nodes: readonly Inline[], mode: DocBlocksProps['mode'], key = ''): ReactNode[] {
  return nodes.map((n, i): ReactNode => {
    const k = `${key}${i}`
    if (n.t === 'text') return n.s
    if (n.t === 'code')
      return (
        <code key={k} className="lobby-doc__code">
          {n.s}
        </code>
      )
    if (n.t === 'strong') return <strong key={k}>{inlineNodes(n.c, mode, `${k}.`)}</strong>
    if (n.t === 'em') return <em key={k}>{inlineNodes(n.c, mode, `${k}.`)}</em>
    // a link: only a safe target is one (markdown-lite.ts safeHref: https, or a Lobby-relative board path), opened in
    // a new tab with no opener and no referrer; nothing is fetched for it
    return n.href ? (
      <a
        key={k}
        className="lobby-doc__link dr-interactive"
        href={n.href}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        tabIndex={mode === 'face' ? -1 : undefined}
        draggable={false}
        data-testid="doc-card-link"
      >
        {inlineNodes(n.c, mode, `${k}.`)}
      </a>
    ) : (
      <span key={k} className="lobby-doc__nolink" data-testid="doc-card-nolink">
        {inlineNodes(n.c, mode, `${k}.`)}
      </span>
    )
  })
}

type Item = Extract<Block, { t: 'item' }>

function ItemLine({
  b,
  mode,
  onToggle,
}: {
  b: Item
  mode: DocBlocksProps['mode']
  onToggle: DocBlocksProps['onToggle']
}) {
  const words = inlineNodes(b.c, mode)
  return (
    <li
      className="lobby-doc__item"
      data-list={b.list}
      data-checked={b.list === 'check' ? String(b.checked) : undefined}
      style={b.depth ? { paddingLeft: `${b.depth * 1.25}em` } : undefined}
    >
      {b.list === 'check' ? (
        onToggle ? (
          <input
            type="checkbox"
            className="lobby-doc__check dr-interactive"
            checked={b.checked}
            tabIndex={mode === 'face' ? -1 : undefined}
            aria-label={b.checked ? 'Done' : 'Not done'}
            data-testid="doc-card-check"
            data-line={b.line}
            onChange={() => onToggle(b.line)}
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="lobby-doc__box"
            role="img"
            aria-label={b.checked ? 'Done' : 'Not done'}
            data-testid="doc-card-box"
          >
            {itemMarker(b)}
          </span>
        )
      ) : (
        <span className="lobby-doc__marker" aria-hidden="true">
          {itemMarker(b)}
        </span>
      )}{' '}
      <span className={b.checked ? 'lobby-doc__done' : undefined}>{words}</span>
    </li>
  )
}

/**
 * The blocks, consecutive items grouped into one list. Memoized: the same parsed words (state.ts caches them by
 * text), mode and toggle give the same nodes, so a face that only moves with the camera renders nothing again.
 */
export const DocBlocks = memo(function DocBlocks({ doc, mode, onToggle }: DocBlocksProps) {
  const out: ReactNode[] = []
  const blocks = doc.blocks
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] as Block
    if (b.t === 'item') {
      // one list per run of items of one kind: numbered ones, or bullets and checklists together
      const numbered = b.list === 'number'
      const items: Item[] = []
      let j = i
      while (j < blocks.length) {
        const next = blocks[j] as Block
        if (next.t !== 'item' || (next.list === 'number') !== numbered) break
        items.push(next)
        j++
      }
      const List = numbered ? 'ol' : 'ul'
      out.push(
        <List key={`l${b.line}`} className="lobby-doc__list" role="list">
          {items.map((it) => (
            <ItemLine key={it.line} b={it} mode={mode} onToggle={onToggle} />
          ))}
        </List>,
      )
      i = j - 1
      continue
    }
    switch (b.t) {
      case 'heading': {
        // one level below the panel's or the page's own heading
        const H = `h${b.level + 1}` as 'h2' | 'h3' | 'h4'
        out.push(
          <H key={b.line} className="lobby-doc__heading" data-level={b.level}>
            {inlineNodes(b.c, mode)}
          </H>,
        )
        break
      }
      case 'para':
        out.push(
          <p key={b.line} className="lobby-doc__line">
            {inlineNodes(b.c, mode)}
          </p>,
        )
        break
      case 'quote':
        out.push(
          <blockquote key={b.line} className="lobby-doc__quote">
            {inlineNodes(b.c, mode)}
          </blockquote>,
        )
        break
      case 'rule':
        out.push(<hr key={b.line} className="lobby-doc__rule" />)
        break
      case 'blank':
        out.push(<p key={b.line} className="lobby-doc__line lobby-doc__blank" aria-hidden="true" />)
        break
      case 'plain': {
        // past a budget (DOC_CARD_LIMITS): every remaining line is ONE paragraph of text (the face is pre-wrap, so
        // its line breaks stay), never one node per line, so the budgets cap the face's DOM nodes too
        let j = i
        const rest: string[] = []
        while (j < blocks.length && (blocks[j] as Block).t === 'plain') {
          rest.push((blocks[j] as Extract<Block, { t: 'plain' }>).s)
          j++
        }
        out.push(
          <p key={`p${b.line}`} className="lobby-doc__line lobby-doc__rest" data-testid="doc-card-rest">
            {rest.join('\n')}
          </p>,
        )
        i = j - 1
        break
      }
    }
  }
  return <>{out}</>
})
