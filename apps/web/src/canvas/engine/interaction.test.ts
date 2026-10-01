import { describe, expect, it } from 'vitest'
import { interactionForRole, isLobbyRole, LOBBY_ROLES, READ_ONLY_INTERACTION } from './interaction.ts'

describe('interactionForRole (plan §2.3.2)', () => {
  it('omits the prop for editors (Excalidraw default: fully interactive)', () => {
    expect(interactionForRole('editor')).toBeUndefined()
  })

  it('gives every read-only role navigation, links, custom tools and the laser (CR-3A-8), with tools inside enabled', () => {
    for (const role of ['commenter', 'viewer', 'guest'] as const) {
      expect(interactionForRole(role)).toEqual({
        enabled: { navigation: true, links: true, tools: { custom: true, laser: true } },
      })
    }
    expect(Object.isFrozen(READ_ONLY_INTERACTION.enabled)).toBe(true)
  })

  it('knows exactly the four roles', () => {
    expect(LOBBY_ROLES).toEqual(['editor', 'commenter', 'viewer', 'guest'])
    expect(isLobbyRole('viewer')).toBe(true)
    expect(isLobbyRole('owner')).toBe(false)
    expect(isLobbyRole(undefined)).toBe(false)
  })
})
