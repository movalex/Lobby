// OWNER: W8 (wave M, M8-4). The 'ws-templates' board feature: who is offered "Save as workspace template" (the
// command and the board menu entry), and the picker's pure rules (./model.ts).
import { PALETTE_COMMAND_IDS, type WorkspaceTemplate } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { feature as askFeature } from '../ai/workspace-ask/index.tsx'
import { CANVAS_FEATURES } from '../canvas-registry.ts'
import { resetWsTemplatesForTests } from './client.ts'
import { feature, MAIN_MENU, saveOffered, WS_TEMPLATES_SAVE_COMMAND_ID } from './index.tsx'
import {
  canSaveWsTemplate,
  defaultTemplateName,
  filterWsTemplates,
  templateMeta,
  templateNameOrNull,
} from './model.ts'

afterEach(() => resetWsTemplatesForTests())

const WID = 'wsp_0123456789'

function ctxFor(
  over: { creator?: boolean; role?: string | null; status?: string } = {},
): CanvasFeatureContext {
  return {
    workspace: { id: WID, name: 'Studio' },
    board: { id: 'b-tpl0000001', title: 'Our retro', status: over.status ?? 'active' },
    me: {
      access: { creator: over.creator ?? true, reason: 'domain', email: null },
      workspaces: over.role === null ? [] : [{ id: WID, name: 'Studio', role: over.role ?? 'admin' }],
    },
  } as unknown as CanvasFeatureContext
}

describe('the board feature', () => {
  it('is registered (with ai-workspace-ask right after it); both commands are static palette commands', () => {
    const ids = CANVAS_FEATURES.map((f) => f.id)
    // wave N's features follow them (features/wave-n-stubs.test.ts)
    const at = ids.indexOf('ws-templates')
    expect(ids.slice(at, at + 2)).toEqual(['ws-templates', 'ai-workspace-ask'])
    expect(feature.commands?.map((c) => c.id)).toEqual([WS_TEMPLATES_SAVE_COMMAND_ID])
    expect(askFeature.commands?.map((c) => c.id)).toEqual(['ai.askWorkspace'])
    for (const id of [WS_TEMPLATES_SAVE_COMMAND_ID, 'ai.askWorkspace'])
      expect(PALETTE_COMMAND_IDS as readonly string[]).toContain(id)
    expect(MAIN_MENU.map((e) => [e.group, e.command])).toEqual([['board', WS_TEMPLATES_SAVE_COMMAND_ID]])
  })

  it('is offered to a creator who is a workspace owner or admin only (command and menu entry alike)', () => {
    const cmd = feature.commands?.[0]
    const entry = MAIN_MENU[0]
    const cases: [Parameters<typeof ctxFor>[0], boolean][] = [
      [{ role: 'owner' }, true],
      [{ role: 'admin' }, true],
      [{ role: 'admin', status: 'archived' }, true],
      [{ role: 'member' }, false],
      [{ role: 'guest' }, false],
      [{ role: null }, false], // a name-only guest has no role in the workspace
      [{ role: 'owner', creator: false }, false],
      [{ role: 'admin', status: 'trashed' }, false],
    ]
    for (const [over, offered] of cases) {
      const ctx = ctxFor(over)
      expect(saveOffered(ctx), JSON.stringify(over)).toBe(offered)
      expect(cmd?.available?.(ctx), JSON.stringify(over)).toBe(offered)
      expect(entry?.visible?.(ctx, { ids: [], point: null, hit: null }), JSON.stringify(over)).toBe(offered)
    }
    // it changes nothing on the board, so a read-only (archived) board can be saved too
    expect(cmd?.readOnlyAllowed).toBe(true)
  })

  it('an api without templates (a 404 seen in this tab) hides it', () => {
    expect(
      canSaveWsTemplate({
        access: { creator: true },
        workspaceRole: 'owner',
        boardStatus: 'active',
        missing: true,
      }),
    ).toBe(false)
  })
})

describe('the picker’s rules', () => {
  const t = (
    name: string,
    category: WorkspaceTemplate['category'],
    by: string | null,
  ): WorkspaceTemplate => ({
    boardId: `b-${name.toLowerCase().replace(/\W/g, '')}00`,
    name,
    category,
    addedBy: by ? { id: 'usr_0123456789', name: by } : null,
    addedAt: '2026-10-10T00:00:00.000Z',
  })
  const all = [t('Our retro', 'review', 'Ana'), t('Kickoff', 'plan', null), t('Café crawl', 'ideate', 'Bo')]

  it('searches every word in the name, the category word and who saved it (accents folded)', () => {
    expect(filterWsTemplates(all, '').map((x) => x.name)).toEqual(['Our retro', 'Kickoff', 'Café crawl'])
    expect(filterWsTemplates(all, 'retro').map((x) => x.name)).toEqual(['Our retro'])
    expect(filterWsTemplates(all, 'plan').map((x) => x.name)).toEqual(['Kickoff'])
    expect(filterWsTemplates(all, 'cafe bo').map((x) => x.name)).toEqual(['Café crawl'])
    expect(filterWsTemplates(all, 'ana kickoff')).toEqual([])
  })

  it('the card line, the default name and the name check', () => {
    expect(templateMeta(all[0] as WorkspaceTemplate)).toBe('Review · saved by Ana')
    expect(templateMeta(all[1] as WorkspaceTemplate)).toBe('Plan')
    expect(defaultTemplateName('  Our   retro  ')).toBe('Our retro')
    expect(defaultTemplateName('x'.repeat(200))).toHaveLength(80)
    expect(defaultTemplateName('   ')).toBe('Team template')
    expect(templateNameOrNull('  Retro ')).toBe('Retro')
    expect(templateNameOrNull('   ')).toBeNull()
    expect(templateNameOrNull('x'.repeat(81))).toBeNull()
  })
})

describe('the picker’s Workspace tab (dashboard/TemplateGallery.tsx)', () => {
  it('copies into the dashboard route’s workspace, and its project in a project’s section', async () => {
    const { galleryWorkspaceOf } = await import('../../dashboard/TemplateGallery.tsx')
    expect(galleryWorkspaceOf(`/w/${WID}`)).toEqual({ id: WID, projectId: null })
    expect(galleryWorkspaceOf(`/w/${WID}/all`)).toEqual({ id: WID, projectId: null })
    expect(galleryWorkspaceOf(`/w/${WID}/p/prj_0123456789`)).toEqual({ id: WID, projectId: 'prj_0123456789' })
    expect(galleryWorkspaceOf('/b/b-board00001')).toBeNull()
    expect(galleryWorkspaceOf('/')).toBeNull()
  })
})
