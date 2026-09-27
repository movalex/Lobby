// The one place canvas-ux reaches the shared board logic packages.
export {
  DEFAULT_MAX_NOTES,
  DEFAULT_NOTE_GAP,
  type FrameEntry,
  frameOutline,
  NOTE_SIZE,
  notesFromText,
  parseBulkText,
  plainTextOf,
  presentationOrder,
  richTextFrom,
  type SearchHit,
  searchBoard,
} from '@draftroom/board-ops'
export {
  instantiateTemplate,
  isTemplateId,
  TEMPLATES,
  type TemplateCategory,
  type TemplateDefinition,
  type TemplateId,
} from '@draftroom/templates'
