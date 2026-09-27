// Six editable board templates for a creative team (docs/FEATURES-CONTRACTS.md, packages/templates).
// Pure logic: returns plain tldraw 5.4.2 shape + binding records, validated by draftroomSchema.

export { IMAGE_SLOT_META } from './builder.ts'
export {
  getTemplate,
  instantiateTemplate,
  isTemplateId,
  MAX_TEMPLATE_ORIGIN,
  parseTemplateContext,
  TEMPLATES,
} from './registry.ts'
export {
  type TemplateBounds,
  type TemplateBuildResult,
  type TemplateCategory,
  type TemplateContext,
  type TemplateDefinition,
  TemplateError,
  type TemplateErrorCode,
  type TemplateId,
  type TemplateInstance,
  type TemplatePoint,
} from './types.ts'
