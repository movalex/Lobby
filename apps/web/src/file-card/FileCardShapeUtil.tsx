import {
  FILE_CARD_TYPE,
  type FileCardShape,
  fileCardShapeMigrations,
  fileCardShapeProps,
} from '@draftroom/canvas-schema'
import { BaseBoxShapeUtil, type TLIndicatorPath } from 'tldraw'
import { FileCardView } from './FileCardView.tsx'

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

  override getAriaDescriptor(shape: FileCardShape) {
    return `${KIND_LABEL[shape.props.kind]} file: ${shape.props.name}`
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
