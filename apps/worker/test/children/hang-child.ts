// Stand-in for a PDF child stuck on a hostile document: records its pid next to the original, then
// never answers and never exits.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

let input = ''
for await (const c of process.stdin) input += String(c)
const req = JSON.parse(input) as { input: string }
writeFileSync(join(dirname(req.input), 'child.pid'), String(process.pid))
setInterval(() => {}, 1 << 30)
