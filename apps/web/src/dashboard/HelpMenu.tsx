// The dashboard's Help menu (wave P, P-010): the Lobby tour, the keyboard shortcuts and Send feedback, outside a
// board (a board has the same three in its own menu). The tour is a board made for them (creators only), so it
// is offered only to those who may make one; the shortcuts open a small dialog of the everyday keys.
import { useState } from 'react'
import { Dialog } from '../ui/Dialog.tsx'
import { MenuButton } from '../ui/Menu.tsx'
import { helpShortcuts, isApplePlatform } from './welcome.ts'

export type HelpAction = 'tour' | 'shortcuts' | 'feedback'

export function helpMenuItems(canTour: boolean): { action: HelpAction; label: string }[] {
  return [
    ...(canTour ? [{ action: 'tour' as const, label: 'Take the Lobby tour' }] : []),
    { action: 'shortcuts', label: 'Keyboard shortcuts' },
    { action: 'feedback', label: 'Send feedback' },
  ]
}

export function HelpMenu({
  canTour,
  onTour,
  onFeedback,
}: {
  canTour: boolean
  onTour(): void
  onFeedback(): void
}) {
  const [shortcuts, setShortcuts] = useState(false)
  return (
    <>
      <MenuButton
        label="Help"
        className="dr-iconbtn dr-helpbtn"
        testId="help-menu"
        items={helpMenuItems(canTour)}
        onSelect={(action: HelpAction) => {
          if (action === 'tour') onTour()
          else if (action === 'shortcuts') setShortcuts(true)
          else onFeedback()
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2 1-1.2 1.8M12 16.6v.1"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
        </svg>
      </MenuButton>
      {shortcuts && (
        <Dialog title="Keyboard shortcuts" testId="help-shortcuts" onClose={() => setShortcuts(false)}>
          <div className="dr-helpkeys">
            {helpShortcuts(isApplePlatform()).map((section) => (
              <section key={section.title}>
                <h3>{section.title}</h3>
                <dl>
                  {section.rows.map((r) => (
                    <div key={`${section.title}:${r.keys}:${r.does}`}>
                      <dt>
                        <kbd>{r.keys}</kbd>
                      </dt>
                      <dd>{r.does}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </Dialog>
      )}
    </>
  )
}
