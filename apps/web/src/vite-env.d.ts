interface ImportMetaEnv {
  /** "1" enables development identities in a production build (e2e only). Never set for a deployment. */
  readonly VITE_DRAFTROOM_DEV_AUTH?: string
  readonly VITE_TLDRAW_LICENSE_KEY?: string
  /** 'excalidraw' (with the dev-auth guard) enables the spike-only /spike/:name engine pages. Spike A only. */
  readonly VITE_LOBBY_ENGINE?: string
}
