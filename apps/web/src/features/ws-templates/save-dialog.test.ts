// N1 (wave M follow-up 8): the "Save as workspace template" dialog and its notice said "Everyone in <workspace> can start a
// new board from a copy of this board". Only members who may make boards can (the api's creator rule: a template use is
// a board creation), so the words name them. Rendered to static markup, as the other dialogs' words are checked.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { savedTemplateNotice } from './model.ts'
import { SaveTemplateDialog } from './SaveTemplateDialog.tsx'

const ctx = {
  workspace: { id: 'wsp_0123456789', name: 'Studio' },
  board: { id: 'b-tpl0000001', title: 'Our retro', status: 'active' },
  api: { request: () => Promise.reject(new Error('not asked in a static render')) },
  notify() {},
} as unknown as CanvasFeatureContext

describe('who the save dialog says can use a template', () => {
  it('the dialog names members who can make boards, not everyone in the workspace', () => {
    const html = renderToStaticMarkup(createElement(SaveTemplateDialog, { ctx, onClose() {} }))
    expect(html).not.toMatch(/Everyone in/i)
    expect(html).toMatch(/<strong>Studio<\/strong> who can make boards can start a new board from a copy of this board/)
    // what the copy carries is still said
    expect(html).toContain('none of its sharing')
  })

  it('the saved notice says it the same way', () => {
    const text = savedTemplateNotice('Studio')
    expect(text).toBe(
      'Saved as a workspace template. Members of Studio who can make boards can start a board from it.',
    )
    expect(text).not.toMatch(/Everyone/i)
  })
})
