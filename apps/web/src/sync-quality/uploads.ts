import { type Atom, atom, type TLAssetStore } from 'tldraw'

/**
 * Counts this tab's uploads in flight through the asset store. tldraw puts an image's shape and asset
 * record on the board BEFORE its bytes are uploaded (defaultHandleExternalFileContent: placeholder
 * asset, upload, then updateAssets), so the sync acknowledgements alone would say "Saved" while the
 * file is still on its way. The save indicator stays on "Saving…" until this count is back to 0
 * (docs/research/saved-indicator.md §8.10).
 */
export function trackUploads(store: TLAssetStore): { store: TLAssetStore; inFlight: Atom<number> } {
  const inFlight = atom('dr-uploads-in-flight', 0)
  return {
    inFlight,
    store: {
      ...store,
      async upload(asset, file, abortSignal) {
        inFlight.update((n) => n + 1)
        try {
          return await store.upload(asset, file, abortSignal)
        } finally {
          inFlight.update((n) => n - 1)
        }
      },
    },
  }
}
