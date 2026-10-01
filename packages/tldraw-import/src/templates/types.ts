import type { TemplateBounds, TemplatePoint } from '@draftroom/templates/common'
import type { TemplateInfo } from '@draftroom/templates/source'
import type { TLPageId, TLRecord } from '@tldraw/tlschema'
import type { IndexKey } from '@tldraw/utils'

export {
  type TemplateBounds,
  type TemplateCategory,
  TemplateError,
  type TemplateErrorCode,
  type TemplateId,
  type TemplatePoint,
} from '@draftroom/templates/common'

/** The tldraw build's context (the Excalidraw scene's is `SceneTemplateContext`, ./scene/index.ts). */
export interface TemplateContext {
  /** Page the template's top-level shapes are parented to. */
  pageId: TLPageId
  /** Page-space position of the template's top-left corner. */
  origin: TemplatePoint
  /**
   * Optional: the highest index already used by the page's top-level shapes
   * (e.g. the last sibling's index). Top-level template shapes get indices above it,
   * so the template renders on top of existing content. Defaults to a fresh sequence.
   */
  indexAbove?: IndexKey | null
}

export interface TemplateBuildResult {
  records: TLRecord[]
}

export interface TemplateDefinition extends TemplateInfo {
  /** Builds shape + binding records with fresh ids on every call. */
  build(ctx: TemplateContext): TemplateBuildResult
}

export interface TemplateInstance {
  records: TLRecord[]
  /** Page-space bounds of the template's top-level shapes. */
  bounds: TemplateBounds
}
