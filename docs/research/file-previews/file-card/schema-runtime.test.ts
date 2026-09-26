// Server-style runtime check of the shared file-card schema (tldraw 5.4.2): validation + migration.
// Imports only @tldraw/tlschema (via the schema module) - what a sync server would load.
// Run: node schema-runtime.test.ts   (Node 24 type stripping)
import { draftroomSchema, fileCardVersions } from './file-card.schema.ts'

const base = {
	typeName: 'shape', id: 'shape:fc1', type: 'file-card', x: 0, y: 0, rotation: 0, index: 'a1', parentId: 'page:page',
	isLocked: false, opacity: 1, meta: {},
	props: { w: 240, h: 200, assetId: 'ast_01J9ZQ4Y7K3M', versionId: 'ver_01J9ZQ4Y7K3N', kind: 'pdf', name: 'document.pdf', mimeType: 'application/pdf', sizeBytes: 2274, status: 'ready', pageCount: 4, durationMs: null, posterDerivativeId: 'drv_01J9ZQ4Y7K3P' },
}
const validator = (draftroomSchema.types as any).shape.validator
const results: Record<string, string> = {}
const check = (label: string, rec: any) => {
	try { validator.validate(rec); results[label] = 'accepted' } catch (e: any) { results[label] = 'rejected: ' + String(e.message).split('\n')[0].slice(0, 160) }
}
check('valid file-card', base)
check('signed URL in posterDerivativeId', { ...base, props: { ...base.props, posterDerivativeId: 'https://r2.example/x.webp?X-Amz-Signature=abc' } })
check('data: URL in assetId', { ...base, props: { ...base.props, assetId: 'data:application/pdf;base64,JVBERi0=' } })
check('unknown status', { ...base, props: { ...base.props, status: 'done' } })
check('extra prop', { ...base, props: { ...base.props, url: 'https://x' } })

// Migration: a v0 record (no posterDerivativeId) migrates up and gains posterDerivativeId=null
const current = draftroomSchema.serialize() as any
const persisted = { ...current, sequences: { ...current.sequences, 'com.tldraw.shape.file-card': 0 } }
const v0Props: any = { ...base.props }
delete v0Props.posterDerivativeId
const migrated = draftroomSchema.migratePersistedRecord({ ...base, props: v0Props } as any, persisted, 'up') as any
results['migrate up result'] = migrated.type
results['migrated posterDerivativeId'] = JSON.stringify(migrated.value?.props?.posterDerivativeId)
results['migration id'] = fileCardVersions.AddPosterDerivativeId
results['current sequence version'] = String(current.sequences['com.tldraw.shape.file-card'])
console.log(JSON.stringify(results, null, 1))
