// Theme before the first paint (no light flash in dark mode): the same rules as src/theme/theme.ts
// (THEME_STORAGE_KEY, resolveColorMode, applyToDocument); src/theme/theme.test.ts runs this file against
// them. Loaded by index.html as a blocking classic <script src> in <head>, so it still runs before the
// first paint; it is a file and not an inline script because Lobby's Content-Security-Policy has no
// inline-script hash (docs/EXCALIDRAW-MIGRATION.md §2.12: a hash in a static header goes stale on every
// edit of the script and fails silently into a flash of the wrong theme). Not a module: modules are
// deferred and would run after the first paint. Keep it tiny and dependency-free.
;(() => {
  let pref = 'system'
  try {
    const stored = localStorage.getItem('draftroom:theme')
    if (stored === 'light' || stored === 'dark' || stored === 'system') pref = stored
  } catch {
    // storage blocked: the default (System)
  }
  const dark =
    pref === 'dark' ||
    (pref === 'system' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const mode = dark ? 'dark' : 'light'
  const root = document.documentElement
  root.setAttribute('data-theme', mode)
  root.setAttribute('data-theme-pref', pref)
  root.style.colorScheme = mode
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', dark ? '#14161b' : '#1f3a5f')
})()
