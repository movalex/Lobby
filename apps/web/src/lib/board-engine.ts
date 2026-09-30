// Which board page /b/:boardId opens in this build (docs/EXCALIDRAW-MIGRATION.md §7.2, wave 2C): Lobby's
// board page on the new canvas in a build with the engine flag AND the dev-auth guard (App.tsx's guard,
// the same test), else the tldraw board page. For code outside the board that must speak the board
// page's language, such as the dashboard's deep links into boards (?el= on the new canvas, ?d= on
// tldraw). Both engines ship until wave 4; this goes then.
import { DEV_AUTH_ENABLED } from './identity.ts'

export const NEW_CANVAS_BOARD_PAGE: boolean =
  import.meta.env.VITE_LOBBY_ENGINE === 'excalidraw' &&
  (import.meta.env.DEV || import.meta.env.VITE_DRAFTROOM_DEV_AUTH === '1') &&
  DEV_AUTH_ENABLED
