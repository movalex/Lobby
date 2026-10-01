// Which board page /b/:boardId opens: since wave 4 part 2 (the tldraw removal, docs/EXCALIDRAW-CUTOVER.md
// G10) every build has Lobby's board page on the new canvas, so code outside the board that must speak
// the board page's language (the dashboard's deep links into boards, ?el=) has one answer.
export const NEW_CANVAS_BOARD_PAGE = true as const
