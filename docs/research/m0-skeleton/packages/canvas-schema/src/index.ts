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
