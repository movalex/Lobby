interface ImportMetaEnv {
  /** "1" enables development identities in a production build (e2e only). Never set for a deployment. */
  readonly VITE_DRAFTROOM_DEV_AUTH?: string
  /** 'spike': dev-auth builds open spike B's board page on /b/:boardId (canvas/board/route.tsx). */
  readonly VITE_LOBBY_BOARD_PAGE?: string
}
