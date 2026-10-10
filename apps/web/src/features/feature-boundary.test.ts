// H1 (wave M, M1-2; FTU-1): one feature's error never blanks the board. FeatureBoundary (./FeatureHostCore.tsx)
// wraps every component a feature renders on the board page. A component test in Node: react-dom/server does not
// run error boundaries, so the boundary's own steps are driven here (what React calls on an error, on new props,
// when it renders) and the real throw in a browser is e2e/excalidraw/m1-boundary.spec.ts.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FEATURE_CRASH_LIMIT,
  FEATURE_CRASH_WINDOW_MS,
  FeatureBoundary,
  featureOff,
  recordFeatureCrash,
  resetFeatureCrashes,
} from './FeatureHostCore.tsx'

beforeEach(() => resetFeatureCrashes())
afterEach(() => vi.restoreAllMocks())

const boundary = (featureId: string, resetKey: string | undefined, child: string) =>
  new FeatureBoundary({ featureId, resetKey, children: createElement('p', null, child) })

/** What React does when a child throws: the derived state, then componentDidCatch. */
function crash(b: FeatureBoundary) {
  b.state = { ...b.state, ...FeatureBoundary.getDerivedStateFromError() }
  b.componentDidCatch()
}

describe('FeatureBoundary', () => {
  it('renders what it wraps until it throws', () => {
    const html = renderToStaticMarkup(
      createElement(FeatureBoundary, { featureId: 'overlay:a', children: createElement('p', null, 'ok') }),
    )
    expect(html).toBe('<p>ok</p>')
  })

  it('a component that throws renders null, and logs one line naming the feature, nothing else', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const b = boundary('overlay:ai-menu', 'board|n1', 'the overlay')
    crash(b)
    expect(b.render()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]).toEqual(['feature_crash overlay:ai-menu'])
  })

  it('its siblings still render: only the crashed one is null', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const crashed = boundary('overlay:bad', 'k', 'bad')
    const sibling = boundary('overlay:good', 'k', 'good')
    crash(crashed)
    expect(crashed.render()).toBeNull()
    expect(renderToStaticMarkup(createElement('div', null, crashed.render(), sibling.render()))).toBe(
      '<div><p>good</p></div>',
    )
  })

  it('a new selection (or board) key resets it: it renders again', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const b = boundary('selectionBar:tags', 'board|n1', 'tags')
    crash(b)
    // the same key (the re-render right after the error): it stays down
    expect(
      FeatureBoundary.getDerivedStateFromProps({ featureId: 'x', resetKey: 'board|n1' }, b.state),
    ).toBeNull()
    // a selection change
    const next = FeatureBoundary.getDerivedStateFromProps({ featureId: 'x', resetKey: 'board|n2' }, b.state)
    expect(next).toEqual({ failed: false, key: 'board|n2' })
    b.state = next ?? b.state
    expect(renderToStaticMarkup(b.render() as never)).toBe('<p>tags</p>')
  })

  it(`after ${FEATURE_CRASH_LIMIT} crashes in a minute it stays off until a reload, whatever the key`, () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const b = boundary('overlay:loop', 'k0', 'x')
    for (let i = 1; i <= FEATURE_CRASH_LIMIT; i++) {
      crash(b)
      b.state =
        FeatureBoundary.getDerivedStateFromProps({ featureId: 'overlay:loop', resetKey: `k${i}` }, b.state) ??
        b.state
    }
    expect(b.state.failed).toBe(false)
    expect(featureOff('overlay:loop')).toBe(true)
    expect(b.render()).toBeNull()
    // another feature is untouched
    expect(featureOff('overlay:other')).toBe(false)
  })

  it('crashes spread over more than a minute do not turn it off', () => {
    const t0 = 1_000_000
    expect(recordFeatureCrash('panel:slow', t0)).toBe(false)
    expect(recordFeatureCrash('panel:slow', t0 + FEATURE_CRASH_WINDOW_MS / 2)).toBe(false)
    expect(recordFeatureCrash('panel:slow', t0 + FEATURE_CRASH_WINDOW_MS + 1)).toBe(false)
    expect(featureOff('panel:slow')).toBe(false)
    expect(recordFeatureCrash('panel:slow', t0 + FEATURE_CRASH_WINDOW_MS + 2)).toBe(true)
  })
})
