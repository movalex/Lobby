// N1 (wave M follow-up 8): the New board dialog's Title and Project went with a blank board or a catalog template and were
// ignored by a workspace template's "Use template" (the copy was named for the template and put in the dashboard's project).
// The request body is built from them now (./model.ts useTemplateInput); the page behaviour is
// e2e/excalidraw/m8-templates.spec.ts.
import { UseWorkspaceTemplateInput } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { useTemplateInput } from './model.ts'

const PROJECT = 'prj_0123456789'

describe('the body of Use template', () => {
  it('carries the dialog’s title and project', () => {
    expect(useTemplateInput({ title: 'Q4 retro', projectId: PROJECT })).toEqual({
      title: 'Q4 retro',
      projectId: PROJECT,
    })
  })

  it('a blank title is none (the api names the copy for the template); the title is trimmed', () => {
    expect(useTemplateInput({ title: '', projectId: null })).toEqual({ projectId: null })
    expect(useTemplateInput({ title: '   \n ', projectId: PROJECT })).toEqual({ projectId: PROJECT })
    expect(useTemplateInput({ projectId: PROJECT })).toEqual({ projectId: PROJECT })
    expect(useTemplateInput({ title: '  Q4 retro  ', projectId: null })).toEqual({
      title: 'Q4 retro',
      projectId: null,
    })
  })

  it('no project is the workspace itself (null), as the dialog’s "No project"', () => {
    expect(useTemplateInput({ title: 'x', projectId: null }).projectId).toBeNull()
  })

  it('is always a body the api accepts (title at most 120 characters, a project id or null)', () => {
    for (const input of [
      useTemplateInput({ title: 'Q4 retro', projectId: PROJECT }),
      useTemplateInput({ title: '', projectId: null }),
      useTemplateInput({ title: 'x'.repeat(300), projectId: null }),
      useTemplateInput({ title: '🎯'.repeat(130), projectId: PROJECT }),
    ])
      expect(UseWorkspaceTemplateInput.safeParse(input).success).toBe(true)
  })
})
