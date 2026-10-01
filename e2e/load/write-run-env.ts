// Writes a run's run.env (the per-run test ticket secret and internal secret, and the fake api's address)
// with mode 0600, printing nothing but the path. On the NAS it runs in a --network none container of the
// pinned image, inside the run folder (docs/EXCALIDRAW-MIGRATION.md §8.6.6 "Secrets"):
//   node e2e/load/write-run-env.ts --out /s/run.env --api-url http://draftroom-spike-load:7899
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { newRunSecrets, runEnvText } from './tickets.ts'

const { values } = parseArgs({ options: { out: { type: 'string' }, 'api-url': { type: 'string' } } })
if (!values.out || !values['api-url']) throw new Error('--out and --api-url are required')
writeFileSync(values.out, runEnvText(newRunSecrets(), values['api-url']), { mode: 0o600 })
console.log(`[run-env] wrote ${values.out}`)
