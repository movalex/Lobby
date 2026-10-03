/**
 * Engine probe page (spike A, node owner). Mounts a real <Excalidraw> so the fonts are registered by
 * Excalidraw's own code (`Fonts.init` + `loadFontFaces`, `chunk-FN755BR4.js:3080-3250`) from the
 * installed package, then exposes probe functions on `window.__probe` for the Playwright runner.
 *
 * Not part of the app: built only by `vite.config.ts` in this folder.
 */
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { createRoot } from 'react-dom/client'
import type { CorpusLabel } from '../a3/corpus.ts'
import { runA8InBrowser } from './a8.ts'
import { type AddFilesApi, checkAddFiles } from './add-files.ts'
import { calibrate } from './calibrate.ts'
import { layoutCorpusInBrowser } from './layout-corpus.ts'

type Api = Parameters<NonNullable<React.ComponentProps<typeof Excalidraw>['onExcalidrawAPI']>>[0]

declare global {
  interface Window {
    __probe: {
      ready: boolean
      error?: string
      api?: Api
      calibrate?: (heldOut: string[], only?: number[]) => ReturnType<typeof calibrate>
      layout?: (labels: CorpusLabel[]) => ReturnType<typeof layoutCorpusInBrowser>
      a8?: () => ReturnType<typeof runA8InBrowser>
      addFiles?: () => ReturnType<typeof checkAddFiles>
    }
  }
}

window.__probe = { ready: false }

const fontsRegistered = () => {
  const families = new Set([...document.fonts].map((f) => f.family.replace(/["']/g, '')))
  return families.has('Nunito') && families.has('Excalifont') && families.has('Xiaolai')
}

const onApi = (api: Api) => {
  if (!api || window.__probe.api) return
  window.__probe.api = api
  const started = performance.now()
  const wait = () => {
    if (fontsRegistered()) {
      window.__probe.calibrate = (heldOut, only) => calibrate(new Set(heldOut), only)
      window.__probe.layout = (labels) => layoutCorpusInBrowser(labels)
      window.__probe.a8 = () => runA8InBrowser(api)
      window.__probe.addFiles = () => checkAddFiles(api as unknown as AddFilesApi)
      window.__probe.ready = true
    } else if (performance.now() - started > 30_000) {
      window.__probe.error = 'Excalidraw did not register its font faces within 30 s'
      window.__probe.ready = true
    } else setTimeout(wait, 50)
  }
  wait()
}

const root = document.getElementById('root')
if (!root) throw new Error('no #root')
createRoot(root).render(
  <div style={{ height: '100%' }}>
    <Excalidraw onExcalidrawAPI={onApi} />
  </div>,
)
