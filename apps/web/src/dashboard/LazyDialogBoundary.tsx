// A lazy dialog that could not load (wave K, K4-6 follow-up). The Share dialog is its own chunk now, fetched when
// someone chooses Share on a card. A dashboard tab left open across a deploy asks for a chunk name the new
// build no longer has: the import is refused, and an uncaught error while rendering would unmount the whole
// app. The dashboard is the longest-lived page, so it catches that here and says what to do instead.
import { Component, type ReactNode } from 'react'
import { Dialog } from '../ui/Dialog.tsx'

interface Props {
  /** What was being opened, for the title ("Share"). */
  what: string
  onClose(): void
  children: ReactNode
}

export class LazyDialogBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override render() {
    if (!this.state.failed) return this.props.children
    const { what, onClose } = this.props
    return (
      <Dialog
        title={`${what} could not open`}
        description="Lobby was updated while this page was open, so part of it is out of date. Reload the page and try again; nothing you have done is lost."
        onClose={onClose}
        testId="lazy-dialog-failed"
      >
        <div className="dr-dialog__actions">
          <button type="button" className="dr-btn" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="dr-btn dr-btn--primary"
            data-testid="lazy-dialog-reload"
            onClick={() => location.reload()}
          >
            Reload
          </button>
        </div>
      </Dialog>
    )
  }
}
