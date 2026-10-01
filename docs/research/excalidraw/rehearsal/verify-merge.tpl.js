// Reads the merged board file of b-0gazyr0d3e (after the roll-forward) next to "ours" (the B4 safety copy of
// the Excalidraw side, clock 6) and "theirs" (lb_source: R0's tldraw records), for the ids of the drill.
// Positions, counts and ids only. Run inside the sync container: docker exec -i … node - < verify-merge.js
const { DatabaseSync } = require('node:sqlite')
const fs = require('fs')
const IDS = __IDS__
const live = '/var/data/rooms/board-b-0gazyr0d3e.sqlite'
const bdir = '/var/data/backups/b-0gazyr0d3e/'
const oursFile = bdir + fs.readdirSync(bdir).filter((f) => f.endsWith('-c6.sqlite')).sort().at(-1)
const L = new DatabaseSync(live, { readOnly: true })
const O = new DatabaseSync(oursFile, { readOnly: true })
const tables = L.prepare("select name from sqlite_master where type='table' order by name").all().map((r) => r.name)
console.log('tables', JSON.stringify(tables))
const meta = Object.fromEntries(L.prepare('select key, value from lb_meta').all().map((r) => [r.key, r.value]))
console.log('converted_from', meta.converted_from)
const geom = (db, table, ids) => {
  const out = {}
  for (const [k, id] of Object.entries(ids)) {
    const r = db.prepare(`select data, deleted from ${table} where id = ?`).get(id)
    if (!r) {
      out[k] = 'missing'
      continue
    }
    const d = JSON.parse(r.data)
    out[k] = { x: Math.round(d.x), y: Math.round(d.y), frameId: d.frameId, deleted: !!r.deleted, v: d.version }
  }
  return out
}
const counts = (db) =>
  db.prepare('select type, count(*) n from lb_elements where deleted=0 group by type').all().reduce((a, r) => ((a[r.type] = r.n), a), {})
console.log('live elements (merged)', JSON.stringify(counts(L)), 'total', L.prepare('select count(*) n from lb_elements where deleted=0').get().n)
console.log('live elements (ours = B4 copy)', JSON.stringify(counts(O)), 'total', O.prepare('select count(*) n from lb_elements where deleted=0').get().n, 'file', oursFile.slice(bdir.length))
console.log('lb_source rows (theirs)', L.prepare('select count(*) n from lb_source').get().n)
const prev = tables.find((t) => /^lb_prev_\d+_elements$/.test(t))
console.log('prev table', prev, prev ? L.prepare(`select count(*) n from ${prev}`).get().n : null)
console.log('merged', JSON.stringify(geom(L, 'lb_elements', IDS)))
console.log('ours  ', JSON.stringify(geom(O, 'lb_elements', IDS)))
if (prev) console.log('prev  ', JSON.stringify(geom(L, prev, IDS)))
const src = (id) => {
  const r = L.prepare('select state from lb_source where id = ?').get('shape:' + id)
  if (!r) return 'missing'
  try {
    const s = JSON.parse(Buffer.from(r.state).toString('utf8'))
    return { x: Math.round(s.x), y: Math.round(s.y), parent: s.parentId }
  } catch (e) {
    return 'unparsed ' + typeof r.state
  }
}
console.log('theirs (lb_source, tldraw records)', JSON.stringify({ F1: src(IDS.F1), F2: src(IDS.F2), C2: src(IDS.C2), N3: src(IDS.N3) }))
const oursIds = new Set(O.prepare('select id from lb_elements').all().map((r) => r.id))
const created = L.prepare('select id, type from lb_elements where deleted=0').all().filter((r) => !oursIds.has(r.id))
console.log('in merged but not in ours (R0-created)', created.length, JSON.stringify(created.map((r) => r.type)))
const label = (db, noteId) => {
  const d = db
    .prepare("select data from lb_elements where deleted=0 and type='text'")
    .all()
    .map((x) => JSON.parse(x.data))
    .find((d) => d.containerId === noteId)
  return d ? d.text.length : null
}
console.log('N3 label text length ours / merged', label(O, IDS.N3), label(L, IDS.N3))
