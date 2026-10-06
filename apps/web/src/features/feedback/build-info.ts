// The commit this web build was made from, for the feedback dialog's context block. vite.config.ts defines
// `__LOBBY_COMMIT__` at build time (Render's RENDER_GIT_COMMIT, else the local git HEAD); tests and any
// build that does not define it read 'dev'. A bare identifier, so Vite's `define` replaces it textually.
declare const __LOBBY_COMMIT__: string | undefined

export const APP_BUILD: string =
  typeof __LOBBY_COMMIT__ === 'string' && __LOBBY_COMMIT__ ? __LOBBY_COMMIT__ : 'dev'
