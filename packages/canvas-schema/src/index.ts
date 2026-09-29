// The package root stays the tldraw schema until the cut-over: the normal (tldraw) web build imports it
// and must carry no engine code. The Excalidraw contracts of spike B (docs/research/excalidraw/spike-b/
// CONTRACTS.md) are subpath exports only: `./protocol`, `./groups`, `./custom-data`, `./limits`,
// `./elements`, `./doc`, `./refs`, `./hash`, `./invariants` and `./engine`.
import { createTLSchema, defaultBindingSchemas, defaultShapeSchemas } from '@tldraw/tlschema'
import { FILE_CARD_TYPE, fileCardShapeMigrations, fileCardShapeProps } from './file-card.ts'

export * from './file-card.ts'

export const customShapeSchemas = {
  [FILE_CARD_TYPE]: { props: fileCardShapeProps, migrations: fileCardShapeMigrations },
}

/** The ONE server schema. The client builds the identical schema from [...defaultShapeUtils, FileCardShapeUtil]. */
export const draftroomSchema = createTLSchema({
  shapes: { ...defaultShapeSchemas, ...customShapeSchemas },
  bindings: defaultBindingSchemas,
})
