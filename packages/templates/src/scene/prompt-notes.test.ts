import { describe, expect, it } from 'vitest'
import { TEMPLATE_INFOS } from '../plan.ts'
import { instantiateSceneTemplate } from './index.ts'
// the server's text metrics, as apps/sync installs them (Node has no canvas to measure with)
import './test-kit.ts'

// CR-3H-2 (R9): on the new canvas the room stamps `lastEditedBy` on a note's label when it is created, so
// the AI's "nobody typed it" rule (packages/contracts ai.ts isTeamNote) no longer tells a template's own
// notes from the team's, and Group into themes grouped a Retrospective's "What slowed us down?" with the
// team's answers. The emitter now marks a template's prompt notes `customData.lobby.prompt`, which the api
// (sources.ts) and the client (features/ai target.ts) read as the `draftroomPrompt` marker: always a prompt.

const notesOf = (id: (typeof TEMPLATE_INFOS)[number]['id']) =>
  instantiateSceneTemplate(id, { origin: { x: 0, y: 0 } }).elements.filter((e) => e.type === 'stickynote')

describe('template prompt notes carry the prompt marker (CR-3H-2)', () => {
  for (const { id } of TEMPLATE_INFOS.filter((t) => t.id !== 'lobby-tour'))
    it(`${id}: every note is marked a prompt; nothing else is`, () => {
      const { elements } = instantiateSceneTemplate(id, { origin: { x: 0, y: 0 } })
      const notes = elements.filter((e) => e.type === 'stickynote')
      expect(notes.length).toBeGreaterThan(0)
      for (const n of notes) expect(n.customData?.lobby?.prompt, n.id).toBe('true')
      for (const e of elements.filter((x) => x.type !== 'stickynote'))
        expect(e.customData?.lobby?.prompt, e.id).toBeUndefined()
    })

  it('the Lobby tour’s notes are example ideas (the demo groups them): unmarked', () => {
    const notes = notesOf('lobby-tour')
    expect(notes.length).toBeGreaterThan(8)
    for (const n of notes) expect(n.customData?.lobby?.prompt).toBeUndefined()
  })

  it('the Retrospective’s “What to improve” prompts are marked', () => {
    const { elements } = instantiateSceneTemplate('retrospective', { origin: { x: 0, y: 0 } })
    const frame = elements.find((e) => e.type === 'frame' && e.name === '3 · What to improve')
    const prompts = elements.filter((e) => e.type === 'stickynote' && e.frameId === frame?.id)
    expect(prompts).toHaveLength(3)
    for (const p of prompts) expect(p.customData).toEqual({ lobby: { prompt: 'true' } })
  })
})
