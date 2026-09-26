// Shared (server + client) schema for the milestone-0 file-card shape. No React / DOM imports.
import {
	createShapePropsMigrationIds,
	createShapePropsMigrationSequence,
	createTLSchema,
	defaultShapeSchemas,
	type RecordProps,
	type TLShape,
} from '@tldraw/tlschema'
import { T } from '@tldraw/validate'

export const FILE_CARD_TYPE = 'file-card' as const

export const FILE_KINDS = ['image', 'pdf', 'video', 'other'] as const
export type FileKind = (typeof FILE_KINDS)[number]

export const FILE_STATUSES = ['queued', 'processing', 'ready', 'failed'] as const
export type FileStatus = (typeof FILE_STATUSES)[number]

// App-level IDs (Postgres), NOT tldraw TLAssetId and NEVER URLs / base64.
// Prefix + ULID/UUID keeps them recognisable in logs and easy to validate.
const appId = (prefix: string) =>
	T.string.check((v) => {
		if (!new RegExp(`^${prefix}_[0-9A-Za-z]{10,40}$`).test(v)) throw new Error(`expected ${prefix}_… id`)
	})

export interface FileCardShapeProps {
	w: number
	h: number
	assetId: string // ast_…  (logical file)
	versionId: string // ver_…  (immutable uploaded version)
	kind: FileKind
	name: string
	mimeType: string // sniffed/validated by server, not the browser's claim
	sizeBytes: number
	status: FileStatus // denormalised hint; Postgres asset_versions.status is authoritative
	pageCount: number | null // pdf only
	durationMs: number | null // video only
	posterDerivativeId: string | null // drv_… (image thumb / pdf cover / video poster)
}

declare module '@tldraw/tlschema' {
	export interface TLGlobalShapePropsMap {
		[FILE_CARD_TYPE]: FileCardShapeProps
	}
}

export type FileCardShape = TLShape<typeof FILE_CARD_TYPE>

export const fileCardShapeProps: RecordProps<FileCardShape> = {
	w: T.positiveNumber,
	h: T.positiveNumber,
	assetId: appId('ast'),
	versionId: appId('ver'),
	kind: T.literalEnum(...FILE_KINDS),
	name: T.string,
	mimeType: T.string,
	sizeBytes: T.positiveInteger,
	status: T.literalEnum(...FILE_STATUSES),
	pageCount: T.nullable(T.positiveInteger),
	durationMs: T.nullable(T.positiveInteger),
	posterDerivativeId: T.nullable(appId('drv')),
}

// Migration example: v1 had no posterDerivativeId; v2 adds it.
export const fileCardVersions = createShapePropsMigrationIds(FILE_CARD_TYPE, {
	AddPosterDerivativeId: 1,
})

export const fileCardShapeMigrations = createShapePropsMigrationSequence({
	sequence: [
		{
			id: fileCardVersions.AddPosterDerivativeId,
			up: (props: any) => {
				props.posterDerivativeId = null
			},
			down: (props: any) => {
				delete props.posterDerivativeId
			},
		},
	],
})

// Server side (sync room): build the schema with the same props + migrations.
export const draftroomSchema = createTLSchema({
	shapes: {
		...defaultShapeSchemas,
		[FILE_CARD_TYPE]: { props: fileCardShapeProps, migrations: fileCardShapeMigrations },
	},
})
