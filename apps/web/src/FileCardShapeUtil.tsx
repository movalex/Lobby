import {
  FILE_CARD_TYPE,
  type FileCardShape,
  fileCardShapeMigrations,
  fileCardShapeProps,
} from '@draftroom/canvas-schema'
import { BaseBoxShapeUtil, HTMLContainer, type TLIndicatorPath } from 'tldraw'

export class FileCardShapeUtil extends BaseBoxShapeUtil<FileCardShape> {
  static override type = FILE_CARD_TYPE
  static override props = fileCardShapeProps
  static override migrations = fileCardShapeMigrations

  getDefaultProps(): FileCardShape['props'] {
    return {
      w: 240,
      h: 160,
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

  component(shape: FileCardShape) {
    const p = shape.props
    return (
      <HTMLContainer
        data-testid="file-card"
        style={{
          background: '#fff',
          border: '1px solid #333',
          borderRadius: 8,
          padding: 8,
          pointerEvents: 'all',
        }}
      >
        <strong>{p.name}</strong> <span>{p.kind}</span> <span>{p.status}</span>
        {p.pageCount != null && <span> {p.pageCount} pages</span>}
      </HTMLContainer>
    )
  }

  getIndicatorPath(shape: FileCardShape): TLIndicatorPath {
    const path = new Path2D()
    path.roundRect(0, 0, shape.props.w, shape.props.h, 8)
    return path
  }
}
