import { type ComponentType, type LazyExoticComponent, lazy, Suspense } from 'react'

// Spike A (docs/EXCALIDRAW-MIGRATION.md §8): /spike/:name loads ./pages/<name>.tsx. App.tsx mounts this
// only when the dev-auth guard is on, outside the session provider (no sign-in, no API calls). Add a page by adding a NEW file under ./pages with a default-exported component;
// nothing shared needs editing.
const pages = import.meta.glob<{ default: ComponentType }>('./pages/*.tsx')

const PAGE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const cache = new Map<string, LazyExoticComponent<ComponentType>>()

function pageFor(name: string): LazyExoticComponent<ComponentType> | null {
  const load = PAGE_NAME_RE.test(name) ? pages[`./pages/${name}.tsx`] : undefined
  if (!load) return null
  let page = cache.get(name)
  if (!page) {
    page = lazy(load)
    cache.set(name, page)
  }
  return page
}

/** The page name from /spike/:name, or null. */
export function spikePageName(pathname: string): string | null {
  const m = /^\/spike\/([^/]+)\/?$/.exec(pathname)
  return m?.[1] ?? null
}

export default function SpikeRoute({ pathname }: { pathname: string }) {
  const name = spikePageName(pathname)
  const Page = name === null ? null : pageFor(name)
  if (!Page) {
    return (
      <main data-testid="spike-missing" style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
        <h1>No spike page here</h1>
        <p>
          Pages:{' '}
          {Object.keys(pages)
            .map((k) => k.replace(/^\.\/pages\/|\.tsx$/g, ''))
            .join(', ')}
        </p>
      </main>
    )
  }
  return (
    <Suspense fallback={<div data-testid="spike-loading">Loading spike page…</div>}>
      <Page />
    </Suspense>
  )
}
