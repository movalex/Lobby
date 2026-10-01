// Which board page /b/:boardId opens in this build (docs/EXCALIDRAW-MIGRATION.md §7.2, wave 2C; wave 4,
// docs/EXCALIDRAW-CUTOVER.md G2): Lobby's board page on the new canvas in a build with the engine flag
// (App.tsx's test, the same), the production build included, else the tldraw board page. For code
// outside the board that must speak the board page's language, such as the dashboard's deep links into
// boards (?el= on the new canvas, ?d= on tldraw). Both engines ship until wave 4 part 2; this goes then.
export const NEW_CANVAS_BOARD_PAGE: boolean = import.meta.env.VITE_LOBBY_ENGINE === 'excalidraw'
