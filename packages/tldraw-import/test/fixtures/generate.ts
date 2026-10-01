// Regenerates the converter's template fixtures from the plans in packages/templates and the tldraw emitter
// in ../../src/templates/ (read-only):
//   node packages/tldraw-import/test/fixtures/generate.ts
// The kitchen sink (tl-kitchen-sink.json) is [DATA]'s hand-built board of every shape type and Lobby
// meta key (data/proto/make-kitchen.mjs), kept as it is. None of these files hold real board content.
import { writeFileSync } from 'node:fs'
import { instantiateTemplate, TEMPLATES } from '../../src/templates/registry.ts'
import type { TLPageId } from '../../src/tldraw.ts'

for (const def of TEMPLATES) {
  const inst = instantiateTemplate(def.id, { pageId: 'page:page' as TLPageId, origin: { x: 0, y: 0 } })
  const records = [
    { id: 'document:document', typeName: 'document', gridSize: 10, name: '', meta: {} },
    { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} },
    ...inst.records,
  ]
  writeFileSync(new URL(`tl-${def.id}.json`, import.meta.url), `${JSON.stringify(records, null, 1)}\n`)
  console.log(def.id, records.length)
}
