// Client-only ShapeUtil. Renders from derivative IDs resolved to short-lived URLs at render time.
import { BaseBoxShapeUtil, HTMLContainer, type TLShape } from 'tldraw'
import {
	FILE_CARD_TYPE,
	fileCardShapeMigrations,
	fileCardShapeProps,
	type FileCardShape,
} from './file-card.schema'

// Hypothetical app hook: GET /api/derivatives/:id/url -> { url, expiresAt } (auth-checked, refreshed before expiry)
declare function useDerivativeUrl(derivativeId: string | null): string | null

function FileCardBody({ shape }: { shape: FileCardShape }) {
	const posterUrl = useDerivativeUrl(shape.props.posterDerivativeId)
	const p = shape.props
	return (
		<HTMLContainer style={{ pointerEvents: 'all', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #ddd', borderRadius: 8, overflow: 'hidden' }}>
			<div style={{ flex: 1, background: '#f3f3f3', display: 'grid', placeItems: 'center' }}>
				{p.status === 'ready' && posterUrl ? (
					<img src={posterUrl} alt="" draggable={false} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
				) : (
					<span>{p.status === 'failed' ? 'Preview unavailable' : 'Processing…'}</span>
				)}
			</div>
			<div style={{ padding: 8, fontSize: 12 }}>
				{p.name} · {p.kind === 'pdf' && p.pageCount ? `${p.pageCount} pages` : p.kind === 'video' && p.durationMs ? `${Math.round(p.durationMs / 1000)}s` : p.mimeType}
			</div>
		</HTMLContainer>
	)
}

export class FileCardShapeUtil extends BaseBoxShapeUtil<FileCardShape> {
	static override type = FILE_CARD_TYPE
	static override props = fileCardShapeProps
	static override migrations = fileCardShapeMigrations

	override getDefaultProps(): FileCardShape['props'] {
		return {
			w: 240,
			h: 200,
			assetId: 'ast_0000000000',
			versionId: 'ver_0000000000',
			kind: 'other',
			name: '',
			mimeType: 'application/octet-stream',
			sizeBytes: 1,
			status: 'queued',
			pageCount: null,
			durationMs: null,
			posterDerivativeId: null,
		}
	}

	override component(shape: FileCardShape) {
		return <FileCardBody shape={shape} />
	}

	override getIndicatorPath(shape: FileCardShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}

// Type-level check that TLShape<'file-card'> resolves via the augmentation when imported from 'tldraw'
export type Check = TLShape<'file-card'>['props']['versionId'] extends string ? true : never
