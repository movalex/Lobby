/**
 * O2's spike board page at /b/:boardId (docs/EXCALIDRAW-MIGRATION.md §8.1 "Web", §8.6.3): the Excalidraw
 * host, the top bar and Saved indicator, the ticket and the socket, "X is typing", the UI slots of
 * `registries.ts`, and one `installAll` call (`canvas/spike/installers.ts`). STUB written by the lead at the
 * spike B contracts step C0; O2 owns `canvas/spike/board/**` from C0 on. App.tsx loads it only with
 * VITE_LOBBY_ENGINE=excalidraw and the dev-auth guard, inside the signed-in session.
 */
export default function SpikeBoardPage({ boardId }: { boardId: string }) {
  return (
    <main data-testid="spike-board-stub" style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Spike board</h1>
      <p>Board {boardId}: not implemented (O2).</p>
    </main>
  )
}
