import {
  FILE_CARD_TYPE,
  type FileCardShape,
  fileCardShapeMigrations,
  fileCardShapeProps,
} from '@draftroom/canvas-schema'
import { BaseBoxShapeUtil, type TLIndicatorPath, type TLShapePartial } from 'tldraw'
import { FileCardView } from './FileCardView.tsx'
import { cardOfficeFormat } from './office.ts'
import { openCardOriginal } from './open-original.ts'

const KIND_LABEL: Record<FileCardShape['props']['kind'], string> = {
  pdf: 'PDF',
  video: 'Video',
  image: 'Image',
  other: 'File',
}

export class FileCardShapeUtil extends BaseBoxShapeUtil<FileCardShape> {
  static override type = FILE_CARD_TYPE
  static override props = fileCardShapeProps
  static override migrations = fileCardShapeMigrations

  getDefaultProps(): FileCardShape['props'] {
    return {
      w: 280,
      h: 92,
      assetId: 'ast_0000000000',
      versionId: 'ver_0000000000',
      kind: 'other',
      name: 'file',
      mimeType: 'application/octet-stream',
      sizeBytes: 0,
      status: 'queued',
      pageCount: null,
      durationMs: null,
      posterDerivativeId: null,
    }
  }

  override getText(shape: FileCardShape) {
    return shape.props.name
  }

  /** A card has nothing to type into (its name comes from the upload). */
  override canEdit() {
    return false
  }

  /**
   * Double-click opens the original in a new tab (the Download link's URL). Returning a (no-op)
   * change matters: with none, tldraw treats the double-click as one on empty canvas and starts
   * editing a new, empty text shape over the card.
   */
  override onDoubleClick(shape: FileCardShape): TLShapePartial<FileCardShape> {
    openCardOriginal(this.editor, shape)
    return { id: shape.id, type: shape.type }
  }

  override getAriaDescriptor(shape: FileCardShape) {
    // An Office document is previewed through a PDF conversion, but it is not a PDF file.
    const office = cardOfficeFormat(null, shape.props)
    return office
      ? `${office.label}: ${shape.props.name}`
      : `${KIND_LABEL[shape.props.kind]} file: ${shape.props.name}`
  }

  component(shape: FileCardShape) {
    return <FileCardView shape={shape} />
  }

  getIndicatorPath(shape: FileCardShape): TLIndicatorPath {
    const path = new Path2D()
    path.roundRect(0, 0, shape.props.w, shape.props.h, 10)
    return path
  }
}
