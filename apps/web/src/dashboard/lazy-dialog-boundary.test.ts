// Wave K (K4-6 follow-up): a dashboard tab left open across a deploy asks for a Share chunk the new build no longer
// has. The boundary turns that into a dialog that says what to do instead of an unmounted app. A component test
// in Node (react-dom/server does not run error boundaries, so the real chunk failure is
// e2e/excalidraw/k4-dashboard.spec.ts: the chunk request is refused and Share shows the notice).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LazyDialogBoundary } from './LazyDialogBoundary.tsx'
import { byTestId, elementsOf, fire, textOf } from './test-tree.ts'

afterEach(() => vi.unstubAllGlobals())

describe('the lazy dialog boundary', () => {
  it('turns an error from below (a chunk that would not load) into its failed state', () => {
    expect(LazyDialogBoundary.getDerivedStateFromError()).toEqual({ failed: true })
  })

  it('renders what it wraps until then', () => {
    const html = renderToStaticMarkup(
      createElement(LazyDialogBoundary, {
        what: 'Share',
        onClose() {},
        children: createElement('p', null, 'the dialog'),
      }),
    )
    expect(html).toBe('<p>the dialog</p>')
  })

  it('says what to do once it failed: a dialog that names the thing, with Reload and Close', () => {
    const onClose = vi.fn()
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    const boundary = new LazyDialogBoundary({ what: 'Share', onClose, children: null })
    boundary.state = { failed: true }
    const tree = boundary.render()

    const html = renderToStaticMarkup(tree)
    expect(html).toContain('data-testid="lazy-dialog-failed"')
    expect(html).toContain('Share could not open')
    expect(html).toMatch(/Reload the page and try again/)
    // nothing about the person’s work was touched
    expect(html).toContain('nothing you have done is lost')

    const [reloadButton] = byTestId(tree, 'lazy-dialog-reload')
    expect(textOf(reloadButton)).toBe('Reload')
    fire(reloadButton as never)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()

    // Close (the other button) hands the screen back
    const close = elementsOf(tree).find((e) => e.type === 'button' && textOf(e) === 'Close')
    fire(close as never)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
