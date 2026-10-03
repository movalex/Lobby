// The web build's stand-in for `@excalidraw/mermaid-to-excalidraw` (apps/web/vite.config.ts aliases the package
// here; docs/EXCALIDRAW-MIGRATION.md §2.2, the wave-4 "mermaid stub").
//
// Lobby turns off the engine's only Mermaid UI (the text-to-diagram dialog: `aiEnabled={false}`, `ui={false}`),
// yet the engine still imports the converter in two places: statically from that dialog's code, and lazily from
// its paste path, which tries every pasted text that starts with a chart keyword ("graph", "flowchart", "pie",
// "timeline", …: `isMaybeMermaidDefinition`) as a Mermaid definition. The real package pulls Mermaid, its
// parser, d3, dagre, cytoscape and marked into the board route (about 70 chunks, and a hoisted part of them
// into the eager closure). With this module a paste never becomes a diagram: the engine's own `catch` around
// `parseMermaidToExcalidraw` (App.insertClipboardContent) logs a warning and pastes the words as plain text,
// as any other text is pasted.
//
// The only name the engine imports from the package (0.18.0-1118751, dist/prod/index.js) is
// `parseMermaidToExcalidraw`; the alias test (./mermaid-to-excalidraw-stub.test.ts) checks that it still is.

/** Always rejects: the paste then goes on as plain text (see the header). */
export async function parseMermaidToExcalidraw(_definition: string, _config?: unknown): Promise<never> {
  throw new Error('Mermaid diagrams are not available on Lobby boards')
}
