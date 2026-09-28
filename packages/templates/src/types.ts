import type { TLPageId, TLRecord } from '@tldraw/tlschema'
import type { IndexKey } from '@tldraw/utils'

export type TemplateId =
  | 'brainstorm'
  | 'mood-board'
  | 'storyboard'
  | 'pitch-outline'
  | 'retrospective'
  | 'production-plan'
  | 'lobby-tour'

/** 'sample': the Lobby tour demo board (shown first on the dashboard, under no category chip). */
export type TemplateCategory = 'ideate' | 'visual' | 'plan' | 'review' | 'sample'

export interface TemplatePoint {
  x: number
  y: number
}

export interface TemplateBounds {
  x: number
  y: number
  w: number
  h: number
}

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

export interface TemplateDefinition {
  id: TemplateId
  name: string
  /** One sentence for the template picker. */
  description: string
  category: TemplateCategory
  /** Frame names in the intended reading order (rows top to bottom, then left to right). */
  sections: readonly string[]
  /** Builds shape + binding records with fresh ids on every call. */
  build(ctx: TemplateContext): TemplateBuildResult
}

export interface TemplateInstance {
  records: TLRecord[]
  /** Page-space bounds of the template's top-level shapes. */
  bounds: TemplateBounds
}

export type TemplateErrorCode = 'unknown-template' | 'invalid-context' | 'invalid-output'

/** Typed error for bad template ids, bad contexts, and (never expected) invalid output. */
export class TemplateError extends Error {
  readonly code: TemplateErrorCode

  constructor(code: TemplateErrorCode, message: string) {
    super(message)
    this.name = 'TemplateError'
    this.code = code
  }
}
