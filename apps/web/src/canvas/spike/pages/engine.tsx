import { useEffect, useState } from 'react'
import ExcalidrawHost from '../../engine/ExcalidrawHost.tsx'
import { LOBBY_ROLES, type LobbyRole } from '../../engine/interaction.ts'
import { createSpikeHandle, installSpikeHandle, pickParam } from '../harness.ts'

const THEMES = ['light', 'dark'] as const

/**
 * /spike/engine?role=editor|commenter|viewer|guest&theme=light|dark
 * ExcalidrawHost full-screen, no scene, no sync. Tests drive it through window.__lobbySpike.
 */
export default function EnginePage() {
  const [role, setRole] = useState<LobbyRole>(() => pickParam('role', LOBBY_ROLES, 'editor'))
  const [theme, setTheme] = useState<'light' | 'dark'>(() => pickParam('theme', THEMES, 'light'))
  const [spike] = useState(() => createSpikeHandle(role, theme))

  useEffect(() => {
    spike.handle.setRole = setRole
    spike.handle.setTheme = setTheme
    return installSpikeHandle(spike.handle)
  }, [spike])
  useEffect(() => {
    spike.handle.role = role
    spike.handle.theme = theme
  }, [spike, role, theme])

  return (
    <div
      data-testid="spike-engine"
      data-role={role}
      data-theme={theme}
      style={{ position: 'fixed', inset: 0 }}
    >
      <ExcalidrawHost
        role={role}
        theme={theme}
        onApi={(api) => {
          spike.handle.api = api
        }}
        onReady={(api) => {
          spike.handle.api = api
          spike.resolveReady(api)
        }}
      />
    </div>
  )
}
