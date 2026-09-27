// MAK-10/11: tldraw's navigation panel (zoom menu with %, 100%, fit, selection; zoom in/out; minimap)
// with the minimap's open state in a shared atom, so M (dr-toggle-minimap) and the button agree.
// Same structure and classes as tldraw 5.4.2's DefaultNavigationPanel; the minimap starts open.

import { memo } from 'react'
import {
  PORTRAIT_BREAKPOINT,
  TldrawUiButtonIcon,
  TldrawUiToolbar,
  TldrawUiToolbarButton,
  useActions,
  useBreakpoint,
  useTldrawUiComponents,
  useTranslation,
  useValue,
} from 'tldraw'
import { minimapOpen, setMinimapOpen } from './bridge.ts'
import { kbdLabel } from './shortcuts.ts'

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export const DraftroomNavigationPanel = memo(function DraftroomNavigationPanel() {
  const actions = useActions()
  const msg = useTranslation()
  const breakpoint = useBreakpoint()
  const { ZoomMenu, Minimap } = useTldrawUiComponents()
  const open = useValue('dr-minimap-open', () => minimapOpen.get(), [])

  if (breakpoint < PORTRAIT_BREAKPOINT.MOBILE) return null
  const zoomOut = actions['zoom-out']
  const zoomIn = actions['zoom-in']
  const title = (label: string, kbd?: string) => (kbd ? `${label} (${kbdLabel(kbd, IS_MAC)})` : label)
  const toggle = actions['dr-toggle-minimap']

  return (
    <div className="tlui-navigation-panel" data-testid="navigation-panel">
      <TldrawUiToolbar orientation="horizontal" label={msg('navigation-zone.title')}>
        {ZoomMenu && breakpoint < PORTRAIT_BREAKPOINT.TABLET ? (
          <ZoomMenu />
        ) : (
          <>
            {open && zoomOut && (
              <TldrawUiToolbarButton
                type="icon"
                data-testid="minimap.zoom-out"
                title={title(msg('action.zoom-out'), '-')}
                onClick={() => zoomOut.onSelect('navigation-zone')}
              >
                <TldrawUiButtonIcon small icon="minus" />
              </TldrawUiToolbarButton>
            )}
            {ZoomMenu && <ZoomMenu key="zoom-menu" />}
            {open && zoomIn && (
              <TldrawUiToolbarButton
                type="icon"
                data-testid="minimap.zoom-in"
                title={title(msg('action.zoom-in'), '=')}
                onClick={() => zoomIn.onSelect('navigation-zone')}
              >
                <TldrawUiButtonIcon small icon="plus" />
              </TldrawUiToolbarButton>
            )}
            {Minimap && (
              <TldrawUiToolbarButton
                type="icon"
                data-testid="minimap.toggle-button"
                aria-pressed={open}
                title={title(open ? 'Hide minimap' : 'Show minimap', toggle?.kbd)}
                onClick={() => setMinimapOpen(!open)}
              >
                <TldrawUiButtonIcon small icon={open ? 'chevron-left' : 'chevron-right'} />
              </TldrawUiToolbarButton>
            )}
          </>
        )}
      </TldrawUiToolbar>
      {/* DefaultMinimap renders data-testid="minimap.canvas" */}
      {Minimap && breakpoint >= PORTRAIT_BREAKPOINT.TABLET && open && <Minimap />}
    </div>
  )
})
