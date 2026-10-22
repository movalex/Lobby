// Creates each app's dev.env from its dev.env.example when the file is missing. dev.env holds the local
// development settings and secrets and is ignored by git; the example is the tracked template. Run by `pnpm dev`.
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const app of ['api', 'sync', 'worker']) {
  const target = join(root, 'apps', app, 'dev.env')
  if (existsSync(target)) continue
  copyFileSync(join(root, 'apps', app, 'dev.env.example'), target)
  console.log(`created apps/${app}/dev.env from dev.env.example`)
}
