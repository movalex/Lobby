// Wave W (WS3, docs/WAVE-W-CONTRACTS.md §5, §8.2): file pages in Ask across boards. They are a third source while
// DRAFTROOM_FILE_SEARCH is on, a capped share of the input (FILE_TEXT_LIMITS.askShareChars), only from boards whose AI is
// on and whose exports this person may use, and only pages a search would return them (placed and served there).

import { FILE_TEXT_LIMITS } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { itemsOf } from '../ai/fake-openai.ts'
import {
  type AskWorld,
  ask,
  askWorld,
  boardWith,
  grantOn,
  indexAll,
  promptOf,
} from '../ai/workspace-ask-support.ts'
import { addPdf, extract, type FileSync, fileObject, withAssetRefs } from './file-support.ts'
import { touch } from './support.ts'

let w: AskWorld | null = null
afterEach(async () => {
  await w?.close()
  w = null
})

const answer = (text: string, citations: string[][]) => ({
  kind: 'content' as const,
  content: { answer: text, found: 'yes', citations: citations.map((ids) => ({ ids })) },
})

async function world(env: Record<string, string> = { DRAFTROOM_FILE_SEARCH: 'on' }) {
  w = await askWorld({ env })
  return { w, sync: withAssetRefs(w.sync) as FileSync }
}

describe('Ask across boards: file pages', () => {
  it('sends the matching pages of placed files, labelled, and cites them by their file hit id', async () => {
    const { w, sync } = await world()
    const a = await boardWith(w, 'Pricing workshop', ['Pricing note: monthly'], {
      visibility: 'workspace_view',
    })
    const v = await addPdf(w.api, a.id, w.bob, 'Brief.pdf')
    await extract(w.api, v, {
      1: 'Cover',
      2: 'Pricing decision: the annual plan wins',
      3: 'Unrelated appendix',
    })
    sync.setRefs(a.id, [v])
    await indexAll(w)
    w.openai.next(answer('Annual wins [1].', [['b1.f1']]))
    const r = await ask(w.carol, 'What did we decide about pricing?')
    const items = itemsOf(w.openai.requests[0] as never)
    expect(items).toContainEqual({
      id: 'b1.f1',
      type: 'file',
      text: '[Brief.pdf p.2] Pricing decision: the annual plan wins',
    })
    expect(items.map((i) => i.text).join('\n')).not.toContain('Unrelated appendix')
    const prompt = promptOf(w)
    expect(prompt).not.toContain(v.versionId) // aliases only
    expect(prompt).toContain('Items of type file are pages of files')
    expect(r.citations).toEqual([
      { boardId: a.id, boardTitle: 'Pricing workshop', elementIds: [fileObject(v.versionId, 2)] },
    ])
  })

  it('never sends a file page of a board this person may not export from, nor of one they cannot open', async () => {
    const { w, sync } = await world()
    const open = await boardWith(w, 'Open board', ['Launch date: October'], { visibility: 'workspace_view' })
    const limited = await boardWith(w, 'Limited board', ['Launch note'], { visibility: 'workspace_view' })
    const hidden = await boardWith(w, 'Hidden board', ['Launch hidden note'])
    const vl = await addPdf(w.api, limited.id, w.bob, 'Limited.pdf')
    const vh = await addPdf(w.api, hidden.id, w.bob, 'Hidden.pdf')
    await extract(w.api, vl, { 1: 'Launch date from the limited file: secretly November' })
    await extract(w.api, vh, { 1: 'Launch date from the hidden file: privately December' })
    sync.setRefs(limited.id, [vl])
    sync.setRefs(hidden.id, [vh])
    await grantOn(w, limited.id, w.dave, 'editor')
    await indexAll(w)
    const pol = await w.bob.req('PUT', `/api/boards/${limited.id}/export-policy`, { exportPolicy: 'editors' })
    expect(pol.statusCode, pol.body).toBe(200)
    w.openai.next(answer('October [1].', [['b1.n1']]))
    await ask(w.carol, 'When is the launch date?')
    const prompt = promptOf(w, 0)
    expect(prompt).toContain('Launch date: October')
    for (const words of ['secretly November', 'privately December', 'Limited.pdf', 'Hidden.pdf'])
      expect(prompt, words).not.toContain(words)
    // an editor of the limited board may copy out of it: its file page is sent to him
    w.openai.next(answer('November [1].', [['b1.f1']]))
    await ask(w.dave, 'When is the launch date?')
    expect(promptOf(w, 1)).toContain('secretly November')
    expect(promptOf(w, 1)).not.toContain('privately December')
    expect(open.id).toBeTruthy()
  })

  it('a file removed from the board is not sent after the reindex', async () => {
    const { w, sync } = await world()
    const a = await boardWith(w, 'Board', ['Budget note'], { visibility: 'workspace_view' })
    const v = await addPdf(w.api, a.id, w.bob, 'Budget.pdf')
    await extract(w.api, v, { 1: 'Budget: 10k for the launch' })
    sync.setRefs(a.id, [v])
    await indexAll(w)
    sync.setRefs(a.id, [])
    await touch(w.api, a.id)
    w.openai.next(answer('No [1].', [['b1.n1']]))
    await ask(w.carol, 'What is the budget?')
    expect(promptOf(w)).not.toContain('10k for the launch')
  })

  it('keeps file text within its share of the input', async () => {
    const { w, sync } = await world()
    const a = await boardWith(w, 'Big', ['Roadmap note'], { visibility: 'workspace_view' })
    const pages: Record<number, string> = {}
    for (let p = 1; p <= 4; p++) pages[p] = `Roadmap page ${p}: ${'milestone '.repeat(400)}`
    const files = []
    for (let f = 0; f < 4; f++) {
      const v = await addPdf(w.api, a.id, w.bob, `Roadmap ${f}.pdf`)
      await extract(w.api, v, pages)
      files.push(v)
    }
    sync.setRefs(a.id, files)
    await indexAll(w)
    w.openai.next(answer('Milestones [1].', [['b1.f1']]))
    await ask(w.carol, 'What are the roadmap milestones?')
    const fileItems = itemsOf(w.openai.requests[0] as never).filter((i) => i.type === 'file')
    expect(fileItems.length).toBeGreaterThan(0)
    const used = fileItems.reduce((n, i) => n + i.text.length, 0) + 'Big'.length
    expect(used).toBeLessThanOrEqual(FILE_TEXT_LIMITS.askShareChars)
  })

  it('with DRAFTROOM_FILE_SEARCH off, no file text is sent', async () => {
    const { w, sync } = await world({})
    const a = await boardWith(w, 'Board', ['Pricing note'], { visibility: 'workspace_view' })
    const v = await addPdf(w.api, a.id, w.bob, 'Brief.pdf')
    await w.api.db.query(
      `INSERT INTO file_text_state (version_id, workspace_id, status, pages, bytes, extractor)
       VALUES ($1, $2, 'done', 1, 40, 'pdfjs-6.3.289')`,
      [v.versionId, v.workspaceId],
    )
    await w.api.db.query(
      `INSERT INTO file_text_pages (version_id, workspace_id, page, body, tsv)
       VALUES ($1, $2, 1, 'Pricing from the file', to_tsvector('simple', 'pricing from the file'))`,
      [v.versionId, v.workspaceId],
    )
    await w.api.db.query(
      'INSERT INTO board_file_refs (board_id, workspace_id, version_id) VALUES ($1, $2, $3)',
      [a.id, v.workspaceId, v.versionId],
    )
    sync.setRefs(a.id, [v])
    await indexAll(w)
    w.openai.next(answer('Monthly [1].', [['b1.n1']]))
    await ask(w.carol, 'What about pricing?')
    expect(promptOf(w)).not.toContain('Pricing from the file')
    expect(sync.refsCalls).toEqual([])
  })
})
